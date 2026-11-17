const {app, BrowserWindow, ipcMain, dialog, session, desktopCapturer,
  powerSaveBlocker, shell, Tray, Menu, nativeImage, screen} = require('electron');
const path = require('node:path');
const {FileSession} = require('./file-session.cjs');
const {UpdateManager} = require('./update-manager.cjs');
const {existsSync} = require('node:fs');
const {captureTypes,selectSource,describeSources} = require('./capture-sources.cjs');

// Capturing a webContents keeps rendering independent of the desktop window.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
let control, webinar, tray, file, selection, power, lastFile, preparing = false, paintTimer, updates;
const browsers = new Set();
const isTest = process.env.WEBINAR_TEST === '1' && !app.isPackaged;
if (isTest && process.env.WEBINAR_TEST_PROFILE) app.setPath('userData', process.env.WEBINAR_TEST_PROFILE);

function notice(message) { control?.webContents.send('notice', message); }
function busy() { return Boolean(file) || preparing; }
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
function watchBrowser(win) {
  browsers.add(win);
  win.webContents.setBackgroundThrottling(false);
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
  if (power !== undefined && powerSaveBlocker.isStarted(power)) powerSaveBlocker.stop(power);
  power = undefined;
}
function restore() { control.show(); control.restore(); control.focus(); }

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
    if (file) { const current = file; file = null; await current.abort().catch(() => {}); }
    releasePower(); app.quit();
  });
  const localSession = control.webContents.session;
  localSession.setPermissionRequestHandler((contents, permission, callback) => {
    callback(contents === control.webContents && permission === 'display-capture' && Boolean(file));
  });
  localSession.setPermissionCheckHandler((contents, permission) =>
    contents === control.webContents && permission === 'display-capture' && Boolean(file));
  localSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      if (request.frame !== control.webContents.mainFrame || !file || !selection) return callback(null);
      if (selection.mode === 'webinar') {
        const target = BrowserWindow.fromId(selection.browserId);
        if (!target || !browsers.has(target)) return callback(null);
        const frame = target.webContents.mainFrame;
        callback({video:frame, ...(selection.audio ? {audio:frame,enableLocalEcho:true} : {})});
      } else {
        const sources = await desktopCapturer.getSources({types:captureTypes(selection.mode),thumbnailSize:{width:0,height:0}});
        const source = selectSource(sources,selection.mode,selection.sourceId,control.getMediaSourceId());
        callback({video:source,...(selection.audio && process.platform === 'win32' ? {audio:'loopback'} : {})});
      }
    } catch (error) { notice(error.message); callback(null); }
  });
  const remoteSession = session.fromPartition('persist:webinars');
  remoteSession.setPermissionRequestHandler(async (contents, permission, callback) => {
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
      selection = {mode:options.mode,browserId:Number(options.browserId),sourceId:options.sourceId,audio:!!options.audio};
      const result = isTest ? {filePath:process.env.WEBINAR_TEST_OUTPUT,canceled:false} : await dialog.showSaveDialog(control, {
        title:'Куда сохранить запись',defaultPath:path.join(app.getPath('videos'),`webinar-${new Date().toISOString().replace(/[:.]/g,'-')}.webm`),
        filters:[{name:'Видео WebM',extensions:['webm']}]});
      if (result.canceled) {selection = null;return null;}
      file = await FileSession.open(result.filePath);
      power = powerSaveBlocker.start('prevent-app-suspension');
      if (selection.mode === 'webinar') {
        const target = BrowserWindow.fromId(selection.browserId);
        let painting = false;
        // Native hidden windows can stop submitting compositor frames even with
        // backgroundThrottling disabled. A tiny visible-page capture wakes the
        // compositor without showing the native window or copying a full frame.
        paintTimer = setInterval(async () => {
          if (painting || target.isDestroyed() || (target.isVisible() && !target.isMinimized())) return;
          painting = true;
          try {await target.webContents.capturePage({x:0,y:0,width:1,height:1},{stayHidden:false,stayAwake:true});}
          catch {} finally {painting = false;}
        }, 40);
      }
      return {name:path.basename(result.filePath),partial:file.partial};
    } finally {preparing = false;}
  });
  handle('write', async data => {
    if (!file || !(data instanceof ArrayBuffer) || data.byteLength > 64 * 1024 * 1024)
      throw new Error('Недопустимый блок записи');
    return file.write(data);
  });
  handle('finish', async () => {
    if (!file) throw new Error('Нет открытого файла');
    const current = file;
    try {const result = await current.finish();lastFile = result.path;return result;}
    finally {file = null;selection = null;releasePower();updates?.onIdle();}
  });
  handle('abort', async () => {
    if (!file) return null;
    const current = file;
    try {const result = await current.abort();lastFile = result.path;return result;}
    finally {file = null;selection = null;releasePower();updates?.onIdle();}
  });
  handle('show-file', () => {if (lastFile) shell.showItemInFolder(lastFile);});

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
});
app.on('window-all-closed', () => app.quit());
