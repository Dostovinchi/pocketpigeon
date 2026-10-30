import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

const PORT = Number(process.env.PORT || 8787);
const PUBLIC_URL = String(process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const MAX_FILE_BYTES = Number(process.env.MAX_FILE_BYTES || 10 * 1024 * 1024);
const MAX_ROOM_FILE_BYTES = Number(process.env.MAX_ROOM_FILE_BYTES || 200 * 1024 * 1024);
const MAX_TOTAL_FILE_BYTES = Number(process.env.MAX_TOTAL_FILE_BYTES || 512 * 1024 * 1024);
const MESSAGE_TTL_MS = Number(process.env.MESSAGE_TTL_MS || 24 * 60 * 60 * 1000);
const FILE_TTL_MS = Number(process.env.FILE_TTL_MS || 60 * 60 * 1000);
const FILE_AFTER_DOWNLOAD_MS = Number(process.env.FILE_AFTER_DOWNLOAD_MS || 10 * 60 * 1000);
const ROOM_TTL_MS = 48 * 60 * 60 * 1000;
const MAX_QUEUE = 500;
const MAX_PAYLOAD_CHARS = 300000;
const MAX_SOCKETS = 8;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

const ROOM_RE = /^[A-Za-z0-9_-]{4,32}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;
const FILE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

const rooms = new Map();
let totalFileBytes = 0;

function now() {
  return Date.now();
}

function roomFor(id, token, create = false) {
  let room = rooms.get(id);
  if (!room && create) {
    room = {
      id,
      token,
      createdAt: now(),
      touchedAt: now(),
      sockets: new Map(),
      queue: new Map(),
      files: new Map(),
      fileBytes: 0,
    };
    rooms.set(id, room);
  }
  if (!room) return null;
  if (room.token !== token) return null;
  room.touchedAt = now();
  return room;
}

function presenceOf(room) {
  return {
    t: 'presence',
    pc: room.sockets.has('pc'),
    phone: room.sockets.has('phone'),
    ts: now(),
  };
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(data);
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Room-Token');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('bad_json'));
      }
    });
    req.on('error', reject);
  });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function tokenMatches(given, expected) {
  if (typeof given !== 'string' || given.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

function clientIp(req) {
  return String(req.socket.remoteAddress || '');
}

const roomAttempts = new Map();
function allowRoomCreate(ip) {
  const t = now();
  const list = (roomAttempts.get(ip) || []).filter((ts) => t - ts < 60 * 60 * 1000);
  if (list.length >= 40) return false;
  list.push(t);
  roomAttempts.set(ip, list);
  return true;
}

function lanUrls() {
  const urls = [];
  const nets = os.networkInterfaces();
  for (const [name, entries] of Object.entries(nets)) {
    if (/tailscale|virtualbox|vmware|vethernet|hyper-v/i.test(name)) continue;
    for (const entry of entries || []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      if (entry.address.startsWith('169.254.')) continue;
      const [a, b] = entry.address.split('.').map(Number);
      if (a === 100 && b >= 64 && b <= 127) continue;
      urls.push(`http://${entry.address}:${PORT}`);
    }
  }
  const score = (url) => {
    const ip = url.slice(7, url.lastIndexOf(':'));
    if (ip.startsWith('192.168.56.')) return 5;
    if (ip.startsWith('192.168.1.')) return 0;
    if (ip.startsWith('192.168.')) return 1;
    if (ip.startsWith('10.')) return 2;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 3;
    return 4;
  };
  return [...new Set(urls)].sort((x, y) => score(x) - score(y)).slice(0, 5);
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.resolve(PUBLIC_DIR, `.${rel}`);
  const relative = path.relative(PUBLIC_DIR, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative) || relative.split(path.sep).some((part) => part.startsWith('.'))) {
    sendJson(res, 404, { ok: false, error: 'not_found' });
    return;
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      sendJson(res, 404, { ok: false, error: 'not_found' });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.webmanifest': 'application/manifest+json; charset=utf-8',
      '.png': 'image/png',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
      '.woff2': 'font/woff2',
    };
    const cache = ext === '.png' || ext === '.svg' || ext === '.woff2'
      ? 'public, max-age=86400'
      : 'no-store';
    res.writeHead(200, {
      'Content-Type': types[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': cache,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' blob: data:",
        "connect-src 'self' ws: wss: blob:",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
      ].join('; '),
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  try {
    if (pathname === '/api/health' && req.method === 'GET') {
      sendJson(res, 200, {
        ok: true,
        rooms: rooms.size,
        uptimeSec: Math.round(process.uptime()),
      });
      return;
    }

    if (pathname === '/api/info' && req.method === 'GET') {
      sendJson(res, 200, {
        ok: true,
        name: 'PocketPigeon',
        version: '1.0.0',
        publicUrl: PUBLIC_URL || null,
        lanUrls: lanUrls(),
        limits: {
          maxFileBytes: MAX_FILE_BYTES,
          messageTtlMs: MESSAGE_TTL_MS,
          fileTtlMs: FILE_TTL_MS,
        },
      });
      return;
    }

    if (pathname === '/api/rooms' && req.method === 'POST') {
      if (!allowRoomCreate(clientIp(req))) {
        sendJson(res, 429, { ok: false, error: 'rate_limited' });
        return;
      }
      const body = await readJson(req);
      const roomId = String(body.room || '');
      const token = String(body.token || '');
      if (!ROOM_RE.test(roomId) || !TOKEN_RE.test(token)) {
        sendJson(res, 400, { ok: false, error: 'invalid_room' });
        return;
      }
      const existing = rooms.get(roomId);
      if (existing && !tokenMatches(token, existing.token)) {
        sendJson(res, 409, { ok: false, error: 'room_taken' });
        return;
      }
      const room = roomFor(roomId, token, true);
      sendJson(res, existing ? 200 : 201, { ok: true, existing: !!existing, room: room.id });
      return;
    }

    const fileMatch = pathname.match(/^\/api\/files\/([^/]+)\/([^/]+)$/);
    if (fileMatch) {
      const [, roomId, fileId] = fileMatch;
      const token = String(req.headers['x-room-token'] || '');
      if (!ROOM_RE.test(roomId) || !FILE_ID_RE.test(fileId)) {
        sendJson(res, 400, { ok: false, error: 'invalid_path' });
        return;
      }
      const room = roomFor(roomId, token);
      if (!room) {
        sendJson(res, 401, { ok: false, error: 'unauthorized' });
        return;
      }

      if (req.method === 'POST') {
        const length = Number(req.headers['content-length'] || 0);
        if (!Number.isFinite(length) || length <= 0) {
          sendJson(res, 411, { ok: false, error: 'length_required' });
          return;
        }
        if (length > MAX_FILE_BYTES) {
          sendJson(res, 413, { ok: false, error: 'file_too_large', maxFileBytes: MAX_FILE_BYTES });
          return;
        }
        if (room.fileBytes + length > MAX_ROOM_FILE_BYTES) {
          sendJson(res, 507, { ok: false, error: 'room_storage_full' });
          return;
        }
        if (totalFileBytes + length > MAX_TOTAL_FILE_BYTES) {
          sendJson(res, 507, { ok: false, error: 'relay_storage_full' });
          return;
        }
        const buffer = await readBody(req, MAX_FILE_BYTES);
        room.files.set(fileId, {
          buffer,
          size: buffer.length,
          createdAt: now(),
          expiresAt: now() + FILE_TTL_MS,
          downloaded: false,
        });
        room.fileBytes += buffer.length;
        totalFileBytes += buffer.length;
        sendJson(res, 201, { ok: true, size: buffer.length, expiresAt: now() + FILE_TTL_MS });
        return;
      }

      if (req.method === 'GET') {
        const file = room.files.get(fileId);
        if (!file) {
          sendJson(res, 404, { ok: false, error: 'not_found' });
          return;
        }
        file.downloaded = true;
        file.expiresAt = Math.min(file.expiresAt, now() + FILE_AFTER_DOWNLOAD_MS);
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': file.size,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(file.buffer);
        return;
      }

      if (req.method === 'DELETE') {
        const file = room.files.get(fileId);
        if (file) {
          room.fileBytes -= file.size;
          totalFileBytes = Math.max(0, totalFileBytes - file.size);
          room.files.delete(fileId);
        }
        sendJson(res, 200, { ok: true });
        return;
      }
    }

    if (pathname.startsWith('/api/')) {
      sendJson(res, 404, { ok: false, error: 'not_found' });
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
      return;
    }

    if (req.method === 'GET' && pathname === '/favicon.ico') {
      serveStatic(req, res, '/icons/icon-192.png');
      return;
    }

    serveStatic(req, res, pathname);
  } catch (err) {
    const code = err && err.message === 'body_too_large' ? 413 : 400;
    sendJson(res, code, { ok: false, error: (err && err.message) || 'bad_request' });
  }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_CHARS + 4096 });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (url.pathname !== '/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  const roomId = String(url.searchParams.get('room') || '');
  const token = String(url.searchParams.get('token') || '');
  const role = String(url.searchParams.get('role') || '');
  const device = String(url.searchParams.get('device') || '').slice(0, 40);
  if (!ROOM_RE.test(roomId) || !TOKEN_RE.test(token) || (role !== 'pc' && role !== 'phone')) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }
  const room = roomFor(roomId, token) || (rooms.has(roomId) ? null : roomFor(roomId, token, true));
  if (!room) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  if (room.sockets.size >= MAX_SOCKETS) {
    socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req, { room, role, device });
  });
});

