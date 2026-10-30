const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64u(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64u(text) {
  const s = String(text).replace(/-/g, '+').replace(/_/g, '/');
  const pad = s + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function randomB64u(n) {
  return b64u(randomBytes(n));
}

export function roomId() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(10);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

export function newId() {
  return randomB64u(16);
}

export async function importRoomKey(keyB64u) {
  const raw = unb64u(keyB64u);
  if (raw.length !== 32) throw new Error('bad_key');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptJson(key, value) {
  const iv = randomBytes(12);
  const plain = enc.encode(JSON.stringify(value));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain);
  return JSON.stringify({ v: 1, i: b64u(iv), d: b64u(ct) });
}

export async function decryptJson(key, payload) {
  const pack = JSON.parse(payload);
  if (!pack || pack.v !== 1 || !pack.i || !pack.d) throw new Error('bad_payload');
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64u(pack.i) },
    key,
    unb64u(pack.d),
  );
  return JSON.parse(dec.decode(plain));
}

export async function encryptBytes(key, buffer) {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, buffer);
  return { iv: b64u(iv), data: new Uint8Array(ct) };
}

export async function decryptBytes(key, buffer, ivB64u) {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64u(ivB64u) },
    key,
    buffer,
  );
  return new Uint8Array(plain);
}

export async function safetyCode(keyB64u) {
  const raw = unb64u(keyB64u);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', raw));
  const num = ((digest[0] << 16) | (digest[1] << 8) | digest[2]) % 1000000;
  return String(num).padStart(6, '0').replace(/(\d{3})(\d{3})/, '$1 $2');
}

export function isHttpUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export function isShareableUrl(value) {
  if (!isHttpUrl(value)) return false;
  try {
    const u = new URL(value);
    return !['chrome:', 'chrome-extension:', 'edge:', 'about:', 'devtools:'].includes(u.protocol);
  } catch {
    return false;
  }
}
