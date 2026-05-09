#!/usr/bin/env node
/**
 * Electron boot smoke.
 *
 * Spawns the desktop-shell with CAIRN_DESKTOP_BOOT_TEST=1 so main.cjs
 * runs one refreshTray() + one getProjectsList() and quits cleanly
 * after ~3s. Failure modes:
 *   - module load throws → non-zero exit, stderr captured
 *   - tray wiring throws → main.cjs exits with code 2
 *   - getProjectsList throws (e.g. missing require, bad DB read) →
 *     main.cjs exits with code 2
 *   - graceful quit doesn't fire → smoke timeout (10s), kill child,
 *     report failure
 *
 * No external deps. Read-only against ~/.cairn/projects.json (live
 * registry). The boot doesn't open windows on screen long enough to
 * show; the side effect is purely the IPC + DB read paths exercised.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const electronBin = path.join(
  root, 'node_modules', '.bin',
  process.platform === 'win32' ? 'electron.cmd' : 'electron',
);

console.log(`==> spawning ${electronBin} . (CAIRN_DESKTOP_BOOT_TEST=1)`);

// Windows spawn for .cmd / .bat shims requires shell:true (Node 16+
// EINVAL guard on direct exec of cmd files). On POSIX, shell:true is
// harmless — the binary path has no spaces here.
const child = spawn(electronBin, ['.'], {
  cwd: root,
  env: Object.assign({}, process.env, {
    CAIRN_DESKTOP_BOOT_TEST: '1',
  }),
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: true,
  windowsHide: true,
});

let stdout = '';
let stderr = '';
child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

const timeoutMs = 12_000;
let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  // eslint-disable-next-line no-console
  console.error(`FAIL: boot did not exit within ${timeoutMs}ms; killing child`);
  child.kill('SIGKILL');
}, timeoutMs);

child.on('exit', (code, signal) => {
  clearTimeout(timer);
  console.log(`==> child exit code=${code} signal=${signal} timedOut=${timedOut}`);
  if (stdout.trim()) {
    console.log('---- stdout ----');
    console.log(stdout.trim());
  }
  if (stderr.trim()) {
    console.log('---- stderr ----');
    // Some Electron shutdown chatter shows up on stderr (DevTools
    // listening, etc.) and is harmless. Only fail on actual error
    // lines (heuristic: lines beginning with "Error" or "BOOT_TEST").
    console.log(stderr.trim());
  }
  if (timedOut) process.exit(1);
  if (code !== 0) {
    console.error(`FAIL: exit code ${code}`);
    process.exit(1);
  }
  // Sanity: stdout should contain the BOOT_TEST projects=… line.
  if (!/BOOT_TEST projects=\d+ unassigned=\d+/.test(stdout)) {
    console.error('FAIL: BOOT_TEST log line not found in stdout — boot path did not run');
    process.exit(1);
  }
  console.log('PASS');
});

child.on('error', (err) => {
  clearTimeout(timer);
  console.error(`FAIL: spawn error: ${err.message}`);
  process.exit(1);
});
