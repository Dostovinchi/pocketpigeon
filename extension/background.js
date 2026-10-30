import {
  getConfig,
  getSettings,
  saveSettings,
  savePairing,
  clearPairing,
  setRuntime,
  addInboxItem,
  appendThreadItem,
  updateThreadItem,
  enqueueOutgoing,
  dropOutgoing,
  takeOutbox,
  markInboxRead,
  clearInbox,
  setBadge,
} from './lib/config.js';
import {
  roomId,
  randomB64u,
  newId,
  importRoomKey,
  encryptJson,
  decryptJson,
  encryptBytes,
  decryptBytes,
  safetyCode,
  isHttpUrl,
  isShareableUrl,
} from './lib/crypto.js';
import {
  normalizeServer,
  fetchInfo,
  phoneBase,
  createRoom,
  uploadFile,
  downloadFile,
  deleteFile,
  socketUrl,
  inviteUrl,
} from './lib/api.js';

const DEFAULT_MAX_FILE = 10 * 1024 * 1024;
const MAX_TEXT = 20000;

let ws = null;
let reconnectTimer = null;
let heartbeatTimer = null;
let connecting = false;
let closing = false;
let reconnecting = false;
let retry = 0;
let runtime = { connected: false, peerOnline: false, error: '', limits: null };
let outboxInflight = new Set();
let pendingNotices = new Map();
let pendingSends = new Map();
let offscreenPromise = null;

/* ---------------- runtime state ---------------- */

function pushRuntime(patch) {
  runtime = { ...runtime, ...patch };
  return setRuntime(runtime);
}

function maxFileBytes() {
  return Number(runtime.limits?.maxFileBytes || DEFAULT_MAX_FILE);
}

function setConfiguredState(configured, error = '') {
  return pushRuntime({ configured, connected: false, peerOnline: false, error });
}

/* ---------------- websocket ---------------- */

function clearSocketTimers() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

async function connect() {
  if (connecting) return;
  if (closing) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  const config = await getConfig();
  if (!config.room || !config.token || !config.key) {
    await setConfiguredState(false);
    return;
  }

  connecting = true;
  clearTimeout(reconnectTimer);
  try {
    const key = await importRoomKey(config.key);
    if (!key) throw new Error('bad_key');
    const url = socketUrl(config.serverUrl, config.room, config.token, 'pc', config.deviceName);
    const socket = new WebSocket(url);
    ws = socket;

    socket.onopen = async () => {
      connecting = false;
      retry = 0;
      closing = false;
      await pushRuntime({ configured: true, connected: true, peerOnline: false, error: '' });
      outboxInflight.clear();
      clearInterval(heartbeatTimer);
      heartbeatTimer = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          try { ws.send(JSON.stringify({ t: 'ping' })); } catch {}
        }
      }, 20000);
      flushOutbox();
    };

    socket.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      handleSocketMessage(msg).catch(() => {});
    };

    socket.onclose = async () => {
      connecting = false;
      if (ws !== socket) return;
      ws = null;
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      await pushRuntime({ configured: true, connected: false, peerOnline: false });
      if (!closing) scheduleReconnect();
    };

    socket.onerror = () => {
      try { socket.close(); } catch {}
    };
  } catch (err) {
    connecting = false;
    await pushRuntime({ connected: false, peerOnline: false, error: err.message || 'Connection failed' });
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (closing) return;
  clearTimeout(reconnectTimer);
  const delay = Math.min(15000, 900 * 2 ** Math.min(retry, 4)) + Math.random() * 400;
  retry += 1;
  reconnectTimer = setTimeout(() => { connect().catch(() => {}); }, delay);
}

async function reconnect() {
  if (reconnecting) return;
  reconnecting = true;
  closing = true;
  clearSocketTimers();
  if (ws) {
    try { ws.close(); } catch {}
    ws = null;
  }
  closing = false;
  retry = 0;
  try {
    await connect();
  } finally {
    reconnecting = false;
  }
}