wss.on('connection', (ws, req, ctx) => {
  const { room, role, device } = ctx;
  const previous = room.sockets.get(role);
  if (previous && previous !== ws) {
    try {
      previous.close(4001, 'replaced');
    } catch {}
  }
  room.sockets.set(role, ws);
  room.touchedAt = now();
  ws.isAlive = true;
  let messageBudget = 60;
  let windowStart = now();

  const senderName = device || (role === 'pc' ? 'computer' : 'phone');

  ws.send(JSON.stringify({
    t: 'ready',
    room: room.id,
    role,
    name: senderName,
    limits: {
      maxFileBytes: MAX_FILE_BYTES,
      maxPayloadChars: MAX_PAYLOAD_CHARS,
    },
  }));

  for (const item of room.queue.values()) {
    if (item.to !== role) continue;
    ws.send(JSON.stringify({
      t: 'msg',
      id: item.id,
      from: item.from,
      kind: item.kind,
      payload: item.payload,
      ts: item.ts,
      queued: true,
    }));
  }

  broadcastPresence(room);

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (data) => {
    ws.isAlive = true;

    let msg;
    try {
      msg = JSON.parse(data.toString('utf8'));
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    if (msg.t === 'ping') {
      ws.send(JSON.stringify({ t: 'pong', ts: now() }));
      return;
    }

    if (msg.t === 'ack') {
      const ids = Array.isArray(msg.ids) ? msg.ids : [];
      for (const id of ids.slice(0, 100)) {
        if (typeof id !== 'string') continue;
        const item = room.queue.get(id);
        if (item && item.to === role) {
          room.queue.delete(id);
          const sender = room.sockets.get(item.from);
          if (sender && sender.readyState === WebSocket.OPEN) {
            sender.send(JSON.stringify({ t: 'delivered', id, ts: now() }));
          }
        }
      }
      return;
    }

    if (msg.t === 'send') {
      const current = now();
      if (current - windowStart > 60_000) {
        windowStart = current;
        messageBudget = 60;
      }
      messageBudget -= 1;
      if (messageBudget < 0) {
        ws.close(4008, 'rate_limited');
        return;
      }
      const id = String(msg.id || '');
      const kind = String(msg.kind || 'text').slice(0, 24);
      const payload = typeof msg.payload === 'string' ? msg.payload : '';
      if (!FILE_ID_RE.test(id)) return;
      if (!payload || payload.length > MAX_PAYLOAD_CHARS) {
        ws.send(JSON.stringify({ t: 'error', code: 'payload_invalid', id }));
        return;
      }
      const to = role === 'pc' ? 'phone' : 'pc';
      const existing = room.queue.get(id);
      if (!existing) {
        room.queue.set(id, { id, from: role, to, kind, payload, ts: now() });
        if (room.queue.size > MAX_QUEUE) {
          const oldest = room.queue.keys().next().value;
          if (oldest) room.queue.delete(oldest);
        }
      }
      const target = room.sockets.get(to);
      const delivered = !!target && target.readyState === WebSocket.OPEN;
      if (delivered) {
        target.send(JSON.stringify({ t: 'msg', id, from: role, kind, payload, ts: now() }));
      }
      ws.send(JSON.stringify({ t: 'sent', id, delivered, ts: now() }));
      return;
    }
  });

  ws.on('close', () => {
    if (room.sockets.get(role) === ws) room.sockets.delete(role);
    room.touchedAt = now();
    broadcastPresence(room);
  });

  ws.on('error', () => {});
});

