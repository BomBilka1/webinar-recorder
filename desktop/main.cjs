const {app, BrowserWindow, ipcMain, dialog, session, desktopCapturer,
  powerSaveBlocker, shell, Tray, Menu, nativeImage, screen} = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const {RecordingLibrary} = require('./recording-library.cjs');
const {RecordingSession} = require('./recording-session.cjs');
const {MediaTools} = require('./media-tools.cjs');
const {Schedule,planTimes} = require('./schedule.cjs');
const {WindowsCapture} = require('./windows-capture.cjs');
const {UpdateManager} = require('./update-manager.cjs');
const {existsSync} = require('node:fs');
const {captureTypes,selectSource,describeSources} = require('./capture-sources.cjs');

// Capturing a webContents keeps rendering independent of the desktop window.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
let audioOutstanding=0;
let control, webinar, tray, file, selection, power, lastFile, preparing = false, paintTimer, updates, schedule, timing, library, media, nativeCapture, maintenance = false, microphoneSetupUntil = 0;
const browsers = new Set();
const isTest = process.env.WEBINAR_TEST === '1' && !app.isPackaged;
if (isTest && process.env.WEBINAR_TEST_PROFILE) app.setPath('userData', process.env.WEBINAR_TEST_PROFILE);

function notice(message) { control?.webContents.send('notice', message); }
function busy() { return Boolean(file) || preparing || maintenance; }
function validateURL(value) {
  const url = new URL(String(value));
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Укажите ссылку http:// или https://');
  return url.href;
}
function remoteOptions() {
  return {width:1280, height:800, title:'Вебинар', backgroundColor:'#ffffff',
    autoHideMenuBar:true, webPreferences:{partition:'persist:webinars', nodeIntegration:false,
      contextIsolation:true, sandbox:true, backgroundThrottling:false}};
}
function leaveFullscreen(win) {
  if(win.isDestroyed())return;
  // The page may be fullscreen in a nested player iframe. Exiting at the top
  // document clears the entire fullscreen chain without accessing iframe data.
  return win.webContents.executeJavaScript('document.fullscreenElement ? document.exitFullscreen() : false')
    .catch(()=>{}).finally(()=>{if(!win.isDestroyed() && win.isFullScreen())win.setFullScreen(false);});
}
function watchBrowser(win) {
  browsers.add(win);
  win.webContents.setBackgroundThrottling(false);
  win.webContents.on('before-input-event', (event,input) => {
    if(input.type==='keyDown' && input.key==='F11' && !input.isAutoRepeat) {
      event.preventDefault();
      if(win.isFullScreen())leaveFullscreen(win);else win.setFullScreen(true);
    } else if(input.type==='keyDown' && input.key==='Escape' && !input.isAutoRepeat) {
      leaveFullscreen(win);
    }
  });
  win.webContents.on('will-navigate', (event, url) => {
    try { validateURL(url); } catch { event.preventDefault(); }
  });
  win.webContents.setWindowOpenHandler(({url}) => {
    try { validateURL(url); } catch { return {action:'deny'}; }
    return {action:'allow', overrideBrowserWindowOptions:remoteOptions()};
  });
  win.webContents.on('did-create-window', child => watchBrowser(child));
  win.webContents.on('render-process-gone', () => {
    if (selection?.browserId === win.id) control?.webContents.send('source-ended');
  });
  win.webContents.on('did-fail-load', (_event, code, description, _url, main) => {
    if (main && code !== -3) notice(`Страница вебинара: ${description}. Проверьте ссылку и соединение.`);
  });
  win.on('close', event => {
    if (busy() && selection?.browserId === win.id) {
      event.preventDefault(); win.minimize();
      notice('Окно вебинара свёрнуто. Сначала завершите запись, затем закройте его.');
    }
  });
  win.on('closed', () => { browsers.delete(win); if (webinar === win) webinar = null; });
}
function checkSender(event) {
  if (!control || event.sender !== control.webContents || event.senderFrame !== control.webContents.mainFrame)
    throw new Error('Недопустимый запрос');
}
function handle(name, fn) {
  ipcMain.handle(name, async (event, ...args) => { checkSender(event); return fn(...args); });
}
function releasePower() {
  clearInterval(paintTimer);
  schedule?.dispose();schedule=null;nativeCapture?.stop();
  if (power !== undefined && powerSaveBlocker.isStarted(power)) powerSaveBlocker.stop(power);
  power = undefined;
}
function restore() { control.show(); control.restore(); control.focus(); }

