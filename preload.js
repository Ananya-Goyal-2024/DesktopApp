'use strict'

const { contextBridge, ipcRenderer } = require('electron')

// The renderer can ONLY reach the main process through these named methods.
// No Node, no fs, no ipcRenderer object leaks into the page.
contextBridge.exposeInMainWorld('api', {
  authState: () => ipcRenderer.invoke('auth:state'),
  signup: (name, password) => ipcRenderer.invoke('auth:signup', { name, password }),
  login: (password) => ipcRenderer.invoke('auth:login', { password }),
  resetIdentity: () => ipcRenderer.invoke('auth:reset'),
  createRoom: (label) => ipcRenderer.invoke('room:create', label),
  joinRoom: (key, label) => ipcRenderer.invoke('room:join', { key, label }),
  switchRoom: (id) => ipcRenderer.invoke('room:switch', id),
  leaveRoom: (id) => ipcRenderer.invoke('room:leave', id),
  createInvite: (id) => ipcRenderer.invoke('invite:create', id),
  redeemInvite: (code, label) => ipcRenderer.invoke('invite:redeem', { code, label }),
  sendMessage: (text) => ipcRenderer.invoke('msg:send', text),
  addContact: (key, name) => ipcRenderer.invoke('contact:add', { key, name }),
  removeContact: (key) => ipcRenderer.invoke('contact:remove', key),
  inviteContact: (key) => ipcRenderer.invoke('contact:invite', key),
  admitRequest: (writer) => ipcRenderer.invoke('request:admit', writer),
  ignoreRequest: (writer) => ipcRenderer.invoke('request:ignore', writer),
  shareFile: () => ipcRenderer.invoke('file:send'),
  downloadFile: (ref) => ipcRenderer.invoke('file:download', ref),
  getState: () => ipcRenderer.invoke('state:get'),
  onUpdate: (callback) => {
    const listener = (_event, state) => callback(state)
    ipcRenderer.on('state:update', listener)
    return () => ipcRenderer.removeListener('state:update', listener)
  }
})
