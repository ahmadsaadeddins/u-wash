import https from 'node:https';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs, { createReadStream, createWriteStream } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import selfsigned from 'selfsigned';
import { WebSocketServer, WebSocket } from 'ws';
import manifest from './assets.cjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.UWASH_DATA_DIR || here;
const localDir = path.join(dataDir, '.local');
const uploadTempDir = path.join(localDir, 'uploads');
const sharedDir = path.join(dataDir, 'shared');
const publicDir = process.env.UWASH_ASSETS_DIR || path.join(here, 'public');
const port = Number(process.env.PORT || 8765);
const listenHost = process.env.UWASH_HOST || '0.0.0.0';
const desktopPort = Number(process.env.UWASH_DESKTOP_PORT || 0);
const cableSetup = process.env.UWASH_CABLE_SETUP || '';
const desktopHost = `127.0.0.1:${desktopPort}`;
const pin = String(process.env.UWASH_PIN || crypto.randomInt(100000, 1000000));
const sessionLifetimeMs = 24 * 60 * 60 * 1000;
const sessions = new Map();
const clients = new Set();
const failedPairs = new Map();
const maxClients = 8;
const maxBufferedBytes = 1024 * 1024;
let clipboard = { text: '', updatedAt: null };
let microphoneActive = false;
let microphoneOwner = null;
let microphoneRate = 48000;
let activeUploads = 0;

const addresses = [...new Set(Object.values(os.networkInterfaces()).flat().filter(x => x && x.family === 'IPv4' && !x.internal).map(x => x.address))];
const allowedHosts = new Set(['localhost', '127.0.0.1', ...addresses].map(host => `${host}:${port}`));
await fsp.mkdir(localDir, { recursive: true });
await fsp.mkdir(uploadTempDir, { recursive: true });
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
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ws: wss:; media-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" });
  res.end(type.startsWith('application/json') ? JSON.stringify(data) : data);
}
function sessionToken(req) {
  const match = /(?:^|;\s*)uwash=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '');
  if (!match) return null;
  const expiry = sessions.get(match[1]);
  if (!expiry) return null;
  if (expiry <= Date.now()) { sessions.delete(match[1]); return null; }
  return match[1];
}
function isDesktop(req) { return desktopPort > 0 && req.headers.host === desktopHost && (req.socket.remoteAddress === '127.0.0.1' || req.socket.remoteAddress === '::ffff:127.0.0.1'); }
function authenticated(req) { return isDesktop(req) || !!sessionToken(req); }
function sameOrigin(req) {
  try {
    const origin = new URL(req.headers.origin);
    if (isDesktop(req)) return origin.protocol === 'http:' && origin.host === desktopHost;
    return origin.protocol === 'https:' && origin.host === req.headers.host && allowedHosts.has(origin.host);
  } catch { return false; }
}
function allowedHost(req) { return isDesktop(req) || allowedHosts.has(req.headers.host); }
function safePath(raw) {
  if (!raw || raw.length > 1000 || raw.includes('\0')) throw new Error('Invalid path');
  const parts = raw.replaceAll('\\', '/').split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || p.includes(':'))) throw new Error('Invalid path');
  const target = path.resolve(sharedDir, ...parts);
  if (path.relative(sharedDir, target).startsWith('..')) throw new Error('Invalid path');
  return target;
}
async function confinedPath(target, mustExist = false) {
  const relative = path.relative(sharedDir, target);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Invalid path');
  let current = sharedDir;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    try {
      const stat = await fsp.lstat(current);
      if (stat.isSymbolicLink()) throw new Error('Linked paths are not allowed');
    } catch (error) { if (error.code !== 'ENOENT') throw error; if (mustExist) throw error; }
  }
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
  for (const client of clients) if (client !== except && client.readyState === WebSocket.OPEN && client.bufferedAmount < maxBufferedBytes) client.send(message);
}

