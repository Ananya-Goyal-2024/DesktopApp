'use strict'

// ---- element refs -------------------------------------------------------
const $ = (id) => document.getElementById(id)
const auth = $('auth')
const signupForm = $('signup-form')
const loginForm = $('login-form')
const authError = $('auth-error')
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
const roomList = $('room-list')
const addRoomBtn = $('add-room-btn')
const lobbyBack = $('lobby-back')
const activeRoomName = $('active-room-name')
const leaveBtn = $('leave-btn')
const requestsPanel = $('requests-panel')
const requestsEl = $('requests')
const contactsEl = $('contacts')
const contactsEmpty = $('contacts-empty')
const makeInviteBtn = $('make-invite-btn')
const inviteBox = $('invite-box')
const inviteCodeEl = $('invite-code')
const inviteNote = $('invite-note')
const inviteInput = $('invite-input')
const useInviteBtn = $('use-invite-btn')

let myWriterKey = null
let activeRoomId = null
let myWritable = false   // am I a writer in the active room? (gates Invite)
let authorColors = {}    // writerKey -> colour, so a name keeps one colour per room

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

// ---- auth (unlock gate) -------------------------------------------------
function showAuthError (msg) {
  authError.textContent = msg
  authError.hidden = !msg
}

// Decide signup vs login based on whether this device already has an identity.
function showAuth (state) {
  auth.hidden = false
  lobby.hidden = true
  room.hidden = true
  showAuthError('')
  if (state.hasIdentity) {
    signupForm.hidden = true
    loginForm.hidden = false
    $('login-name').textContent = state.name || 'there'
    // Collapse the "start over" confirmation back to its default state.
    $('reset-confirm').hidden = true
    $('reset-btn').hidden = false
    $('li-pass').focus()
  } else {
    loginForm.hidden = true
    signupForm.hidden = false
    $('su-name').focus()
  }
}

async function doSignup () {
  showAuthError('')
  const name = $('su-name').value.trim()
  const pass = $('su-pass').value
  const pass2 = $('su-pass2').value
  if (!name) return showAuthError('Please choose a display name.')
  if (pass.length < 8) return showAuthError('Password must be at least 8 characters.')
  if (pass !== pass2) return showAuthError('The two passwords do not match.')
  $('su-btn').disabled = true
  const res = await api.signup(name, pass)
  $('su-btn').disabled = false
  if (!res.ok) return showAuthError(res.error)
  enterApp(res.data)
}

async function doLogin () {
  showAuthError('')
  const pass = $('li-pass').value
  if (!pass) return showAuthError('Enter your password to unlock.')
  $('li-btn').disabled = true
  const res = await api.login(pass)
  $('li-btn').disabled = false
  if (!res.ok) return showAuthError(res.error)
  enterApp(res.data)
}

// "Start over" — reveal / collapse the destructive confirmation.
function showResetConfirm () {
  showAuthError('')
  $('reset-btn').hidden = true
  $('reset-confirm').hidden = false
}
function hideResetConfirm () {
  $('reset-confirm').hidden = true
  $('reset-btn').hidden = false
}
async function doReset () {
  $('reset-confirm-btn').disabled = true
  const res = await api.resetIdentity()
  $('reset-confirm-btn').disabled = false
  if (!res.ok) return showAuthError(res.error)
  // Identity wiped locally — drop back to a fresh signup screen.
  showAuth(res.data)
}

// After unlocking, leave the auth screen and render the app.
function enterApp (state) {
  auth.hidden = true
  $('su-pass').value = $('su-pass2').value = $('li-pass').value = ''
  render(state)
}

// ---- view toggling ------------------------------------------------------
function showLobby () {
  auth.hidden = true
  room.hidden = true
  lobby.hidden = false
  // Offer a way back only when at least one room is already open.
  lobbyBack.hidden = activeRoomId == null
}
function showRoomView () {
  auth.hidden = true
  lobby.hidden = true
  room.hidden = false
}

// ---- lobby actions ------------------------------------------------------
async function createRoom () {
  showLobbyError('')
  const label = nameInput.value.trim() // optional local label for the room
  const res = await api.createRoom(label)
  if (!res.ok) return showLobbyError(res.error)
  nameInput.value = ''
  $('join-key').value = ''
  showRoomView()
  render(res.data)
}

async function joinRoom () {
  showLobbyError('')
  const label = nameInput.value.trim()
  const key = $('join-key').value.trim()
  if (!key) return showLobbyError('Paste the room ID you were given.')
  const res = await api.joinRoom(key, label)
  if (!res.ok) return showLobbyError(res.error)
  nameInput.value = ''
  $('join-key').value = ''
  showRoomView()
  render(res.data)
}

// ---- room switching / leaving -------------------------------------------
async function switchRoom (id) {
  if (id === activeRoomId) return
  const res = await api.switchRoom(id)
  if (!res.ok) return showRoomError(res.error)
  showRoomView()
  render(res.data)
}

