import { originPattern } from '../lib/api.js';

const $ = (id) => document.getElementById(id);

const THEME_KEY = 'pocketpigeon.theme';
const themeMedia = window.matchMedia('(prefers-color-scheme: dark)');

let appState = null;
let activeTab = null;
let view = 'pair';
let settingsOpen = false;
let pairing = false;
let showPair = false;
let skipPairing = false;
let autoPairStarted = false;
let pairError = '';
let allowRetryVisible = false;
let qrDrawnFor = '';
let pollTimer = null;
let toastTimer = null;
let themePref = document.documentElement.dataset.themePref || 'system';

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

async function saveThemePreference(pref) {
  applyTheme(pref, { persist: true });
  if (appState && appState.settings) appState.settings.theme = themePref;
  try {
    await send({ type: 'SAVE_SETTINGS', patch: { theme: themePref } });
  } catch {}
}

function bindTheme() {
  $('themeBtn').addEventListener('click', () => {
    const resolved = document.documentElement.dataset.theme;
    saveThemePreference(resolved === 'dark' ? 'light' : 'dark');
  });
  document.querySelectorAll('#themeSegmented [data-theme-choice]').forEach((choice) => {
    choice.addEventListener('click', () => saveThemePreference(choice.dataset.themeChoice || 'system'));
  });
  if (themeMedia.addEventListener) {
    themeMedia.addEventListener('change', () => {
      if (themePref === 'system') applyTheme('system');
    });
  }
}

function send(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(response);
    });
  });
}

function toast(text) {
  const node = $('toast');
  node.textContent = text;
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 2600);
}