async function handleRequest(req, res) {
  try {
    if (!allowedHost(req)) return send(res, 421, { error: 'Unknown host' });
    const url = new URL(req.url, `https://${req.headers.host}`);
    if (url.pathname === '/api/session' && req.method === 'GET') return send(res, 200, { paired: authenticated(req), desktop: isDesktop(req) });
    if (url.pathname === '/api/desktop' && req.method === 'GET') {
      if (!isDesktop(req)) return send(res, 403, { error: 'Desktop only' });
      return send(res, 200, { pin, phoneUrls: addresses.map(ip => `https://${ip}:${port}`), sharedDir });
    }
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
      if (sessions.size >= 32) for (const [token, expiry] of sessions) { if (expiry <= Date.now()) sessions.delete(token); }
      if (sessions.size >= 32) return send(res, 429, { error: 'Too many paired devices. Restart the server to clear sessions.' });
      const token = crypto.randomBytes(32).toString('hex'); sessions.set(token, Date.now() + sessionLifetimeMs);
      res.writeHead(200, { 'Set-Cookie': `uwash=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=86400`, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ paired: true }));
    }
    if (url.pathname.startsWith('/api/')) {
      if (!authenticated(req)) return send(res, 401, { error: 'Pair first' });
      if (req.method !== 'GET' && !sameOrigin(req)) return send(res, 403, { error: 'Invalid origin' });
      if (url.pathname === '/api/logout' && req.method === 'POST') {
        const token = sessionToken(req);
        if (token) {
          sessions.delete(token);
          for (const client of clients) if (client.sessionToken === token) client.terminate();
        }
        res.writeHead(200, { 'Set-Cookie': 'uwash=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify({ ok: true }));
      }
      if (url.pathname === '/api/open-downloads' && req.method === 'POST') {
        if (!isDesktop(req) || process.platform !== 'win32') return send(res, 403, { error: 'Desktop only' });
        const folder = path.join(os.homedir(), 'Downloads');
        await new Promise((resolve, reject) => {
          const explorer = spawn('explorer.exe', [folder], { detached: true, stdio: 'ignore' });
          explorer.once('error', reject);
          explorer.once('spawn', () => { explorer.unref(); resolve(); });
        });
        return send(res, 200, { ok: true });
      }
      if (url.pathname === '/api/install-cable' && req.method === 'POST') {
        if (!isDesktop(req) || process.platform !== 'win32') return send(res, 403, { error: 'Desktop only' });
        if (!cableSetup || !fs.existsSync(cableSetup)) return send(res, 404, { error: 'The bundled VB-CABLE setup was not found' });
        // The driver setup needs administrator rights; RunAs raises the UAC prompt.
        await new Promise((resolve, reject) => {
          const child = spawn('powershell', ['-NoProfile', '-Command', `Start-Process -FilePath '${cableSetup}' -Verb RunAs`], { detached: true, stdio: 'ignore' });
          child.once('error', reject);
          child.once('spawn', () => { child.unref(); resolve(); });
        });
        return send(res, 200, { ok: true });
      }
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
        if (activeUploads >= 2) return send(res, 429, { error: 'Two uploads are already in progress' });
        const target = safePath(url.searchParams.get('path'));
        const max = 1024 * 1024 * 1024;
        const declared = Number(req.headers['content-length']);
        if (!Number.isFinite(declared) || declared < 0 || declared > max) return send(res, 413, { error: 'File limit is 1 GB' });
        activeUploads++;
        try {
          await confinedPath(target);
          await fsp.mkdir(path.dirname(target), { recursive: true });
          await confinedPath(target);
          const temp = path.join(uploadTempDir, `${crypto.randomUUID()}.upload`);
          let received = 0;
          try {
            req.on('data', chunk => { received += chunk.length; if (received > max) req.destroy(); });
            await pipeline(req, createWriteStream(temp, { flags: 'wx' }));
            if (received !== declared) throw new Error('Incomplete upload');
            await fsp.rename(temp, target);
          } catch (error) { await fsp.rm(temp, { force: true }); throw error; }
          broadcast(JSON.stringify({ type: 'files-changed' }));
          return send(res, 200, { ok: true });
        } finally { activeUploads--; }
      }
      if (url.pathname === '/api/download' && req.method === 'GET') {
        const target = safePath(url.searchParams.get('path'));
        await confinedPath(target, true);
        const stat = await fsp.stat(target);
        if (!stat.isFile()) return send(res, 404, { error: 'File not found' });
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': stat.size, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(target))}`, 'X-Content-Type-Options': 'nosniff' });
        return createReadStream(target).pipe(res);
      }
      return send(res, 404, { error: 'Not found' });
    }
    if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
    const files = manifest.publicAssets;
    const file = files[url.pathname];
    if (!file) return send(res, 404, { error: 'Not found' });
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
    return send(res, 200, await fsp.readFile(path.join(publicDir, file)), types[path.extname(file)]);
  } catch (error) {
    if (!res.headersSent) send(res, error.code === 'ENOENT' ? 404 : 400, { error: error.message || 'Request failed' });
    else res.destroy();
  }
}
const server = https.createServer({ key: await fsp.readFile(keyFile), cert: await fsp.readFile(certFile) }, handleRequest);
const desktopServer = desktopPort > 0 ? http.createServer(handleRequest) : null;
for (const listener of [server, desktopServer].filter(Boolean)) {
  listener.headersTimeout = 15_000;
  listener.requestTimeout = 10 * 60_000;
  listener.maxHeadersCount = 50;
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
function upgrade(req, socket, head) {
  if (!allowedHost(req) || !authenticated(req) || !sameOrigin(req) || clients.size >= maxClients || new URL(req.url, `https://${req.headers.host}`).pathname !== '/ws') return socket.destroy();
  wss.handleUpgrade(req, socket, head, ws => { ws.desktop = isDesktop(req); ws.sessionToken = sessionToken(req); wss.emit('connection', ws); });
}
server.on('upgrade', upgrade);
desktopServer?.on('upgrade', upgrade);
wss.on('connection', ws => {
  clients.add(ws);
  ws.isAlive = true;
  ws.audioWindowStart = Date.now();
  ws.audioWindowBytes = 0;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('error', () => { ws.terminate(); });
  ws.send(JSON.stringify({ type: 'state', microphoneActive, microphoneRate, clipboard }));
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      if (microphoneOwner !== ws || data.length > 32768 || data.length % 4 !== 0) return;
      if (Date.now() - ws.audioWindowStart >= 1000) { ws.audioWindowStart = Date.now(); ws.audioWindowBytes = 0; }
      ws.audioWindowBytes += data.length;
      if (ws.audioWindowBytes > 2 * 1024 * 1024) { ws.close(1008, 'Audio rate exceeded'); return; }
      broadcast(data, ws);
      return;
    }
    if (data.length > 512) return;
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
const heartbeat = setInterval(() => {
  for (const ws of clients) {
    if ((!ws.desktop && (!sessions.has(ws.sessionToken) || sessions.get(ws.sessionToken) <= Date.now())) || !ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false; ws.ping();
  }
}, 30_000);
heartbeat.unref();
if (process.env.UWASH_PARENT_PID) {
  const parentPid = Number(process.env.UWASH_PARENT_PID);
  const parentWatch = setInterval(() => {
    try { process.kill(parentPid, 0); } catch { process.exit(0); }
  }, 5_000);
  parentWatch.unref();
}

// Machine-readable marker on startup-failure output; the desktop shell and the
// startup tests match this prefix rather than the human wording after it.
const startupErrorPrefix = 'UWASH_STARTUP_ERROR:';
function announceReady() {
  console.log(`\nu-wash is ready\nComputer: https://localhost:${port}\nPhone:    ${addresses.map(ip => `https://${ip}:${port}`).join(' or ') || 'connect to this computer on your local network'}\nPairing code: ${pin}\nShared files: ${sharedDir}\n`);
  console.log('Both devices must be on the same local network. On your phone, accept the local certificate warning once.');
}
function listenFailure(name, listenPort) {
  return error => {
    const reason = error.code === 'EADDRINUSE'
      ? `is already in use. Close the other u-wash instance (for example a "npm start" server or another desktop app), or free the port, then start again`
      : `could not be opened (${error.code || error.message})`;
    console.error(`${startupErrorPrefix} the ${name} port ${listenPort} ${reason}.`);
    process.exit(1);
  };
}
const listeners = desktopServer
  ? [[server, 'sharing', port, listenHost], [desktopServer, 'desktop', desktopPort, '127.0.0.1']]
  : [[server, 'sharing', port, listenHost]];
let started = 0;
for (const [listener, name, listenPort, host] of listeners) {
  listener.on('error', listenFailure(name, listenPort));
  listener.listen(listenPort, host, () => {
    // The "u-wash is ready" line is the sidecar readiness contract: print it only once every listener is bound.
    if (++started === listeners.length) announceReady();
  });
}
