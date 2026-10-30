# PocketPigeon

Send links, text and files between your desktop browser and your phone, with an end-to-end encrypted relay you host yourself.

PocketPigeon is a clean-room implementation of the “toss this tab to my phone” workflow. It ships a Chrome/Edge extension, a tiny Node relay, and a phone web app. No accounts, no analytics, and no third-party cloud.

---

## Features

- **Two-device chat** — both sides keep the conversation, with delivered/saved states and day separators.
- **One-time pairing** — scan once; both devices remember the room and reconnect without scanning again.
- **End-to-end encryption** — AES-256-GCM with a room key generated in the extension; a lock bar and matching safety code are visible on both devices.
- **One-click tab handoff** — send the current tab from the chip above the PC composer.
- **Liquid-glass UI** — soft animated gradients, frosted surfaces, and springy controls.
- **Light, dark, and system themes** — remembered per device and applied before first paint.
- **Composer** — send links, notes, or several files at once.
- **Right-click actions** — send an image, link, selected text, or the page.
- **Keyboard shortcut** — `Ctrl+Shift+S` (`Command+Shift+S` on macOS).
- **Phone → browser** — text is copied, links open in a tab, files download. Each automatic action can be turned off.
- **Offline queue** — messages wait on the relay while the other device is away; delivery receipts update the chat when they arrive.
- **Chat controls** — clear the conversation on either device without unpairing.
- **Self-contained UI** — no fonts, scripts, or images fetched from third parties.

---

## Architecture

```
┌──────────────────────┐        WSS + HTTPS         ┌──────────────────────┐
│  Browser extension   │  ───────────────────────▶  │   PocketPigeon relay │
│  (Chrome / Edge)     │  ◀───────────────────────  │   + phone web app    │
└──────────┬───────────┘   ciphertext only          └──────────┬───────────┘
           │                                                   │
           │ QR / invite link (key in URL fragment, never sent)│
           ▼                                                   ▼
      ┌─────────────────────────────────────────────────────────────┐
      │                       Your phone browser                    │
      │   same web app, same room key, E2E with the extension       │
      └─────────────────────────────────────────────────────────────┘
```

- The extension creates a room, a 256-bit key, and a room token.
- The QR code carries `room`, `token`, and `key` in the URL **fragment**. Fragments are not sent to the server.
- Payloads are encrypted client-side. The relay stores only opaque strings and ciphertext blobs.
- The phone derives the same safety code from the key; compare it with the extension if you want to verify the pairing.

---

## Quick start

> **The ZIP is only the browser half.** PocketPigeon also needs the local relay — a small Node process — running whenever you use the extension. If the popup says “Could not reach the relay”, start it and click **Retry**.

### 1. Start the relay

Requires Node.js 20 or newer.

On Windows, double-click **`start-relay.cmd`** in the project root. Or from a terminal:

```bash
cd server
npm install
npm start
```

Keep the relay window open. The relay prints `http://localhost:8787` and one or more LAN URLs. Allow the private network if Windows Firewall asks.

For an app-like setup, run **`start-relay-hidden.vbs`** instead: it starts the relay with no window and logs to `server/relay.log`. Put a shortcut to that file in `shell:startup` so it starts with Windows. **`stop-relay.cmd`** stops the relay. The phone page is served by the relay, so the PC must be on and the relay running.

### 2. Load the extension

Chrome or Edge 120+:

1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select the `extension/` folder.

### 3. Pair your phone

1. Put the phone on the same Wi-Fi as the relay.
2. Click the PocketPigeon toolbar icon.
3. Scan the QR code with the phone camera.
4. The phone opens the relay and both sides switch to the encrypted chat.

This is a **one-time pair**. The extension and the phone keep the room key locally, so reopening the popup or the phone page reconnects automatically. If the QR cannot be scanned, use **Copy** and paste the invite into the phone page (**Paste an invite link instead**).

### 4. Chat