async function handleSocketMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.t === 'ready') {
    const limits = msg.limits || null;
    await pushRuntime({ configured: true, connected: true, error: '', limits });
    return;
  }
  if (msg.t === 'presence') {
    if (msg.phone) {
      const { phoneConfirmed } = await chrome.storage.local.get({ phoneConfirmed: false });
      if (!phoneConfirmed) await chrome.storage.local.set({ phoneConfirmed: true });
    }
    await pushRuntime({ configured: true, peerOnline: !!msg.phone, error: '' });
    return;
  }
  if (msg.t === 'sent') {
    const waiter = pendingSends.get(msg.id);
    if (waiter) {
      pendingSends.delete(msg.id);
      waiter(!!msg.delivered);
    }
    await updateThreadItem(msg.id, { status: msg.delivered ? 'delivered' : 'stored' });
    await dropOutgoing(msg.id);
    const notice = pendingNotices.get(msg.id);
    if (notice) {
      pendingNotices.delete(msg.id);
      notify(
        msg.delivered ? 'Delivered to your phone' : 'Saved for your phone',
        msg.delivered ? notice : 'Your phone is offline. It will arrive when it reconnects.',
      );
    }
    return;
  }
  if (msg.t === 'delivered') {
    await updateThreadItem(msg.id, { status: 'delivered' });
    return;
  }
  if (msg.t === 'msg') {
    await handleIncoming(msg);
  }
}

async function flushOutbox() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const config = await getConfig();
  if (!config.key) return;
  let key;
  try { key = await importRoomKey(config.key); } catch { return; }
  const entries = await takeOutbox();
  for (const entry of entries) {
    if (outboxInflight.has(entry.id)) continue;
    outboxInflight.add(entry.id);
    try {
      const payload = await encryptJson(key, entry.envelope);
      ws.send(JSON.stringify({ t: 'send', id: entry.id, kind: entry.kind, payload }));
    } catch {
      outboxInflight.delete(entry.id);
    }
  }
}

async function handleIncoming(msg) {
  const config = await getConfig();
  if (!config.key) return;
  const { inbox = [] } = await chrome.storage.local.get({ inbox: [] });
  if (inbox.some((entry) => entry.id === msg.id)) {
    ack(msg.id);
    return;
  }
  let envelope;
  try {
    const key = await importRoomKey(config.key);
    envelope = await decryptJson(key, msg.payload);
  } catch {
    ack(msg.id);
    return;
  }

  const kind = envelope.kind === 'file' ? 'file' : envelope.kind === 'link' ? 'link' : 'text';
  const settings = await getSettings();
  const item = {
    id: msg.id,
    dir: 'in',
    kind,
    text: String(envelope.text || '').slice(0, MAX_TEXT),
    url: isHttpUrl(envelope.url) ? String(envelope.url) : '',
    title: String(envelope.title || '').slice(0, 300),
    file: null,
    ts: msg.ts || Date.now(),
    read: false,
    error: '',
  };

  if (kind === 'link' && !item.url && isHttpUrl(item.text)) item.url = item.text;

  if (kind === 'file' && envelope.file && envelope.file.id) {
    item.file = {
      id: String(envelope.file.id),
      name: String(envelope.file.name || 'file').slice(0, 200),
      mime: String(envelope.file.mime || 'application/octet-stream').slice(0, 120),
      size: Number(envelope.file.size) || 0,
      iv: String(envelope.file.iv || ''),
    };
    try {
      const cipher = await downloadFile(config.serverUrl, config.room, config.token, item.file.id);
      const key = await importRoomKey(config.key);
      const plain = await decryptBytes(key, cipher, item.file.iv);
      if (settings.autoDownload) {
        await downloadToDisk(item.file.name, item.file.mime, plain);
        item.downloaded = true;
        deleteFile(config.serverUrl, config.room, config.token, item.file.id);
      }
    } catch (err) {
      item.error = err.message || 'Could not fetch the file.';
    }
  }

  if (kind === 'link' && item.url && settings.autoOpenLinks) {
    chrome.tabs.create({ url: item.url }).catch(() => {});
  }
  if (kind === 'text' && settings.autoCopyText) {
    await copyToClipboard(item.text).catch(() => {});
  }

  const unread = await addInboxItem(item);
  await setBadge(unread);
  ack(msg.id);

  if (kind === 'file') {
    notify(
      item.error ? 'File could not be delivered' : 'File from your phone',
      item.error || item.file.name,
    );
  } else if (kind === 'link') {
    notify('Link from your phone', item.title || item.url || 'Open PocketPigeon');
  } else {
    notify('Text from your phone', item.text.slice(0, 120) || 'Open PocketPigeon');
  }
}

