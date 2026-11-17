// Keep update policy separate from Electron so recording/installation races can
// be tested without downloading or executing an installer.
class UpdateManager {
  constructor({updater, isBusy, notify = () => {}, version}) {
    this.updater = updater;
    this.isBusy = isBusy;
    this.notify = notify;
    this.installing = false;
    this.deferred = false;
    this.available = false;
    this.ready = false;
    this.runningCheck = false;
    this.downloading = false;
    this.state = {phase:updater ? 'idle' : 'unsupported',currentVersion:version,
      message:updater ? 'Обновления проверяются автоматически' : 'Автообновление доступно в Windows-версии, установленной через Setup.exe'};
    if (!updater) return;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowDowngrade = false;
    updater.allowPrerelease = false;
    updater.on('checking-for-update', () => this.set({phase:'checking',message:'Проверка обновлений…'}));
    updater.on('update-not-available', () => {
      this.available = false;
      this.set({phase:'current',message:'Установлена последняя версия'});
    });
    updater.on('update-available', info => {
      this.available = true;
      this.set({phase:'available',version:info.version,message:`Доступна версия ${info.version}`});
      this.download();
    });
    updater.on('download-progress', progress => this.set({phase:'downloading',
      percent:Math.max(0,Math.min(100,Math.round(progress.percent || 0))),message:'Загрузка обновления…'}));
    updater.on('update-downloaded', info => {
      this.ready = true;
      this.available = false;
      this.set({phase:'downloaded',version:info.version,percent:100,
        message:'Обновление загружено. Установка — после завершения записи'});
    });
    updater.on('error', () => {
      this.installing = false;
      this.set({phase:this.ready ? 'downloaded' : 'error',message:'Не удалось обновить программу. Проверьте интернет и повторите позже'});
    });
  }
  snapshot() { return {...this.state}; }
  set(change) { Object.assign(this.state,change);this.notify(this.snapshot()); }
  async check() {
    if (!this.updater || this.ready || this.installing || this.runningCheck || this.downloading) return this.snapshot();
    if (this.isBusy()) {
      this.deferred = true;
      this.set({message:'Проверка обновлений отложена до завершения записи'});
      return this.snapshot();
    }
    this.runningCheck = true;
    this.deferred = false;
    try {await this.updater.checkForUpdates();}
    catch {this.set({phase:'error',message:'Не удалось проверить обновления. Повторите позже'});}
    finally {this.runningCheck = false;}
    return this.snapshot();
  }
  async download() {
    if (!this.updater || !this.available || this.ready || this.downloading || this.installing) return;
    if (this.isBusy()) {
      this.deferred = true;
      this.set({message:'Новая версия будет загружена после завершения записи'});
      return;
    }
    this.downloading = true;
    this.set({phase:'downloading',message:'Загрузка обновления…',percent:0});
    try {await this.updater.downloadUpdate();}
    catch {this.set({phase:'error',message:'Загрузка обновления не завершена. Повторите проверку позже'});}
    finally {this.downloading = false;}
  }
  onIdle() {
    if (this.isBusy() || !this.deferred) return;
    this.deferred = false;
    if (this.available) this.download(); else this.check();
  }
  install() {
    if (!this.updater || !this.ready || this.installing) return false;
    if (this.isBusy()) {
      this.set({message:'Сначала остановите запись и дождитесь сохранения файла'});
      return false;
    }
    // Reserve installation synchronously, before quitAndInstall schedules work.
    this.installing = true;
    this.set({phase:'installing',message:'Установка обновления и перезапуск…'});
    this.set({phase:'installing',message:'Перезапуск и установка обновления…'});
    try {this.updater.quitAndInstall(false,true);return true;}
    catch {
      this.installing = false;
      this.set({phase:'downloaded',message:'Не удалось запустить установку. Повторите попытку'});
      return false;
    }
  }
  start() {
    if (!this.updater) return;
    this.initialTimer = setTimeout(() => this.check(),15000);
    this.timer = setInterval(() => this.check(),6 * 60 * 60 * 1000);
    this.initialTimer.unref?.();this.timer.unref?.();
  }
  dispose() { clearTimeout(this.initialTimer);clearInterval(this.timer); }
}
module.exports = {UpdateManager};