- Type in the composer and press **Send**; messages appear on both devices.
- Use the **Send this tab** chip above the composer when you are on a normal website.
- Right-click an image, link, or selection → **Send … to phone**.
- Press `Ctrl+Shift+S` for the current tab.
- Attach files with the paperclip; they appear as chat cards.
- Messages show **Delivered** or **Saved on relay**; the latter switches to Delivered once the other device receives it.

---

## One-time pairing

- The extension stores the room, token, and key in `chrome.storage.local`; the phone stores them in `localStorage`.
- Reopening either side reconnects automatically — you do not scan again.
- To show the QR again at any time, use the **QR pill in the encryption bar** in the PC chat, or **Settings → Pairing → Show pairing code**. This is the same room; scanning it reconnects the phone without unpairing.
- The relay auto-recreates a room when a paired device reconnects after a relay restart. Chat history lives on the devices, so it survives; queued relay messages and undownloaded files do not survive a relay restart.
- Reinstalling the extension under a new extension ID/folder clears its local storage and requires one new scan. Normal extension updates keep it.
- On HTTPS you can install the phone app from **⋯ → Install app on this phone** (or Add to Home Screen) and reopen it like a native app. On plain HTTP over the LAN, bookmark the page or use Add to Home screen as a shortcut instead.
- Clearing the phone browser’s site data also removes the saved pairing.

---

## Themes

Both interfaces ship with **System**, **Light**, and **Dark** appearance modes.

- **Popup:** the moon/sun button in the header flips between light and dark. For the full choice, open **Settings → Appearance**.
- **Phone:** the moon/sun button in the header flips the theme. Open the **⋯ menu → Appearance** for System/Light/Dark.
- **System** follows the operating system and updates live when the OS theme changes.
- The extension stores the preference in `chrome.storage.sync` and mirrors it to `localStorage` so the popup paints in the right theme immediately. The phone stores its choice in `localStorage`.
- Animations and blurred blobs are disabled automatically under `prefers-reduced-motion`.

---

## Using a deployed or HTTPS relay

The default relay is `http://localhost:8787`, which the phone reaches over your LAN. For use outside the LAN, deploy the relay behind HTTPS (Caddy, nginx, Cloudflare Tunnel, a VPS, etc.) and set `PUBLIC_URL`:

```bash
PUBLIC_URL=https://pigeon.example.com npm start
```

Caddy example:

```
pigeon.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

Then in the extension:

1. Open **Settings → Relay**.
2. Enter `https://pigeon.example.com`.
3. Save and pair again.

HTTPS matters for more than reachability:

- On plain HTTP (other than `localhost`), the phone page uses a bundled JavaScript AES-GCM implementation because `crypto.subtle` requires a secure context. The message format is identical, but an HTTP page can be modified in transit, which defeats the end-to-end guarantee.
- Service workers, PWA installation, and `navigator.clipboard` also require HTTPS or `localhost`.

Use HTTPS for anything beyond a trusted LAN.

---