function broadcastPresence(room) {
  const payload = JSON.stringify(presenceOf(room));
  for (const ws of room.sockets.values()) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

const heartbeat = setInterval(() => {
  for (const room of rooms.values()) {
    for (const [role, ws] of room.sockets) {
      if (!ws.isAlive) {
        room.sockets.delete(role);
        try { ws.terminate(); } catch {}
        continue;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch {}
    }
  }
}, 30000);
heartbeat.unref?.();

const cleanup = setInterval(() => {
  const t = now();
  for (const [roomId, room] of rooms) {
    for (const [fileId, file] of room.files) {
      if (file.expiresAt <= t) {
        room.fileBytes -= file.size;
        totalFileBytes = Math.max(0, totalFileBytes - file.size);
        room.files.delete(fileId);
      }
    }
    for (const [id, item] of room.queue) {
      if (t - item.ts > MESSAGE_TTL_MS) room.queue.delete(id);
    }
    if (room.sockets.size === 0 && room.queue.size === 0 && room.files.size === 0 && t - room.touchedAt > ROOM_TTL_MS) {
      rooms.delete(roomId);
    }
  }
  for (const [ip, list] of roomAttempts) {
    const live = list.filter((ts) => t - ts < 60 * 60 * 1000);
    if (live.length) roomAttempts.set(ip, live);
    else roomAttempts.delete(ip);
  }
}, 60000);
cleanup.unref?.();

server.listen(PORT, '0.0.0.0', () => {
  const urls = lanUrls();
  console.log(`PocketPigeon relay on http://localhost:${PORT}`);
  for (const url of urls) console.log(`  phone: ${url}`);
  if (PUBLIC_URL) console.log(`  public: ${PUBLIC_URL}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
