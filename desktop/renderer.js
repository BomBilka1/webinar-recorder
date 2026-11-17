const api = window.recorderApp;
const el = id => document.getElementById(id);
let busy = false, stream, recorder, pending = Promise.resolve(), failure,
  bytes = 0, queued = 0, timer, accumulated = 0, tick = 0, finishing = false;
const controls = ['url','open','mode','source','refresh','quality','audio'];
const message = text => {el('notice').textContent = text || '';};
const status = text => {el('status').textContent = text;};
let updateState, sourceRequest = 0, loadingSources = false;
function clock() {
  const seconds = Math.floor((accumulated + (tick ? Date.now() - tick : 0)) / 1000);
  el('timer').textContent = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map(n => String(n).padStart(2,'0')).join(':');
  el('size').textContent = `${(bytes / 1048576).toFixed(1)} МБ`;
}
function modeUI() {
  const mode = el('mode').value;
  el('webinar-controls').hidden = mode !== 'webinar';
  el('hint').textContent = mode === 'webinar'
    ? 'Войдите на сайт и запустите видео. Встроенное окно можно сворачивать во время записи.'
    : mode === 'window'
      ? 'Выберите окно приложения по названию или миниатюре. Свёрнутое стороннее окно может не обновлять видео. Звук — всей системы.'
      : 'Выберите монитор. Записывается всё, что на нём видно, включая другие окна и уведомления. Звук — всей системы.';
  const unsupportedAudio = mode !== 'webinar' && api.platform !== 'win32';
  el('audio').disabled = busy || unsupportedAudio;
  if (unsupportedAudio) el('audio').checked = false;
  el('audio-label').textContent = mode === 'webinar' ? 'Звук вебинара' : 'Звук всей системы';
}
function renderSelection() {
  const value = el('source').value;
  el('selected-source').textContent = value
    ? `Будет записано: ${el('source').selectedOptions[0].textContent}` : 'Выберите источник записи';
  for (const card of el('source-grid').querySelectorAll('button')) {
    card.setAttribute('aria-pressed',String(card.dataset.sourceId === value));
    card.disabled = busy || loadingSources;
  }
  el('start').disabled = busy || loadingSources || !value || updateState?.phase === 'installing';
}
function lock(value) {
  busy = value;
  controls.forEach(id => {el(id).disabled = value;});
  el('refresh').disabled = value || loadingSources;
  el('source').disabled = value || loadingSources;
  modeUI();
  if (updateState) showUpdate(updateState);
  renderSelection();
}
function placeholder(text) {
  const option = document.createElement('option');option.value = '';option.textContent = text;
  el('source').replaceChildren(option);
}
async function refresh(preferred) {
  if (busy) return;
  const request = ++sourceRequest;
  const mode = el('mode').value;
  const current = preferred ?? el('source').value;
  loadingSources = true;
  placeholder('Поиск источников…');el('source-grid').replaceChildren();lock(false);
  try {
    const sources = await api.sources(mode);
    if (request !== sourceRequest || mode !== el('mode').value) return;
    const items = mode === 'webinar' ? sources.browsers : sources.external;
    placeholder(items.length ? (mode === 'window' ? 'Выберите окно приложения' : mode === 'screen' ? 'Выберите монитор' : 'Выберите окно вебинара')
      : mode === 'webinar' ? 'Сначала откройте вебинар' : 'Источники не найдены — откройте окно и нажмите ↻');
    for (const source of items) {
      const option = document.createElement('option');option.value = source.id;option.textContent = source.name;
      el('source').append(option);
      if (mode !== 'webinar') {
        const card = document.createElement('button');card.type = 'button';card.className = 'source-card';
        card.dataset.sourceId = source.id;card.setAttribute('aria-label',source.name);
        if (source.thumbnail) {
          const image = document.createElement('img');image.className = 'preview';image.alt = '';image.src = source.thumbnail;card.append(image);
        } else {
          const empty = document.createElement('span');empty.className = 'empty-preview';empty.textContent = 'Нет миниатюры';card.append(empty);
        }
        const name = document.createElement('span');name.className = 'source-name';name.textContent = source.name;name.title = source.name;
        if (source.icon) {const icon=document.createElement('img');icon.className='app-icon';icon.alt='';icon.src=source.icon;name.prepend(icon);}
        card.append(name);
        card.addEventListener('click', () => {if (!busy) {el('source').value = source.id;renderSelection();}});
        el('source-grid').append(card);
      }
    }
    if (items.some(source => String(source.id) === String(current))) el('source').value = current;
    else if (mode === 'webinar' && items.length) el('source').value = items[0].id;
  } catch (error) {
    if (request === sourceRequest) {placeholder('Не удалось получить источники. Нажмите ↻');message(error.message);}
  } finally {
    if (request === sourceRequest) {loadingSources = false;lock(busy);}
  }
}
el('source').addEventListener('change',renderSelection);
el('open').addEventListener('click', async () => {
  try {
    message('');
    const id = await api.openWebinar(el('url').value.trim());
    el('mode').value = 'webinar';modeUI();
    if (api.platform !== 'win32') el('audio').checked = true;
    await refresh(id);
  } catch (error) {message(error.message);}
});
el('url').addEventListener('keydown', event => {if (event.key === 'Enter' && !busy) el('open').click();});
el('refresh').addEventListener('click', () => refresh());
el('mode').addEventListener('change', () => {
  modeUI();
  el('audio').checked = el('mode').value === 'webinar' || api.platform === 'win32';
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
    status('Сохранение и подготовка перемотки…');
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
  if (busy || loadingSources) return;
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
function showUpdate(state) {
  updateState = state;
  el('version').textContent = `Версия ${state.currentVersion}`;
  el('update-status').textContent = state.message +
    (state.phase === 'downloading' ? ` ${state.percent || 0}%` : '');
  el('check-update').disabled = ['unsupported','checking','downloading','downloaded','installing'].includes(state.phase);
  el('install-update').hidden = state.phase !== 'downloaded';
  el('install-update').disabled = busy;
  renderSelection();
}
api.onUpdate(showUpdate);
api.updateState().then(showUpdate).catch(() => {el('update-status').textContent = 'Проверка обновлений недоступна';});
el('check-update').addEventListener('click', () => api.checkUpdates().then(showUpdate).catch(error => message(error.message)));
el('install-update').addEventListener('click', () => api.installUpdate().catch(error => message(error.message)));
refresh();
