#!/usr/bin/env node
/**
 * spike-claude-hooks.mjs — does `claude --settings <inline-json>` actually
 * fire SessionStart + Stop hooks on Windows + emit them via
 * --include-hook-events in the stream-json output? Reference:
 * https://github.com/smithersai/claude-p (uses the same trick to extract
 * transcript_path on turn complete).
 *
 * Strategy:
 *   1. Write a temp settings file with Stop + SessionStart hooks
 *      whose `command` writes a sentinel file we can verify on disk.
 *   2. Spawn `claude --print "say hi" --settings <file>
 *                   --output-format stream-json --include-hook-events`
 *   3. Capture stdout NDJSON.
 *   4. Verify:
 *      - hook lifecycle events appear in stdout stream
 *      - sentinel files on disk exist (proves hooks fired)
 *      - transcript_path payload is captured
 *
 * Read-only re: Cairn. Burns minimal Anthropic credit (one ~5-token turn).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-spike-hooks-'));
const settingsPath = path.join(tmpDir, 'settings.json');
const sentinelStart = path.join(tmpDir, 'session-start-fired.txt');
const sentinelStop  = path.join(tmpDir, 'stop-fired.txt');

// node -e command — must be cross-platform. JSON.stringify embeds the path
// safely. The hook payload arrives via stdin as JSON; we slurp it and write
// out the file path it gives us (proves we got transcript_path / etc).
function nodeWriteSentinel(target) {
  const tgt = target.replace(/\\/g, '/');
  return `node -e "let s=''; process.stdin.on('data',d=>s+=d); process.stdin.on('end',()=>{require('fs').writeFileSync('${tgt}', s||'<no-stdin>')});"`;
}

const settings = {
  hooks: {
    SessionStart: [
      { hooks: [{ type: 'command', command: nodeWriteSentinel(sentinelStart) }] },
    ],
    Stop: [
      { hooks: [{ type: 'command', command: nodeWriteSentinel(sentinelStop) }] },
    ],
  },
};
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

console.log('tmpdir:', tmpDir);
console.log('settings:', settingsPath);
console.log('');

// Resolve claude binary (Windows: prefer .cmd)
function which(name) {
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', '.bat'] : [''];
  const sep = process.platform === 'win32' ? ';' : ':';
  for (const dir of (process.env.PATH || '').split(sep)) {
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      try { if (fs.statSync(p).isFile()) return p; } catch {}
    }
  }
  return null;
}
const claudeExe = which('claude');
if (!claudeExe) {
  console.error('FATAL: claude binary not found on PATH');
  process.exit(2);
}

const argv = [
  '--print',
  'say "hi" and nothing else',
  '--output-format', 'stream-json',
  '--verbose',
  '--include-hook-events',
  '--settings', settingsPath,
  '--permission-mode', 'bypassPermissions',
];

let exec = claudeExe;
let execArgv = argv;
if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(claudeExe)) {
  exec = process.env.ComSpec || 'cmd.exe';
  execArgv = ['/d', '/s', '/c', claudeExe, ...argv];
}

console.log('spawn:', claudeExe, argv.join(' '));
console.log('');

const t0 = Date.now();
const child = spawn(exec, execArgv, { windowsHide: true, shell: false });

let stdout = '';
let stderr = '';
child.stdout.on('data', d => stdout += d.toString());
child.stderr.on('data', d => stderr += d.toString());

child.on('exit', (code, signal) => {
  const dt = Date.now() - t0;
  console.log('=== exit ===');
  console.log('code:', code, 'signal:', signal, 'duration_ms:', dt);
  console.log('');

  // Parse stream-json events
  const events = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch {}
  }
  console.log('=== NDJSON events:', events.length, '===');
  const byType = {};
  for (const e of events) {
    const t = e.type || 'unknown';
    byType[t] = (byType[t] || 0) + 1;
  }
  for (const [t, n] of Object.entries(byType)) console.log('  ', t, ':', n);
  console.log('');

  // Look for hook events specifically
  console.log('=== hook-related events (look for hook/lifecycle) ===');
  let hookSeen = 0;
  for (const e of events) {
    const json = JSON.stringify(e);
    if (/hook/i.test(e.type || '') || /SessionStart|Stop/i.test(json)) {
      hookSeen++;
      console.log(' ', JSON.stringify(e).slice(0, 300));
    }
  }
  if (hookSeen === 0) console.log('  (no hook-tagged events found in NDJSON)');
  console.log('');

  // Disk sentinels (proves hooks fired)
  console.log('=== sentinel files (proves hooks fired on disk) ===');
  for (const [name, p] of [['SessionStart', sentinelStart], ['Stop', sentinelStop]]) {
    const exists = fs.existsSync(p);
    console.log('  ', name, exists ? '✓ fired' : '✗ NOT fired');
    if (exists) {
      const payload = fs.readFileSync(p, 'utf8');
      console.log('     payload preview:', payload.slice(0, 400));
    }
  }
  console.log('');
  if (stderr) {
    console.log('=== stderr (last 500 chars) ===');
    console.log(stderr.slice(-500));
  }
});
