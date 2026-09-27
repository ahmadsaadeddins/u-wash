import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createClient } from './helpers.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const agent = new https.Agent({ rejectUnauthorized: false });
const STARTUP_ERROR_PREFIX = 'UWASH_STARTUP_ERROR:';

function spawnServer(env) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, UWASH_HOST: '127.0.0.1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = { stdout: '', stderr: '' };
  child.stdout.on('data', chunk => output.stdout += chunk);
  child.stderr.on('data', chunk => output.stderr += chunk);
  return { child, output };
}

function untilExit(child, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('server.js did not exit in time')); }, timeoutMs);
    // 'close' fires after the stdio streams are flushed, unlike 'exit'.
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
  });
}

function waitReady(child, output, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let timer, onClose, poll;
    const finish = (ok, error) => {
      clearTimeout(timer);
      child.removeListener('close', onClose);
      clearInterval(poll);
      ok ? resolve() : reject(error);
    };
    timer = setTimeout(() => finish(false, new Error(`server did not become ready: ${output.stdout} ${output.stderr}`)), timeoutMs);
    onClose = (code, signal) => finish(false, new Error(`server exited before ready (code ${code}, signal ${signal}): ${output.stderr || output.stdout}`));
    poll = setInterval(() => {
      if (output.stdout.includes('u-wash is ready')) finish(true);
      else if (output.stderr.includes(STARTUP_ERROR_PREFIX)) finish(false, new Error(`server failed early: ${output.stderr}`));
    }, 100);
    child.once('close', onClose);
  });
}

function occupy(port) {
  return new Promise((resolve, reject) => {
    const blocker = net.createServer();
    blocker.once('error', reject);
    blocker.listen(port, '127.0.0.1', () => resolve(blocker));
  });
}

// Upload characterized with a request whose declared Content-Length lies,
// or that is destroyed mid-body. The server frames request bodies by
// Content-Length (or rejects missing lengths outright), so the streaming
// guard at server.js's upload handler never needs to fire; these tests pin
// what a client actually observes in each reachable case.
async function uploadCase(port, cookie, { name, declared, chunked, body, abortAfter }) {
  return new Promise((resolve, reject) => {
    const headers = { Origin: `https://localhost:${port}`, Cookie: cookie, 'Content-Type': 'application/octet-stream', Connection: 'close' };
    if (chunked) headers['Transfer-Encoding'] = 'chunked';
    if (declared !== undefined) headers['Content-Length'] = declared;
    const req = https.request({ hostname: 'localhost', port, path: `/api/upload?path=${encodeURIComponent(name)}`, method: 'PUT', agent, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', error => (abortAfter !== undefined ? resolve({ aborted: true, error }) : reject(error)));
    if (abortAfter !== undefined) {
      req.write(body.subarray(0, abortAfter));
      setTimeout(() => req.destroy(), 100);
    } else if (chunked) {
      // write() without a declared length keeps Node from computing Content-Length.
      req.write(body);
      req.end();
    } else {
      req.end(body);
    }
  });
}

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'uwash-startup-'));

// 1. Sharing port occupied: fast exit, error names the port, no readiness claim.
{
  const port = 8879;
  const blocker = await occupy(port);
  const { child, output } = spawnServer({ PORT: String(port), UWASH_DATA_DIR: dataDir });
  const { code } = await untilExit(child);
  assert.equal(code, 1);
  assert.match(output.stderr, new RegExp(`sharing port ${port} is already in use`));
  assert.ok(output.stderr.includes(STARTUP_ERROR_PREFIX), 'must carry the machine-readable startup-error marker');
  assert.ok(!output.stdout.includes('u-wash is ready'), 'readiness must not be claimed when a listener failed');
  blocker.close();
  console.log('ok: occupied sharing port exits 1 with an actionable message');
}

// 2. Desktop port occupied: same contract, and the readiness line is withheld
//    even though the sharing listener bound successfully.
{
  const desktopPort = 8880;
  const blocker = await occupy(desktopPort);
  const { child, output } = spawnServer({ PORT: '8881', UWASH_DESKTOP_PORT: String(desktopPort), UWASH_DATA_DIR: dataDir });
  const { code } = await untilExit(child);
  assert.equal(code, 1);
  assert.match(output.stderr, new RegExp(`desktop port ${desktopPort} is already in use`));
  assert.ok(output.stderr.includes(STARTUP_ERROR_PREFIX), 'must carry the machine-readable startup-error marker');
  assert.ok(!output.stdout.includes('u-wash is ready'), 'readiness must wait for every listener');
  blocker.close();
  console.log('ok: occupied desktop port exits 1 and withholds the ready line');
}

