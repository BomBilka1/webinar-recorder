"""Split a portable ZIP for delivery through Telegram's standard Bot API."""
import argparse
import hashlib
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('archive', type=Path)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    parts = []
    digest = hashlib.sha256()
    with args.archive.open('rb') as source:
        while block := source.read(40 * 1024 * 1024):
            part = args.out / f'WebinarRecorder.zip.{len(parts) + 1:03}'
            part.write_bytes(block)
            digest.update(block)
            parts.append(part.name)
    joined = '+'.join(f'"{name}"' for name in parts)
    lines = ['@echo off', 'setlocal EnableExtensions', 'cd /d "%~dp0"',
             'echo Webinar Recorder - Windows 10/11 x64',
             'echo Keep this file and ALL parts in the same folder.']
    lines += [f'if not exist "{name}" goto missing' for name in parts]
    lines += [f'copy /b /y {joined} "WebinarRecorder.zip" >nul',
              'if errorlevel 1 goto failed',
              'powershell.exe -NoProfile -Command "if ((Get-FileHash -LiteralPath \'WebinarRecorder.zip\' -Algorithm SHA256).Hash -ne \'' + digest.hexdigest() + '\') {exit 1}"',
              'if errorlevel 1 goto failed',
              'echo Extracting application. Please wait...',
              'powershell.exe -NoProfile -Command "Expand-Archive -LiteralPath \'WebinarRecorder.zip\' -DestinationPath \'WebinarRecorder-App\' -Force"',
              'if errorlevel 1 goto failed',
              'start "" "WebinarRecorder-App\\WebinarRecorder\\WebinarRecorder.exe"',
              'exit /b 0', ':missing',
              'echo Missing part. Download ALL WebinarRecorder.zip.00x files into this folder.',
              'pause', 'exit /b 1', ':failed',
              'echo Cannot extract. Check free disk space and download all parts again.',
              'pause', 'exit /b 1']
    (args.out / 'START-WINDOWS.cmd').write_bytes(('\r\n'.join(lines) + '\r\n').encode('ascii'))
    (args.out / 'HOW-TO-START.txt').write_text(
        f'Запись вебинара — Windows 10/11 x64\n\n'
        f'Скачайте {len(parts)} файла WebinarRecorder.zip.001 … .{len(parts):03} и START-WINDOWS.cmd\n'
        'в ОДНУ папку на компьютере. Запустите START-WINDOWS.cmd двойным щелчком.\n'
        'Он объединит части, проверит SHA256, распакует программу и запустит её.\n'
        'Python, Node.js, Chrome и 7-Zip устанавливать не нужно.\n'
        'Нужно около 1 ГБ свободного места для объединения и распаковки.\n\n'
        'При следующих запусках открывайте:\n'
        'WebinarRecorder-App\\WebinarRecorder\\WebinarRecorder.exe\n\n'
        'В программе вставьте ссылку на вебинар, откройте его, войдите на сайт,\n'
        'включите видео и нажмите «Начать запись». Окна можно сворачивать.\n'
        'В конце нажмите «Остановить и сохранить».\n\n'
        'Убедитесь, что имена частей не получили суффикс (1) при скачивании.\n'
        f'SHA256 полного ZIP: {digest.hexdigest()}\n', encoding='utf-8')
    print('Created',len(parts),'parts, launcher and instructions.')


if __name__ == '__main__':
    main()
