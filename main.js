'use strict'

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron')
const path = require('path')
const P2PNode = require('./backend/p2p')

let win = null
let node = null

function createWindow () {
  win = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 900,
    minHeight: 580,
    backgroundColor: '#0e1014',
    title: 'P2P Office',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,   // renderer cannot touch Node internals
      nodeIntegration: false,   // no require() in the page
      sandbox: true,            // renderer runs sandboxed
      webSecurity: true,
      spellcheck: false
    }
  })

  if (win.removeMenu) win.removeMenu()
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))

  // Lock the window down: no popups, no navigating away from our own page.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())

  win.on('closed', () => { win = null })
}

app.whenReady().then(async () => {
  // The node stays locked until the user signs up / logs in; only then does it
  // open the store, swarm and rooms. See P2PNode.signup / login / _start.
  node = new P2PNode(path.join(app.getPath('userData'), 'p2p'))
  node.on('state', (state) => {
    if (win && !win.isDestroyed()) win.webContents.send('state:update', state)
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', async () => {
  try { if (node) await node.destroy() } catch (_) {}
  if (process.platform !== 'darwin') app.quit()
})

// Every handler returns { ok, data } or { ok:false, error } so the renderer
// can show a clean message instead of crashing on a rejected promise.
function handle (channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, data: await fn(...args) }
    } catch (err) {
      console.error(channel, err)
      return { ok: false, error: err && err.message ? err.message : 'Something went wrong.' }
    }
  })
}

handle('auth:state', () => node.authState())
handle('auth:signup', ({ name, password }) => node.signup(name, password))
handle('auth:login', ({ password }) => node.login(password))
handle('auth:reset', () => node.resetIdentity())

handle('room:create', (label) => node.createRoom(label))
handle('room:join', ({ key, label }) => node.joinRoom(key, label))
handle('room:switch', (id) => node.switchRoom(id))
handle('room:leave', (id) => node.leaveRoom(id))
handle('invite:create', (id) => node.createInvite(id))
handle('invite:redeem', ({ code, label }) => node.redeemInvite(code, label))
handle('msg:send', (text) => node.sendMessage(text))
handle('contact:add', ({ key, name }) => node.addContact(key, name))
handle('contact:remove', (key) => node.removeContact(key))
handle('contact:invite', (key) => node.inviteContact(key))
handle('request:admit', (writer) => node.admitRequest(writer))
handle('request:ignore', (writer) => node.ignoreRequest(writer))
handle('state:get', () => node.getState())

handle('file:send', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Choose a file to share',
    properties: ['openFile']
  })
  if (res.canceled || !res.filePaths[0]) return false
  await node.sendFile(res.filePaths[0])
  return true
})

handle('file:download', async (ref) => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Choose where to save',
    properties: ['openDirectory', 'createDirectory']
  })
  if (res.canceled || !res.filePaths[0]) return null
  return node.downloadFile(ref, res.filePaths[0])
})
