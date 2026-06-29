'use strict'

const path = require('path')
const fs = require('fs')
const { pipeline } = require('stream/promises')
const { EventEmitter } = require('events')

const crypto = require('hypercore-crypto')
const b4a = require('b4a')
const Corestore = require('corestore')
const Hyperswarm = require('hyperswarm')
const Hyperbee = require('hyperbee')
const Hyperdrive = require('hyperdrive')
const Autobase = require('autobase')

const MAX_FILE_BYTES = 250 * 1024 * 1024 // 250 MB hard cap per file
const MAX_TEXT_LEN = 4000
const HEX64 = /^[0-9a-fA-F]{64}$/

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function shortId () {
  return b4a.toString(crypto.randomBytes(8), 'hex')
}

function sanitizeName (name) {
  const s = String(name || '').replace(/[\u0000-\u001f]/g, '').trim()
  return s.slice(0, 48) || 'Anonymous'
}

// Strip anything that could escape a directory or carry control chars.
function sanitizeFileName (name) {
  const base = path.basename(String(name || 'file'))
  const cleaned = base.replace(/[\u0000-\u001f\\/:*?"<>|]/g, '_').trim()
  return cleaned.slice(0, 180) || 'file'
}

function mimeOf (name) {
  const ext = path.extname(String(name)).toLowerCase()
  const map = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
    '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown',
    '.zip': 'application/zip'
  }
  return map[ext] || 'application/octet-stream'
}

// ---------------------------------------------------------------------------
// P2PNode: owns everything for one running app instance.
// ---------------------------------------------------------------------------
class P2PNode extends EventEmitter {
  constructor (storageDir) {
    super()
    this.storageDir = storageDir
    this.store = null
    this.swarm = null
    this.base = null            // Autobase = the room ledger (layer 3)
    this.drive = null           // our own outbox Hyperdrive (files we share)
    this.remoteDrives = new Map() // driveKeyHex -> read-only Hyperdrive
    this.displayName = 'Anonymous'
    this.connections = 0
    this._emitTimer = null
  }

  async init () {
    fs.mkdirSync(this.storageDir, { recursive: true })

    // A persisted 32-byte seed keeps our cryptographic identity (and therefore
    // our write access to any room) stable across restarts.
    const primaryKey = this._loadOrCreateSeed()
    this.store = new Corestore(path.join(this.storageDir, 'corestore'), { primaryKey, unsafe: true })
    await this.store.ready()

    this.swarm = new Hyperswarm({
      keyPair: await this.store.createKeyPair('swarm-identity')
    })

    // One replication stream per peer carries every core in the store:
    // the Autobase room AND any Hyperdrives we are mirroring.
    this.swarm.on('connection', (conn) => {
      this.connections++
      this._scheduleEmit()
      this.store.replicate(conn)
      conn.on('close', () => {
        this.connections = Math.max(0, this.connections - 1)
        this._scheduleEmit()
      })
      conn.on('error', () => {})
    })
  }

  _loadOrCreateSeed () {
    const p = path.join(this.storageDir, 'seed.key')
    try {
      const buf = fs.readFileSync(p)
      if (buf.length === 32) return buf
    } catch (_) { /* not created yet */ }
    const seed = crypto.randomBytes(32)
    fs.writeFileSync(p, seed, { mode: 0o600 })
    return seed
  }

  // -- Autobase view + apply ------------------------------------------------
  // The view is a Hyperbee. apply() is the only place that mutates it, so the
  // rules below ARE the room's rules. Only an existing writer can add a new
  // writer, which gives us admin-gated membership with no central server.
  _openView (viewStore) {
    return new Hyperbee(viewStore.get('view'), {
      extension: false,
      keyEncoding: 'utf-8',
      valueEncoding: 'json'
    })
  }

  async _apply (nodes, view, host) {
    for (const node of nodes) {
      const op = node.value
      if (!op || typeof op !== 'object') continue

      if (op.type === 'addWriter' && HEX64.test(op.key || '')) {
        try {
          await host.addWriter(b4a.from(op.key, 'hex'), { indexer: true })
          await view.put('member!' + op.key.toLowerCase(), {
            name: sanitizeName(op.name), ts: Number(op.ts) || Date.now()
          })
        } catch (_) { /* already a writer, or invalid key */ }
        continue
      }

      if (op.type === 'member' && HEX64.test(op.key || '')) {
        await view.put('member!' + op.key.toLowerCase(), {
          name: sanitizeName(op.name), ts: Number(op.ts) || Date.now()
        })
        continue
      }

      if (op.type === 'message' && typeof op.text === 'string') {
        const ts = Number(op.ts) || Date.now()
        await view.put('msg!' + String(ts).padStart(16, '0') + '!' + (op.id || shortId()), {
          text: op.text.slice(0, MAX_TEXT_LEN),
          name: sanitizeName(op.name),
          author: op.author,
          ts
        })
        continue
      }

      if (op.type === 'file' && HEX64.test(op.driveKey || '') && typeof op.path === 'string') {
        const ts = Number(op.ts) || Date.now()
        await view.put('file!' + String(ts).padStart(16, '0') + '!' + (op.id || shortId()), {
          name: sanitizeFileName(op.name),
          path: op.path,
          driveKey: op.driveKey.toLowerCase(),
          size: Number(op.size) || 0,
          mime: String(op.mime || 'application/octet-stream'),
          sender: sanitizeName(op.sender),
          author: op.author,
          ts
        })
        continue
      }
    }
  }

  _newBase (bootstrap) {
    return new Autobase(this.store.namespace('room'), bootstrap, {
      open: this._openView.bind(this),
      apply: this._apply.bind(this),
      valueEncoding: 'json'
    })
  }

  // -- Room lifecycle -------------------------------------------------------
  async createRoom (displayName) {
    if (this.base) throw new Error('You are already in a room. Restart to switch rooms.')
    this.displayName = sanitizeName(displayName)
    this.base = this._newBase(null)
    await this.base.ready()
    await this._afterRoomReady()
    // Record the creator as the first member (creator is already a writer).
    await this.base.append({
      type: 'member', key: this._writerKeyHex(), name: this.displayName, ts: Date.now()
    })
    return this.roomInfo()
  }

  async joinRoom (roomKeyHex, displayName) {
    if (this.base) throw new Error('You are already in a room. Restart to switch rooms.')
    const key = String(roomKeyHex || '').trim().toLowerCase()
    if (!HEX64.test(key)) throw new Error('That room ID is not valid. It should be 64 hex characters.')
    this.displayName = sanitizeName(displayName)
    this.base = this._newBase(b4a.from(key, 'hex'))
    await this.base.ready()
    await this._afterRoomReady()
    return this.roomInfo()
  }

  async _afterRoomReady () {
    // Our personal outbox: files we share live here and replicate to peers.
    this.drive = new Hyperdrive(this.store.namespace('outbox'))
    await this.drive.ready()

    this.base.on('update', () => this._scheduleEmit())

    // Join the swarm on a discovery key derived from the room key. We publish
    // the discovery key, never the room key itself, on the DHT.
    const topic = crypto.discoveryKey(this.base.key)
    this.swarm.join(topic, { server: true, client: true })
    this.swarm.flush().catch(() => {})
  }

  // -- Actions --------------------------------------------------------------
  async sendMessage (text) {
    this._requireWritable('Ask an existing member to add you before you can post.')
    const clean = String(text || '').trim().slice(0, MAX_TEXT_LEN)
    if (!clean) return
    await this.base.append({
      type: 'message', text: clean, name: this.displayName,
      author: this._writerKeyHex(), id: shortId(), ts: Date.now()
    })
  }

  async addMember (writerKeyHex, name) {
    this._requireWritable('Only existing members can add new members.')
    const key = String(writerKeyHex || '').trim().toLowerCase()
    if (!HEX64.test(key)) throw new Error('That writer key is not valid. It should be 64 hex characters.')
    if (key === this._writerKeyHex()) throw new Error('That is your own writer key.')
    await this.base.append({ type: 'addWriter', key, name: sanitizeName(name), ts: Date.now() })
  }

  async sendFile (filePath) {
    this._requireWritable('You must be a member to share files.')
    const stat = fs.statSync(filePath)
    if (!stat.isFile()) throw new Error('That is not a file.')
    if (stat.size > MAX_FILE_BYTES) throw new Error('File is larger than the 250 MB limit.')

    const name = sanitizeFileName(path.basename(filePath))
    const id = shortId()
    const drivePath = '/files/' + id + '/' + name

    await pipeline(fs.createReadStream(filePath), this.drive.createWriteStream(drivePath))

    await this.base.append({
      type: 'file', driveKey: this._driveKeyHex(), path: drivePath,
      name, size: stat.size, mime: mimeOf(name),
      sender: this.displayName, author: this._writerKeyHex(), id, ts: Date.now()
    })
  }

  async downloadFile (ref, saveDir) {
    if (!ref || !HEX64.test(ref.driveKey || '') || typeof ref.path !== 'string') {
      throw new Error('That file reference is invalid.')
    }
    const drive = this._getRemoteDrive(ref.driveKey.toLowerCase())
    await drive.ready()
    const entry = await drive.entry(ref.path)
    if (!entry) throw new Error('This file is not available right now. It downloads from the sender, so try again when they are online.')

    const out = path.join(saveDir, sanitizeFileName(ref.name))
    await pipeline(drive.createReadStream(ref.path), fs.createWriteStream(out))
    return out
  }

  _getRemoteDrive (keyHex) {
    if (keyHex === this._driveKeyHex()) return this.drive
    let d = this.remoteDrives.get(keyHex)
    if (!d) {
      d = new Hyperdrive(this.store, b4a.from(keyHex, 'hex'))
      this.remoteDrives.set(keyHex, d)
    }
    return d
  }

  // -- State read-out -------------------------------------------------------
  async getState () {
    if (!this.base) return { inRoom: false, connections: this.connections }
    await this.base.update().catch(() => {})

    const messages = []
    const files = []
    const members = []

    for await (const { key, value } of this.base.view.createReadStream()) {
      if (key.startsWith('msg!')) messages.push(value)
      else if (key.startsWith('file!')) files.push(value)
      else if (key.startsWith('member!')) members.push({ key: key.slice('member!'.length), ...value })
    }

    // One chronological timeline of messages and file shares.
    const timeline = []
    for (const m of messages) timeline.push({ kind: 'message', ...m })
    for (const f of files) timeline.push({ kind: 'file', ...f })
    timeline.sort((a, b) => a.ts - b.ts)

    return {
      inRoom: true,
      roomKey: this._roomKeyHex(),
      writerKey: this._writerKeyHex(),
      writable: this.base.writable,
      displayName: this.displayName,
      connections: this.connections,
      members: members.sort((a, b) => a.ts - b.ts),
      timeline
    }
  }

  roomInfo () {
    return {
      roomKey: this._roomKeyHex(),
      writerKey: this._writerKeyHex(),
      writable: this.base.writable
    }
  }

  // -- internals ------------------------------------------------------------
  _requireWritable (why) {
    if (!this.base) throw new Error('Create or join a room first.')
    if (!this.base.writable) throw new Error('You are not a member of this room yet. ' + why)
  }

  _roomKeyHex () { return b4a.toString(this.base.key, 'hex') }
  _writerKeyHex () { return b4a.toString(this.base.local.key, 'hex') }
  _driveKeyHex () { return b4a.toString(this.drive.key, 'hex') }

  _scheduleEmit () {
    if (this._emitTimer) return
    this._emitTimer = setTimeout(() => {
      this._emitTimer = null
      this.getState().then((s) => this.emit('state', s)).catch(() => {})
    }, 120)
  }

  async destroy () {
    try { if (this.swarm) await this.swarm.destroy() } catch (_) {}
    try { if (this.store) await this.store.close() } catch (_) {}
  }
}

module.exports = P2PNode
