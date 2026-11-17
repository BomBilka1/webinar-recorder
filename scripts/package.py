"""Build a portable desktop distribution without installing Node on the user's PC.

Uses the official, SHA256-verified Electron release. Never includes user profiles,
test output, recordings, node_modules, .git, or local configuration.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--platform', choices=['win32', 'linux'], default='win32')
    parser.add_argument('--out', type=Path, default=ROOT / 'dist')
    args = parser.parse_args()
    tools = []
    if args.platform == 'win32':
        tools = [(ROOT / 'node_modules/ffmpeg-static/ffmpeg.exe', 'ffmpeg.exe'),
                 (ROOT / 'node_modules/ffmpeg-static/ffmpeg.exe.LICENSE', 'FFMPEG-LICENSE.txt'),
                 (ROOT / 'node_modules/ffmpeg-static/ffmpeg.exe.README', 'FFMPEG-README.txt'),
                 (ROOT / 'native/build/Release/recorder-windows.exe', 'recorder-windows.exe')]
        if any(not file.is_file() for file, _ in tools):
            raise RuntimeError('Build Windows tools first: npm ci; cmake -S native -B native/build -A x64; cmake --build native/build --config Release')
    package = json.loads((ROOT / 'package.json').read_text())
    version = package['devDependencies']['electron']
    artifact = f'electron-v{version}-{args.platform}-x64.zip'
    base = f'https://github.com/electron/electron/releases/download/v{version}'
    args.out.mkdir(parents=True, exist_ok=True)
    destination = args.out / f'WebinarRecorder-{package["version"]}-{args.platform}-x64.zip'
    building = destination.with_suffix('.zip.building')
    print(f'Downloading {artifact}', flush=True)
    with tempfile.TemporaryDirectory(prefix='webinar-package-') as temporary:
        archive = Path(temporary) / artifact
        with urllib.request.urlopen(f'{base}/{artifact}', timeout=120) as response, archive.open('wb') as output:
            shutil.copyfileobj(response, output, length=1024 * 1024)
        with urllib.request.urlopen(f'{base}/SHASUMS256.txt', timeout=60) as response:
            checksums = response.read().decode()
        expected = next(line.split()[0] for line in checksums.splitlines()
                        if line.split() and line.split()[-1].lstrip('*') == artifact)
        digest = hashlib.sha256()
        with archive.open('rb') as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b''):
                digest.update(chunk)
        if digest.hexdigest() != expected:
            raise RuntimeError('Electron archive checksum mismatch')
        print('Checksum verified; packaging app', flush=True)
        prefix = 'WebinarRecorder/'
        with zipfile.ZipFile(archive) as original, zipfile.ZipFile(building, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as bundle:
            for item in original.infolist():
                if item.filename == 'resources/default_app.asar':
                    continue
                old_name = item.filename
                new_name = 'WebinarRecorder.exe' if old_name == 'electron.exe' else ('WebinarRecorder' if old_name == 'electron' else old_name)
                item.filename = prefix + new_name
                with original.open(old_name) as source, bundle.open(item, 'w') as output:
                    shutil.copyfileobj(source, output, length=1024 * 1024)
            app_package = {key: package[key] for key in ['name', 'version', 'main', 'productName']}
            bundle.writestr(prefix + 'resources/app/package.json', json.dumps(app_package))
            for file in sorted((ROOT / 'desktop').rglob('*')):
                if file.is_file():
                    bundle.write(file, prefix + 'resources/app/' + file.relative_to(ROOT).as_posix())
            for file, name in tools:
                bundle.write(file, prefix + 'resources/bin/' + name)
            bundle.write(ROOT / 'THIRD_PARTY.txt', prefix + 'THIRD-PARTY.txt')
            bundle.write(ROOT / 'USER_GUIDE.txt', prefix + 'READ-ME.txt')
        building.replace(destination)
        print(f'Built: {destination} ({destination.stat().st_size / 1048576:.1f} MB)', flush=True)
        print('SHA256:', hashlib.sha256(destination.read_bytes()).hexdigest())


if __name__ == '__main__':
    main()