function isHttp(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function hostOf(value) {
  try { return new URL(value).host; } catch { return ''; }
}

function truncate(text, max) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function formatSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function bufferToBase64(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/* ---------------- boot ---------------- */

document.addEventListener('DOMContentLoaded', init);

async function init() {
  bindTheme();
  bindHeader();
  bindPairView();
  bindMainView();
  bindSettings();
  applyTheme(themePref);

  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTab = tabs && tabs[0];
  } catch {
    activeTab = null;
  }
  renderTabCard();

  await refresh({ first: true });
  pollTimer = setInterval(() => refresh({ quiet: true }).catch(() => {}), 2000);
}

/* ---------------- state refresh ---------------- */

async function refresh({ first = false, quiet = false } = {}) {
  let next;
  try {
    next = await send({ type: 'GET_STATE' });
  } catch (err) {
    if (!quiet) setStatus('offline', 'Worker unavailable');
    return;
  }
  if (!next || next.ok !== true) return;
  const wasEmpty = !appState;
  appState = next;
  if (wasEmpty) {
    const storedTheme = appState.settings?.theme || 'system';
    applyTheme(storedTheme, { persist: true });
    if (appState.configured) {
      try {
        const refreshed = await send({ type: 'REFRESH_BASE' });
        if (refreshed && refreshed.ok) {
          appState.invite = refreshed.invite;
          appState.phoneBase = refreshed.phoneBase;
          appState.relayBase = refreshed.relayBase;
          appState.safetyCode = refreshed.safetyCode;
        }
      } catch {}
    }
  }

  updateStatus();
  updateCommon();

  if (settingsOpen) {
    // Leave form fields alone while the user is editing.
  } else {
    decideView();
  }

  if (view === 'pair') renderPair();
  if (view === 'main') renderMain();
  if (view === 'main' && !quiet) markRead();
  if (view === 'settings') updateSettingsLive();

  if (first) {
    if (!appState.configured && !settingsOpen && !pairing && !autoPairStarted) {
      ensurePairing();
    }
    if (appState.configured && appState.unread > 0) markRead();
  }
}

async function markRead() {
  if (!appState || !appState.unread) return;
  try {
    const res = await send({ type: 'MARK_READ' });
    if (res && res.ok) {
      appState.inbox = res.inbox;
      appState.unread = 0;
      renderChat();
    }
  } catch {}
}

function decideView() {
  if (!appState) return;
  if (settingsOpen) return;
  if (!appState.configured) {
    setView('pair');
    return;
  }
  if (showPair) {
    setView('pair');
    return;
  }
  if (!appState.phoneSeen && !skipPairing) {
    setView('pair');
    return;
  }
  setView('main');
}

function setView(name) {
  view = name;
  $('pairView').hidden = name !== 'pair';
  $('mainView').hidden = name !== 'main';
  $('settingsView').hidden = name !== 'settings';
  $('settingsBtn').hidden = name === 'settings';
  $('backBtn').hidden = name !== 'settings';
  if (name === 'main') {
    renderTabCard();
    renderMain();
    markRead();
  }
  if (name === 'pair') renderPair();
}

/* ---------------- status / common ---------------- */

function setStatus(kind, text) {
  $('statusPill').className = `status ${kind === 'neutral' ? '' : kind}`.trim();
  $('statusText').textContent = text;
}

function updateStatus() {
  if (!appState) return;
  if (!appState.configured) {
    setStatus('neutral', 'Not paired');
    return;
  }
  if (appState.peerOnline) setStatus('online', 'Phone online');
  else if (appState.connected) setStatus('offline', 'Phone offline');
  else setStatus('offline', 'Connecting…');
}

function updateCommon() {
  const code = appState?.safetyCode || '';
  $('pairSafetyCode').textContent = code || '—';
  $('settingsSafetyCode').textContent = code || '—';
  $('chatSafety').textContent = code || '—';
  $('footCode').textContent = code ? `code ${code}` : '';
  $('footText').textContent = appState?.configured ? 'End-to-end encrypted' : 'Pair a phone to start';
}

/* ---------------- pairing view ---------------- */

function bindPairView() {
  $('copyInviteBtn').addEventListener('click', copyInvite);
  $('copyInviteBtn2').addEventListener('click', copyInvite);
  $('openPhoneBtn').addEventListener('click', () => {
    if (!appState?.invite) return;
    chrome.tabs.create({ url: appState.invite }).catch(() => {});
  });
  $('skipPairBtn').addEventListener('click', () => {
    skipPairing = true;
    showPair = false;
    setView('main');
  });
  $('retryPairBtn').addEventListener('click', () => {
    autoPairStarted = false;
    pairError = '';
    ensurePairing();
  });
  $('allowRetryBtn').addEventListener('click', async () => {
    try {
      const granted = await chrome.permissions.request({ origins: [originPattern(appState?.serverUrl || 'http://localhost:8787')] });
      if (!granted) {
        pairError = 'Relay access was not granted.';
        renderPair();
        return;
      }
      autoPairStarted = false;
      pairError = '';
      ensurePairing();
    } catch (err) {
      pairError = err.message || 'Could not request relay access.';
      renderPair();
    }
  });
}

async function ensurePairing() {
  if (pairing) return;
  if (!appState) return;
  autoPairStarted = true;
  pairing = true;
  pairError = '';
  allowRetryVisible = false;
  renderPair();
  try {
    const result = await send({ type: 'PAIR', serverUrl: appState.serverUrl });
    if (!result || !result.ok) throw new Error(result?.error || 'Pairing failed.');
    appState = await send({ type: 'GET_STATE' });
    showPair = false;
    skipPairing = false;
    qrDrawnFor = '';
    updateStatus();
    updateCommon();
    renderPair();
    if (appState?.phoneSeen) decideView();
  } catch (err) {
    pairError = err.message || 'Could not create a room.';
    allowRetryVisible = /Could not reach|Failed to fetch|NetworkError|Relay/i.test(pairError);
    renderPair();
  } finally {
    pairing = false;
    renderPair();
  }
}

function renderPair() {
  const configured = !!appState?.configured;
  const invite = appState?.invite || '';
  const text = $('qrStateText');
  const stateEl = $('qrState');

  $('inviteInput').value = invite;
  $('openPhoneBtn').disabled = !invite;
  $('skipPairBtn').hidden = !configured;

  if (!configured && pairing) {
    text.textContent = 'Preparing an encrypted room…';
    stateEl.classList.remove('ok');
    drawQr('');
  } else if (!configured) {
    text.textContent = pairError ? 'Pairing needs attention' : 'Preparing…';
    stateEl.classList.remove('ok');
  } else if (appState.peerOnline) {
    text.textContent = 'Phone connected';
    stateEl.classList.add('ok');
    drawQr(invite);
  } else if (appState.connected) {
    text.textContent = 'Waiting for your phone…';
    stateEl.classList.remove('ok');
    drawQr(invite);
  } else {
    text.textContent = 'Connecting to the relay…';
    stateEl.classList.remove('ok');
    drawQr(invite);
  }

  $('qrSpinner').hidden = !pairing && (appState?.peerOnline || false);
  $('pairError').hidden = !pairError;
  $('pairErrorText').textContent = pairError;
  $('allowRetryBtn').hidden = !allowRetryVisible;
  $('retryPairBtn').hidden = !!invite;

  if (!invite) {
    drawQr('');
    if (configured) {
      $('pairError').hidden = false;
      $('pairErrorText').textContent = 'This pairing is missing its invite. Unpair in settings and pair again.';
    }
  }
}

function drawQr(text) {
  const canvas = $('qrCanvas');
  const ctx = canvas.getContext('2d');
  if (canvas.width !== 424) {
    canvas.width = 424;
    canvas.height = 424;
    qrDrawnFor = '';
  }
  if (qrDrawnFor === text) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!text) {
    qrDrawnFor = '';
    return;
  }
  if (typeof window.qrcode !== 'function') {
    $('qrStateText').textContent = 'QR library did not load.';
    return;
  }
  try {
    const qr = window.qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const count = qr.getModuleCount();
    const quiet = 3;
    const scale = Math.max(4, Math.floor(canvas.width / (count + quiet * 2)));
    const size = scale * (count + quiet * 2);
    const offset = Math.floor((canvas.width - size) / 2);
    ctx.fillStyle = '#191b1f';
    for (let row = 0; row < count; row += 1) {
      for (let col = 0; col < count; col += 1) {
        if (qr.isDark(row, col)) {
          ctx.fillRect(offset + (col + quiet) * scale, offset + (row + quiet) * scale, scale, scale);
        }
      }
    }
    qrDrawnFor = text;
  } catch (err) {
    $('qrStateText').textContent = 'Could not render the QR code.';
  }
}

