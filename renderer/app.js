'use strict'

// ---- element refs -------------------------------------------------------
const $ = (id) => document.getElementById(id)
const lobby = $('lobby')
const room = $('room')
const nameInput = $('name-input')
const lobbyError = $('lobby-error')
const roomError = $('room-error')
const timeline = $('timeline')
const membersEl = $('members')
const presence = $('presence')
const connCount = $('conn-count')
const readonlyBanner = $('readonly-banner')

let myWriterKey = null

// ---- helpers ------------------------------------------------------------
function showLobbyError (msg) {
  lobbyError.textContent = msg
  lobbyError.hidden = !msg
}
function showRoomError (msg) {
  roomError.textContent = msg
  roomError.hidden = !msg
  if (msg) setTimeout(() => { roomError.hidden = true }, 5000)
}

function fmtTime (ts) {
  const d = new Date(ts)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function fmtSize (bytes) {
  if (!bytes) return ''
  const u = ['B', 'KB', 'MB', 'GB']
  let i = 0; let n = bytes
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++ }
  return n.toFixed(n < 10 && i > 0 ? 1 : 0) + ' ' + u[i]
}

// Deterministic, pleasant colour from a string (name or key).
function colorFor (str) {
  let h = 0
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360
  return `hsl(${h} 58% 62%)`
}

function initials (name) {
  const parts = String(name || '?').trim().split(/\s+/)
  return ((parts[0]?.[0] || '?') + (parts[1]?.[0] || '')).toUpperCase()
}

function el (tag, className, text) {
  const e = document.createElement(tag)
  if (className) e.className = className
  if (text != null) e.textContent = text // textContent => no HTML injection
  return e
}

// ---- lobby actions ------------------------------------------------------
async function createRoom () {
  showLobbyError('')
  const name = nameInput.value.trim()
  if (!name) return showLobbyError('Please enter your name first.')
  const res = await api.createRoom(name)
  if (!res.ok) return showLobbyError(res.error)
  enterRoom()
}

async function joinRoom () {
  showLobbyError('')
  const name = nameInput.value.trim()
  const key = $('join-key').value.trim()
  if (!name) return showLobbyError('Please enter your name first.')
  if (!key) return showLobbyError('Paste the room ID you were given.')
  const res = await api.joinRoom(key, name)
  if (!res.ok) return showLobbyError(res.error)
  enterRoom()
}

async function enterRoom () {
  lobby.hidden = true
  room.hidden = false
  const res = await api.getState()
  if (res.ok) render(res.data)
}

// ---- room actions -------------------------------------------------------
async function sendMessage (e) {
  e.preventDefault()
  const input = $('msg-input')
  const text = input.value
  if (!text.trim()) return
  input.value = ''
  const res = await api.sendMessage(text)
  if (!res.ok) { showRoomError(res.error); input.value = text }
}

async function addMember () {
  const keyInput = $('add-key')
  const key = keyInput.value.trim()
  if (!key) return
  const res = await api.addMember(key, 'Member')
  if (!res.ok) return showRoomError(res.error)
  keyInput.value = ''
}

async function shareFile () {
  const res = await api.shareFile()
  if (!res.ok) showRoomError(res.error)
}

async function downloadFile (ref) {
  const res = await api.downloadFile(ref)
  if (!res.ok) return showRoomError(res.error)
  if (res.data) showRoomError('Saved to ' + res.data) // reuse banner as a notice
}

async function copy (text, btn) {
  try {
    await navigator.clipboard.writeText(text)
    const old = btn.textContent
    btn.textContent = 'Copied'
    setTimeout(() => { btn.textContent = old }, 1200)
  } catch (_) { /* clipboard blocked */ }
}

// ---- rendering ----------------------------------------------------------
function render (state) {
  if (!state || !state.inRoom) return

  myWriterKey = state.writerKey
  $('room-key').textContent = state.roomKey
  $('writer-key').textContent = state.writerKey

  // presence
  connCount.textContent = state.connections
  presence.classList.toggle('live', state.connections > 0)

  // read-only banner for non-writers
  readonlyBanner.hidden = state.writable
  $('send-btn').disabled = !state.writable
  $('attach-btn').disabled = !state.writable
  $('add-btn').disabled = !state.writable

  renderMembers(state.members)
  renderTimeline(state.timeline)
}

function renderMembers (members) {
  membersEl.replaceChildren()
  for (const m of members) {
    const li = document.createElement('li')
    const av = el('div', 'avatar', initials(m.name))
    av.style.background = colorFor(m.key)
    const meta = el('div', 'member-meta')
    const nm = el('div', 'member-name', m.name + (m.key === myWriterKey ? ' (you)' : ''))
    const kk = el('div', 'member-key', m.key.slice(0, 16) + '…')
    meta.append(nm, kk)
    li.append(av, meta)
    membersEl.append(li)
  }
}

function renderTimeline (items) {
  const atBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 80
  timeline.replaceChildren()

  if (!items.length) {
    timeline.append(el('div', 'empty', 'No messages yet. Say hello to start the room.'))
    return
  }

  for (const item of items) {
    if (item.kind === 'message') timeline.append(messageNode(item))
    else if (item.kind === 'file') timeline.append(fileNode(item))
  }

  if (atBottom) timeline.scrollTop = timeline.scrollHeight
}

function messageNode (m) {
  const wrap = el('div', 'msg')
  const head = el('div', 'msg-head')
  const name = el('span', 'msg-name' + (m.author === myWriterKey ? ' me' : ''), m.name || 'Anonymous')
  const time = el('span', 'msg-time', fmtTime(m.ts))
  head.append(name, time)
  wrap.append(head, el('div', 'msg-text', m.text))
  return wrap
}

function fileNode (f) {
  const card = el('div', 'filecard')
  const ext = (f.name.split('.').pop() || 'file').slice(0, 4)
  card.append(el('div', 'fileicon', ext))

  const info = el('div', 'fileinfo')
  info.append(el('div', 'filename', f.name))
  const meta = [f.sender ? 'from ' + f.sender : '', fmtSize(f.size), fmtTime(f.ts)]
    .filter(Boolean).join(' · ')
  info.append(el('div', 'filemeta', meta))
  card.append(info)

  const btn = el('button', 'btn btn-small', 'Save')
  btn.addEventListener('click', () => downloadFile({
    driveKey: f.driveKey, path: f.path, name: f.name
  }))
  card.append(btn)
  return card
}

// ---- global error surfacing ---------------------------------------------
window.addEventListener('error', (e) => {
  lobbyError.textContent = 'JS error: ' + (e.message || e)
  lobbyError.hidden = false
})
window.addEventListener('unhandledrejection', (e) => {
  lobbyError.textContent = 'Unhandled rejection: ' + (e.reason && e.reason.message ? e.reason.message : String(e.reason))
  lobbyError.hidden = false
})

// ---- wire up ------------------------------------------------------------
$('create-btn').addEventListener('click', createRoom)
$('join-btn').addEventListener('click', joinRoom)
$('composer').addEventListener('submit', sendMessage)
$('attach-btn').addEventListener('click', shareFile)
$('add-btn').addEventListener('click', addMember)
$('copy-room').addEventListener('click', (e) => copy($('room-key').textContent, e.target))
$('copy-writer').addEventListener('click', (e) => copy($('writer-key').textContent, e.target))

nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') createRoom() })
$('join-key').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom() })
$('add-key').addEventListener('keydown', (e) => { if (e.key === 'Enter') addMember() })

// live updates pushed from the main process
api.onUpdate((state) => {
  if (!room.hidden) render(state)
})
