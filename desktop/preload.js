const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('comicstreamDesktop', {
  platform: 'desktop',
  info: () => ipcRenderer.invoke('cs:info'),
  openLibrary: () => ipcRenderer.invoke('cs:open-library'),
  chooseLibrary: () => ipcRenderer.invoke('cs:choose-library')
});
