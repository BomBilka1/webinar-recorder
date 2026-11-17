const api = window.recorderApp;
const el = id => document.getElementById(id);
let busy = false, stream, recorder, pending = Promise.resolve(), failure,
  bytes = 0, queued = 0, timer, accumulated = 0, tick = 0, finishing = false;
const controls = ['url','open','mode','source','refresh','quality','audio','audio-scope','microphone','microphone-device','microphone-choose','format','split','schedule-start','schedule-end','duration','repair'];
const message = text => {el('notice').textContent = text || '';};
const status = text => {el('status').textContent = text;};
let updateState, sourceRequest = 0, loadingSources = false, capabilities = {},
  microphoneStream, recordingStream, audioContext, mix, sourceAnalyser, micAnalyser,
  monitorTimer, lastFrameHash, lastFrameChange = 0, windowMinimized = false,
  waiting = false, stopRequested = false, rotating = false, segmentOffset = 0,
  preparedResult, nativeAudioCursor = 0, hasStarted = false;
const elapsed = () => accumulated + (tick ? Date.now()-tick : 0);
function clock() {
  const seconds = Math.floor((accumulated + (tick ? Date.now() - tick : 0)) / 1000);
  el('timer').textContent = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map(n => String(n).padStart(2,'0')).join(':');
  el('size').textContent = `${(bytes / 1048576).toFixed(1)} МБ`;
  if(recorder?.state==='recording' && !stopRequested && !rotating && Number(el('split').value)>0 && elapsed()-segmentOffset>=Number(el('split').value)*60000) {
    rotating=true;recorder.stop();
  }
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
  el('audio-label').textContent = 'Записывать звук источника';
  const appOption=el('audio-scope').querySelector('[value="application"]');
  const systemOption=el('audio-scope').querySelector('[value="system"]');
  appOption.disabled=mode==='screen' || (mode==='window' && !capabilities.applicationAudio);
  appOption.textContent=mode==='webinar'?'Только встроенный вебинар':'Выбранное приложение';
  systemOption.disabled=api.platform!=='win32';
  if(el('audio-scope').selectedOptions[0]?.disabled)el('audio-scope').value=mode==='webinar'?'application':'system';
  el('audio-scope').disabled=busy || !el('audio').checked || unsupportedAudio;
  el('microphone-device').disabled=busy || !el('microphone').checked;
  el('audio-help').textContent=el('audio-scope').value==='application'
    ? (mode==='webinar'?'Звук выбранного встроенного окна.':'Windows 11: звук процесса и его дочерних процессов. У браузера — всех его вкладок.')
    : 'Включает звук других программ и уведомлений.';
  el('format').querySelector('[value="mp4"]').disabled=!capabilities.mp4;
  document.querySelectorAll('.history-entry button').forEach(button=>{button.disabled=busy;});
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
    el('mode').value = 'webinar';el('audio-scope').value='application';modeUI();
    if (api.platform !== 'win32') el('audio').checked = true;
    await refresh(id);
  } catch (error) {message(error.message);}
});
el('url').addEventListener('keydown', event => {if (event.key === 'Enter' && !busy) el('open').click();});
el('refresh').addEventListener('click', () => refresh());
el('mode').addEventListener('change', () => {
  el('audio-scope').value=el('mode').value==='webinar'?'application':'system';
  modeUI();
  el('audio').checked = el('mode').value === 'webinar' || api.platform === 'win32';
  refresh();
});
el('reveal').addEventListener('click', () => api.revealWebinar());
el('show').addEventListener('click', () => api.showFile());