function ack(id) {
  if (!id || !ws || ws.readyState !== WebSocket.OPEN) return;
  try { ws.send(JSON.stringify({ t: 'ack', ids: [id] })); } catch {}
}

/* ---------------- offscreen: clipboard + downloads ---------------- */

async function ensureOffscreen() {
  if (offscreenPromise) return offscreenPromise;
  offscreenPromise = (async () => {
    try {
      if (chrome.runtime.getContexts) {
        const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
        if (contexts.length) return;
      }
    } catch {}
    try {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['CLIPBOARD', 'BLOBS'],
        justification: 'Copy received text and save received files to disk',
      });
    } catch (err) {
      if (!String(err && err.message).includes('Only a single offscreen')) throw err;
    }
  })().finally(() => { offscreenPromise = null; });
  return offscreenPromise;
}

async function copyToClipboard(text) {
  await ensureOffscreen();
  return chrome.runtime.sendMessage({ target: 'offscreen', type: 'copy', text });
}

function sanitizeFileName(name) {
  const raw = String(name || 'pocketpigeon-file').trim();
  const cleaned = raw
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .slice(0, 160);
  return cleaned || 'pocketpigeon-file';
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function downloadToDisk(name, mime, bytes) {
  const filename = sanitizeFileName(name);
  const type = mime || 'application/octet-stream';
  const dataB64 = bytesToBase64(bytes);
  let url = '';
  try {
    await ensureOffscreen();
    const prepared = await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'blob',
      name: filename,
      mime: type,
      dataB64,
    });
    if (prepared && prepared.ok && prepared.url) url = prepared.url;
  } catch {}
  if (!url) {
    url = `data:${type};base64,${dataB64}`;
  }
  const id = await chrome.downloads.download({
    url,
    filename,
    saveAs: false,
    conflictAction: 'uniquify',
  });
  if (typeof id !== 'number' || id <= 0) throw new Error('The browser refused the download.');
  return { ok: true, id };
}

function base64ToBytes(text) {
  const bin = atob(String(text || ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/* ---------------- sending ---------------- */

async function sendEnvelope(envelope, { notifyMe = false } = {}) {
  const config = await getConfig();
  if (!config.room || !config.key) throw new Error('Pair your phone first.');
  const key = await importRoomKey(config.key);
  const id = newId();
  const payload = await encryptJson(key, envelope);
  await enqueueOutgoing({ id, kind: envelope.kind, envelope });
  const open = ws && ws.readyState === WebSocket.OPEN;
  await appendThreadItem({
    id,
    dir: 'out',
    kind: envelope.kind,
    text: envelope.text || '',
    url: envelope.url || '',
    title: envelope.title || '',
    file: envelope.file || null,
    ts: Date.now(),
    status: open ? 'sending' : 'queued',
  });
  let delivered;
  if (open) {
    const sent = waitForSent(id);
    try {
      ws.send(JSON.stringify({ t: 'send', id, kind: envelope.kind, payload }));
    } catch {
      try { ws.close(); } catch {}
      await updateThreadItem(id, { status: 'queued' });
      connect().catch(() => {});
      return { ok: true, id, queued: true, delivered: undefined };
    }
    if (notifyMe) pendingNotices.set(id, envelope.kind === 'link' ? 'The link is on its way.' : 'Sent.');
    delivered = await sent;
    await updateThreadItem(id, {
      status: delivered === false ? 'stored' : delivered === true ? 'delivered' : 'sent',
    });
  } else {
    if (notifyMe) notify('Saved for your phone', 'The phone is offline. It will arrive when it reconnects.');
    connect().catch(() => {});
  }
  return { ok: true, id, queued: !open, delivered };
}

function waitForSent(id, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingSends.delete(id);
      resolve(undefined);
    }, timeoutMs);
    pendingSends.set(id, (delivered) => {
      clearTimeout(timer);
      resolve(delivered);
    });
  });
}

