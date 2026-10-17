// LAN screen-share signaling server.
//   Sender (Chrome on this Mac):  http://localhost:8090/
//   Receiver (TV dashboard):      index.html?...&share=<mac-ip>:8090&key=<token>
// Media flows peer-to-peer over WebRTC; this server only relays offers/answers/candidates.
// Only pages served from this Mac's loopback address may act as sender; receivers need the key.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT) || 8090;
const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(DIR, '..');
const TOKEN_FILE = path.join(DIR, '.token');

const token = loadToken();
const lanIps = Object.values(os.networkInterfaces()).flat()
  .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);

function loadToken() {
  try {
    const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (t) return t;
  } catch {}
  const t = crypto.randomBytes(12).toString('hex');
  fs.writeFileSync(TOKEN_FILE, t + '\n', { mode: 0o600 });
  return t;
}

function isLoopback(req) {
  const a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

function sameKey(k) {
  const a = Buffer.from(String(k || ''));
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---- static files ----
const FILES = {
  '/': { file: path.join(DIR, 'sender.html'), type: 'text/html', local: true },
  '/receiver.html': { file: path.join(DIR, 'receiver.html'), type: 'text/html' },
  '/share.js': { file: path.join(ROOT, 'share.js'), type: 'text/javascript' },
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/config' && isLoopback(req)) {
    const ip = lanIps[0] || '127.0.0.1';
    return send(res, 200, 'application/json', JSON.stringify({ lanIps, port: PORT, tvParams: `&share=${ip}:${PORT}&key=${token}` }));
  }
  const f = FILES[url.pathname];
  if (!f || (f.local && !isLoopback(req))) return send(res, 404, 'text/plain', 'not found');
  fs.readFile(f.file, (err, buf) => (err ? send(res, 500, 'text/plain', String(err)) : send(res, 200, f.type, buf)));
});

function send(res, code, type, body) {
  res.writeHead(code, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

// ---- signaling ----
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 256 * 1024 });
const receivers = new Map(); // id -> ws
let sender = null;
let sharing = false;
let nextId = 1;

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  const role = url.searchParams.get('role');
  const reject = (code, msg) => { socket.end(`HTTP/1.1 ${code} ${msg}\r\n\r\n`); };
  if (url.pathname !== '/ws') return reject(404, 'Not Found');
  if (role === 'sender') {
    // The sender must be a page served by this server on loopback. Checking Origin stops any other
    // website open in Chrome from connecting to ws://localhost and pushing its own video to the TV.
    const origin = req.headers.origin || '';
    if (!isLoopback(req) || !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return reject(403, 'Forbidden');
  } else if (role === 'receiver') {
    if (!sameKey(url.searchParams.get('k'))) return reject(401, 'Unauthorized');
  } else {
    return reject(400, 'Bad Request');
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.alive = true;
    ws.on('pong', () => { ws.alive = true; });
    if (role === 'sender') onSender(ws); else onReceiver(ws, req);
  });
});

function json(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function onSender(ws) {
  if (sender) { json(sender, { type: 'replaced' }); sender.close(); }
  sender = ws;
  sharing = false;
  log('sender connected');
  json(ws, { type: 'receivers', list: [...receivers].map(([id, r]) => ({ id, addr: r.addr })) });

  ws.on('message', async (data) => {
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (ws !== sender) return;
    if (m.type === 'state') {
      sharing = !!m.sharing;
      log(sharing ? 'share started' : 'share stopped');
      if (!sharing) receivers.forEach((r) => json(r, { type: 'stop' }));
    } else if (m.type === 'offer' || m.type === 'candidate') {
      const r = receivers.get(m.to);
      if (!r) return;
      if (m.type === 'candidate') m.candidate = await unmaskCandidate(m.candidate);
      json(r, m.type === 'offer' ? { type: 'offer', sdp: m.sdp } : { type: 'candidate', candidate: m.candidate });
    }
  });
  ws.on('close', () => {
    if (ws !== sender) return;
    sender = null;
    if (sharing) receivers.forEach((r) => json(r, { type: 'stop' }));
    sharing = false;
    log('sender disconnected');
  });
}

function onReceiver(ws, req) {
  const id = String(nextId++);
  ws.addr = (req.socket.remoteAddress || '').replace('::ffff:', '');
  receivers.set(id, ws);
  log(`receiver ${id} connected from ${ws.addr}`);
  json(sender, { type: 'receiver-joined', id, addr: ws.addr });

  ws.on('message', (data) => {
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (m.type === 'answer' || m.type === 'candidate' || m.type === 'stats') json(sender, { ...m, from: id });
  });
  ws.on('close', () => {
    receivers.delete(id);
    json(sender, { type: 'receiver-left', id });
    log(`receiver ${id} disconnected`);
  });
}

// Chrome hides host IPs behind random "<uuid>.local" mDNS names. The sender runs on this Mac, so we
// can resolve them here and hand the TV a plain IP; its WebView then needs no mDNS support.
const mdnsCache = new Map();
async function unmaskCandidate(c) {
  const m = c && c.candidate && c.candidate.match(/ ([0-9a-f-]{36}\.local) /i);
  if (!m) return c;
  let ip = mdnsCache.get(m[1]);
  if (ip === undefined) {
    ip = await Promise.race([
      dns.lookup(m[1], { family: 4 }).then((r) => r.address, () => null),
      new Promise((r) => setTimeout(() => r(null), 1500)),
    ]);
    mdnsCache.set(m[1], ip);
  }
  return ip ? { ...c, candidate: c.candidate.replace(m[1], ip) } : c;
}

// Drop dead connections (e.g. the TV went to standby) so the sender's receiver list stays accurate.
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.alive === false) return ws.terminate();
    ws.alive = false;
    ws.ping();
  });
}, 10000);

function log(s) {
  console.log(new Date().toLocaleTimeString('en-GB'), s);
}

server.listen(PORT, '0.0.0.0', () => {
  const ip = lanIps[0] || '<mac-ip>';
  console.log(`Screen share server on port ${PORT}`);
  console.log(`  Sender (open in Chrome on this Mac): http://localhost:${PORT}/`);
  console.log(`  Add to the TV dashboard URL:          &share=${ip}:${PORT}&key=${token}`);
});
