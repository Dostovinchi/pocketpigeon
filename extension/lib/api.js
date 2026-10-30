export function normalizeServer(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('Enter the relay URL.');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('That relay URL is not valid.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('The relay URL must start with http:// or https://.');
  }
  url.hash = '';
  url.search = '';
  return url.toString().replace(/\/+$/, '');
}

export function originPattern(serverUrl) {
  const url = new URL(normalizeServer(serverUrl));
  return `${url.origin}/*`;
}

export function isLocalHost(serverUrl) {
  try {
    const host = new URL(serverUrl).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

async function request(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal, cache: 'no-store' });
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchInfo(serverUrl) {
  const base = normalizeServer(serverUrl);
  let res;
  try {
    res = await request(`${base}/api/info`, { method: 'GET' }, 8000);
  } catch {
    throw new Error('Could not reach the relay. Is the server running?');
  }
  if (!res.ok) throw new Error(`The relay answered ${res.status}.`);
  const info = await res.json();
  if (!info || info.ok !== true) throw new Error('That address is not a PocketPigeon relay.');
  return info;
}

export function phoneBase(serverUrl, info) {
  const base = normalizeServer(serverUrl);
  if (info && info.publicUrl) return String(info.publicUrl).replace(/\/+$/, '');
  if (isLocalHost(base) && Array.isArray(info?.lanUrls) && info.lanUrls.length) {
    return String(info.lanUrls[0]).replace(/\/+$/, '');
  }
  return base;
}

export async function createRoom(serverUrl, room, token) {
  const base = normalizeServer(serverUrl);
  const res = await request(`${base}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ room, token }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) {
    if (body.error === 'room_taken') throw new Error('That room is already in use. Try pairing again.');
    throw new Error(body.error || `The relay answered ${res.status}.`);
  }
  return body;
}

export async function uploadFile(serverUrl, room, token, fileId, data) {
  const base = normalizeServer(serverUrl);
  const res = await request(
    `${base}/api/files/${encodeURIComponent(room)}/${encodeURIComponent(fileId)}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Room-Token': token,
      },
      body: data,
    },
    60000,
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) {
    if (body.error === 'file_too_large') throw new Error('That file is larger than the relay allows.');
    throw new Error(body.error || 'The file upload failed.');
  }
  return body;
}

export async function downloadFile(serverUrl, room, token, fileId) {
  const base = normalizeServer(serverUrl);
  const res = await request(
    `${base}/api/files/${encodeURIComponent(room)}/${encodeURIComponent(fileId)}`,
    {
      method: 'GET',
      headers: { 'X-Room-Token': token },
    },
    60000,
  );
  if (!res.ok) {
    if (res.status === 404) throw new Error('That file has expired.');
    throw new Error('Could not fetch the file.');
  }
  return new Uint8Array(await res.arrayBuffer());
}

export async function deleteFile(serverUrl, room, token, fileId) {
  try {
    const base = normalizeServer(serverUrl);
    await request(
      `${base}/api/files/${encodeURIComponent(room)}/${encodeURIComponent(fileId)}`,
      { method: 'DELETE', headers: { 'X-Room-Token': token } },
      8000,
    );
  } catch {}
}

export function socketUrl(serverUrl, room, token, role, device) {
  const url = new URL(normalizeServer(serverUrl));
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/ws`;
  url.search = new URLSearchParams({
    room,
    token,
    role,
    device: device || role,
  }).toString();
  return url.toString();
}

export function inviteUrl(base, room, token, key, relayBase = '') {
  const site = String(base).replace(/\/+$/, '');
  const relay = String(relayBase || '').replace(/\/+$/, '');
  const includeRelay = relay && relay !== site;
  const relayParam = includeRelay ? `&s=${encodeURIComponent(relay)}` : '';
  return `${site}/#r=${encodeURIComponent(room)}&t=${encodeURIComponent(token)}&k=${encodeURIComponent(key)}${relayParam}`;
}
