import { gcm, sha256 } from './vendor/noble-ciphers.js';

const STORE_KEY = 'pocketpigeon.v1';
const THEME_KEY = 'pocketpigeon.theme';
const MAX_TEXT = 20000;
const MAX_FEED = 300;

const $ = (id) => document.getElementById(id);
const enc = new TextEncoder();
const dec = new TextDecoder();
const themeMedia = window.matchMedia('(prefers-color-scheme: dark)');
let themePref = document.documentElement.dataset.themePref || 'system';
let installPrompt = null;

const state = {
  cfg: null,
  rawKey: null,
  cryptoKey: null,
  subtle: false,
  ws: null,
  connected: false,
  peerOnline: false,
  retry: 0,
  retryTimer: null,
  heartbeat: null,
  socketFailures: 0,
  blobUrls: new Map(),
  hydrating: new Set(),
  unread: 0,
};

/* ---------------- helpers ---------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function resolveTheme(pref) {
  if (pref === 'light' || pref === 'dark') return pref;
  return themeMedia.matches ? 'dark' : 'light';
}

function applyTheme(pref, { persist = false } = {}) {
  themePref = pref === 'light' || pref === 'dark' ? pref : 'system';
  const resolved = resolveTheme(themePref);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themePref = themePref;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', resolved === 'dark' ? '#0a0f14' : '#f6f1e7');
  if (persist) {
    try { localStorage.setItem(THEME_KEY, themePref); } catch {}
  }
  updateThemeControls();
}

function updateThemeControls() {
  const resolved = document.documentElement.dataset.theme;
  const button = $('themeBtn');
  if (button) {
    const label = resolved === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
    button.title = label;
    button.setAttribute('aria-label', label);
  }
  document.querySelectorAll('#themeSegmented [data-theme-choice]').forEach((choice) => {
    const active = choice.dataset.themeChoice === themePref;
    choice.classList.toggle('active', active);
    choice.setAttribute('aria-pressed', String(active));
  });
}

function setThemePreference(pref) {
  applyTheme(pref, { persist: true });
}

function bindTheme() {
  $('themeBtn').addEventListener('click', () => {
    const resolved = document.documentElement.dataset.theme;
    setThemePreference(resolved === 'dark' ? 'light' : 'dark');
  });
  document.querySelectorAll('#themeSegmented [data-theme-choice]').forEach((choice) => {
    choice.addEventListener('click', () => setThemePreference(choice.dataset.themeChoice || 'system'));
  });
  if (themeMedia.addEventListener) {
    themeMedia.addEventListener('change', () => {
      if (themePref === 'system') applyTheme('system');
    });
  }
}

function b64u(bytes) {
  let s = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64u(text) {
  const s = String(text).replace(/-/g, '+').replace(/_/g, '/');
  const pad = s + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

function newId() {
  return b64u(randomBytes(16));
}

function validRoom(v) { return /^[A-Za-z0-9_-]{4,32}$/.test(v); }
function validToken(v) { return /^[A-Za-z0-9_-]{16,64}$/.test(v); }

function normalizeRelay(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    url.hash = '';
    url.search = '';
    return url.href.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

function relayBase() {
  return (state.cfg && state.cfg.relay) || location.origin;
}

function siteBase() {
  const url = new URL(location.href);
  url.hash = '';
  url.search = '';
  if (url.pathname.endsWith('/index.html')) url.pathname = url.pathname.slice(0, -10);
  return url.href.replace(/\/?$/, '/');
}

function formatSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(ts) {
  const d = new Date(ts || Date.now());
  const today = new Date();
  if (d.toDateString() === today.toDateString()) {
    return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(d);
  }
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(d);
}

function formatDay(ts) {
  const date = new Date(ts || Date.now());
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
}

function isSafeHttpUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

let toastTimer = null;
function toast(message) {
  const node = $('toast');
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 2600);
}

/* ---------------- storage ---------------- */

function loadCfg() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const cfg = JSON.parse(raw);
    if (!validRoom(cfg.room) || !validToken(cfg.token) || !cfg.k) return null;
    if (!Array.isArray(cfg.feed)) cfg.feed = [];
    if (!Array.isArray(cfg.outbox)) cfg.outbox = [];
    return cfg;
  } catch {
    return null;
  }
}