async function copyInvite() {
  if (!appState?.invite) {
    toast('No invite link yet.');
    return;
  }
  try {
    await navigator.clipboard.writeText(appState.invite);
    toast('Invite link copied.');
  } catch {
    const field = $('inviteInput');
    field.select();
    document.execCommand('copy');
    toast('Invite link copied.');
  }
}

/* ---------------- main view ---------------- */

function bindHeader() {
  $('settingsBtn').addEventListener('click', openSettings);
  $('backBtn').addEventListener('click', closeSettings);
}

function bindMainView() {
  $('sendTabCard').addEventListener('click', sendActiveTab);
  $('chatQrBtn').addEventListener('click', openPairView);
  $('composerForm').addEventListener('submit', (event) => {
    event.preventDefault();
    sendComposedText();
  });
  $('composerInput').addEventListener('input', () => {
    growComposer();
    $('sendBtn').disabled = !$('composerInput').value.trim();
  });
  $('composerInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendComposedText();
    }
  });
  $('attachBtn').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', async (event) => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    for (const file of files) await sendOneFile(file);
  });
}

function growComposer() {
  const input = $('composerInput');
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 100)}px`;
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function formatTime(ts) {
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(new Date(ts || Date.now()));
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

function linkifyInto(container, text) {
  const pattern = /(https?:\/\/[^\s<>"']+)/g;
  let last = 0;
  let match;
  while ((match = pattern.exec(text))) {
    if (match.index > last) container.append(document.createTextNode(text.slice(last, match.index)));
    const raw = match[0];
    const url = raw.replace(/[.,;:!?)]+$/, '');
    const trailing = raw.slice(url.length);
    if (isHttp(url)) {
      container.append(el('a', { href: url, target: '_blank', rel: 'noopener noreferrer', text: url }));
    } else {
      container.append(document.createTextNode(url));
    }
    if (trailing) container.append(document.createTextNode(trailing));
    last = match.index + raw.length;
  }
  if (last < text.length) container.append(document.createTextNode(text.slice(last)));
  if (!text) container.append(document.createTextNode(''));
}

function statusLabel(item) {
  const labels = {
    sending: 'Sending…',
    queued: 'Queued',
    delivered: 'Delivered',
    stored: 'Saved on relay',
    sent: 'Sent',
    failed: 'Failed',
  };
  return labels[item.status] || 'Sent';
}

function renderTabCard() {
  const card = $('sendTabCard');
  if (!activeTab || !isHttp(activeTab.url)) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  card.disabled = false;
  card.title = activeTab.url;
  $('tabTitle').textContent = activeTab.title || hostOf(activeTab.url) || 'This tab';
}

async function sendActiveTab() {
  if (!activeTab || !isHttp(activeTab.url)) return;
  const card = $('sendTabCard');
  card.disabled = true;
  try {
    const res = await send({ type: 'SEND_PAGE', url: activeTab.url, title: activeTab.title || '' });
    if (!res || !res.ok) throw new Error(res?.error || 'Could not send.');
    toast(res.message || 'Sent.');
    await refresh({ quiet: true });
    scrollChatToEnd();
  } catch (err) {
    toast(err.message || 'Could not send.');
  } finally {
    card.disabled = false;
  }
}

async function sendComposedText() {
  const input = $('composerInput');
  const text = input.value.trim();
  if (!text) return;
  const button = $('sendBtn');
  button.disabled = true;
  $('composerStatus').textContent = 'Sending…';
  try {
    const res = await send({ type: 'SEND_TEXT', text });
    if (!res || !res.ok) throw new Error(res?.error || 'Could not send.');
    input.value = '';
    input.style.height = '';
    $('composerStatus').textContent = '';
    toast(res.message || 'Sent.');
    await refresh({ quiet: true });
    scrollChatToEnd();
  } catch (err) {
    $('composerStatus').textContent = '';
    toast(err.message || 'Could not send.');
  } finally {
    button.disabled = !input.value.trim();
  }
}

async function sendOneFile(file) {
  const limit = Number(appState?.limits?.maxFileBytes || 10 * 1024 * 1024);
  if (file.size > limit) {
    toast(`${file.name} is over the ${formatSize(limit)} limit.`);
    return;
  }
  const status = $('composerStatus');
  status.textContent = `Sending ${truncate(file.name, 24)}…`;
  try {
    const buffer = await file.arrayBuffer();
    const res = await send({
      type: 'SEND_FILE',
      name: file.name,
      mime: file.type || 'application/octet-stream',
      dataB64: bufferToBase64(buffer),
    });
    if (!res || !res.ok) throw new Error(res?.error || 'Could not send the file.');
    toast(res.message || 'File sent.');
    await refresh({ quiet: true });
    scrollChatToEnd();
  } catch (err) {
    toast(err.message || 'Could not send the file.');
  } finally {
    status.textContent = '';
  }
}

let chatSignature = '';

function renderMain() {
  renderTabCard();
  renderChat();
}

function renderChat(force = false) {
  if (!appState) return;
  const items = (appState.inbox || []).slice().sort((a, b) => (a.ts || 0) - (b.ts || 0));
  $('chatSafety').textContent = appState.safetyCode || '—';
  const signature = items
    .map((item) => `${item.id}:${item.dir}:${item.status || ''}:${item.read ? 1 : 0}:${item.downloaded ? 1 : 0}:${item.error || ''}`)
    .join('|');
  if (!force && signature === chatSignature) {
    $('emptyChat').hidden = items.length > 0;
    return;
  }
  chatSignature = signature;

  const list = $('chatList');
  const scroller = $('chatScroll');
  const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
  list.replaceChildren();
  let lastDay = '';
  for (const item of items) {
    const day = formatDay(item.ts);
    if (day !== lastDay) {
      lastDay = day;
      list.append(el('div', { class: 'chat-day', text: day }));
    }
    list.append(chatRow(item));
  }
  $('emptyChat').hidden = items.length > 0;
  if (items.length && nearBottom) scrollChatToEnd();
}

function chatRow(item) {
  const direction = item.dir === 'out' ? 'out' : 'in';
  const row = el('div', { class: `msg ${direction}` });
  row.append(chatBubble(item));
  row.append(chatMeta(item));
  return row;
}

function chatBubble(item) {
  const bubble = el('div', { class: 'bubble' });
  if (item.kind === 'file' && item.file) {
    const file = item.file;
    const icon = el('span', { class: 'file-icon', html: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5zm0 2.5L16.5 8H14V5.5z"/></svg>' });
    const copy = el('div', {}, [
      el('div', { class: 'file-name', text: file.name || 'File' }),
      el('div', { class: 'file-size', text: item.error || formatSize(file.size) }),
    ]);
    let action = null;
    if (item.dir !== 'out') {
      if (item.error) {
        action = el('span', { class: 'file-action', text: 'Expired' });
      } else if (item.downloaded) {
        action = el('span', { class: 'file-action', text: 'Saved' });
      } else {
        action = el('button', {
          class: 'file-action',
          type: 'button',
          text: 'Save',
          onclick: () => saveFileItem(item),
        });
      }
    }
    const card = el('div', { class: 'file-card' }, [icon, copy, action]);
    bubble.append(card);
    return bubble;
  }

  if (item.kind === 'link' && isHttp(item.url)) {
    if (item.title) bubble.append(el('span', { class: 'title', text: item.title }));
    bubble.append(el('a', {
      href: item.url,
      target: '_blank',
      rel: 'noopener noreferrer',
      class: 'url',
      text: item.url,
    }));
    return bubble;
  }

  const text = el('div', { class: 'text' });
  linkifyInto(text, item.text || '');
  bubble.append(text);
  return bubble;
}

function chatMeta(item) {
  const meta = el('div', { class: 'chat-meta' });
  meta.append(el('span', { text: formatTime(item.ts) }));
  if (item.dir === 'out') {
    meta.append(el('span', { text: statusLabel(item) }));
  }
  if (item.kind === 'link' && isHttp(item.url)) {
    meta.append(el('button', {
      type: 'button',
      text: 'Open',
      onclick: () => chrome.tabs.create({ url: item.url }).catch(() => {}),
    }));
  } else if (item.kind !== 'file' && item.text) {
    meta.append(el('button', {
      type: 'button',
      text: 'Copy',
      onclick: () => copyText(item.text),
    }));
  }
  return meta;
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

async function saveFileItem(item) {
  try {
    const res = await send({ type: 'OPEN_ITEM', id: item.id });
    if (!res || !res.ok) throw new Error(res?.error || 'Could not save that file.');
    toast(res.already ? 'Already saved.' : 'Saved to your downloads.');
    await refresh({ quiet: true });
  } catch (err) {
    toast(err.message || 'Could not save that file.');
  }
}

function scrollChatToEnd() {
  const scroller = $('chatScroll');
  if (scroller) scroller.scrollTop = scroller.scrollHeight;
}

/* ---------------- settings ---------------- */

function openSettings() {
  settingsOpen = true;
  setView('settings');
  renderSettings();
}

function openPairView() {
  settingsOpen = false;
  showPair = true;
  skipPairing = false;
  view = 'pair';
  setView('pair');
  if (!appState?.configured) {
    autoPairStarted = false;
    ensurePairing();
    return;
  }
  send({ type: 'REFRESH_BASE' })
    .then((refreshed) => {
      if (refreshed && refreshed.ok && appState) {
        appState.invite = refreshed.invite;
        appState.phoneBase = refreshed.phoneBase;
        appState.relayBase = refreshed.relayBase;
        appState.safetyCode = refreshed.safetyCode;
        updateCommon();
        renderPair();
      }
    })
    .catch(() => {});
}

function closeSettings() {
  settingsOpen = false;
  view = 'pair';
  decideView();
}

function bindSettings() {
  $('saveSettingsBtn').addEventListener('click', saveSettingsFromForm);
  $('testRelayBtn').addEventListener('click', testRelay);
  $('clearChatBtn').addEventListener('click', async () => {
    if (!confirm('Clear this conversation on this browser? Your phone keeps its copy.')) return;
    try {
      await send({ type: 'CLEAR_INBOX' });
      if (appState) {
        appState.inbox = [];
        appState.unread = 0;
      }
      chatSignature = '';
      renderChat(true);
      toast('Conversation cleared.');
    } catch (err) {
      toast(err.message || 'Could not clear the conversation.');
    }
  });
  $('showPairBtn').addEventListener('click', () => {
    openPairView();
  });
  $('unpairBtn').addEventListener('click', async () => {
    if (!confirm('Unpair this browser? The room key will be removed from this device.')) return;
    try {
      await send({ type: 'UNPAIR' });
      appState = await send({ type: 'GET_STATE' });
      showPair = false;
      skipPairing = false;
      autoPairStarted = false;
      settingsOpen = false;
      view = 'pair';
      setView('pair');
      updateStatus();
      updateCommon();
      ensurePairing();
    } catch (err) {
      toast(err.message || 'Could not unpair.');
    }
  });
  $('allowImages').addEventListener('change', async (event) => {
    const wants = event.target.checked;
    try {
      if (wants) {
        const granted = await chrome.permissions.request({ origins: ['<all_urls>'] });
        if (!granted) event.target.checked = false;
      } else {
        await chrome.permissions.remove({ origins: ['<all_urls>'] });
      }
    } catch {
      event.target.checked = !wants;
    }
  });
}

async function renderSettings() {
  if (!appState) return;
  $('serverUrlInput').value = appState.serverUrl || '';
  $('deviceNameInput').value = appState.settings.deviceName || '';
  $('phoneSiteUrlInput').value = appState.settings.phoneSiteUrl || '';
  $('autoOpenLinks').checked = !!appState.settings.autoOpenLinks;
  $('autoCopyText').checked = !!appState.settings.autoCopyText;
  $('autoDownload').checked = !!appState.settings.autoDownload;
  $('settingsMsg').textContent = '';
  $('relayStatus').textContent = '';
  try {
    const hasImages = await chrome.permissions.contains({ origins: ['<all_urls>'] });
    $('allowImages').checked = hasImages;
  } catch {
    $('allowImages').checked = false;
  }
  updateThemeControls();
  updateCommon();
}

function updateSettingsLive() {
  updateCommon();
  if (!settingsOpen) return;
  if (document.activeElement !== $('serverUrlInput')) $('serverUrlInput').value = appState.serverUrl || '';
  if (document.activeElement !== $('deviceNameInput')) $('deviceNameInput').value = appState.settings.deviceName || '';
  if (document.activeElement !== $('phoneSiteUrlInput')) $('phoneSiteUrlInput').value = appState.settings.phoneSiteUrl || '';
}

async function testRelay() {
  const serverUrl = $('serverUrlInput').value.trim();
  $('relayStatus').textContent = 'Testing…';
  try {
    const res = await send({ type: 'CHECK_SERVER', serverUrl });
    if (!res || !res.ok) throw new Error(res?.error || 'No answer.');
    $('relayStatus').textContent = `Reachable · phone URL ${res.phoneBase}`;
  } catch (err) {
    $('relayStatus').textContent = err.message || 'Could not reach the relay.';
  }
}

async function saveSettingsFromForm() {
  const serverUrl = $('serverUrlInput').value.trim();
  const deviceName = $('deviceNameInput').value.trim() || 'Computer';
  const phoneSiteUrl = $('phoneSiteUrlInput').value.trim();
  if (!isHttp(serverUrl)) {
    $('settingsMsg').textContent = 'Enter a valid http(s) relay URL.';
    return;
  }
  if (phoneSiteUrl && !isHttp(phoneSiteUrl)) {
    $('settingsMsg').textContent = 'Enter a valid hosted phone URL or leave it empty.';
    return;
  }
  const patch = {
    serverUrl,
    deviceName,
    phoneSiteUrl,
    autoOpenLinks: $('autoOpenLinks').checked,
    autoCopyText: $('autoCopyText').checked,
    autoDownload: $('autoDownload').checked,
  };
  $('settingsMsg').textContent = 'Saving…';
  try {
    const res = await send({ type: 'SAVE_SETTINGS', patch });
    if (!res || !res.ok) throw new Error(res?.error || 'Could not save settings.');
    appState = await send({ type: 'GET_STATE' });
    $('settingsMsg').textContent = res.message || 'Saved.';
    updateStatus();
    updateCommon();
    if (res.unpaired) {
      toast('Server changed. Pair your phone again.');
      closeSettings();
      autoPairStarted = false;
      ensurePairing();
    } else if (!appState.configured) {
      autoPairStarted = false;
      ensurePairing();
    }
  } catch (err) {
    $('settingsMsg').textContent = err.message || 'Could not save settings.';
  }
}
