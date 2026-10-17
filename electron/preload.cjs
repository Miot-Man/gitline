const { contextBridge, ipcRenderer } = require('electron');

function on(channel, cb) {
  const h = (_e, data) => cb(data);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
}

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  git: (op, cwd, ...args) => ipcRenderer.invoke('git', op, cwd, ...args),
  openRepoDialog: () => ipcRenderer.invoke('dialog:openRepo'),
  pickFolder: (title) => ipcRenderer.invoke('dialog:pickFolder', title),
  validateRepo: (p) => ipcRenderer.invoke('repo:validate', p),
  recent: {
    get: () => ipcRenderer.invoke('recent:get'),
    add: (p) => ipcRenderer.invoke('recent:add', p),
    remove: (p) => ipcRenderer.invoke('recent:remove', p),
  },
  watch: (p) => ipcRenderer.invoke('repo:watch', p),
  unwatch: (p) => ipcRenderer.invoke('repo:unwatch', p),
  showItem: (p) => ipcRenderer.invoke('shell:showItem', p),
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  openTerminal: (p) => ipcRenderer.invoke('shell:terminal', p),
  onRepoChanged: (cb) => on('repo-changed', cb),
  onMenu: (cb) => on('menu', cb),
  onFocus: (cb) => on('focus', cb),
});
