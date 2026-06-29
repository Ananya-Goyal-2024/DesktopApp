# P2P Office

A strictly peer-to-peer desktop app for office communication — chat, files,
images and video — with **no central server**. Messages and files travel
directly between teammates' computers over an encrypted mesh.

Built on the Holepunch stack:

| Layer | Job | Library |
|------|-----|---------|
| Transport | peer discovery, firewall hole-punching, encryption | `hyperswarm` |
| Storage | files, images, video shared between peers | `hyperdrive` |
| Room ledger ("blockchain") | tamper-evident chat + membership, multi-writer, no server | `autobase` + `hyperbee` |
| Identity | each person is an Ed25519 key | `hypercore-crypto` |
| App shell | installable desktop window | `electron` |

## Run it

Requires Node.js 18+ and npm.

```bash
npm install
npm start
```

To produce installers (Windows/Mac/Linux):

```bash
npm run build
```

## How to use it

1. **One person creates a room.** They get a **Room ID** (share this so others
   can join) and a personal **writer key**.
2. **Others join** by pasting the Room ID. On joining they can *read* the room
   immediately, but cannot post yet — they are read-only.
3. To let someone post, they copy **their writer key** (shown in the left
   panel) and send it to an existing member, who pastes it into **Add a
   member**. Membership is admin-gated: only a current member can add another.
   There is no central admin server — the membership list lives in the shared
   Autobase ledger.
4. Once added, they can chat and share files. Big files stream in chunks from
   whoever has them.

## Why these design choices

- **Desktop, not browser.** A browser can't open direct peer connections
  without a signaling/relay server, which would break the "no server" promise.
  A desktop app runs a real P2P node.
- **Autobase instead of a formal blockchain.** A permissioned chain like
  Hyperledger Fabric reintroduces semi-central ordering nodes. Autobase is a
  multi-writer, peer-replicated, conflict-resolved log — the same tamper-evident
  membership + audit benefits, but pure P2P.
- **The ledger never stores files**, only chat, membership, and file *references*
  (a content key + path). The bytes live in Hyperdrive and move peer-to-peer.

## Security notes (the "no loopholes" part)

- Renderer runs with `contextIsolation: true`, `nodeIntegration: false`,
  `sandbox: true`. The UI can only reach the backend through a small, named
  bridge in `preload.js`. No `fs`/Node access leaks into the page.
- A strict Content-Security-Policy blocks remote scripts.
- All user text is rendered with `textContent` (DOM building), never
  `innerHTML` — no script injection from messages.
- Swarm connections are end-to-end encrypted (Noise) by Hyperswarm.
- Authorship is cryptographic: each member writes only to their own signed
  core, so a message's true origin is the writer key. (Display *names* are
  self-chosen labels — trust the key, not the name.)
- File names are sanitized (no path traversal); files are capped at 250 MB.
- The identity seed is persisted at `<userData>/p2p/seed.key` with mode `600`
  so your write access survives restarts. Back it up; losing it means
  re-requesting membership.

## Known limits / next steps

- Inline image/video preview is not built yet — media shows as a downloadable
  file card. Add previews by streaming small blobs from Hyperdrive into the UI.
- Member invites are manual (paste writer key). A nicer flow would use
  Holepunch's `blind-pairing` for one-time invite codes.
- No message editing/deletion or read receipts yet.

## Project layout

```
p2p-office/
  package.json
  main.js            Electron main — boots the P2P node, IPC handlers
  preload.js         the only bridge between UI and backend
  backend/
    p2p.js           Corestore, Hyperswarm, Autobase room, Hyperdrive files
  renderer/
    index.html       lobby + room markup (with CSP)
    styles.css       visual system
    app.js           UI logic (XSS-safe DOM building)
```