function release() {
  if(tick) accumulated+=Date.now()-tick;
  tick=0;clearInterval(timer);clearInterval(monitorTimer);clock();
  stream?.getTracks().forEach(track=>track.stop());
  microphoneStream?.getTracks().forEach(track=>track.stop());
  recordingStream?.getTracks().forEach(track=>track.stop());
  stream=null;microphoneStream=null;recordingStream=null;
  audioContext?.close().catch(()=>{});audioContext=null;mix=null;
  sourceAnalyser=null;micAnalyser=null;
  el('monitor-video').srcObject=null;el('monitor').hidden=true;
  el('source-level').value=0;el('mic-level').value=0;
  el('dot').classList.remove('active');
}
function stop() {
  if(finishing || stopRequested)return;
  stopRequested=true;
  el('stop').disabled=true;el('pause').disabled=true;
  if(waiting){
    waiting=false;release();api.abort().then(()=>{status('Ожидание отменено');lock(false);}).catch(error=>{message(error.message);lock(false);});
    return;
  }
  status('Сохранение и подготовка перемотки…');
  if(recorder && recorder.state!=='inactive')recorder.stop();
  else if(!rotating)finish();
}
async function finish() {
  if(finishing)return;
  finishing=true;release();
  try {
    await pending;
    if(failure){
      const result=await api.abort();status('Запись прервана');
      message(`${failure.message}. Доступная часть: ${result?.path || 'смотрите историю записей'}. Используйте восстановление в разделе «Мои записи».`);
      el('show').hidden=!result?.bytes;
    }else{
      const result=await api.finish((elapsed()-segmentOffset)/1000);
      status('Запись сохранена');el('file').textContent=result.path;el('show').hidden=false;
      if(result.warning)message(`Исходное видео сохранено, но обработка не завершилась: ${result.warning}. Доступно восстановление в истории.`);
      else if(result.segments>1)message(`Сохранено частей: ${result.segments}. Все файлы доступны в истории.`);
    }
  }catch(error){status('Ошибка сохранения');message(`${error.message}. Исходные файлы остаются на диске; откройте историю для восстановления.`);}
  finally{lock(false);el('pause').disabled=true;el('stop').disabled=true;finishing=false;clock();refreshHistory();}
}
function makeRecorder() {
  const mimeType=['video/webm;codecs=vp8,opus','video/webm'].find(type=>MediaRecorder.isTypeSupported(type));
  if(!mimeType)throw new Error('Видеокодек WebM недоступен');
  const current=new MediaRecorder(recordingStream,{mimeType,videoBitsPerSecond:Number(el('quality').value),audioBitsPerSecond:128000});
  recorder=current;
  current.addEventListener('dataavailable',event=>{
    if(!event.data.size || failure)return;
    queued+=event.data.size;
    if(queued>64*1048576){failure=new Error('Диск не успевает сохранять видео');stop();return;}
    pending=pending.then(async()=>{if(!failure)bytes=await api.write(await event.data.arrayBuffer());})
      .catch(error=>{failure=error;stop();}).finally(()=>{queued-=event.data.size;});
  });
  current.addEventListener('stop',()=>{
    if(rotating && !stopRequested && !failure){
      const duration=(elapsed()-segmentOffset)/1000;segmentOffset=elapsed();
      pending=pending.then(()=>api.rotate(duration)).then(result=>{el('file').textContent=`Часть ${result.number}: ${result.partial}`;})
        .catch(error=>{failure=error;stop();});
      rotating=false;
      try{makeRecorder();}catch(error){failure=error;stop();}
    }else{rotating=false;finish();}
  });
  current.addEventListener('error',event=>{failure=event.error||new Error('Ошибка видеозаписи');stop();});
  current.start(1000);
}
function beginRecording() {
  if(!busy || stopRequested || finishing || hasStarted)return;
  hasStarted=true;
  waiting=false;tick=Date.now();segmentOffset=0;
  try{makeRecorder();}catch(error){failure=error;stop();return;}
  timer=setInterval(clock,500);status('Идёт запись — программу можно свернуть');
  el('dot').classList.add('active');el('pause').disabled=false;el('pause').textContent='Пауза';
  el('stop').disabled=false;el('stop').textContent='Остановить и сохранить';
}
function connectAudio(mediaStream,kind) {
  if(!mediaStream?.getAudioTracks().length)return;
  const node=audioContext.createMediaStreamSource(mediaStream),analyser=audioContext.createAnalyser();analyser.fftSize=256;
  node.connect(analyser);const gain=audioContext.createGain();gain.gain.value=(el('microphone').checked && el('audio').checked) ? .75 : 1;
  analyser.connect(gain);gain.connect(mix);
  if(kind==='source')sourceAnalyser=analyser;else micAnalyser=analyser;
}
function sampleLevel(analyser,id) {
  if(!analyser){el(id).value=0;return;}
  const values=new Float32Array(analyser.fftSize);analyser.getFloatTimeDomainData(values);
  let sum=0;for(const value of values)sum+=value*value;
  el(id).value=Math.min(1,Math.sqrt(sum/values.length)*3);
}
function captureWarning(text='') {
  el('capture-warning').textContent=windowMinimized
    ? 'Выбранное окно свёрнуто: приложение может перестать отдавать кадры. Разверните его или используйте режим встроенного вебинара.' : text;
}
async function monitorCapture() {
  const video=el('monitor-video');video.srcObject=new MediaStream(stream.getVideoTracks());
  await video.play();el('monitor').hidden=false;lastFrameHash=null;lastFrameChange=Date.now();windowMinimized=false;
  const ctx=el('monitor').getContext('2d',{willReadFrequently:true});
  monitorTimer=setInterval(()=>{
    sampleLevel(sourceAnalyser,'source-level');sampleLevel(micAnalyser,'mic-level');
    if(recorder?.state!=='recording'){captureWarning(waiting?'Ожидание начала записи. Компьютер должен оставаться включённым.':'');return;}
    try{
      ctx.drawImage(video,0,0,160,90);const data=ctx.getImageData(0,0,160,90).data;
      let hash=2166136261;for(let i=0;i<data.length;i+=16)hash=Math.imul(hash^data[i],16777619);
      if(hash!==lastFrameHash){lastFrameHash=hash;lastFrameChange=Date.now();}
      captureWarning(Date.now()-lastFrameChange>20000?'Кадр не меняется более 20 секунд. Это может быть неподвижный слайд; проверьте воспроизведение и окно источника.':'');
    }catch{captureWarning('Предпросмотр недоступен. Проверьте окно источника.');}
  },500);
}
api.onApplicationAudio(data=>{
  api.audioAck(data.byteLength).catch(()=>{});
  if(!audioContext || !mix)return;
  const pcm=new DataView(data),frames=Math.floor(data.byteLength/4);
  if(!frames)return;
  // Bounded scheduling: never accumulate old audio indefinitely after a stall.
  if(nativeAudioCursor>audioContext.currentTime+1){message('Обработка звука не успевает за записью. Сохраняю доступную часть.');stop();return;}
  const buffer=audioContext.createBuffer(2,frames,44100);
  for(let channel=0;channel<2;channel++){const values=buffer.getChannelData(channel);for(let i=0;i<frames;i++)values[i]=pcm.getInt16(i*4+channel*2,true)/32768;}
  const source=audioContext.createBufferSource();source.buffer=buffer;source.connect(sourceAnalyser);
  nativeAudioCursor=Math.max(nativeAudioCursor,audioContext.currentTime+.03);source.start(nativeAudioCursor);nativeAudioCursor+=buffer.duration;
});
el('start').addEventListener('click',async()=>{
  if(busy || loadingSources)return;
  lock(true);message('');failure=null;pending=Promise.resolve();recorder=null;preparedResult=null;
  bytes=0;queued=0;accumulated=0;tick=0;segmentOffset=0;stopRequested=false;rotating=false;hasStarted=false;clock();
  el('show').hidden=true;el('capture-warning').textContent='';el('disk').textContent='';
  let prepared=false;
  try{
    if(!el('source').value)throw new Error('Откройте вебинар или выберите источник записи');
    status('Выберите файл для записи');
    preparedResult=await api.prepare({mode:el('mode').value,browserId:Number(el('source').value),sourceId:el('source').value,
      audio:el('audio').checked,audioScope:el('audio-scope').value,microphone:el('microphone').checked,
      format:el('format').value,splitMinutes:Number(el('split').value),
      startAt:el('schedule-start').value?new Date(el('schedule-start').value).getTime():undefined,
      endAt:el('schedule-end').value?new Date(el('schedule-end').value).getTime():undefined,durationMinutes:Number(el('duration').value)});
    if(!preparedResult){status('Запись отменена');lock(false);return;}
    prepared=true;el('file').textContent=`В процессе: ${preparedResult.partial}`;
    stream=await navigator.mediaDevices.getDisplayMedia({video:{width:{ideal:1920},height:{ideal:1080},frameRate:{ideal:25,max:30}},audio:el('audio').checked && !preparedResult.applicationAudio});
    if(el('audio').checked && !preparedResult.applicationAudio && !stream.getAudioTracks().length)throw new Error('Источник не предоставил звук. Включите воспроизведение или отключите звук источника');
    if(el('microphone').checked){
      microphoneStream=await navigator.mediaDevices.getUserMedia({audio:el('microphone-device').value?{deviceId:{exact:el('microphone-device').value}}:true,video:false});
      microphoneStream.getAudioTracks()[0].addEventListener('ended',()=>{message('Микрофон отключился. Сохраняю доступную часть.');stop();});
    }
    if(el('audio').checked || microphoneStream){
      audioContext=new AudioContext({sampleRate:48000});await audioContext.resume();mix=audioContext.createMediaStreamDestination();
      connectAudio(stream,'source');connectAudio(microphoneStream,'mic');
      if(preparedResult.applicationAudio){
        sourceAnalyser=audioContext.createAnalyser();sourceAnalyser.fftSize=256;sourceAnalyser.connect(mix);nativeAudioCursor=audioContext.currentTime;
        await api.applicationAudio();
      }
    }
    recordingStream=new MediaStream([...stream.getVideoTracks(),...(mix?mix.stream.getAudioTracks():[])]);
    stream.getVideoTracks()[0].addEventListener('ended',()=>{message('Источник захвата отключился. Сохраняю доступную часть.');stop();});
    stream.getVideoTracks()[0].addEventListener('mute',()=>captureWarning('Источник временно перестал отдавать кадры. Проверьте его окно.'));
    await monitorCapture();
    const result=await api.captureReady();
    waiting=true;el('stop').disabled=false;el('stop').textContent='Отменить ожидание';
    status(`Ожидание начала: ${new Date(result.startAt).toLocaleString()}`);
    if(!result.waiting)beginRecording();
  }catch(error){release();if(prepared)await api.abort().catch(()=>{});status('Запись не началась');message(error.message);lock(false);refreshHistory();}
});
el('stop').addEventListener('click',stop);
el('pause').addEventListener('click',()=>{
  if(rotating || stopRequested)return;
  if(recorder?.state==='recording'){
    recorder.pause();accumulated+=Date.now()-tick;tick=0;el('pause').textContent='Продолжить';status('Пауза');
  }else if(recorder?.state==='paused'){
    recorder.resume();tick=Date.now();lastFrameChange=Date.now();el('pause').textContent='Пауза';status('Идёт запись — программу можно свернуть');
  }clock();
});
for(const id of ['audio','audio-scope','microphone'])el(id).addEventListener('change',()=>modeUI());
el('microphone-choose').addEventListener('click',async()=>{
  if(busy)return;
  let testStream;
  try {
    if(!await api.microphoneAccess(true))return;
    testStream=await navigator.mediaDevices.getUserMedia({audio:true,video:false});
    const devices=await navigator.mediaDevices.enumerateDevices();
    const previous=el('microphone-device').value;el('microphone-device').replaceChildren();
    const option=document.createElement('option');option.value='';option.textContent='По умолчанию';el('microphone-device').append(option);
    for(const device of devices.filter(d=>d.kind==='audioinput' && d.deviceId)){
      const option=document.createElement('option');option.value=device.deviceId;option.textContent=device.label||`Микрофон ${el('microphone-device').options.length}`;el('microphone-device').append(option);
    }
    if([...el('microphone-device').options].some(o=>o.value===previous))el('microphone-device').value=previous;
    el('microphone').checked=true;modeUI();message('Выберите микрофон в списке. Он будет записываться только после начала записи.');
  }catch(error){message(`Микрофон: ${error.message}`);}
  finally{testStream?.getTracks().forEach(track=>track.stop());await api.microphoneAccess(false);}
});
api.onNotice(message);
api.onSourceEnded(()=>{message('Страница вебинара завершила работу. Сохраняю доступную часть.');stop();});
api.onScheduleStart(beginRecording);api.onScheduleStop(stop);
api.onLowDisk(()=>{message('Место на диске заканчивается. Останавливаю запись и сохраняю доступную часть.');stop();});
api.onDisk(data=>{el('disk').textContent=`Свободно на диске: ${(data.free/1073741824).toFixed(1)} ГБ`;});
api.onDiskWarning(()=>{el('disk').textContent='Не удалось проверить свободное место на диске';});
api.onWindowState(state=>{windowMinimized=state.minimized;captureWarning();if(!state.valid){message('Выбранное окно закрыто. Сохраняю запись.');stop();}});
api.onProcessingError(error=>{message(`Ошибка обработки: ${error.message}. Сохраняю доступную часть.`);stop();});
api.onAudioEnded(()=>{message('Захват звука приложения прервался. Сохраняю доступную часть.');stop();});
api.onProcessing(data=>{if(busy && (finishing || !recorder || recorder.state==='inactive'))status(`${data.label || 'Обработка видео'}${data.number?` · часть ${data.number}`:''}${data.percent!=null?` · ${data.percent}%`:''}…`);});
async function repairRecording(id,index){
  if(busy)return;
  lock(true);status('Восстановление видео…');message('');
  try{
    const result=await api.repair(id,index);
    if(result){status('Восстановленная копия сохранена');el('file').textContent=result.path;el('show').hidden=false;}
    else status('Восстановление отменено');
  }catch(error){status('Ошибка восстановления');message(error.message);}
  finally{lock(false);refreshHistory();}
}
el('repair').addEventListener('click',()=>repairRecording());
el('history-refresh').addEventListener('click',()=>refreshHistory());
api.onHistory(()=>refreshHistory());
let historyRequest=0;
async function refreshHistory(){
  const request=++historyRequest;
  try{
    const entries=await api.history();if(request!==historyRequest)return;
    const list=el('history-list');list.replaceChildren();
    const interrupted=entries.filter(e=>['interrupted','error'].includes(e.status));
    el('recovery-notice').textContent=interrupted.length?`Есть незавершённые записи: ${interrupted.length}. Нажмите «Восстановить» у нужного файла — исходник останется на месте.`:'';
    if(!entries.length){const p=document.createElement('p');p.className='hint';p.textContent='Здесь появятся ваши записи. Старый файл можно добавить через восстановление.';list.append(p);}
    const labels={completed:'Сохранено',recording:'Записывается',waiting:'Ожидание',processing:'Обрабатывается',interrupted:'Нужно восстановить',error:'Нужно проверить',cancelled:'Отменено'};
    for(const entry of entries.filter(e=>e.status!=='cancelled')){
      const card=document.createElement('div');card.className='history-entry';
      const title=document.createElement('strong');title.textContent=`${new Date(entry.created).toLocaleString()} · ${labels[entry.status]||entry.status}`;card.append(title);
      const info=document.createElement('p');info.className='hint';info.textContent=`${new Date((entry.duration||entry.segments.reduce((n,s)=>n+(s.duration||0),0))*1000).toISOString().slice(11,19)} · ${(entry.segments.reduce((n,s)=>n+(s.bytes||0),0)/1048576).toFixed(1)} МБ`;card.append(info);
      entry.segments.forEach((segment,index)=>{
        const name=document.createElement('p');name.className='history-file';name.textContent=segment.path || segment.partial;card.append(name);
        if(segment.error){const warning=document.createElement('p');warning.className='warning';warning.textContent=segment.error;card.append(warning);}
        const row=document.createElement('div');row.className='row';
        for(const [label,action] of [['Открыть','play'],['Папка','folder'],['Восстановить','repair']]){
          const button=document.createElement('button');button.textContent=label;button.disabled=busy;
          button.onclick=()=>action==='repair'?repairRecording(entry.id,index):api.historyOpen(entry.id,index,action).catch(e=>message(e.message));row.append(button);
        }card.append(row);
      });list.append(card);
    }
  }catch(error){el('recovery-notice').textContent=error.message;}
}
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
api.capabilities().then(value=>{capabilities=value;modeUI();}).catch(error=>message(error.message));
refresh();refreshHistory();
