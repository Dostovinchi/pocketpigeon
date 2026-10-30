export const DEFAULT_SERVER = 'http://localhost:8787';

const SYNC_DEFAULTS = {
  serverUrl: DEFAULT_SERVER,
  deviceName: 'Computer',
  phoneSiteUrl: 'https://dostovinchi.github.io/pocketpigeon/',
  theme: 'system',
  autoOpenLinks: true,
  autoCopyText: true,
  autoDownload: true,
};

const LOCAL_DEFAULTS = {
  room: '',
  token: '',
  key: '',
  phoneBase: '',
  relayBase: '',
  pairedAt: 0,
  phoneConfirmed: false,
  inbox: [],
  unread: 0,
  outbox: [],
  runtime: { connected: false, peerOnline: false, error: '', checkedAt: 0 },
};

export async function getSettings() {
  return chrome.storage.sync.get(SYNC_DEFAULTS);
}

export async function saveSettings(patch) {
  const allowed = {};
  for (const key of Object.keys(SYNC_DEFAULTS)) {
    if (patch[key] !== undefined) allowed[key] = patch[key];
  }
  await chrome.storage.sync.set(allowed);
  return getSettings();
}

export async function getLocal() {
  return chrome.storage.local.get(LOCAL_DEFAULTS);
}

export async function getConfig() {
  const [settings, local] = await Promise.all([getSettings(), getLocal()]);
  return { ...settings, ...local };
}

export async function isConfigured() {
  const local = await getLocal();
  return !!(local.room && local.token && local.key);
}

export async function savePairing({ room, token, key, phoneBase, relayBase }) {
  await chrome.storage.local.set({
    room,
    token,
    key,
    phoneBase,
    relayBase: relayBase || '',
    pairedAt: Date.now(),
    phoneConfirmed: false,
    outbox: [],
    runtime: { connected: false, peerOnline: false, error: '', checkedAt: Date.now() },
  });
}

export async function clearPairing() {
  await chrome.storage.local.set({
    room: '',
    token: '',
    key: '',
    phoneBase: '',
    relayBase: '',
    pairedAt: 0,
    phoneConfirmed: false,
    outbox: [],
    runtime: { connected: false, peerOnline: false, error: '', checkedAt: Date.now() },
  });
}

export async function setRuntime(runtime) {
  await chrome.storage.local.set({
    runtime: { ...runtime, checkedAt: Date.now() },
  });
}

export async function enqueueOutgoing(entry) {
  const { outbox = [] } = await chrome.storage.local.get({ outbox: [] });
  if (!outbox.some((item) => item.id === entry.id)) outbox.push(entry);
  await chrome.storage.local.set({ outbox: outbox.slice(-50) });
}

export async function dropOutgoing(id) {
  const { outbox = [] } = await chrome.storage.local.get({ outbox: [] });
  const next = outbox.filter((item) => item.id !== id);
  await chrome.storage.local.set({ outbox: next });
}

export async function takeOutbox() {
  const { outbox = [] } = await chrome.storage.local.get({ outbox: [] });
  return outbox;
}

const HISTORY_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_THREAD = 300;

export async function appendThreadItem(item, { unread = false } = {}) {
  const { inbox = [], unread: previous = 0 } = await chrome.storage.local.get({ inbox: [], unread: 0 });
  const cutoff = Date.now() - HISTORY_MS;
  const next = inbox
    .filter((entry) => (entry.ts || 0) > cutoff && entry.id !== item.id)
    .slice(-(MAX_THREAD - 1));
  next.push(item);
  const nextUnread = unread ? Math.min(999, previous + 1) : previous;
  await chrome.storage.local.set({ inbox: next, unread: nextUnread });
  return { inbox: next, unread: nextUnread };
}

export async function updateThreadItem(id, patch) {
  const { inbox = [] } = await chrome.storage.local.get({ inbox: [] });
  let changed = false;
  const next = inbox.map((entry) => {
    if (entry.id !== id) return entry;
    changed = true;
    return { ...entry, ...patch };
  });
  if (changed) await chrome.storage.local.set({ inbox: next });
  return next;
}

export async function addInboxItem(item) {
  const { unread } = await appendThreadItem(item, { unread: true });
  return unread;
}

export async function markInboxRead() {
  const { inbox = [] } = await chrome.storage.local.get({ inbox: [] });
  const next = inbox.map((item) => (item.read ? item : { ...item, read: true }));
  await chrome.storage.local.set({ inbox: next, unread: 0 });
  return next;
}

export async function clearInbox() {
  await chrome.storage.local.set({ inbox: [], unread: 0 });
}

export async function removeInboxItem(id) {
  const { inbox = [] } = await chrome.storage.local.get({ inbox: [] });
  await chrome.storage.local.set({ inbox: inbox.filter((item) => item.id !== id) });
}

export async function setBadge(count) {
  await chrome.action.setBadgeBackgroundColor({ color: '#f2542d' });
  await chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
}
