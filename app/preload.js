const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('walksync', {
  // setup
  checkEnv: () => ipcRenderer.invoke('env:check'),
  installEnv: () => ipcRenderer.invoke('env:install'),
  // device
  listDevices: () => ipcRenderer.invoke('devices:list'),
  status: (device) => ipcRenderer.invoke('engine:status', device),
  space: (device) => ipcRenderer.invoke('device:space', device),
  eject: (device) => ipcRenderer.invoke('device:eject', device),
  onDevices: (fn) => ipcRenderer.on('devices', (_e, d) => fn(d)),
  // log-style tasks (sync, dedupe, clean)
  run: (args) => ipcRenderer.invoke('engine:run', args),
  cancel: () => ipcRenderer.invoke('engine:cancel'),
  onLog: (fn) => ipcRenderer.on('log', (_e, d) => fn(d)),
  onDone: (fn) => ipcRenderer.on('done', (_e, d) => fn(d)),
  // library view
  list: (opts) => ipcRenderer.invoke('library:list', opts),
  apply: (opts) => ipcRenderer.invoke('library:apply', opts),
  cancelStream: (id) => ipcRenderer.invoke('library:cancel', id),
  search: (q) => ipcRenderer.invoke('library:search', q),
  onStream: (fn) => ipcRenderer.on('stream', (_e, d) => fn(d)),
  onStreamEnd: (fn) => ipcRenderer.on('stream-end', (_e, d) => fn(d)),
  // files
  pickFolder: (title) => ipcRenderer.invoke('dialog:folder', title),
  pickImage: () => ipcRenderer.invoke('dialog:image'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  open: (p) => ipcRenderer.invoke('shell:open', p),
});