function saveCfg() {
  if (!state.cfg) return;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state.cfg));
  } catch {
    state.cfg.feed = state.cfg.feed.slice(-40);
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state.cfg)); } catch {}
  }
}

function resetCfg() {
  localStorage.removeItem(STORE_KEY);
  state.cfg = null;
  state.rawKey = null;
  state.cryptoKey = null;
}

/* ---------------- crypto ---------------- */

async function initCrypto() {
  state.rawKey = unb64u(state.cfg.k);
  if (state.rawKey.length !== 32) throw new Error('bad_key');
  state.subtle = !!(globalThis.crypto && crypto.subtle);
  if (state.subtle) {
    state.cryptoKey = await crypto.subtle.importKey('raw', state.rawKey, 'AES-GCM', false, ['encrypt', 'decrypt']);
  } else {
    state.cryptoKey = state.rawKey;
  }
}

async function aesEncrypt(key, iv, bytes) {
  if (state.subtle) {
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes);
    return new Uint8Array(ct);
  }
  return gcm(key, iv).encrypt(bytes);
}

async function aesDecrypt(key, iv, bytes) {
  if (state.subtle) {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, bytes);
    return new Uint8Array(plain);
  }
  return gcm(key, iv).decrypt(bytes);
}

async function encryptEnvelope(envelope) {
  const iv = randomBytes(12);
  const plain = enc.encode(JSON.stringify(envelope));
  const ct = await aesEncrypt(state.cryptoKey, iv, plain);
  return JSON.stringify({ v: 1, i: b64u(iv), d: b64u(ct) });
}

async function decryptEnvelope(payload) {
  const pack = JSON.parse(payload);
  if (!pack || pack.v !== 1 || !pack.i || !pack.d) throw new Error('bad_payload');
  const iv = unb64u(pack.i);
  const ct = unb64u(pack.d);
  const plain = await aesDecrypt(state.cryptoKey, iv, ct);
  return JSON.parse(dec.decode(plain));
}

async function encryptBytes(buffer) {
  const iv = randomBytes(12);
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const ct = await aesEncrypt(state.cryptoKey, iv, bytes);
  return { iv: b64u(iv), data: ct };
}

async function decryptBytes(buffer, ivB64u) {
  const iv = unb64u(ivB64u);
  return aesDecrypt(state.cryptoKey, iv, new Uint8Array(buffer));
}

async function safetyCode() {
  if (!state.rawKey) return '—';
  const digest = state.subtle
    ? new Uint8Array(await crypto.subtle.digest('SHA-256', state.rawKey))
    : sha256(state.rawKey);
  const num = ((digest[0] << 16) | (digest[1] << 8) | digest[2]) % 1000000;
  return String(num).padStart(6, '0').replace(/(\d{3})(\d{3})/, '$1 $2');
}

/* ---------------- pairing ---------------- */

function inviteUrl() {
  if (!state.cfg) return '';
  const relay = state.cfg.relay || location.origin;
  return `${siteBase()}#r=${encodeURIComponent(state.cfg.room)}&t=${encodeURIComponent(state.cfg.token)}&k=${encodeURIComponent(state.cfg.k)}&s=${encodeURIComponent(relay)}`;
}

