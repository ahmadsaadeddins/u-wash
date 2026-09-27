import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tauriDir = path.join(root, 'src-tauri');
const triple = execFileSync('rustc', ['--print', 'host-tuple'], { encoding: 'utf8' }).trim();
if (process.platform !== 'win32' || triple !== 'x86_64-pc-windows-msvc') {
  throw new Error('The desktop packaging script currently supports Windows x64 with the MSVC Rust toolchain.');
}

const assetsDir = path.join(tauriDir, 'resources', 'public');
const binaryDir = path.join(tauriDir, 'binaries');
fs.mkdirSync(assetsDir, { recursive: true });
fs.mkdirSync(binaryDir, { recursive: true });
for (const file of ['index.html', 'app.js', 'style.css', 'audio-worklet.js']) {
  fs.copyFileSync(path.join(root, 'public', file), path.join(assetsDir, file));
}

const binary = path.join(binaryDir, `uwash-server-${triple}.exe`);
const pkgScript = path.join(root, 'node_modules', '@yao-pkg', 'pkg', 'lib-es5', 'bin.js');
const result = spawnSync(process.execPath, [pkgScript, path.join(root, 'server.js'), '--target', 'node24-win-x64', '--output', binary], { cwd: root, stdio: 'inherit' });
if (result.status !== 0) throw new Error(`Sidecar packaging failed (${result.status ?? result.error?.message})`);
console.log(`Prepared ${binary}`);
