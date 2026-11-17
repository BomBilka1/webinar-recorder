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
  onNotice: listener => ipcRenderer.on('notice', (_event, message) => listener(message)),
  onSourceEnded: listener => ipcRenderer.on('source-ended', () => listener())
});