function deliveryMessage(result) {
  if (result.queued) return 'Saved — waiting for the relay.';
  if (result.delivered === false) return 'Saved — your phone is offline. It will arrive when it reconnects.';
  if (result.delivered === true) return 'Delivered to your phone.';
  return 'Sent.';
}

async function sendText(text, options) {
  const clean = String(text || '').trim();
  if (!clean) throw new Error('There is nothing to send.');
  if (clean.length > MAX_TEXT) throw new Error('That text is too long.');
  const url = isHttpUrl(clean) ? clean : '';
  return sendEnvelope({ kind: url ? 'link' : 'text', text: clean, url }, options);
}

async function sendPage(url, title, options) {
  if (!isShareableUrl(url)) throw new Error('This browser page has no shareable link.');
  const cleanTitle = String(title || '').trim().slice(0, 300);
  const text = cleanTitle ? `${cleanTitle}\n${url}` : url;
  return sendEnvelope({ kind: 'link', url, title: cleanTitle, text }, options);
}

async function sendFile(name, mime, data, options) {
  const config = await getConfig();
  if (!config.room) throw new Error('Pair your phone first.');
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.byteLength > maxFileBytes()) {
    throw new Error(`That file is over the ${Math.round(maxFileBytes() / (1024 * 1024))} MB limit.`);
  }
  const key = await importRoomKey(config.key);
  const { iv, data: cipher } = await encryptBytes(key, bytes);
  const id = newId();
  await uploadFile(config.serverUrl, config.room, config.token, id, cipher);
  return sendEnvelope({
    kind: 'file',
    text: '',
    file: {
      id,
      name: String(name || 'file').slice(0, 200),
      mime: String(mime || 'application/octet-stream').slice(0, 120),
      size: bytes.byteLength,
      iv,
    },
  }, options);
}

async function sendImage(srcUrl) {
  if (!srcUrl || !isHttpUrl(srcUrl)) {
    if (String(srcUrl || '').startsWith('data:image/')) {
      return sendImageAsFile(srcUrl, 'image');
    }
    throw new Error('That image has no shareable address.');
  }
  const hasHosts = await chrome.permissions.contains({ origins: ['<all_urls>'] }).catch(() => false);
  if (hasHosts) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      const res = await fetch(srcUrl, { signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
      clearTimeout(timer);
      if (res.ok) {
        const blob = await res.blob();
        if (blob.size <= maxFileBytes()) {
          const name = fileNameFromUrl(srcUrl, blob.type);
          const buffer = new Uint8Array(await blob.arrayBuffer());
          return sendFile(name, blob.type || 'image/*', buffer, { notifyMe: true });
        }
      }
    } catch {}
  }
  const result = await sendEnvelope({ kind: 'link', url: srcUrl, title: 'Image', text: srcUrl }, { notifyMe: true });
  notify('Sent the image link', 'Enable “Fetch images from sites” in settings to deliver the file itself.');
  return result;
}

async function sendImageAsFile(dataUrl, fallbackName) {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  const buffer = new Uint8Array(await blob.arrayBuffer());
  return sendFile(`${fallbackName}.${(blob.type.split('/')[1] || 'png').split('+')[0]}`, blob.type, buffer, { notifyMe: true });
}

