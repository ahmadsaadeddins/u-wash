import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import https from 'node:https';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const port = 8877;
const child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT: String(port), UWASH_PIN: '123456' }, stdio: 'pipe' });
const agent = new https.Agent({ rejectUnauthorized: false });
let cookie;
async function request(method, route, body, type) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: 'localhost', port, path: route, method, agent, headers: { Origin: `https://localhost:${port}`, ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': type || 'application/json', 'Content-Length': body.length } : {}) } }, res => {
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
try {
  await ready();
  assert.equal((await request('GET', '/api/files')).status, 401);
  assert.equal((await request('POST', '/api/pair', Buffer.from('{"pin":"000000"}'))).status, 401);
  const pair = await request('POST', '/api/pair', Buffer.from('{"pin":"123456"}'));
  assert.equal(pair.status, 200); cookie = pair.headers['set-cookie'][0].split(';')[0];
  const text = Buffer.from('hello from phone');
  assert.equal((await request('PUT', '/api/upload?path=smoke-test%2Fhello.txt', text, 'application/octet-stream')).status, 200);
  const files = JSON.parse((await request('GET', '/api/files')).body);
  assert(files.files.some(file => file.path === 'smoke-test/hello.txt'));
  assert.equal((await request('GET', '/api/download?path=smoke-test%2Fhello.txt')).body.toString(), text.toString());
  assert.equal((await request('GET', '/api/download?path=..%2Fserver.js')).status, 400);
  assert.equal((await request('POST', '/api/clipboard', Buffer.from('{"text":"shared text"}'))).status, 200);
  assert.equal(JSON.parse((await request('GET', '/api/clipboard')).body).text, 'shared text');
  const sender = await socket(), receiver = await socket();
  const gotAudio = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Audio was not forwarded')), 3000);
    receiver.on('message', (data, binary) => { if (binary) { clearTimeout(timer); resolve(data); } });
  });
  sender.send(JSON.stringify({ type: 'mic-start', sampleRate: 48000 }));
  sender.send(Buffer.from([1, 2, 3, 4]));
  assert.deepEqual(Buffer.from(await gotAudio), Buffer.from([1, 2, 3, 4]));
  sender.close(); receiver.close();
  console.log('Smoke test passed: pairing, files, clipboard, and audio relay');
} finally {
  child.kill();
  await fs.rm(path.join(root, 'shared', 'smoke-test'), { recursive: true, force: true });
}