async function leaveRoom () {
  if (activeRoomId == null) return
  const res = await api.leaveRoom(activeRoomId)
  if (!res.ok) return showRoomError(res.error)
  render(res.data) // render() shows the lobby itself if no rooms remain
}

// "Add room" keeps existing rooms open and shows the lobby form on top.
function addRoom () {
  showLobbyError('')
  nameInput.value = ''
  showLobby()
}

// ---- invite codes (blind pairing) ---------------------------------------
async function makeInvite () {
  if (activeRoomId == null) return
  makeInviteBtn.disabled = true
  const res = await api.createInvite(activeRoomId)
  makeInviteBtn.disabled = false
  if (!res.ok) return showRoomError(res.error)
  inviteCodeEl.textContent = res.data.code
  inviteBox.hidden = false
  const mins = Math.max(1, Math.round((res.data.expiresAt - Date.now()) / 60000))
  inviteNote.textContent = 'One-time code · expires in about ' + mins + ' min. Share it with one person.'
  inviteNote.hidden = false
}

async function useInvite () {
  showLobbyError('')
  const code = inviteInput.value.trim()
  const label = nameInput.value.trim()
  if (!code) return showLobbyError('Paste the invite code you were given.')
  useInviteBtn.disabled = true
  showLobbyError('Connecting to the inviter…')
  const res = await api.redeemInvite(code, label)
  useInviteBtn.disabled = false
  showLobbyError('')
  if (!res.ok) return showLobbyError(res.error)
  inviteInput.value = ''
  nameInput.value = ''
  showRoomView()
  render(res.data)
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

// ---- contacts & join requests -------------------------------------------
async function saveContact (identityKey, name) {
  const res = await api.addContact(identityKey, name)
  if (!res.ok) return showRoomError(res.error)
  render(res.data)
}
async function removeContact (identityKey) {
  const res = await api.removeContact(identityKey)
  if (!res.ok) return showRoomError(res.error)
  render(res.data)
}
async function inviteContact (identityKey) {
  const res = await api.inviteContact(identityKey)
  if (!res.ok) return showRoomError(res.error)
  render(res.data)
}
async function admitRequest (writerKey) {
  const res = await api.admitRequest(writerKey)
  if (!res.ok) return showRoomError(res.error)
  render(res.data)
}
async function ignoreRequest (writerKey) {
  const res = await api.ignoreRequest(writerKey)
  if (!res.ok) return showRoomError(res.error)
  render(res.data)
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
  if (!state) return
  activeRoomId = state.activeRoomId
  renderRoomList(state.rooms || [], state.activeRoomId)

  if (state.inRoom) {
    showRoomView()
    renderActive(state)
  } else {
    // No active room (e.g. left the last one) — fall back to the lobby.
    showLobby()
  }
}

function renderRoomList (rooms, activeId) {
  roomList.replaceChildren()
  for (const r of rooms) {
    const li = el('li', 'room-item' + (r.id === activeId ? ' active' : ''))
    const av = el('div', 'avatar', initials(r.name))
    av.style.background = colorFor(r.id)
    const nm = el('div', 'room-item-name', r.name)
    li.append(av, nm)
    li.addEventListener('click', () => switchRoom(r.id))
    roomList.append(li)
  }
}

let inviteShownFor = null // which room the visible invite code belongs to

function renderActive (state) {
  myWriterKey = state.writerKey
  myWritable = state.writable
  // A generated invite code is per-room; clear it when the room changes.
  if (inviteShownFor !== state.activeRoomId) {
    inviteShownFor = state.activeRoomId
    inviteBox.hidden = true
    inviteNote.hidden = true
  }
  // Only writers (admins/members) can mint invite codes.
  makeInviteBtn.disabled = !state.writable
  activeRoomName.textContent = state.name || 'Room'
  $('room-key').textContent = state.roomKey

  // presence (peers replicating this room)
  connCount.textContent = state.connections
  presence.classList.toggle('live', state.connections > 0)

  // read-only banner for non-writers
  readonlyBanner.hidden = state.writable
  $('send-btn').disabled = !state.writable
  $('attach-btn').disabled = !state.writable

  // Map each member's writer key to a stable colour (matches their avatar) so
  // message names are colour-coded and easy to follow within the room.
  authorColors = {}
  for (const m of state.members || []) authorColors[m.key] = colorFor(m.identity || m.key)

  renderRequests(state.requests || [])
  renderMembers(state.members || [])
  renderContacts(state.contacts || [], state.members || [])
  renderTimeline(state.timeline)
}

function renderRequests (requests) {
  requestsPanel.hidden = requests.length === 0
  requestsEl.replaceChildren()
  for (const r of requests) {
    const li = el('li', 'request')
    const meta = el('div', 'member-meta')
    const label = r.isContact ? (r.name + ' · contact') : r.name
    meta.append(el('div', 'member-name', label))
    meta.append(el('div', 'member-key', 'wants to join'))
    const actions = el('div', 'req-actions')
    const admit = el('button', 'btn btn-small', 'Admit')
    admit.addEventListener('click', () => admitRequest(r.writer))
    const ignore = el('button', 'icon-btn', 'Ignore')
    ignore.addEventListener('click', () => ignoreRequest(r.writer))
    actions.append(admit, ignore)
    li.append(meta, actions)
    requestsEl.append(li)
  }
}

function renderMembers (members) {
  membersEl.replaceChildren()
  for (const m of members) {
    const li = document.createElement('li')
    const av = el('div', 'avatar', initials(m.name))
    av.style.background = colorFor(m.identity || m.key)
    const meta = el('div', 'member-meta')
    meta.append(el('div', 'member-name', m.name + (m.you ? ' (you)' : '')))
    meta.append(el('div', 'member-key', m.isContact ? 'saved contact' : (m.you ? 'this is you' : 'in this room')))
    li.append(av, meta)
    // Offer to save a fellow member as a contact (needs their identity key).
    if (!m.you && m.identity && !m.isContact) {
      const save = el('button', 'icon-btn', 'Save')
      save.title = 'Save as contact'
      save.addEventListener('click', () => saveContact(m.identity, m.name))
      li.append(save)
    }
    membersEl.append(li)
  }
}

// Local contacts. While in a room you can write to, each contact gets an
// "Invite" that pre-authorises them — they join with the Room ID and are
// admitted automatically, no writer key anywhere.
function renderContacts (contacts, members) {
  const inRoomIdentities = new Set(members.map((m) => m.identity).filter(Boolean))
  contactsEmpty.hidden = contacts.length > 0
  contactsEl.replaceChildren()
  for (const ct of contacts) {
    const li = el('li', 'contact')
    const av = el('div', 'avatar', initials(ct.name))
    av.style.background = colorFor(ct.key)
    const meta = el('div', 'member-meta')
    meta.append(el('div', 'member-name', ct.name))
    meta.append(el('div', 'member-key', ct.key.slice(0, 16) + '…'))
    li.append(av, meta)

    const actions = el('div', 'req-actions')
    // Invite only makes sense if I can write here and they're not already in.
    if (myWritable && !inRoomIdentities.has(ct.key)) {
      const invite = el('button', 'btn btn-small', 'Invite')
      invite.title = 'Pre-authorise for this room'
      invite.addEventListener('click', () => inviteContact(ct.key))
      actions.append(invite)
    }
    const rm = el('button', 'icon-btn', 'Remove')
    rm.addEventListener('click', () => removeContact(ct.key))
    actions.append(rm)
    li.append(actions)
    contactsEl.append(li)
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
  const name = el('span', 'msg-name', m.name || 'Anonymous')
  name.style.color = authorColors[m.author] || colorFor(m.author || m.name || '?')
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
$('su-btn').addEventListener('click', doSignup)
$('li-btn').addEventListener('click', doLogin)
$('su-pass2').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSignup() })
$('li-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin() })
$('reset-btn').addEventListener('click', showResetConfirm)
$('reset-cancel').addEventListener('click', hideResetConfirm)
$('reset-confirm-btn').addEventListener('click', doReset)
$('create-btn').addEventListener('click', createRoom)
$('join-btn').addEventListener('click', joinRoom)
addRoomBtn.addEventListener('click', addRoom)
lobbyBack.addEventListener('click', showRoomView)
leaveBtn.addEventListener('click', leaveRoom)
$('composer').addEventListener('submit', sendMessage)
$('attach-btn').addEventListener('click', shareFile)
$('copy-room').addEventListener('click', (e) => copy($('room-key').textContent, e.target))
makeInviteBtn.addEventListener('click', makeInvite)
$('copy-invite').addEventListener('click', (e) => copy(inviteCodeEl.textContent, e.target))
useInviteBtn.addEventListener('click', useInvite)

nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') createRoom() })
$('join-key').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom() })
inviteInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') useInvite() })

// On launch, the node is locked: show the signup or login gate. The rest of
// the app (lobby/rooms) only appears after the identity is unlocked.
;(async () => {
  const res = await api.authState()
  if (res.ok) showAuth(res.data)
})()

// live updates pushed from the main process
api.onUpdate((state) => {
  activeRoomId = state.activeRoomId
  // Always keep the rooms list fresh (e.g. names/new rooms).
  renderRoomList(state.rooms || [], state.activeRoomId)
  // Only refresh the active-room panes while the room view is showing, so a
  // background update never pulls us out of the lobby form.
  if (!room.hidden && state.inRoom) renderActive(state)
})
