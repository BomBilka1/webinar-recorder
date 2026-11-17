const api = window.recorderApp;
const el = id => document.getElementById(id);
let busy = false, stream, recorder, pending = Promise.resolve(), failure,
  bytes = 0, queued = 0, timer, accumulated = 0, tick = 0, finishing = false;
const controls = ['url','open','mode','source','refresh','quality','audio'];
const message = text => {el('notice').textContent = text || '';};
const status = text => {el('status').textContent = text;};
function clock() {
  const seconds = Math.floor((accumulated + (tick ? Date.now() - tick : 0)) / 1000);
  el('timer').textContent = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map(n => String(n).padStart(2,'0')).join(':');
  el('size').textContent = `${(bytes / 1048576).toFixed(1)} МБ`;
}
function lock(value) {
  busy = value;
  controls.forEach(id => {el(id).disabled = value;});
  el('start').disabled = value;
  if (!value && el('mode').value === 'desktop' && api.platform !== 'win32') el('audio').disabled = true;
}
async function refresh(preferred) {
  try {
    const current = preferred || el('source').value;
    const mode = el('mode').value;
    const sources = await api.sources(mode);
    el('source').replaceChildren();
    for (const source of mode === 'webinar' ? sources.browsers : sources.external) {
      const option = document.createElement('option'); option.value = source.id; option.textContent = source.name;
      el('source').append(option);
    }
    if ([...el('source').options].some(option => option.value === String(current))) el('source').value = current;
    if (!el('source').options.length) {
      const option = document.createElement('option'); option.value = '';
      option.textContent = mode === 'webinar' ? 'Сначала откройте вебинар' : 'Нет доступных источников';
      el('source').append(option);
    }
  } catch (error) {message(error.message);}
}
el('open').addEventListener('click', async () => {
  try {
    message('');
    const id = await api.openWebinar(el('url').value.trim());
    el('mode').value = 'webinar';
    await refresh(id);
  } catch (error) {message(error.message);}
});
el('url').addEventListener('keydown', event => {if (event.key === 'Enter' && !busy) el('open').click();});
el('refresh').addEventListener('click', () => refresh());
el('mode').addEventListener('change', () => {
  el('hint').textContent = el('mode').value === 'webinar'
    ? 'Войдите на сайт и запустите видео. Для нового окна обновите список источников.'
    : 'Запись экрана содержит всё, что на нём видно. Свёрнутое стороннее окно может не обновляться. Звук здесь — всей системы, поддерживается в Windows.';
  el('audio').disabled = el('mode').value === 'desktop' && api.platform !== 'win32';
  if (el('audio').disabled) el('audio').checked = false;
  refresh();
});
el('reveal').addEventListener('click', () => api.revealWebinar());
el('show').addEventListener('click', () => api.showFile());
function release() {
  if (tick) accumulated += Date.now() - tick;
  tick = 0;
  clearInterval(timer);
  clock();
  stream?.getTracks().forEach(track => track.stop());
  stream = null;
  el('dot').classList.remove('active');
}
function stop() {
  if (recorder && recorder.state !== 'inactive') {
    status('Сохранение файла…');
    el('stop').disabled = true;
    el('pause').disabled = true;
    recorder.stop();
  }
}
async function finish() {
  if (finishing) return;
  finishing = true;
  release();
  try {
    await pending;
    if (failure) {
      const result = await api.abort();
      status('Запись прервана');
      message(`${failure.message}. Доступная часть: ${result?.path || 'не сохранена'}. Файл .partial можно попробовать открыть в VLC.`);
      el('show').hidden = !result?.bytes;
    } else {
      const result = await api.finish();
      status('Запись сохранена');
      el('file').textContent = result.path;
      el('show').hidden = false;
    }
  } catch (error) {
    status('Ошибка сохранения');
    message(`${error.message}. Проверьте оставшийся файл .partial в выбранной папке.`);
  } finally {
    lock(false);
    el('pause').disabled = true;
    el('stop').disabled = true;
    finishing = false;
    clock();
  }
}
el('start').addEventListener('click', async () => {
  if (busy) return;
  lock(true); message(''); failure = null; pending = Promise.resolve();
  bytes = 0; queued = 0; accumulated = 0; tick = 0; clock();
  el('show').hidden = true;
  let prepared = false;
  try {
    if (!el('source').value) throw new Error('Откройте вебинар или выберите источник записи');
    const mimeType = ['video/webm;codecs=vp8,opus','video/webm'].find(type => MediaRecorder.isTypeSupported(type));
    if (!mimeType) throw new Error('Видеокодек WebM недоступен');
    status('Выберите файл для записи');
    const result = await api.prepare({mode:el('mode').value, browserId:Number(el('source').value),
      sourceId:el('source').value, audio:el('audio').checked});
    if (!result) {status('Запись отменена');lock(false);return;}
    prepared = true;
    el('file').textContent = `В процессе: ${result.partial}`;
    stream = await navigator.mediaDevices.getDisplayMedia({
      video:{width:{ideal:1920},height:{ideal:1080},frameRate:{ideal:25,max:30}},
      audio:el('audio').checked
    });
    if (el('audio').checked && !stream.getAudioTracks().length)
      throw new Error('Источник не предоставил звук. Включите воспроизведение и повторите, либо снимите галочку «Записывать звук»');
    recorder = new MediaRecorder(stream,{mimeType,videoBitsPerSecond:Number(el('quality').value),audioBitsPerSecond:128000});
    recorder.addEventListener('dataavailable', event => {
      if (!event.data.size || failure) return;
      queued += event.data.size;
      if (queued > 64 * 1048576) {failure = new Error('Диск не успевает сохранять видео');stop();return;}
      pending = pending.then(async () => {
        if (failure) return;
        bytes = await api.write(await event.data.arrayBuffer());
      }).catch(error => {failure = error;stop();}).finally(() => {queued -= event.data.size;});
    });
    recorder.addEventListener('stop', finish);
    recorder.addEventListener('error', event => {
      failure = event.error || new Error('Ошибка видеозаписи');
      if (recorder.state === 'inactive') finish(); else stop();
    });
    stream.getVideoTracks()[0].addEventListener('ended', () => {
      message('Источник захвата отключился. Доступная часть будет сохранена.');stop();
    });
    recorder.start(1000);
    tick = Date.now();timer = setInterval(clock,500);
    status('Идёт запись — программу можно свернуть');
    el('dot').classList.add('active');
    el('pause').textContent = 'Пауза';
    el('pause').disabled = false;el('stop').disabled = false;
  } catch (error) {
    release();
    if (prepared) await api.abort().catch(() => {});
    status('Запись не началась');message(error.message);lock(false);
  }
});
el('stop').addEventListener('click',stop);
el('pause').addEventListener('click', () => {
  if (recorder?.state === 'recording') {
    recorder.pause();accumulated += Date.now() - tick;tick = 0;
    el('pause').textContent = 'Продолжить';status('Пауза');
  } else if (recorder?.state === 'paused') {
    recorder.resume();tick = Date.now();
    el('pause').textContent = 'Пауза';status('Идёт запись — программу можно свернуть');
  }
  clock();
});
api.onNotice(message);
api.onSourceEnded(() => {message('Страница вебинара завершила работу. Сохраняю доступную часть.');stop();});
refresh();