if(isTest || app.requestSingleInstanceLock()) {
app.on('second-instance',()=>{if(control && !control.isDestroyed())restore();});
app.whenReady().then(async () => {
  control = new BrowserWindow({width:920,height:900,minWidth:700,minHeight:700,
    title:'Запись вебинара',backgroundColor:'#101522',autoHideMenuBar:true,
    webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,
      sandbox:true,nodeIntegration:false,backgroundThrottling:false}});
  control.webContents.on('will-navigate', event => event.preventDefault());
  control.webContents.setWindowOpenHandler(() => ({action:'deny'}));
  control.on('close', event => {
    if (busy()) {
      event.preventDefault(); restore(); notice('Нажмите «Остановить и сохранить», затем закройте программу.');
    }
  });
  control.on('closed', () => { for (const win of browsers) win.destroy(); app.quit(); });
  control.webContents.on('render-process-gone', async () => {
    releasePower();
    if (file) { const current = file; file = null; await current.abort().catch(() => {}); }
    releasePower(); app.quit();
  });
  const binary=process.platform==='win32' ? (app.isPackaged?path.join(process.resourcesPath,'bin','ffmpeg.exe'):path.join(__dirname,'../node_modules/ffmpeg-static/ffmpeg.exe')) : '/usr/bin/ffmpeg';
  const nativeBinary=app.isPackaged ? path.join(process.resourcesPath,'bin','recorder-windows.exe') : path.join(__dirname,'../native/build/Release/recorder-windows.exe');
  const nativeAvailable=process.platform==='win32' && existsSync(nativeBinary);
  nativeCapture=new WindowsCapture(nativeAvailable?nativeBinary:null);
  library=new RecordingLibrary(path.join(app.getPath('userData'),'recordings.json'));
  await library.load();
  const notify=(name,data)=>control?.webContents.send(name,data);
  media=new MediaTools({binary:existsSync(binary)?binary:null,notify:data=>notify('processing',data)});
  const capabilities={mp4:!!media.binary,nativeWindowState:nativeAvailable,
    applicationAudio:nativeAvailable && Number(os.release().split('.')[2])>=20348};
  handle('capabilities',()=>capabilities);
  handle('microphone-access',enabled=>{microphoneSetupUntil=enabled && !busy()?Date.now()+30000:0;return microphoneSetupUntil>0;});
  const localSession = control.webContents.session;
  localSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const microphone=permission==='media' && ((file && selection?.microphone) || Date.now()<microphoneSetupUntil) && details.mediaTypes?.length && details.mediaTypes.every(t=>t==='audio');
    callback(contents === control.webContents && ((permission==='display-capture' && Boolean(file)) || !!microphone));
  });
  localSession.setPermissionCheckHandler((contents, permission, _origin, details) =>
    contents === control.webContents && ((permission==='display-capture' && Boolean(file)) ||
      (permission==='media' && ((file && selection?.microphone) || Date.now()<microphoneSetupUntil) && details.mediaType!=='video')));
  localSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      if (request.frame !== control.webContents.mainFrame || !file || !selection) return callback(null);
      if (selection.browserId) {
        const target = BrowserWindow.fromId(selection.browserId);
        if (!target || !browsers.has(target)) return callback(null);
        const frame = target.webContents.mainFrame;
        callback({video:frame, ...(selection.audio ? {audio:selection.audioScope==='system'?'loopback':frame,enableLocalEcho:true} : {})});
      } else {
        const sources = await desktopCapturer.getSources({types:captureTypes(selection.mode),thumbnailSize:{width:0,height:0}});
        const source = selectSource(sources,selection.mode,selection.sourceId,control.getMediaSourceId());
        callback({video:source,...(selection.audio && selection.audioScope!=='application' && process.platform === 'win32' ? {audio:'loopback'} : {})});
      }
    } catch (error) { notice(error.message); callback(null); }
  });
  const remoteSession = session.fromPartition('persist:webinars');
  remoteSession.setPermissionRequestHandler(async (contents, permission, callback) => {
    if (permission === 'fullscreen' && [...browsers].some(win=>win.webContents===contents)) return callback(true);
    if (permission !== 'media') return callback(false);
    const result = await dialog.showMessageBox(control, {type:'question',
      message:'Разрешить сайту вебинара камеру / микрофон?',detail:contents.getURL(),
      buttons:['Запретить','Разрешить'],defaultId:0,cancelId:0});
    callback(result.response === 1);
  });

  handle('open-webinar', async value => {
    if (busy()) throw new Error('Завершите запись перед сменой ссылки');
    const url = validateURL(value);
    if (!webinar || webinar.isDestroyed()) { webinar = new BrowserWindow(remoteOptions()); watchBrowser(webinar); }
    webinar.show(); webinar.focus();
    webinar.loadURL(url).catch(error => notice(`Не удалось открыть вебинар: ${error.message}`));
    return webinar.id;
  });
  handle('reveal-webinar', () => {
    const target = selection?.browserId ? BrowserWindow.fromId(selection.browserId) : webinar;
    if (target) {target.show();target.restore();target.focus();}
  });
  handle('toggle-webinar-fullscreen', async () => {
    const target = selection?.browserId ? BrowserWindow.fromId(selection.browserId) : webinar;
    if (!target || target.isDestroyed() || !browsers.has(target)) throw new Error('Сначала откройте вебинар');
    target.show();target.restore();
    const htmlFullscreen=await target.webContents.executeJavaScript('Boolean(document.fullscreenElement)').catch(()=>false);
    if(htmlFullscreen || target.isFullScreen())await leaveFullscreen(target);else target.setFullScreen(true);
    target.focus();
  });
  handle('sources', async mode => {
    const external = mode === 'webinar' ? [] : await desktopCapturer.getSources({
      types:captureTypes(mode),thumbnailSize:{width:320,height:180},fetchWindowIcons:mode === 'window'});
    return {browsers:[...browsers].map(win => ({id:win.id,name:win.webContents.getTitle() || 'Вебинар'})),
      external:mode === 'webinar' ? [] : describeSources(external,mode,control.getMediaSourceId(),screen.getAllDisplays())};
  });
  handle('prepare', async options => {
    if (updates?.installing) throw new Error('Выполняется установка обновления. Дождитесь перезапуска программы');
    if (busy()) throw new Error('Запись уже идёт');
    preparing = true;
    try {
      if (!['webinar','window','screen'].includes(options?.mode)) throw new Error('Выберите источник');
      if (options.mode === 'webinar') {
        const target = BrowserWindow.fromId(Number(options.browserId));
        if (!target || !browsers.has(target)) throw new Error('Сначала откройте вебинар по ссылке');
      } else {
        const sources = await desktopCapturer.getSources({types:captureTypes(options.mode),thumbnailSize:{width:0,height:0}});
        selectSource(sources,options.mode,options.sourceId,control.getMediaSourceId());
      }
      const own=options.mode==='window'?[...browsers].find(win=>win.getMediaSourceId()===options.sourceId):null;
      const scope=options.audioScope || (options.mode==='webinar'?'application':'system');
      if(!['application','system'].includes(scope))throw new Error('Выберите источник звука');
      if(options.audio && scope==='application' && options.mode!=='webinar' && !own && (!capabilities.applicationAudio || options.mode!=='window'))
        throw new Error('Звук отдельного приложения доступен для окна в Windows 11; для встроенного вебинара — во всех поддерживаемых системах');
      const fps=options.fps === undefined ? 30 : Number(options.fps);
      if(![30,60].includes(fps))throw new Error('Частота кадров должна быть 30 или 60');
      const splitMinutes=Number(options.splitMinutes||0);
      if(!Number.isFinite(splitMinutes)||splitMinutes<0||splitMinutes>1440)throw new Error('Разделение: от 0 до 1440 минут');
      timing={...planTimes(options),durationMinutes:Number(options.durationMinutes||0),fixedEnd:!!options.endAt,scheduledStart:!!options.startAt};
      selection={mode:options.mode,browserId:own?.id || (options.mode==='webinar'?Number(options.browserId):null),
        sourceId:options.sourceId,audio:!!options.audio,audioScope:scope,microphone:!!options.microphone,fps};
      const format=options.format || 'webm';
      if(!['webm','mp4'].includes(format))throw new Error('Выберите формат видео');
      const result = isTest ? {filePath:process.env.WEBINAR_TEST_OUTPUT,canceled:false} : await dialog.showSaveDialog(control, {
        title:'Куда сохранить запись',defaultPath:path.join(app.getPath('videos'),`webinar-${new Date().toISOString().replace(/[:.]/g,'-')}.${format}`),
        filters:[{name:`Видео ${format.toUpperCase()}`,extensions:[format]}]});
      if (result.canceled) {selection = null;return null;}
      const destination=result.filePath.toLowerCase().endsWith(`.${format}`)?result.filePath:`${result.filePath}.${format}`;
      const recording=new RecordingSession({library,media,notify});
      const prepared=await recording.start(destination,{format,splitMinutes,waiting:timing.startAt>Date.now()+500});
      file=recording;
      power = powerSaveBlocker.start('prevent-app-suspension');
      if (selection.browserId) {
        const target = BrowserWindow.fromId(selection.browserId);
        const targetInterval = Math.floor(1000 / selection.fps);
        let interval = targetInterval, lastStart = 0;
        const pendingCaptures = new Set();
        // A hidden native window can stop submitting compositor frames. A tiny
        // page capture wakes it; limit parallel calls and back off on slow PCs.
        // One stuck capture must not indefinitely prevent all later wakeups.
        let warned=false;
        paintTimer = setInterval(() => {
          if (target.isDestroyed() || (target.isVisible() && !target.isMinimized())) return;
          const now = performance.now();
          if(pendingCaptures.size >= 2){
            if(!warned && now-Math.min(...pendingCaptures)>5000 && file?.entry?.status==='recording'){
              warned=true;notice('Возможна задержка кадров свёрнутого вебинара. Проверьте предпросмотр; если видео застыло, разверните окно или уменьшите размер записи до 720p.');
            }
            return;
          }
          if (now - lastStart < interval) return;
          if (pendingCaptures.size && now - Math.min(...pendingCaptures) < 250) return;
          lastStart = now;pendingCaptures.add(now);
          target.webContents.capturePage({x:0,y:0,width:1,height:1},{stayHidden:false,stayAwake:true})
            .catch(()=>{})
            .finally(()=>{
              pendingCaptures.delete(now);
              const duration=performance.now()-now;
              if (duration > 70) interval=Math.min(100,Math.max(interval*1.4,35));
              else if(duration < 25) interval=Math.max(targetInterval,interval-1);
            });
        }, Math.floor(targetInterval));
      }
      return {...prepared,...timing,applicationAudio:selection.audio && selection.audioScope==='application' && !selection.browserId};
    } finally {preparing = false;}
  });
  handle('write', async data => {
    if (!file || !(data instanceof ArrayBuffer) || data.byteLength > 64 * 1024 * 1024)
      throw new Error('Недопустимый блок записи');
    return file.write(data);
  });
  handle('capture-ready', async () => {
    if(!file || schedule)throw new Error('Запись не подготовлена');
    if(!timing.scheduledStart)timing.startAt=Date.now();
    if(!timing.fixedEnd && timing.durationMinutes)timing.endAt=Math.max(timing.startAt,Date.now())+timing.durationMinutes*60000;
    if(timing.endAt && timing.endAt<=Date.now())throw new Error('Время окончания записи уже прошло');
    const waiting=timing.startAt>Date.now()+200;
    schedule=new Schedule({...timing,onStart:()=>{
      library.patch(file.entry.id,{status:'recording'}).catch(e=>notice(e.message));notify('schedule-start',{});
    },onStop:()=>notify('schedule-stop',{})});
    if(selection.mode==='window' && !selection.browserId && nativeAvailable) {
      nativeCapture.watch(selection.sourceId,state=>notify('window-state',state),e=>notice(e.message));
    }
    return {waiting,startAt:timing.startAt,endAt:timing.endAt};
  });
  handle('audio-ack', bytes=>{if(Number.isInteger(bytes) && bytes>0 && bytes<=1048576)audioOutstanding=Math.max(0,audioOutstanding-bytes);});
  handle('application-audio', async () => {
    if(!file || !selection?.audio || selection.audioScope!=='application' || selection.browserId || !capabilities.applicationAudio)
      throw new Error('Звук приложения не выбран');
    audioOutstanding=0;
    await nativeCapture.audio(selection.sourceId,buffer=>{
      audioOutstanding+=buffer.byteLength;
      if(audioOutstanding>2*1048576){nativeCapture.stop();notify('audio-ended',{});return;}
      if(file)notify('application-audio-data',buffer.buffer.slice(buffer.byteOffset,buffer.byteOffset+buffer.byteLength));
    },error=>{if(file){notice(error.message);notify('audio-ended',{});}});
    return true;
  });
  handle('rotate',async duration=>{
    if(!file)throw new Error('Нет открытой записи');
    return file.rotate(Math.min(14*86400,Math.max(0,Number(duration)||0)));
  });
  handle('finish', async duration => {
    if (!file) throw new Error('Нет открытого файла');
    schedule?.dispose();schedule=null;nativeCapture.stop();
    const current = file;
    try {const result = await current.finish(Math.min(14*86400,Math.max(0,Number(duration)||0)));lastFile = result.path;return result;}
    finally {file = null;selection = null;releasePower();updates?.onIdle();notify('history',{});}
  });
  handle('abort', async () => {
    if (!file) return null;
    schedule?.dispose();schedule=null;nativeCapture.stop();
    const current = file;
    try {const result = await current.abort();lastFile = result?.path;return result;}
    finally {file = null;selection = null;releasePower();updates?.onIdle();notify('history',{});}
  });
  handle('show-file', () => {if (lastFile) shell.showItemInFolder(lastFile);});
  handle('history',()=>library.list());
  handle('history-open',async (id,index,action)=>{
    if(busy())throw new Error('Дождитесь завершения записи и обработки');
    const entry=library.get(id),segment=entry.segments[Number(index)];
    if(!segment)throw new Error('Файл не найден');
    const candidates=segment.status==='completed'?[segment.path,segment.raw,segment.partial]:[segment.raw,segment.partial];
    let target;for(const candidate of candidates)if(candidate && existsSync(candidate)){target=candidate;break;}
    if(!target)throw new Error('Файл перемещён или удалён');
    if(action==='folder')shell.showItemInFolder(target);
    else if(action==='play'){const error=await shell.openPath(target);if(error)throw new Error(error);}
    else throw new Error('Неизвестное действие');
  });
  handle('repair',async (id,index)=>{
    if(busy() || updates?.installing)throw new Error('Сначала завершите запись и обработку');
    maintenance=true;let powerId;
    try {
      powerId=powerSaveBlocker.start('prevent-app-suspension');
      let input;
      if(id){
        const entry=library.get(id),segment=entry.segments[Number(index)];
        if(!segment)throw new Error('Запись не найдена');
        input=[segment.partial,segment.raw,segment.path].find(candidate=>candidate && existsSync(candidate));
        if(!input)throw new Error('Исходный файл перемещён или удалён');
      }else{
        const result=await dialog.showOpenDialog(control,{title:'Выберите старую или незавершённую запись',properties:['openFile'],filters:[{name:'Записи WebM',extensions:['webm','partial']}]});
        if(result.canceled)return null;input=result.filePaths[0];
      }
      const result=await dialog.showSaveDialog(control,{title:'Куда сохранить восстановленную копию',
        defaultPath:input.replace(/\.partial$/i,'').replace(/\.webm$/i,'')+'.recovered.webm',filters:[{name:'WebM',extensions:['webm']}]});
      if(result.canceled)return null;
      const destination=result.filePath.toLowerCase().endsWith('.webm')?result.filePath:result.filePath+'.webm';
      const repaired=await media.repair(input,destination);lastFile=repaired.path;
      await library.add({status:'completed',format:'webm',duration:repaired.duration,segments:[{...repaired,raw:repaired.path,status:'completed'}],recovered:true});
      notify('history',{});return repaired;
    }finally{maintenance=false;if(powerId!==undefined)powerSaveBlocker.stop(powerId);updates?.onIdle();}
  });

  const updateEnabled = app.isPackaged && process.platform === 'win32' &&
    existsSync(path.join(process.resourcesPath,'app-update.yml'));
  updates = new UpdateManager({updater:updateEnabled ? require('electron-updater').autoUpdater : null,
    isBusy:busy,version:app.getVersion(),notify:state => {
      if (!control.isDestroyed()) control.webContents.send('update-state',state);
    }});
  handle('update-state', () => updates.snapshot());
  handle('check-updates', () => updates.check());
  handle('install-update', () => updates.install());
  updates.start();
  app.once('will-quit', () => updates.dispose());

  tray = new Tray(nativeImage.createFromPath(path.join(__dirname,'tray.png')));
  tray.setToolTip('Запись вебинара');
  tray.setContextMenu(Menu.buildFromTemplate([{label:'Показать программу',click:restore},
    {label:'Показать вебинар',click:() => webinar?.show()},
    {label:'Выход',click:() => {if (busy()) {restore();notice('Сначала остановите и сохраните запись.');} else control.close();}}]));
  tray.on('click',restore);
  await control.loadFile(path.join(__dirname,'index.html'));
}).catch(error=>{dialog.showErrorBox('Не удалось запустить программу',error.message);app.quit();});
} else {app.quit();}
app.on('window-all-closed', () => app.quit());
