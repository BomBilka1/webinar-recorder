const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {UpdateManager} = require('../desktop/update-manager.cjs');
const turn = () => new Promise(resolve => setImmediate(resolve));
class FakeUpdater extends EventEmitter {
  checks=0;downloads=0;installs=0;
  async checkForUpdates() {this.checks++;this.emit('checking-for-update');}
  async downloadUpdate() {this.downloads++;}
  quitAndInstall() {this.installs++;}
}
function fixture() {
  const updater = new FakeUpdater();let busy=false;
  const manager = new UpdateManager({updater,isBusy:()=>busy,version:'2.1.0'});
  return {updater,manager,setBusy:value=>{busy=value;}};
}
test('checking and downloading wait until recording and file saving finish', async () => {
  const {updater,manager,setBusy}=fixture();
  setBusy(true);await manager.check();assert.equal(updater.checks,0);
  manager.onIdle();assert.equal(updater.checks,0);
  setBusy(false);manager.onIdle();await turn();assert.equal(updater.checks,1);
  setBusy(true);updater.emit('update-available',{version:'2.2.0'});
  await turn();assert.equal(updater.downloads,0);
  setBusy(false);manager.onIdle();await turn();assert.equal(updater.downloads,1);
});
test('downloaded installer never launches while recording or automatically on exit', () => {
  const {updater,manager,setBusy}=fixture();
  assert.equal(updater.autoInstallOnAppQuit,false);
  assert.equal(updater.autoDownload,false);
  assert.equal(updater.allowDowngrade,false);
  assert.equal(updater.allowPrerelease,false);
  updater.emit('update-downloaded',{version:'2.2.0'});
  setBusy(true);assert.equal(manager.install(),false);assert.equal(updater.installs,0);
  setBusy(false);assert.equal(manager.install(),true);assert.equal(updater.installs,1);
  assert.equal(manager.installing,true);
  assert.equal(manager.install(),false);assert.equal(updater.installs,1);
});
test('concurrent checks coalesce; downloaded version survives further checks', async () => {
  const {updater,manager}=fixture();let finish;
  updater.checkForUpdates=()=>{updater.checks++;return new Promise(resolve=>{finish=resolve;});};
  const check=manager.check();await manager.check();assert.equal(updater.checks,1);
  finish();await check;
  updater.emit('update-downloaded',{version:'2.2.0'});
  await manager.check();assert.equal(updater.checks,1);assert.equal(manager.snapshot().phase,'downloaded');
});
test('failed network check can recover without affecting recorder state', async () => {
  const {updater,manager}=fixture();
  updater.checkForUpdates=async()=>{throw new Error('Offline');};
  await manager.check();assert.equal(manager.snapshot().phase,'error');
  assert.equal(manager.runningCheck,false);assert.equal(manager.install(),false);
  updater.checkForUpdates=async()=>{updater.emit('update-not-available');};
  await manager.check();assert.equal(manager.snapshot().phase,'current');
});
test('failed installation releases its reservation for a retry', () => {
  const {updater,manager}=fixture();
  updater.emit('update-downloaded',{version:'2.2.0'});
  updater.quitAndInstall=()=>{throw new Error('Cannot start installer');};
  assert.equal(manager.install(),false);assert.equal(manager.installing,false);
  assert.equal(manager.snapshot().phase,'downloaded');
});
test('portable and development builds do not contact an update server', async () => {
  const manager = new UpdateManager({updater:null,isBusy:()=>false,version:'2.1.0'});
  await manager.check();manager.start();
  assert.equal(manager.snapshot().phase,'unsupported');
  assert.equal(manager.install(),false);manager.dispose();
});
