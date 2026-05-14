#!/usr/bin/env node
/**
 * smoke-stream-launcher.mjs — E2E with a fake `claude` binary.
 *
 * Validates the Phase 1 streaming launcher without burning Anthropic API.
 *
 * Strategy:
 *   1. Write a Node.js script `fake-claude.js` that emits 5 NDJSON events
 *      to stdout then exits 0.
 *   2. On Windows, wrap it as `claude.cmd` shim. On POSIX, mark executable
 *      and name it `claude` (no extension).
 *   3. PREPEND tmpDir to process.env.PATH (parent process — whichCommand
 *      resolves at call time from parent PATH).
 *   4. Invoke launchStreamWorker.
 *   5. Wait for child exit, then assert: stream_events.jsonl has 5 lines,
 *      tail.log contains the assistant text, run.json status='exited'.
 *
 * HOME sandbox (registry-pollution lesson): run-dir under tmpDir.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dsRoot = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

const _tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-stream-smk-'));
const _binDir = path.join(_tmpDir, 'bin');
fs.mkdirSync(_binDir, { recursive: true });
const _projectDir = path.join(_tmpDir, 'project');
fs.mkdirSync(_projectDir, { recursive: true });
fs.mkdirSync(path.join(_tmpDir, '.cairn'), { recursive: true });

// Write fake-claude.js that emits NDJSON events
const fakeBody = `#!/usr/bin/env node
// Fake claude — emits 5 NDJSON events, ignores stdin (just sinks it).
process.stdin.resume();
process.stdin.on('data', () => {}); // drain stdin

const events = [
  { type: 'system', subtype: 'init', session_id: 'sess_fake_abc123', tools: ['Read','Edit'] },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'starting work' }] } },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: { path: 'README.md' } }] } },
  { type: 'log', level: 'info', message: 'finished reading' },
  { type: 'result', subtype: 'success', session_id: 'sess_fake_abc123', is_error: false, duration_ms: 42 },
];
for (const e of events) {
  process.stdout.write(JSON.stringify(e) + '\\n');
}
setTimeout(() => process.exit(0), 50);
`;

const fakeScriptPath = path.join(_binDir, 'fake-claude.js');
fs.writeFileSync(fakeScriptPath, fakeBody);

let _fakeExeName;
if (process.platform === 'win32') {
  // Windows: write claude.cmd that invokes node fake-claude.js
  const cmdBody = `@echo off\r\nnode "${fakeScriptPath}" %*\r\n`;
  fs.writeFileSync(path.join(_binDir, 'claude.cmd'), cmdBody);
  _fakeExeName = 'claude.cmd';
} else {
  // POSIX: shebang script
  const posixBody = `#!/usr/bin/env node\n${fakeBody}`;
  fs.writeFileSync(path.join(_binDir, 'claude'), posixBody);
  fs.chmodSync(path.join(_binDir, 'claude'), 0o755);
  _fakeExeName = 'claude';
}

// CRITICAL: prepend to PARENT process.env.PATH so whichCommand sees fake first.
process.env.PATH = _binDir + path.delimiter + process.env.PATH;

const launcher = require(path.join(dsRoot, 'claude-stream-launcher.cjs'));

let asserts = 0, fails = 0;
const failures = [];
function ok(c, l) {
  asserts++;
  if (c) process.stdout.write(`  ok    ${l}\n`);
  else { fails++; failures.push(l); process.stdout.write(`  FAIL  ${l}\n`); }
}
function header(t) { process.stdout.write(`\n${'='.repeat(64)}\n${t}\n${'='.repeat(64)}\n`); }
function section(t) { process.stdout.write(`\n[${t}]\n`); }

header('smoke-stream-launcher');

section('1 whichCommand resolves the fake');
{
  const exe = launcher._whichCommand('claude');
  ok(exe && exe.includes('cairn-stream-smk-'), 'whichCommand picks fake from PATH (got ' + exe + ')');
}

section('2 makeInputEnvelope produces stream-json envelope');
{
  const env = launcher._makeInputEnvelope('hello world');
  const parsed = JSON.parse(env.trim());
  ok(parsed.type === 'user', 'envelope.type = user');
  ok(parsed.message && parsed.message.role === 'user', 'envelope.message.role = user');
  ok(Array.isArray(parsed.message.content) && parsed.message.content[0].text === 'hello world', 'envelope content text matches');
}

section('3 extractAssistantText handles text + tool_use blocks');
{
  const e1 = { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } };
  ok(launcher._extractAssistantText(e1) === 'hi\n', 'text block extracted');
  const e2 = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { path: 'a' } }] } };
  ok(/tool_use: Read/.test(launcher._extractAssistantText(e2)), 'tool_use summarized');
  ok(launcher._extractAssistantText({ type: 'result' }) === '', 'non-assistant returns empty');
}

section('4 launch fake, verify files written + status');
{
  const res = launcher.launchStreamWorker({
    cwd: _projectDir,
    prompt: 'do a thing',
    project_id: 'p_test',
    iteration_id: 'smoke',
    env: process.env,
  }, { home: _tmpDir });

  ok(res.ok === true, 'launch returns ok (got ' + JSON.stringify(res) + ')');
  ok(typeof res.run_id === 'string' && res.run_id.startsWith('wr_'), 'run_id assigned');

  // Wait for child to exit (max 5s)
  const runJsonPath = path.join(_tmpDir, '.cairn', 'worker-runs', res.run_id, 'run.json');
  const streamPath = path.join(_tmpDir, '.cairn', 'worker-runs', res.run_id, 'stream_events.jsonl');
  const tailPath = path.join(_tmpDir, '.cairn', 'worker-runs', res.run_id, 'tail.log');

  await new Promise((resolve) => {
    const deadline = Date.now() + 8000;
    const tick = () => {
      if (Date.now() > deadline) return resolve();
      try {
        const m = JSON.parse(fs.readFileSync(runJsonPath, 'utf8'));
        if (m.status !== 'running' && m.status !== 'queued') return resolve();
      } catch (_e) {}
      setTimeout(tick, 100);
    };
    tick();
  });

  // Assertions
  const meta = JSON.parse(fs.readFileSync(runJsonPath, 'utf8'));
  ok(meta.status === 'exited', 'run.json status=exited (got ' + meta.status + ')');
  ok(meta.exit_code === 0, 'exit_code=0 (got ' + meta.exit_code + ')');
  ok(meta.event_count === 5, 'event_count=5 (got ' + meta.event_count + ')');
  ok(meta.session_id === 'sess_fake_abc123', 'session_id captured (got ' + meta.session_id + ')');
  ok(meta.result_subtype === 'success', 'result_subtype=success (got ' + meta.result_subtype + ')');

  ok(fs.existsSync(streamPath), 'stream_events.jsonl exists');
  const streamLines = fs.readFileSync(streamPath, 'utf8').trim().split('\n');
  ok(streamLines.length === 5, '5 NDJSON lines in stream_events.jsonl (got ' + streamLines.length + ')');
  for (let i = 0; i < streamLines.length; i++) {
    try { JSON.parse(streamLines[i]); ok(true, 'stream line ' + i + ' is valid JSON'); }
    catch (_e) { ok(false, 'stream line ' + i + ' parse failed: ' + streamLines[i].slice(0,80)); }
  }

  ok(fs.existsSync(tailPath), 'tail.log exists');
  const tail = fs.readFileSync(tailPath, 'utf8');
  ok(/starting work/.test(tail), 'tail.log has assistant text "starting work"');
  ok(/tool_use: Read/.test(tail), 'tail.log has tool_use summary');
  ok(!/session_id/.test(tail), 'tail.log does NOT contain raw NDJSON (no session_id leak)');
}

header(`${asserts - fails}/${asserts} assertions passed (${fails} failed)`);
if (fails) {
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
  process.exit(1);
}
process.exit(0);