function fileNameFromUrl(url, mime) {
  try {
    const last = new URL(url).pathname.split('/').pop() || '';
    const clean = decodeURIComponent(last).replace(/[^\w.\- ]+/g, '_').slice(0, 120);
    if (clean && clean.includes('.')) return clean;
  } catch {}
  const ext = (String(mime || '').split('/')[1] || 'bin').split('+')[0].replace(/[^a-z0-9]/gi, '');
  return `image-${Date.now()}.${ext || 'bin'}`;
}

/* ---------------- pairing ---------------- */

function normalizeSiteUrl(value) {
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

function resolvePhoneTargets(siteValue, relayValue) {
  const relay = normalizeSiteUrl(relayValue);
  const site = normalizeSiteUrl(siteValue);
  const useSite = !!site && site.startsWith('https://') && relay.startsWith('https://');
  const appBase = useSite ? `${site}/` : `${relay}/`;
  return { appBase, relayBase: relay };
}

async function pairNew(serverUrlInput) {
  const serverUrl = normalizeServer(serverUrlInput);
  const info = await fetchInfo(serverUrl);
  const relay = phoneBase(serverUrl, info);
  const settings = await getSettings();
  const { appBase } = resolvePhoneTargets(settings.phoneSiteUrl, relay);
  const room = roomId();
  const token = randomB64u(24);
  const key = randomB64u(32);
  await createRoom(serverUrl, room, token);
  await savePairing({ room, token, key, phoneBase: appBase, relayBase: relay });
  await saveSettings({ serverUrl });
  const code = await safetyCode(key);
  await reconnect();
  return {
    ok: true,
    invite: inviteUrl(appBase, room, token, key, relay),
    safetyCode: code,
    serverUrl,
    phoneBase: appBase,
    relayBase: relay,
  };
}

async function unpair() {
  await clearPairing();
  await setBadge(0);
  await reconnect();
  return { ok: true };
}

/* ---------------- state ---------------- */

async function getState() {
  const [config, settings, local] = await Promise.all([getConfig(), getSettings(), chrome.storage.local.get({ inbox: [], unread: 0, outbox: [], phoneConfirmed: false })]);
  const configured = !!(config.room && config.token && config.key);
  const relay = config.relayBase || config.phoneBase || settings.serverUrl;
  const { appBase } = resolvePhoneTargets(settings.phoneSiteUrl || config.phoneBase, relay);
  const code = configured ? await safetyCode(config.key).catch(() => '—') : '';
  return {
    ok: true,
    configured,
    connected: !!runtime.connected,
    peerOnline: !!runtime.peerOnline,
    phoneSeen: !!local.phoneConfirmed,
    error: runtime.error || '',
    serverUrl: settings.serverUrl,
    phoneBase: appBase,
    relayBase: relay,
    invite: configured ? inviteUrl(appBase, config.room, config.token, config.key, relay) : '',
    safetyCode: code,
    settings: {
      deviceName: settings.deviceName,
      phoneSiteUrl: settings.phoneSiteUrl,
      theme: settings.theme,
      autoOpenLinks: settings.autoOpenLinks,
      autoCopyText: settings.autoCopyText,
      autoDownload: settings.autoDownload,
    },
    limits: runtime.limits,
    inbox: local.inbox,
    unread: local.unread,
    outboxCount: local.outbox.length,
  };
}

/* ---------------- notifications ---------------- */

function notify(title, message) {
  const id = `pp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const pending = chrome.notifications.create(id, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: String(title || 'PocketPigeon').slice(0, 80),
      message: String(message || '').slice(0, 220),
      priority: 0,
    });
    if (pending && typeof pending.catch === 'function') pending.catch(() => {});
  } catch {}
}

async function openPopup() {
  try {
    await chrome.action.openPopup();
    return;
  } catch {}
  chrome.tabs.create({ url: chrome.runtime.getURL('popup/popup.html') }).catch(() => {});
}

function notifyPairing() {
  notify('Pair your phone', 'Click the PocketPigeon icon and scan the code to get started.');
}

/* ---------------- context menus and commands ---------------- */

function installMenus() {
  chrome.contextMenus.removeAll(() => {
    void chrome.runtime.lastError;
    const items = [
      ['send-image', 'Send image to phone', ['image']],
      ['send-link', 'Send link to phone', ['link']],
      ['send-selection', 'Send text to phone', ['selection']],
      ['send-page', 'Send this page to phone', ['page']],
    ];
    for (const [id, title, contexts] of items) {
      chrome.contextMenus.create({ id, title, contexts }, () => { void chrome.runtime.lastError; });
    }
  });
}

async function configuredOrNotify() {
  const config = await getConfig();
  if (config.room && config.key) return true;
  notifyPairing();
  return false;
}

async function handleMenuClick(info, tab) {
  if (!(await configuredOrNotify())) return;
  try {
    if (info.menuItemId === 'send-image') {
      await sendImage(info.srcUrl);
      return;
    }
    if (info.menuItemId === 'send-link') {
      if (!isHttpUrl(info.linkUrl)) throw new Error('That link cannot be sent.');
      await sendEnvelope({ kind: 'link', url: info.linkUrl, title: '', text: info.linkUrl }, { notifyMe: true });
      return;
    }
    if (info.menuItemId === 'send-selection') {
      await sendText(info.selectionText, { notifyMe: true });
      return;
    }
    if (info.menuItemId === 'send-page') {
      const url = (tab && tab.url) || info.pageUrl;
      await sendPage(url, tab?.title, { notifyMe: true });
    }
  } catch (err) {
    notify('Could not send', err.message || 'Something went wrong.');
  }
}

async function handleCommand(command) {
  if (command !== 'send-page') return;
  if (!(await configuredOrNotify())) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !isShareableUrl(tab.url)) throw new Error('This page has no shareable link.');
    await sendPage(tab.url, tab.title, { notifyMe: true });
  } catch (err) {
    notify('Could not send', err.message || 'Something went wrong.');
  }
}

/* ---------------- popup messages ---------------- */

async function handleMessage(msg) {
  if (!msg || typeof msg !== 'object') return { ok: false, error: 'bad_message' };
  switch (msg.type) {
    case 'GET_STATE':
      return getState();
    case 'PAIR':
      return pairNew(msg.serverUrl);
    case 'REFRESH_BASE': {
      const config = await getConfig();
      if (!config.room || !config.token || !config.key) {
        return { ok: false, error: 'Pair a phone first.' };
      }
      let relay = config.relayBase || config.phoneBase || config.serverUrl;
      try {
        const info = await fetchInfo(config.serverUrl);
        relay = phoneBase(config.serverUrl, info);
      } catch {}
      const { appBase } = resolvePhoneTargets(config.phoneSiteUrl || config.phoneBase, relay);
      await chrome.storage.local.set({ phoneBase: appBase, relayBase: relay });
      return {
        ok: true,
        invite: inviteUrl(appBase, config.room, config.token, config.key, relay),
        phoneBase: appBase,
        relayBase: relay,
        safetyCode: await safetyCode(config.key),
      };
    }
    case 'UNPAIR':
      return unpair();
    case 'CHECK_SERVER': {
      const info = await fetchInfo(msg.serverUrl);
      return { ok: true, info, phoneBase: phoneBase(msg.serverUrl, info) };
    }
    case 'SEND_TEXT': {
      const result = await sendText(msg.text);
      return { ...result, message: deliveryMessage(result) };
    }
    case 'SEND_PAGE': {
      const result = await sendPage(msg.url, msg.title);
      return { ...result, message: deliveryMessage(result) };
    }
    case 'SEND_FILE': {
      if (!msg.dataB64) throw new Error('The file data was missing.');
      const result = await sendFile(msg.name, msg.mime, base64ToBytes(msg.dataB64));
      return { ...result, message: deliveryMessage(result) };
    }
    case 'SAVE_SETTINGS': {
      const patch = msg.patch || {};
      if (patch.serverUrl !== undefined) {
        const normalized = normalizeServer(patch.serverUrl);
        const before = await getSettings();
        const local = await chrome.storage.local.get({ room: '' });
        if (normalized !== before.serverUrl && local.room) {
          await clearPairing();
          await setBadge(0);
          await saveSettings({ ...patch, serverUrl: normalized });
          await reconnect();
          return { ok: true, unpaired: true, message: 'Saved. Pair your phone again on the new relay.' };
        }
        patch.serverUrl = normalized;
      }
      const settings = await saveSettings(patch);
      if (patch.deviceName !== undefined) reconnect();
      return { ok: true, settings };
    }
    case 'MARK_READ': {
      const inbox = await markInboxRead();
      await setBadge(0);
      return { ok: true, inbox };
    }
    case 'CLEAR_INBOX':
      await clearInbox();
      await chrome.storage.local.set({ outbox: [] });
      outboxInflight.clear();
      await setBadge(0);
      return { ok: true };
    case 'OPEN_ITEM': {
      const { inbox = [] } = await chrome.storage.local.get({ inbox: [] });
      const item = inbox.find((entry) => entry.id === msg.id);
      if (!item) return { ok: false, error: 'That item is gone.' };
      if (item.kind === 'link' && item.url) {
        await chrome.tabs.create({ url: item.url });
        return { ok: true };
      }
      if (item.kind === 'text') {
        await copyToClipboard(item.text);
        return { ok: true, copied: true };
      }
      if (item.kind === 'file' && item.file) {
        if (item.downloaded) return { ok: true, already: true };
        const config = await getConfig();
        const cipher = await downloadFile(config.serverUrl, config.room, config.token, item.file.id);
        const key = await importRoomKey(config.key);
        const plain = await decryptBytes(key, cipher, item.file.iv);
        await downloadToDisk(item.file.name, item.file.mime, plain);
        await updateThreadItem(item.id, { downloaded: true, error: '' });
        return { ok: true, saved: true };
      }
      return { ok: true };
    }
    case 'RETRY':
      await reconnect();
      return { ok: true };
    case 'OPEN_POPUP':
      await openPopup();
      return { ok: true };
    default:
      return { ok: false, error: 'unknown_message' };
  }
}

/* ---------------- events ---------------- */

chrome.runtime.onInstalled.addListener((details) => {
  installMenus();
  chrome.alarms.create('pigeon-keepalive', { periodInMinutes: 0.5 });
  getConfig().then((config) => {
    if (config.room && config.key) connect().catch(() => {});
    else if (details.reason === 'install') notifyPairing();
  });
});

chrome.runtime.onStartup.addListener(() => {
  installMenus();
  connect().catch(() => {});
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  handleMenuClick(info, tab).catch(() => {});
});

chrome.commands.onCommand.addListener((command) => {
  handleCommand(command).catch(() => {});
});

chrome.notifications.onClicked.addListener((id) => {
  chrome.notifications.clear(id);
  openPopup();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'pigeon-keepalive') return;
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify({ t: 'ping' })); } catch {}
  } else {
    connect().catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target === 'offscreen') return false;
  if (sender && sender.id !== chrome.runtime.id) return false;
  handleMessage(msg)
    .then((result) => sendResponse(result))
    .catch((err) => sendResponse({ ok: false, error: err?.message || 'Unexpected error' }));
  return true;
});

/* ---------------- boot ---------------- */

chrome.alarms.create('pigeon-keepalive', { periodInMinutes: 0.5 });
getConfig().then((config) => {
  if (config.room && config.key) connect().catch(() => {});
  else setConfiguredState(false);
}).catch(() => {});
