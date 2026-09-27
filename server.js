import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import fs, { createReadStream, createWriteStream } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import selfsigned from 'selfsigned';
import { WebSocketServer, WebSocket } from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
const localDir = path.join(here, '.local');
const sharedDir = path.join(here, 'shared');
const publicDir = path.join(here, 'public');
const port = Number(process.env.PORT || 8765);
const pin = String(process.env.UWASH_PIN || crypto.randomInt(100000, 1000000));
const sessions = new Set();
const clients = new Set();
const failedPairs = new Map();
let clipboard = { text: '', updatedAt: null };
let microphoneActive = false;
let microphoneOwner = null;
let microphoneRate = 48000;

const addresses = [...new Set(Object.values(os.networkInterfaces()).flat().filter(x => x && x.family === 'IPv4' && !x.internal).map(x => x.address))];
await fsp.mkdir(localDir, { recursive: true });
await fsp.mkdir(sharedDir, { recursive: true });
const keyFile = path.join(localDir, 'key.pem');
const certFile = path.join(localDir, 'cert.pem');
if (!fs.existsSync(keyFile) || !fs.existsSync(certFile)) {
  const altNames = [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }, ...addresses.map(ip => ({ type: 7, ip }))];
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'u-wash local' }], {
    days: 365, keySize: 2048, extensions: [{ name: 'subjectAltName', altNames }]
  });
  await fsp.writeFile(keyFile, pems.private, { mode: 0o600 });
  await fsp.writeFile(certFile, pems.cert);
}

