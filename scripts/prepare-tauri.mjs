import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import manifest from '../assets.cjs';

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
for (const file of Object.values(manifest.publicAssets)) {
  fs.copyFileSync(path.join(root, 'public', file), path.join(assetsDir, file));
}

// Ship the unmodified VB-CABLE pack (donationware, redistributed as-is per its
// license) so the desktop app can launch its own installer on demand.
const cableDir = path.join(tauriDir, 'resources', 'vbcable');
fs.rmSync(cableDir, { recursive: true, force: true });
fs.mkdirSync(cableDir, { recursive: true });
const cableZip = path.join(root, 'VBCABLE_Driver_Pack45.zip');
const cableExtract = spawnSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${cableZip}' -DestinationPath '${cableDir}' -Force`], { stdio: 'pipe' });
if (cableExtract.status !== 0) throw new Error(`VB-CABLE pack extraction failed (${cableExtract.status ?? cableExtract.error?.message})`);
if (!fs.existsSync(path.join(cableDir, 'VBCABLE_Setup_x64.exe'))) throw new Error('VB-CABLE pack is missing VBCABLE_Setup_x64.exe');

const binary = path.join(binaryDir, `uwash-server-${triple}.exe`);
const pkgScript = path.join(root, 'node_modules', '@yao-pkg', 'pkg', 'lib-es5', 'bin.js');
const result = spawnSync(process.execPath, [pkgScript, path.join(root, 'server.js'), '--target', 'node24-win-x64', '--output', binary], { cwd: root, stdio: 'inherit' });
if (result.status !== 0) throw new Error(`Sidecar packaging failed (${result.status ?? result.error?.message})`);
console.log(`Prepared ${binary}`);
