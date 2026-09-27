import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import https from 'node:https';
import http from 'node:http';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const port = 8877;
const desktopPort = 8878;
const child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT: String(port), UWASH_DESKTOP_PORT: String(desktopPort), UWASH_HOST: '127.0.0.1', UWASH_PIN: '123456' }, stdio: 'pipe' });
const agent = new https.Agent({ rejectUnauthorized: false });
let cookie;
async function request(method, route, body, type, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: 'localhost', port, path: route, method, agent, headers: { Origin: `https://localhost:${port}`, ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': type || 'application/json', 'Content-Length': body.length } : {}), ...extraHeaders } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.end(body);
  });
}
async function desktopRequest(method, route, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: desktopPort, path: route, method, headers: { Origin: `http://127.0.0.1:${desktopPort}`, ...(body ? { 'Content-Type': 'application/json', 'Content-Length': body.length } : {}), ...extraHeaders } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.end(body);
  });
}
async function ready() {
  for (let i = 0; i < 50; i++) {
    try { await request('GET', '/api/session'); return; } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  throw new Error('Server did not start');
}
async function socket() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://localhost:${port}/ws`, { rejectUnauthorized: false, headers: { Cookie: cookie, Origin: `https://localhost:${port}` } });
    ws.once('open', () => resolve(ws)); ws.once('error', reject);
  });
}
async function desktopSocket() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${desktopPort}/ws`, { headers: { Origin: `http://127.0.0.1:${desktopPort}` } });
    ws.once('open', () => resolve(ws)); ws.once('error', reject);
  });
}
try {
  await ready();
  const desktopSession = await desktopRequest('GET', '/api/session');
  assert.equal(JSON.parse(desktopSession.body).desktop, true);
  assert.equal(JSON.parse(desktopSession.body).paired, true);
  const desktopInfo = await desktopRequest('GET', '/api/desktop');
  assert.equal(JSON.parse(desktopInfo.body).pin, '123456');
  assert.equal((await desktopRequest('GET', '/api/desktop', undefined, { Host: `untrusted.test:${desktopPort}` })).status, 421);
  assert.equal((await desktopRequest('POST', '/api/open-downloads', undefined, { Origin: 'http://untrusted.test:8878' })).status, 403);
  assert.equal((await request('GET', '/api/desktop')).status, 403);
  assert.equal((await request('GET', '/', undefined, undefined, { Host: `untrusted.test:${port}` })).status, 421);
  assert.equal((await request('POST', '/api/pair', Buffer.from('{"pin":"123456"}'), undefined, { Origin: 'https://untrusted.test:8877' })).status, 403);
  assert.match((await request('GET', '/')).headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal((await request('GET', '/api/files')).status, 401);
  assert.equal((await request('POST', '/api/pair', Buffer.from('{"pin":"000000"}'))).status, 401);
  const pair = await request('POST', '/api/pair', Buffer.from('{"pin":"123456"}'));
  assert.equal(pair.status, 200); cookie = pair.headers['set-cookie'][0].split(';')[0];
  assert.equal((await request('POST', '/api/open-downloads')).status, 403);
  const text = Buffer.from('hello from phone');
  assert.equal((await request('PUT', '/api/upload?path=smoke-test%2Fhello.txt', text, 'application/octet-stream')).status, 200);
  const files = JSON.parse((await request('GET', '/api/files')).body);
  assert(files.files.some(file => file.path === 'smoke-test/hello.txt'));
  assert.equal((await request('GET', '/api/download?path=smoke-test%2Fhello.txt')).body.toString(), text.toString());
  assert.equal((await request('GET', '/api/download?path=..%2Fserver.js')).status, 400);
  const linkedFile = path.join(root, 'shared', 'smoke-test', 'linked.txt');
  let symlinkChecked = false;
  try {
    await fs.symlink(path.join(root, 'README.md'), linkedFile, 'file');
    symlinkChecked = true;
    assert.equal((await request('GET', '/api/download?path=smoke-test%2Flinked.txt')).status, 400);
    assert.equal((await request('PUT', '/api/upload?path=smoke-test%2Flinked.txt', text, 'application/octet-stream')).status, 400);
  } catch (error) {
    if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
    if (process.env.UWASH_TEST_REQUIRE_SYMLINKS) throw new Error('Symlink confinement assertions could not run: symlink creation was denied');
    console.warn('WARNING: symlink confinement assertions were SKIPPED because symlink creation was denied (enable Windows Developer Mode or run as administrator to run them).');
  } finally { await fs.rm(linkedFile, { force: true }); }
  assert.equal((await request('POST', '/api/clipboard', Buffer.from('{"text":"shared text"}'))).status, 200);
  assert.equal(JSON.parse((await request('GET', '/api/clipboard')).body).text, 'shared text');
  const sender = await socket(), receiver = await desktopSocket();
  const gotAudio = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Audio was not forwarded')), 3000);
    receiver.on('message', (data, binary) => { if (binary) { clearTimeout(timer); resolve(data); } });
  });
  sender.send(JSON.stringify({ type: 'mic-start', sampleRate: 48000 }));
  sender.send(Buffer.from([1, 2, 3, 4]));
  assert.deepEqual(Buffer.from(await gotAudio), Buffer.from([1, 2, 3, 4]));
  sender.close(); receiver.close();
  assert.equal((await request('POST', '/api/logout')).status, 200);
  assert.equal((await request('GET', '/api/files')).status, 401);
  // Cookie-less desktop logout must be a harmless no-op for sessions and sockets.
  assert.equal((await desktopRequest('POST', '/api/logout')).status, 200);
  assert.equal(JSON.parse((await desktopRequest('GET', '/api/session')).body).desktop, true);
  console.log(`Smoke test passed: host/origin checks, pairing, file path confinement${symlinkChecked ? ' including symlinks' : ' (symlink assertions SKIPPED)'}, clipboard, audio relay, and logout`);
} finally {
  child.kill();
  await fs.rm(path.join(root, 'shared', 'smoke-test'), { recursive: true, force: true });
}