function send(res, code, data, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(type.startsWith('application/json') ? JSON.stringify(data) : data);
}
function authenticated(req) {
  const match = /(?:^|;\s*)uwash=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '');
  return !!match && sessions.has(match[1]);
}
function sameOrigin(req) {
  try { return new URL(req.headers.origin).host === req.headers.host; } catch { return false; }
}
function safePath(raw) {
  if (!raw || raw.length > 1000 || raw.includes('\0')) throw new Error('Invalid path');
  const parts = raw.replaceAll('\\', '/').split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || p.includes(':'))) throw new Error('Invalid path');
  const target = path.resolve(sharedDir, ...parts);
  if (path.relative(sharedDir, target).startsWith('..')) throw new Error('Invalid path');
  return target;
}
async function readJson(req, max = 64 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > max) throw new Error('Request too large'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
async function listFiles(dir = sharedDir, prefix = '', result = []) {
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    if (result.length >= 5000) break;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await listFiles(path.join(dir, entry.name), rel, result);
    else if (entry.isFile()) { const stat = await fsp.stat(path.join(dir, entry.name)); result.push({ path: rel, size: stat.size, updatedAt: stat.mtime.toISOString() }); }
  }
  return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
function broadcast(message, except) {
  for (const client of clients) if (client !== except && client.readyState === WebSocket.OPEN) client.send(message);
}

const server = https.createServer({ key: await fsp.readFile(keyFile), cert: await fsp.readFile(certFile) }, async (req, res) => {
  try {
    const url = new URL(req.url, `https://${req.headers.host}`);
    if (url.pathname === '/api/session' && req.method === 'GET') return send(res, 200, { paired: authenticated(req) });
    if (url.pathname === '/api/pair' && req.method === 'POST') {
      if (!sameOrigin(req)) return send(res, 403, { error: 'Invalid origin' });
      const ip = req.socket.remoteAddress;
      const attempts = failedPairs.get(ip) || { count: 0, until: 0 };
      if (attempts.until > Date.now()) return send(res, 429, { error: 'Too many attempts. Try again later.' });
      const body = await readJson(req);
      if (String(body.pin) !== pin) {
        attempts.count++;
        if (attempts.count >= 5) { attempts.count = 0; attempts.until = Date.now() + 60_000; }
        failedPairs.set(ip, attempts);
        return send(res, 401, { error: 'Wrong pairing code' });
      }
      failedPairs.delete(ip);
      const token = crypto.randomBytes(32).toString('hex'); sessions.add(token);
      res.writeHead(200, { 'Set-Cookie': `uwash=${token}; HttpOnly; Secure; SameSite=Strict; Path=/`, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ paired: true }));
    }
    if (url.pathname.startsWith('/api/')) {
      if (!authenticated(req)) return send(res, 401, { error: 'Pair first' });
      if (req.method !== 'GET' && !sameOrigin(req)) return send(res, 403, { error: 'Invalid origin' });
      if (url.pathname === '/api/files' && req.method === 'GET') return send(res, 200, { files: await listFiles() });
      if (url.pathname === '/api/clipboard' && req.method === 'GET') return send(res, 200, clipboard);
      if (url.pathname === '/api/clipboard' && req.method === 'POST') {
        const body = await readJson(req);
        if (typeof body.text !== 'string' || body.text.length > 50000) return send(res, 400, { error: 'Text must be under 50,000 characters' });
        clipboard = { text: body.text, updatedAt: new Date().toISOString() };
        broadcast(JSON.stringify({ type: 'clipboard', ...clipboard }));
        return send(res, 200, clipboard);
      }
      if (url.pathname === '/api/upload' && req.method === 'PUT') {
        const target = safePath(url.searchParams.get('path'));
        const max = 1024 * 1024 * 1024;
        const declared = Number(req.headers['content-length']);
        if (!Number.isFinite(declared) || declared < 0 || declared > max) return send(res, 413, { error: 'File limit is 1 GB' });
        await fsp.mkdir(path.dirname(target), { recursive: true });
        const temp = `${target}.${crypto.randomUUID()}.upload`;
        let received = 0;
        try {
          req.on('data', chunk => { received += chunk.length; if (received > max) req.destroy(); });
          await pipeline(req, createWriteStream(temp, { flags: 'wx' }));
          if (received !== declared) throw new Error('Incomplete upload');
          await fsp.rename(temp, target);
        } catch (error) { await fsp.rm(temp, { force: true }); throw error; }
        broadcast(JSON.stringify({ type: 'files-changed' }));
        return send(res, 200, { ok: true });
      }
      if (url.pathname === '/api/download' && req.method === 'GET') {
        const target = safePath(url.searchParams.get('path'));
        const stat = await fsp.stat(target);
        if (!stat.isFile()) return send(res, 404, { error: 'File not found' });
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': stat.size, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(target))}`, 'X-Content-Type-Options': 'nosniff' });
        return createReadStream(target).pipe(res);
      }
      return send(res, 404, { error: 'Not found' });
    }
    if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
    const files = { '/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css', '/audio-worklet.js': 'audio-worklet.js' };
    const file = files[url.pathname];
    if (!file) return send(res, 404, { error: 'Not found' });
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
    return send(res, 200, await fsp.readFile(path.join(publicDir, file)), types[path.extname(file)]);
  } catch (error) {
    if (!res.headersSent) send(res, error.code === 'ENOENT' ? 404 : 400, { error: error.message || 'Request failed' });
    else res.destroy();
  }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
server.on('upgrade', (req, socket, head) => {
  if (!authenticated(req) || !sameOrigin(req) || new URL(req.url, `https://${req.headers.host}`).pathname !== '/ws') return socket.destroy();
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
});
wss.on('connection', ws => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'state', microphoneActive, microphoneRate, clipboard }));
  ws.on('message', (data, isBinary) => {
    if (isBinary) { if (microphoneOwner === ws && data.length <= 256 * 1024) broadcast(data, ws); return; }
    try {
      const message = JSON.parse(data.toString());
      if (message.type === 'mic-start' && Number.isFinite(message.sampleRate) && message.sampleRate >= 8000 && message.sampleRate <= 192000) {
        if (microphoneOwner && microphoneOwner !== ws) return;
        microphoneActive = true; microphoneOwner = ws; microphoneRate = message.sampleRate;
        broadcast(JSON.stringify({ type: 'mic-start', sampleRate: microphoneRate }), ws);
      } else if (message.type === 'mic-stop' && microphoneOwner === ws) {
        microphoneActive = false; microphoneOwner = null; broadcast(JSON.stringify({ type: 'mic-stop' }), ws);
      }
    } catch { /* Ignore malformed messages. */ }
  });
  ws.on('close', () => { clients.delete(ws); if (microphoneOwner === ws) { microphoneActive = false; microphoneOwner = null; broadcast(JSON.stringify({ type: 'mic-stop' })); } });
});

server.listen(port, '0.0.0.0', () => {
  console.log(`\nu-wash is ready\nComputer: https://localhost:${port}\nPhone:    ${addresses.map(ip => `https://${ip}:${port}`).join(' or ') || 'connect to this computer on your local network'}\nPairing code: ${pin}\nShared files: ${sharedDir}\n`);
  console.log('Both devices must be on the same local network. On your phone, accept the local certificate warning once.');
});
