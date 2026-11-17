const { contextBridge, ipcRenderer } = require('electron');
const invoke = (name, ...args) => ipcRenderer.invoke(name, ...args);
contextBridge.exposeInMainWorld('recorderApp', {
  platform: process.platform,
  openWebinar: url => invoke('open-webinar', url),
  sources: mode => invoke('sources', mode),
  prepare: options => invoke('prepare', options),
  write: data => invoke('write', data),
  finish: () => invoke('finish'),
  abort: () => invoke('abort'),
  showFile: () => invoke('show-file'),
  revealWebinar: () => invoke('reveal-webinar'),
  updateState: () => invoke('update-state'),
  checkUpdates: () => invoke('check-updates'),
  installUpdate: () => invoke('install-update'),
  onUpdate: listener => ipcRenderer.on('update-state', (_event, state) => listener(state)),
  onNotice: listener => ipcRenderer.on('notice', (_event, message) => listener(message)),
  onSourceEnded: listener => ipcRenderer.on('source-ended', () => listener())
});
