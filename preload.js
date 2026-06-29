'use strict'

const { contextBridge, ipcRenderer } = require('electron')

// The renderer can ONLY reach the main process through these named methods.
// No Node, no fs, no ipcRenderer object leaks into the page.
contextBridge.exposeInMainWorld('api', {
  createRoom: (name) => ipcRenderer.invoke('room:create', name),
  joinRoom: (key, name) => ipcRenderer.invoke('room:join', { key, name }),
  sendMessage: (text) => ipcRenderer.invoke('msg:send', text),
  addMember: (key, name) => ipcRenderer.invoke('member:add', { key, name }),
  shareFile: () => ipcRenderer.invoke('file:send'),
  downloadFile: (ref) => ipcRenderer.invoke('file:download', ref),
  getState: () => ipcRenderer.invoke('state:get'),
  onUpdate: (callback) => {
    const listener = (_event, state) => callback(state)
    ipcRenderer.on('state:update', listener)
    return () => ipcRenderer.removeListener('state:update', listener)
  }
})
