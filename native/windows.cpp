// Window state and per-process WASAPI capture. Uses the process loopback API
// documented by Microsoft for Windows build 20348+, without global audio routing.
#include <windows.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <mmdeviceapi.h>
#include <wrl.h>
#include <cstdio>
#include <string>
#include <vector>
#include <fcntl.h>
#include <io.h>
using namespace Microsoft::WRL;

class Activation final : public RuntimeClass<RuntimeClassFlags<ClassicCom>, FtmBase,
                                             IActivateAudioInterfaceCompletionHandler> {
public:
    HANDLE done = CreateEvent(nullptr, TRUE, FALSE, nullptr);
    HRESULT result = E_PENDING;
    ComPtr<IAudioClient> client;
    ~Activation() { if (done) CloseHandle(done); }
    STDMETHOD(ActivateCompleted)(IActivateAudioInterfaceAsyncOperation* operation) override {
        HRESULT activation = E_FAIL;
        ComPtr<IUnknown> object;
        result = operation->GetActivateResult(&activation, &object);
        if (SUCCEEDED(result)) result = activation;
        if (SUCCEEDED(result)) result = object.As(&client);
        SetEvent(done);
        return S_OK;
    }
};
static void check(HRESULT hr) { if (FAILED(hr)) throw hr; }
static DWORD windowPid(HWND window) {
    if (!IsWindow(window)) throw E_INVALIDARG;
    DWORD pid = 0;
    GetWindowThreadProcessId(window, &pid);
    if (!pid) throw E_INVALIDARG;
    return pid;
}
static void printWindow(HWND window) {
    DWORD pid = 0;
    const bool valid = IsWindow(window) != FALSE;
    if (valid) GetWindowThreadProcessId(window, &pid);
    std::printf("{\"valid\":%s,\"minimized\":%s,\"pid\":%lu}\n",
        valid ? "true" : "false", IsIconic(window) ? "true" : "false", pid);
    std::fflush(stdout);
}
static void capture(DWORD pid, DWORD duration = 0) {
    check(CoInitializeEx(nullptr, COINIT_MULTITHREADED));
    auto activation = Make<Activation>();
    AUDIOCLIENT_ACTIVATION_PARAMS params{};
    params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    params.ProcessLoopbackParams.TargetProcessId = pid;
    params.ProcessLoopbackParams.ProcessLoopbackMode = PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;
    PROPVARIANT prop{};
    prop.vt = VT_BLOB;
    prop.blob.cbSize = sizeof(params);
    prop.blob.pBlobData = reinterpret_cast<BYTE*>(&params);
    ComPtr<IActivateAudioInterfaceAsyncOperation> operation;
    check(ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
        __uuidof(IAudioClient), &prop, activation.Get(), &operation));
    if (WaitForSingleObject(activation->done, 15000) != WAIT_OBJECT_0) throw HRESULT_FROM_WIN32(ERROR_TIMEOUT);
    check(activation->result);
    WAVEFORMATEX format{};
    format.wFormatTag = WAVE_FORMAT_PCM;
    format.nChannels = 2;
    format.nSamplesPerSec = 44100;
    format.wBitsPerSample = 16;
    format.nBlockAlign = 4;
    format.nAvgBytesPerSec = 176400;
    check(activation->client->Initialize(AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
        0, 0, &format, nullptr));
    ComPtr<IAudioCaptureClient> reader;
    check(activation->client->GetService(IID_PPV_ARGS(&reader)));
    HANDLE ready = CreateEvent(nullptr, FALSE, FALSE, nullptr);
    if (!ready) throw HRESULT_FROM_WIN32(GetLastError());
    check(activation->client->SetEventHandle(ready));
    _setmode(_fileno(stdout), _O_BINARY);
    check(activation->client->Start());
    std::fprintf(stderr, "READY\n"); std::fflush(stderr);
    const HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
    bool running = true;
    const ULONGLONG started = GetTickCount64();
    while (running && (!duration || GetTickCount64() - started < duration)) {
        const DWORD wait = WaitForSingleObject(ready, duration ? 250 : 2000);
        if (wait != WAIT_OBJECT_0 && wait != WAIT_TIMEOUT) throw E_FAIL;
        UINT32 packet = 0;
        check(reader->GetNextPacketSize(&packet));
        while (packet) {
            BYTE* data = nullptr; UINT32 frames = 0; DWORD flags = 0;
            check(reader->GetBuffer(&data, &frames, &flags, nullptr, nullptr));
            const DWORD bytes = frames * format.nBlockAlign;
            std::vector<BYTE> silence;
            if (flags & AUDCLNT_BUFFERFLAGS_SILENT) { silence.resize(bytes); data = silence.data(); }
            DWORD sent = 0;
            while (sent < bytes) {
                DWORD written = 0;
                if (!WriteFile(output, data + sent, bytes - sent, &written, nullptr) || !written) { running = false; break; }
                sent += written;
            }
            check(reader->ReleaseBuffer(frames));
            check(reader->GetNextPacketSize(&packet));
        }
    }
    activation->client->Stop(); CloseHandle(ready); CoUninitialize();
}
int wmain(int argc, wchar_t** argv) {
    try {
        if (argc == 2 && std::wstring(argv[1]) == L"self-test") {
            HWND window = CreateWindowEx(0, L"STATIC", L"Recorder test", WS_OVERLAPPEDWINDOW,
                0, 0, 100, 100, nullptr, nullptr, GetModuleHandle(nullptr), nullptr);
            windowPid(window); ShowWindow(window, SW_MINIMIZE);
            if (!IsIconic(window)) throw E_FAIL;
            printWindow(window); DestroyWindow(window); printWindow(window); return 0;
        }
        if (argc == 2 && std::wstring(argv[1]) == L"audio-probe") {
            capture(GetCurrentProcessId(), 1500); return 0;
        }
        if (argc != 3) return 2;
        const std::wstring mode(argv[1]);
        const HWND window = reinterpret_cast<HWND>(std::stoull(argv[2]));
        if (mode == L"inspect") { printWindow(window); return 0; }
        if (mode == L"watch") {
            while (true) { printWindow(window); if (!IsWindow(window)) break; Sleep(1000); }
            return 0;
        }
        if (mode == L"audio") { capture(windowPid(window)); return 0; }
        return 2;
    } catch (HRESULT hr) {
        std::fprintf(stderr, "Windows capture error: 0x%08lx\n", static_cast<unsigned long>(hr)); return 1;
    } catch (...) { std::fprintf(stderr, "Invalid capture request\n"); return 1; }
}