function invokeFromInput(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('Paste the invite link from the extension.');
  let params = null;
  try {
    const url = new URL(raw);
    if (url.hash) params = new URLSearchParams(url.hash.slice(1));
    if (!params || !params.get('r')) params = url.searchParams;
  } catch {
    params = new URLSearchParams(raw.replace(/^#/, ''));
  }
  if (!params) throw new Error('That does not look like an invite link.');
  const room = params.get('r') || '';
  const token = params.get('t') || '';
  const k = params.get('k') || '';
  const relayParam = params.get('s') || '';
  if (!validRoom(room) || !validToken(token) || !k) throw new Error('The invite link is incomplete.');
  let keyBytes;
  try { keyBytes = unb64u(k); } catch { throw new Error('The invite link key is invalid.'); }
  if (keyBytes.length !== 32) throw new Error('The invite link key is invalid.');
  const relay = relayParam ? normalizeRelay(relayParam) : location.origin;
  if (!relay) throw new Error('The invite relay address is invalid.');
  return { room, token, k, relay };
}

function adoptInvite(invite) {
  const current = state.cfg;
  const same = current && current.room === invite.room && current.k === invite.k;
  state.cfg = {
    room: invite.room,
    token: invite.token,
    k: invite.k,
    relay: invite.relay || location.origin,
    feed: same && Array.isArray(current.feed) ? current.feed : [],
    outbox: same && Array.isArray(current.outbox) ? current.outbox : [],
    pairedAt: same && current.pairedAt ? current.pairedAt : Date.now(),
  };
  saveCfg();
  if (state.ws) {
    try { state.ws.close(); } catch {}
    state.ws = null;
  }
  state.connected = false;
  state.peerOnline = false;
  state.retry = 0;
}

function readHashInvite() {
  if (!location.hash) return null;
  try {
    const params = new URLSearchParams(location.hash.slice(1));
    const room = params.get('r');
    const token = params.get('t');
    const k = params.get('k');
    const s = params.get('s');
    if (!room || !token || !k) return null;
    const relay = s ? `&s=${encodeURIComponent(s)}` : '';
    return invokeFromInput(`${location.origin}/#r=${encodeURIComponent(room)}&t=${encodeURIComponent(token)}&k=${encodeURIComponent(k)}${relay}`);
  } catch {
    return null;
  }
}

/* ---------------- websocket ---------------- */

function wsUrl() {
  const base = new URL(relayBase());
  const proto = base.protocol === 'https:' ? 'wss:' : 'ws:';
  const params = new URLSearchParams({
    room: state.cfg.room,
    token: state.cfg.token,
    role: 'phone',
    device: 'phone',
  });
  return `${proto}//${base.host}/ws?${params}`;
}

function connect() {
  if (!state.cfg) return;
  clearTimeout(state.retryTimer);
  if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) return;

  setStatus('connecting', 'Connecting…');
  let ws;
  try {
    ws = new WebSocket(wsUrl());
  } catch {
    scheduleReconnect();
    return;
  }
  state.ws = ws;

  ws.onopen = () => {
    state.connected = true;
    state.retry = 0;
    state.socketFailures = 0;
    setStatus('connecting', 'Syncing…');
    clearInterval(state.heartbeat);
    state.heartbeat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'ping' }));
    }, 20000);
    flushOutbox();
  };

  ws.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    handleSocketMessage(msg);
  };

  ws.onclose = () => {
    if (state.ws !== ws) return;
    state.connected = false;
    state.peerOnline = false;
    clearInterval(state.heartbeat);
    state.heartbeat = null;
    state.socketFailures += 1;
    if (state.socketFailures >= 6) setStatus('offline', 'Relay unreachable');
    else setStatus('offline', 'Reconnecting…');
    updatePeerUi();
    scheduleReconnect();
  };

  ws.onerror = () => {
    try { ws.close(); } catch {}
  };
}

function scheduleReconnect() {
  if (!state.cfg) return;
  clearTimeout(state.retryTimer);
  const attempt = Math.min(state.retry, 5);
  const delay = Math.min(15000, 900 * 2 ** attempt) + Math.random() * 300;
  state.retry += 1;
  state.retryTimer = setTimeout(connect, delay);
}

function handleSocketMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.t) {
    case 'ready':
      if (msg.limits) state.cfg.limits = msg.limits;
      break;
    case 'presence':
      state.peerOnline = !!msg.pc;
      updatePeerUi();
      break;
    case 'pong':
      break;
    case 'sent':
      onSent(msg);
      break;
    case 'delivered': {
      const item = state.cfg.feed.find((entry) => entry.id === msg.id);
      if (item && item.dir === 'out' && item.status !== 'delivered') {
        item.status = 'delivered';
        saveCfg();
        renderFeed();
      }
      break;
    }
    case 'msg':
      onIncoming(msg);
      break;
    case 'error':
      if (msg.code === 'payload_invalid') toast('That message was too large to send.');
      break;
    default:
      break;
  }
}