// 2b. Death before ready without the known error line (unwritable data dir):
//     still a fast non-zero exit with no readiness claim. The desktop shell
//     falls back to the last stderr line or the exit code for this path.
{
  const notADir = path.join(dataDir, 'not-a-dir');
  await fs.writeFile(notADir, 'not a directory');
  const { child, output } = spawnServer({ PORT: '8886', UWASH_DESKTOP_PORT: '8887', UWASH_DATA_DIR: path.join(notADir, 'nested') });
  const { code } = await untilExit(child);
  assert.equal(code, 1);
  assert.ok(!output.stdout.includes('u-wash is ready'), 'readiness must never be claimed on early death');
  assert.ok(!output.stderr.includes(STARTUP_ERROR_PREFIX), 'unknown-death path must not claim the known startup-error contract');
  assert.ok(output.stderr.trim().length > 0, 'the crash should still explain itself on stderr');
  console.log('ok: early death without a known error still exits 1 with no readiness claim');
}

// 3. Both listeners free: the ready line prints (this is the sidecar contract),
//    and this instance carries the upload characterization.
{
  const port = 8882;
  const desktopPort = 8883;
  const { child, output } = spawnServer({ PORT: String(port), UWASH_DESKTOP_PORT: String(desktopPort), UWASH_DATA_DIR: dataDir });
  await waitReady(child, output);
  assert.ok(output.stdout.includes('u-wash is ready'));

  // The desktop channel is plain http on its own loopback port; the pairing
  // code only exists there, so this instance pairs through it.
  const desktopRequest = createClient({ host: '127.0.0.1', port: desktopPort, tls: false, origin: `http://127.0.0.1:${desktopPort}` });
  const desktopInfo = JSON.parse((await desktopRequest('GET', '/api/desktop')).body.toString());
  const request = createClient({ host: 'localhost', port, tls: true, origin: `https://localhost:${port}` });
  const pair = await request('POST', '/api/pair', Buffer.from(JSON.stringify({ pin: desktopInfo.pin })));
  assert.equal(pair.status, 200);

  // a. Declared length over the 1 GiB limit: intended 413, message names the limit.
  const oversize = await uploadCase(port, request.cookie(), { name: 'oversize.bin', declared: 2 * 1024 * 1024 * 1024, body: Buffer.alloc(64) });
  assert.equal(oversize.status, 413);
  assert.match(oversize.body, /File limit is 1 GB/);
  console.log('ok: declared oversize upload gets the intended 413');

  // b. Chunked body (no Content-Length): currently conflated with oversize and
  //    answered 413 with the same message. Pinned as-is; 411 Length Required
  //    would be the more accurate status if this is ever revisited.
  const chunked = await uploadCase(port, request.cookie(), { name: 'chunked.bin', chunked: true, body: Buffer.from('chunked body') });
  assert.equal(chunked.status, 413);
  assert.match(chunked.body, /File limit is 1 GB/);
  console.log('ok: chunked upload is answered 413 (characterized, not endorsed)');

  // c. Client aborts mid-body after a valid declared length: the server must
  //    survive, leave no shared file, and clean its upload temp.
  const aborted = await uploadCase(port, request.cookie(), { name: 'aborted.bin', declared: 1000, body: Buffer.alloc(600), abortAfter: 200 });
  assert.equal(aborted.aborted, true);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal((await request('GET', '/api/session')).status, 200);
  assert.ok(!(await fs.stat(path.join(dataDir, 'shared', 'aborted.bin')).catch(() => null)), 'no shared file after aborted upload');
  assert.deepEqual(await fs.readdir(path.join(dataDir, '.local', 'uploads')), [], 'upload temp must be cleaned');
  console.log('ok: aborted upload leaves the server alive with no partial file');

  child.kill();
}

// 4. Packaged sidecar (when built): boots and serves under the same
//    environment the Tauri shell provides. This guards against packaging
//    regressions (for example a module the pkg bundle fails to include) that
//    never show up when running server.js from source.
{
  const binariesDir = path.join(root, 'src-tauri', 'binaries');
  const binary = (await fs.readdir(binariesDir).catch(() => []))
    .filter(name => name.startsWith('uwash-server-') && name.endsWith('.exe'))
    .map(name => path.join(binariesDir, name))[0];
  if (!binary) {
    console.log('skip: packaged sidecar check (no src-tauri/binaries/uwash-server-*.exe; run npm run prepare:tauri to enable it)');
  } else {
    const port = 8884;
    const desktopPort = 8885;
    const child = spawn(binary, {
      env: {
        ...process.env,
        UWASH_HOST: '127.0.0.1',
        PORT: String(port),
        UWASH_DESKTOP_PORT: String(desktopPort),
        UWASH_DATA_DIR: dataDir,
        UWASH_ASSETS_DIR: path.join(root, 'src-tauri', 'resources', 'public'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = { stdout: '', stderr: '' };
    child.stdout.on('data', chunk => output.stdout += chunk);
    child.stderr.on('data', chunk => output.stderr += chunk);
    await waitReady(child, output);
    const request = createClient({ host: '127.0.0.1', port, tls: true, origin: `https://localhost:${port}` });
    const index = await request('GET', '/');
    assert.equal(index.status, 200);
    assert.match(index.body.toString(), /<!doctype html>/i);
    child.kill();
    console.log('ok: packaged sidecar boots and serves under the Tauri environment');
  }
}

await fs.rm(dataDir, { recursive: true, force: true });
console.log('Startup tests passed: port conflicts fail fast with actionable errors, readiness is gated on all listeners, upload edge cases characterized');