## Configuration

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8787` | Relay listen port |
| `PUBLIC_URL` | — | Public base URL (used for the QR code) |
| `MAX_FILE_BYTES` | `10485760` | Per-file limit (10 MB) |
| `MAX_ROOM_FILE_BYTES` | `209715200` | Per-room ciphertext storage (200 MB) |
| `MAX_TOTAL_FILE_BYTES` | `536870912` | Relay-wide ciphertext storage (512 MB) |
| `MESSAGE_TTL_MS` | 24 h | Queued message lifetime |
| `FILE_TTL_MS` | 1 h | File lifetime before first download |
| `FILE_AFTER_DOWNLOAD_MS` | 10 min | File lifetime after first download |

Room creation is limited per IP; message sends are limited per socket.

---

## Security model

- **Encryption:** AES-256-GCM, a fresh random 96-bit IV per message and per file. Keys are never sent to the relay. Chat content is encrypted before it leaves each device.
- **Pairing:** The key travels in the QR code’s URL fragment or in the copied invite link. The relay receives the room ID and a room token (a capability), not the key.
- **Safety code:** A six-digit code derived from `SHA-256(key)` is shown in the lock bar on both devices. They should match.
- **Chat history:** Messages are stored locally on the two devices (up to 300 messages / 7 days on the PC, 300 on the phone). The relay only holds ciphertext for queued messages and files, with TTL cleanup. Delivery receipts carry only message IDs.
- **Capability:** The room token is required to join the WebSocket and to upload/download files. Room IDs alone are not enough.
- **Metadata:** The relay can see room IDs, device roles, message sizes and timing, file sizes, and IP addresses. It cannot read content.
- **No forward secrecy:** There is no ratchet or key rotation. Pair again (new room + new key) if a key may have leaked.
- **Extension permissions:** `activeTab` (send the current tab), `contextMenus`, `notifications`, `alarms`, `downloads`, `offscreen`, `clipboardWrite`, `storage`. The optional `<all_urls>` permission is requested only when you enable **Fetch images from websites**; otherwise images are sent as links.
- **No content scripts:** the extension does not read pages you browse.

This is a personal relay, not a multi-tenant service. If you expose it publicly, add TLS, keep Node and dependencies patched, and monitor resource use.

---

## Project layout

```
pocketpigeon/
├── extension/                 Manifest V3 extension
│   ├── background.js          Service worker: socket, menus, sends, inbox
│   ├── lib/                   Crypto, config, relay client
│   ├── popup/                 Popup UI (pair, inbox, settings)
│   ├── offscreen.*            Clipboard + blob-URL helper
│   ├── vendor/                qrcode-generator (MIT)
│   └── icons/
├── server/
│   ├── server.js              HTTP + WebSocket relay
│   ├── test.mjs               Relay protocol tests
│   └── public/                Phone app, PWA manifest, styles, assets
├── assets/                    Source SVG icons
├── dist/                      Packaged extension zip
├── start-relay.cmd            Windows one-click relay starter
├── start-relay-hidden.vbs     Hidden relay + server/relay.log
├── stop-relay.cmd             Stop the relay on port 8787
├── README.md
└── LICENSE
```

---

## Testing

With the relay running:

```bash
cd server
npm test
```

The test covers room creation, presence, both message directions, delivery feedback, offline queueing, file upload/download, token rejection, and static serving.

The packaged build was also exercised end to end in Edge with a live phone page: QR pairing, a two-way chat with delivery receipts, one-time reconnect without rescanning, encrypted file transfer with byte-for-byte verification, queued delivery while the phone was offline, clipboard copy, automatic link opening, themes, unpair/re-pair, manual invite paste, and a fresh extraction of the packaged ZIP.

---

## Known differences from commercial “send to phone” extensions

- No accounts, paid plans, analytics, or cloud hosting — you run the relay.
- QR/invite-link pairing only; there is no numeric phone-login-code flow.
- One browser and one phone per room. A second device in the same role replaces the first socket.
- The relay is in-memory: restarting it clears queued messages and undownloaded files. Rooms are recreated automatically when the paired devices reconnect; chat history stays on the devices.
- No background push notifications. The phone shows in-app toasts; desktop notifications are available in the browser.
- Delivery receipts are supported; there are no read receipts.
- Phone PWA installation and service-worker caching need HTTPS (or `localhost`).
- Images are sent as files only when the optional site-access permission is enabled; otherwise their URL is sent.

---

## Third-party notices

- [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) — MIT. See `extension/vendor/qrcode-generator.LICENSE`.
- [@noble/ciphers](https://github.com/paulmillr/noble-ciphers) — MIT. See `server/public/vendor/noble-ciphers.LICENSE`.
- [@noble/hashes](https://github.com/paulmillr/noble-hashes) — MIT. See `server/public/vendor/noble-hashes.LICENSE`.
- [ws](https://github.com/websockets/ws) — MIT. Installed with the relay.

---

## License

MIT. See [LICENSE](LICENSE).

PocketPigeon is an independent clean-room project. It is not affiliated with Sendover or any other send-to-phone product, and it contains no code, UI assets, or branding from those products.
