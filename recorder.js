import { DiskSink, duration } from './recording-core.mjs';

const el = id => document.getElementById(id);
const targetTabId = Number(new URLSearchParams(location.search).get('target'));
let stream, audio, recorder, sink, timer, started, busy = false, failure = null;

window.addEventListener('beforeunload', event => {
  if (busy) { event.preventDefault(); event.returnValue = ''; }
});

function release() {
  clearInterval(timer);
  stream?.getTracks().forEach(track => track.stop());
  stream = null;
  audio?.close().catch(() => {});
  audio = null;
  chrome.power.releaseKeepAwake();
}

function stop() {
  if (recorder?.state === 'recording') {
    el('stop').disabled = true;
    el('status').textContent = 'Сохранение файла…';
    recorder.stop();
  }
}

el('stop').addEventListener('click', stop);
el('start').addEventListener('click', async () => {
  if (busy) return;
  busy = true;
  failure = null;
  el('start').disabled = true;
  el('quality').disabled = true;
  let writable;
  try {
    if (!Number.isInteger(targetTabId) || targetTabId <= 0)
      throw new Error('Откройте вебинар и нажмите значок расширения.');
    const mimeType = ['video/webm;codecs=vp8,opus', 'video/webm']
      .find(type => MediaRecorder.isTypeSupported(type));
    if (!mimeType) throw new Error('Браузер не поддерживает запись WebM.');
    const handle = await window.showSaveFilePicker({
      suggestedName: `webinar-${new Date().toISOString().replace(/[:.]/g, '-')}.webm`,
      types: [{description:'Видео WebM', accept:{'video/webm':['.webm']}}]
    });
    writable = await handle.createWritable();
    sink = new DiskSink(writable);
    el('file').textContent = `Файл: ${handle.name}`;
    el('status').textContent = 'Подключение к вкладке…';
    const id = await chrome.tabCapture.getMediaStreamId({targetTabId});
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {mandatory:{chromeMediaSource:'tab', chromeMediaSourceId:id}},
      video: {mandatory:{chromeMediaSource:'tab', chromeMediaSourceId:id,
        maxWidth:1920, maxHeight:1080, maxFrameRate:30}}
    });
    // tabCapture redirects the tab audio; route it back to the speakers.
    audio = new AudioContext();
    audio.createMediaStreamSource(stream).connect(audio.destination);
    await audio.resume();
    recorder = new MediaRecorder(stream, {
      mimeType, videoBitsPerSecond:Number(el('quality').value), audioBitsPerSecond:128000
    });
    recorder.addEventListener('dataavailable', event => {
      if (event.data.size) sink.append(event.data).then(() => {
        if (sink.error) { failure = sink.error; stop(); }
      });
    });
    recorder.addEventListener('error', event => {
      failure = event.error || new Error('Сбой записи.');
      stop();
    });
    recorder.addEventListener('stop', async () => {
      el('stop').disabled = true;
      release();
      try {
        await sink.close();
        el('status').textContent = failure
          ? `Запись прервана: ${failure.message}. Доступная часть сохранена.`
          : 'Запись сохранена. Файл можно открыть в VLC.';
      } catch (error) {
        el('status').textContent = `Не удалось сохранить файл: ${error.message}`;
      } finally {
        el('size').textContent = `${(sink.bytes / 1048576).toFixed(1)} МБ`;
        busy = false;
        el('start').disabled = false;
        el('quality').disabled = false;
      }
    });
    stream.getVideoTracks()[0].addEventListener('ended', () => {
      failure = new Error('Вкладка закрыта или захват прекращён');
      stop();
    });
    chrome.power.requestKeepAwake('system');
    recorder.start(1000);
    started = Date.now();
    el('timer').textContent = '00:00:00';
    el('size').textContent = '0 МБ';
    timer = setInterval(() => {
      el('timer').textContent = duration(Date.now() - started);
      el('size').textContent = `${(sink.bytes / 1048576).toFixed(1)} МБ`;
    }, 1000);
    el('status').textContent = '● Идёт запись — браузер можно свернуть';
    el('stop').disabled = false;
  } catch (error) {
    release();
    await writable?.abort().catch(() => {});
    busy = false;
    el('start').disabled = false;
    el('quality').disabled = false;
    el('status').textContent = error.name === 'AbortError'
      ? 'Выбор файла отменён. Можно начать снова.' : `Ошибка: ${error.message}`;
  }
});