/* ---------------- outbox / sending ---------------- */

function queueEnvelope(envelope) {
  const id = newId();
  const item = {
    id,
    dir: 'out',
    kind: envelope.kind,
    text: envelope.text || '',
    url: envelope.url || '',
    title: envelope.title || '',
    file: envelope.file || null,
    ts: Date.now(),
    status: 'queued',
  };
  state.cfg.feed.push(item);
  state.cfg.feed = state.cfg.feed.slice(-MAX_FEED);
  state.cfg.outbox.push({ id, kind: envelope.kind, envelope });
  saveCfg();
  renderFeed();
  if (state.connected && state.ws && state.ws.readyState === WebSocket.OPEN) {
    flushOutbox();
  } else {
    toast('Saved — it will send when the relay reconnects.');
  }
  return item;
}

async function flushOutbox() {
  if (!state.cfg || !state.connected || !state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  const pending = state.cfg.outbox.slice();
  for (const entry of pending) {
    try {
      const payload = await encryptEnvelope(entry.envelope);
      state.ws.send(JSON.stringify({ t: 'send', id: entry.id, kind: entry.kind, payload }));
      markStatus(entry.id, 'sending');
    } catch {
      toast('Could not encrypt that message.');
    }
  }
}

function onSent(msg) {
  state.cfg.outbox = state.cfg.outbox.filter((entry) => entry.id !== msg.id);
  markStatus(msg.id, msg.delivered ? 'delivered' : 'stored');
  saveCfg();
}

function markStatus(id, status) {
  const item = state.cfg.feed.find((x) => x.id === id);
  if (!item) return;
  item.status = status;
  saveCfg();
  renderFeed();
}

async function sendText(rawText) {
  const text = String(rawText || '').trim();
  if (!text) return;
  if (text.length > MAX_TEXT) {
    toast('That message is too long. Keep it under 20,000 characters.');
    return;
  }
  const url = isSafeHttpUrl(text) ? text : '';
  queueEnvelope({ kind: url ? 'link' : 'text', text, url });
}

async function sendFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length || !state.cfg) return;
  const max = Number(state.cfg.limits?.maxFileBytes || 10 * 1024 * 1024);
  for (const file of files) {
    if (file.size > max) {
      toast(`${file.name} is over the ${formatSize(max)} limit.`);
      continue;
    }
    try {
      const buffer = await file.arrayBuffer();
      const { iv, data } = await encryptBytes(buffer);
      const fileId = newId();
      const res = await fetch(`${relayBase()}/api/files/${encodeURIComponent(state.cfg.room)}/${encodeURIComponent(fileId)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Room-Token': state.cfg.token,
        },
        body: data,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error === 'file_too_large' ? 'File is too large for this relay.' : 'Upload failed.');
      }
      if (file.type.startsWith('image/')) {
        state.blobUrls.set(fileId, URL.createObjectURL(file));
      }
      queueEnvelope({
        kind: 'file',
        text: '',
        file: {
          id: fileId,
          name: file.name || 'file',
          mime: file.type || 'application/octet-stream',
          size: file.size,
          iv,
        },
      });
    } catch (err) {
      toast(err.message || 'Could not send that file.');
    }
  }
}

function onIncoming(msg) {
  if (!msg.id || state.cfg.feed.some((x) => x.id === msg.id)) {
    ack(msg.id);
    return;
  }
  decryptEnvelope(msg.payload)
    .then(async (envelope) => {
      const item = {
        id: msg.id,
        dir: 'in',
        kind: envelope.kind || 'text',
        text: envelope.text || '',
        url: envelope.url || '',
        title: envelope.title || '',
        file: envelope.file || null,
        ts: msg.ts || Date.now(),
        status: 'received',
      };
      if (item.kind === 'file' && item.file) {
        try {
          const res = await fetch(`${relayBase()}/api/files/${encodeURIComponent(state.cfg.room)}/${encodeURIComponent(item.file.id)}`, {
            headers: { 'X-Room-Token': state.cfg.token },
          });
          if (!res.ok) throw new Error('This file has expired.');
          const cipher = await res.arrayBuffer();
          const plain = await decryptBytes(cipher, item.file.iv);
          const blob = new Blob([plain], { type: item.file.mime || 'application/octet-stream' });
          state.blobUrls.set(item.file.id, URL.createObjectURL(blob));
        } catch (err) {
          item.fileError = err.message || 'Could not fetch this file.';
        }
      }
      state.cfg.feed.push(item);
      state.cfg.feed = state.cfg.feed.slice(-MAX_FEED);
      saveCfg();
      ack(msg.id);
      renderFeed();
      if (document.hidden) {
        state.unread += 1;
        document.title = `(${state.unread}) PocketPigeon`;
      } else {
        toast('New message from your computer.');
      }
    })
    .catch(() => {
      ack(msg.id);
      toast('A message arrived that this device could not decrypt.');
    });
}

function ack(id) {
  if (!id) return;
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ t: 'ack', ids: [id] }));
  }
}

/* ---------------- rendering ---------------- */

function setStatus(kind, text) {
  const pill = $('statusPill');
  pill.className = `status ${kind}`;
  $('statusText').textContent = text;
}

function updatePeerUi() {
  if (!state.connected) return;
  if (state.peerOnline) setStatus('online', 'PC online');
  else setStatus('offline', 'PC offline');
  $('peerState').textContent = state.peerOnline ? 'Online' : 'Offline';
  $('statusPill').title = state.peerOnline ? 'Computer online' : 'Computer offline';
}

function showPairing() {
  $('pairScreen').hidden = false;
  $('feedScreen').hidden = true;
  $('composerBar').hidden = true;
  setStatus('offline', 'Not paired');
}

function showFeed() {
  $('pairScreen').hidden = true;
  $('feedScreen').hidden = false;
  $('composerBar').hidden = false;
}

function messageBubble(item) {
  const bubble = el('div', { class: 'bubble' });

  if (item.kind === 'file' && item.file) {
    const file = item.file;
    const isImage = String(file.mime || '').startsWith('image/');
    const blobUrl = state.blobUrls.get(file.id);
    if (isImage && blobUrl) {
      bubble.append(el('img', { class: 'preview', src: blobUrl, alt: file.name || 'image' }));
    }
    let action = null;
    if (item.dir !== 'out') {
      action = el('a', {
        class: 'file-action',
        text: item.fileError ? 'Expired' : (blobUrl ? 'Save' : 'Fetch'),
        href: blobUrl || '#',
        download: file.name || 'file',
        onclick: (e) => {
          if (!blobUrl && !item.fileError) {
            e.preventDefault();
            hydrateFile(item);
          }
          if (item.fileError) e.preventDefault();
        },
      });
      if (item.fileError) action.removeAttribute('href');
    }
    const card = el('div', { class: 'file-card' }, [
      el('div', { class: 'file-icon' }, [
        (() => {
          const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          svg.setAttribute('viewBox', '0 0 24 24');
          const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          path.setAttribute('d', 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5zm0 2.5L16.5 8H14V5.5z');
          svg.append(path);
          return svg;
        })(),
      ]),
      el('div', {}, [
        el('div', { class: 'file-name', text: file.name || 'file' }),
        el('div', { class: 'file-size', text: item.fileError || formatSize(file.size) }),
      ]),
      action,
    ]);
    bubble.append(card);
  } else {
    if (item.title) bubble.append(el('span', { class: 'title', text: item.title }));
    if (item.kind === 'link' && isSafeHttpUrl(item.url)) {
      bubble.append(el('a', {
        class: 'url',
        href: item.url,
        target: '_blank',
        rel: 'noopener noreferrer',
        text: item.url,
      }));
      if (item.text && item.text !== item.url && !item.title) {
        bubble.append(el('div', { class: 'text', text: item.text }));
      }
    } else {
      const textNode = el('div', { class: 'text' });
      linkify(textNode, item.text || '');
      bubble.append(textNode);
    }
  }
  return bubble;
}

function linkify(container, text) {
  const pattern = /(https?:\/\/[^\s<>"']+)/g;
  let last = 0;
  let match;
  while ((match = pattern.exec(text))) {
    if (match.index > last) container.append(document.createTextNode(text.slice(last, match.index)));
    const urlText = match[0].replace(/[.,;:!?)]+$/, '');
    const trailing = match[0].slice(urlText.length);
    if (isSafeHttpUrl(urlText)) {
      container.append(el('a', {
        href: urlText,
        target: '_blank',
        rel: 'noopener noreferrer',
        text: urlText,
      }));
    } else {
      container.append(document.createTextNode(urlText));
    }
    if (trailing) container.append(document.createTextNode(trailing));
    last = match.index + match[0].length;
  }
  if (last < text.length) container.append(document.createTextNode(text.slice(last)));
  if (!text) container.append(document.createTextNode(''));
}

function metaLine(item) {
  const meta = el('div', { class: 'meta' });
  meta.append(el('span', { text: formatTime(item.ts) }));
  if (item.dir === 'out') {
    const labels = {
      queued: 'Queued',
      sending: 'Sending…',
      delivered: 'Delivered',
      stored: 'Saved on relay',
    };
    meta.append(el('span', { text: labels[item.status] || '' }));
  } else if (item.kind !== 'file' && item.text) {
    meta.append(el('button', {
      type: 'button',
      text: 'Copy',
      onclick: () => copyText(item.text),
    }));
  }
  return meta;
}

function renderFeed() {
  if (!state.cfg) return;
  const feed = $('feed');
  feed.replaceChildren();
  const items = state.cfg.feed.slice(-MAX_FEED).slice().sort((a, b) => (a.ts || 0) - (b.ts || 0));
  let lastDay = '';
  for (const item of items) {
    const day = formatDay(item.ts);
    if (day !== lastDay) {
      lastDay = day;
      feed.append(el('div', { class: 'chat-day', text: day }));
    }
    const wrap = el('div', { class: `msg ${item.dir === 'in' ? 'in' : 'out'}` }, [
      messageBubble(item),
      metaLine(item),
    ]);
    feed.append(wrap);
    if (item.dir === 'in' && item.kind === 'file' && item.file && !state.blobUrls.has(item.file.id) && !item.fileError) {
      hydrateFile(item, { quiet: true });
    }
  }
  const empty = $('emptyState');
  feed.hidden = items.length === 0;
  if (empty) empty.hidden = items.length > 0;
  if (items.length) feed.scrollTop = feed.scrollHeight;
}

async function hydrateFile(item, opts = {}) {
  if (!state.cfg || !item.file || state.hydrating.has(item.file.id)) return;
  state.hydrating.add(item.file.id);
  try {
    const res = await fetch(`${relayBase()}/api/files/${encodeURIComponent(state.cfg.room)}/${encodeURIComponent(item.file.id)}`, {
      headers: { 'X-Room-Token': state.cfg.token },
    });
    if (!res.ok) throw new Error('This file has expired.');
    const cipher = await res.arrayBuffer();
    const plain = await decryptBytes(cipher, item.file.iv);
    const blob = new Blob([plain], { type: item.file.mime || 'application/octet-stream' });
    state.blobUrls.set(item.file.id, URL.createObjectURL(blob));
    item.fileError = '';
    saveCfg();
    renderFeed();
  } catch (err) {
    item.fileError = err.message || 'Could not fetch this file.';
    saveCfg();
    renderFeed();
    if (!opts.quiet) toast(item.fileError);
  } finally {
    state.hydrating.delete(item.file.id);
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied.');
  } catch {
    const area = el('textarea', { style: 'position:fixed;opacity:0' });
    area.value = text;
    document.body.append(area);
    area.select();
    try { document.execCommand('copy'); toast('Copied.'); } catch { toast('Could not copy.'); }
    area.remove();
  }
}

/* ---------------- composer ---------------- */

function bindComposer() {
  const input = $('composerInput');
  const send = $('sendBtn');

  const grow = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
  };

  input.addEventListener('input', () => {
    grow();
    send.disabled = !input.value.trim();
  });

  input.addEventListener('keydown', (event) => {
    const finePointer = !window.matchMedia('(pointer: coarse)').matches;
    if (event.key === 'Enter' && !event.shiftKey && finePointer) {
      event.preventDefault();
      submitComposer();
    }
  });

  send.addEventListener('click', submitComposer);

  $('attachBtn').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', async (event) => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    await sendFiles(files);
  });

  send.disabled = true;
  grow();
}

function submitComposer() {
  const input = $('composerInput');
  const text = input.value;
  if (!text.trim()) return;
  input.value = '';
  input.style.height = '';
  $('sendBtn').disabled = true;
  sendText(text);
}

/* ---------------- sheet ---------------- */

function bindSheet() {
  const sheet = $('sheet');
  const openSheet = async () => {
    $('safetyCode').textContent = await safetyCode();
    $('peerState').textContent = state.peerOnline ? 'Online' : (state.connected ? 'Offline' : 'Not connected');
    await updateSecureCode();
    sheet.showModal();
  };
  $('menuBtn').addEventListener('click', openSheet);
  $('secureStrip').addEventListener('click', openSheet);
  $('closeSheet').addEventListener('click', () => sheet.close());
  sheet.addEventListener('click', (event) => {
    if (event.target === sheet) sheet.close();
  });
  $('copyInviteBtn').addEventListener('click', async () => {
    await copyText(inviteUrl());
    sheet.close();
  });
  $('clearChatBtn').addEventListener('click', () => {
    if (!confirm('Clear this conversation on this phone? Your computer keeps its copy.')) return;
    state.cfg.feed = [];
    state.cfg.outbox = [];
    for (const url of state.blobUrls.values()) URL.revokeObjectURL(url);
    state.blobUrls.clear();
    saveCfg();
    renderFeed();
    sheet.close();
    toast('Conversation cleared.');
  });
  $('installAppBtn').addEventListener('click', async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    try { await installPrompt.userChoice; } catch {}
    installPrompt = null;
    $('installAppBtn').hidden = true;
  });
  $('unpairBtn').addEventListener('click', () => {
    if (!confirm('Unpair this phone? Messages and the room key will be removed from this device.')) return;
    try { state.ws?.close(); } catch {}
    resetCfg();
    sheet.close();
    location.reload();
  });
}

function bindInstallPrompt() {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installPrompt = event;
    if (!window.matchMedia('(display-mode: standalone)').matches) {
      $('installAppBtn').hidden = false;
    }
  });
  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    $('installAppBtn').hidden = true;
  });
}

async function updateSecureCode() {
  const node = $('secureCode');
  if (!node) return;
  node.textContent = state.rawKey ? await safetyCode() : '—';
}

/* ---------------- pairing screen ---------------- */

function bindPairingScreen() {
  const form = $('inviteForm');
  const button = $('pasteInviteBtn');
  button.addEventListener('click', () => {
    form.hidden = !form.hidden;
    if (!form.hidden) $('inviteInput').focus();
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    try {
      const invite = invokeFromInput($('inviteInput').value);
      adoptInvite(invite);
      location.hash = `r=${invite.room}&t=${invite.token}&k=${invite.k}&s=${encodeURIComponent(invite.relay)}`;
      location.reload();
    } catch (err) {
      toast(err.message);
    }
  });
}

/* ---------------- boot ---------------- */

async function boot() {
  bindTheme();
  bindComposer();
  bindSheet();
  bindPairingScreen();
  bindInstallPrompt();
  applyTheme(themePref);

  const fromHash = readHashInvite();
  if (fromHash) {
    adoptInvite(fromHash);
    history.replaceState(null, '', location.pathname + location.search);
  } else {
    state.cfg = loadCfg();
  }

  if (!state.cfg) {
    showPairing();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
    return;
  }

  try {
    await initCrypto();
  } catch {
    resetCfg();
    showPairing();
    toast('The saved pairing was invalid. Pair again from the extension.');
    return;
  }

  showFeed();
  renderFeed();
  await updateSecureCode();
  connect();
  updatePeerUi();

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      state.unread = 0;
      document.title = 'PocketPigeon';
      if (!state.connected) connect();
    }
  });

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
}

boot();

window.addEventListener('hashchange', () => {
  const invite = readHashInvite();
  if (!invite) return;
  adoptInvite(invite);
  location.reload();
});
