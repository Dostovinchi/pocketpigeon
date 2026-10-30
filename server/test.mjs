import { WebSocket } from 'ws';

const BASE = 'http://localhost:8787';
const room = `T${Math.random().toString(36).slice(2, 11).toUpperCase()}`;
const token = `tok_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
let failures = 0;

function check(name, ok, extra = '') {
  if (ok) console.log(`PASS ${name}${extra ? ` — ${extra}` : ''}`);
  else {
    failures += 1;
    console.log(`FAIL ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

function connect(role) {
  const ws = new WebSocket(`ws://localhost:8787/ws?room=${room}&token=${token}&role=${role}&device=${role}`);
  const queue = [];
  const waiters = [];
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    const idx = waiters.findIndex((w) => w.match(msg));
    if (idx >= 0) {
      const [w] = waiters.splice(idx, 1);
      clearTimeout(w.timer);
      w.resolve(msg);
    } else {
      queue.push(msg);
    }
  });
  function next(match, timeout = 3000) {
    const idx = queue.findIndex(match);
    if (idx >= 0) return Promise.resolve(queue.splice(idx, 1)[0]);
    return new Promise((resolve, reject) => {
      const entry = { match, resolve };
      entry.timer = setTimeout(() => {
        const i = waiters.indexOf(entry);
        if (i >= 0) waiters.splice(i, 1);
        reject(new Error(`timeout waiting for ${match}`));
      }, timeout);
      waiters.push(entry);
    });
  }
  return { ws, next, close: () => ws.close() };
}

const created = await fetch(`${BASE}/api/rooms`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ room, token }),
});
check('create room', created.status === 201, `status ${created.status}`);

const info = await (await fetch(`${BASE}/api/info`)).json();
check('info identifies relay', info.ok === true && info.name === 'PocketPigeon');

const pc = connect('pc');
const readyPc = await pc.next((m) => m.t === 'ready');
check('pc ready', readyPc.role === 'pc');

const phone = connect('phone');
await phone.next((m) => m.t === 'ready');
const presence = await pc.next((m) => m.t === 'presence' && m.phone === true);
check('presence announces phone', presence.phone === true);

const id1 = 'testmsg01';
pc.ws.send(JSON.stringify({ t: 'send', id: id1, kind: 'text', payload: 'ciphertext-one' }));
const incoming = await phone.next((m) => m.t === 'msg' && m.id === id1);
check('pc to phone delivery', incoming.payload === 'ciphertext-one' && incoming.from === 'pc');
const sent = await pc.next((m) => m.t === 'sent' && m.id === id1);
check('sender sees delivered', sent.delivered === true);
phone.ws.send(JSON.stringify({ t: 'ack', ids: [id1] }));

const id2 = 'testmsg02';
phone.ws.send(JSON.stringify({ t: 'send', id: id2, kind: 'link', payload: 'ciphertext-two' }));
const back = await pc.next((m) => m.t === 'msg' && m.id === id2);
check('phone to pc delivery', back.payload === 'ciphertext-two' && back.from === 'phone');
pc.ws.send(JSON.stringify({ t: 'ack', ids: [id2] }));

const fileId = 'filetest01';
const bytes = Buffer.from('PocketPigeon encrypted payload test');
const upload = await fetch(`${BASE}/api/files/${room}/${fileId}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/octet-stream', 'X-Room-Token': token },
  body: bytes,
});
check('file upload', upload.status === 201);
const download = await fetch(`${BASE}/api/files/${room}/${fileId}`, { headers: { 'X-Room-Token': token } });
const downloaded = Buffer.from(await download.arrayBuffer());
check('file download matches', downloaded.equals(bytes));
const badAuth = await fetch(`${BASE}/api/files/${room}/${fileId}`, { headers: { 'X-Room-Token': 'nope' } });
check('file auth rejects wrong token', badAuth.status === 401);

phone.close();
await new Promise((r) => setTimeout(r, 250));
const id3 = 'queuedmsg1';
pc.ws.send(JSON.stringify({ t: 'send', id: id3, kind: 'text', payload: 'queued-payload' }));
const queuedSent = await pc.next((m) => m.t === 'sent' && m.id === id3);
check('queued send reports offline', queuedSent.delivered === false);

const phone2 = connect('phone');
await phone2.next((m) => m.t === 'ready');
const queued = await phone2.next((m) => m.t === 'msg' && m.id === id3);
check('offline message delivered on reconnect', queued.payload === 'queued-payload' && queued.queued === true);
phone2.ws.send(JSON.stringify({ t: 'ack', ids: [id3] }));

const page = await fetch(`${BASE}/`);
const html = await page.text();
check('phone app served', page.status === 200 && html.includes('PocketPigeon'));
const sw = await fetch(`${BASE}/sw.js`);
check('service worker served', sw.status === 200);

pc.close();
phone2.close();
await new Promise((r) => setTimeout(r, 200));
console.log(failures === 0 ? '\nALL RELAY TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
