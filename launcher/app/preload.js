const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('launcher', {
  init: () => ipcRenderer.invoke('init'),
  login: () => ipcRenderer.invoke('login'),
  logout: () => ipcRenderer.invoke('logout'),
  play: (options) => ipcRenderer.invoke('play', options),
  friends: () => ipcRenderer.invoke('friends'),
  openFolder: () => ipcRenderer.send('open-folder'),
  minimize: () => ipcRenderer.send('win-min'),
  close: () => ipcRenderer.send('win-close'),
  on: (channel, fn) => ipcRenderer.on(channel, (_e, data) => fn(data)),
});
