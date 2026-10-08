const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('workspace', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (partial) => ipcRenderer.invoke('config:set', partial),
  loadLine: () => ipcRenderer.invoke('line:load'),
  chooseLineFolder: () => ipcRenderer.invoke('line:choose-folder'),
  openLineDesktop: () => ipcRenderer.invoke('line:open-desktop'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  onOpenInWork: (callback) => ipcRenderer.on('open-in-work', (_e, url) => callback(url)),
});
