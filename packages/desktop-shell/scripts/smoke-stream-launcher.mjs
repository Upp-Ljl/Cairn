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

// Write fake-claude.js that emits NDJSON events AND dumps argv so smoke
// can verify --mcp-config / --strict-mcp-config / --resume are present.
const argvDumpDir = path.join(_tmpDir, 'argv-dumps');
fs.mkdirSync(argvDumpDir, { recursive: true });
const fakeBody = `#!/usr/bin/env node
// Fake claude — emits 5 NDJSON events, dumps argv, ignores stdin.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const dumpDir = ${JSON.stringify(argvDumpDir)};
try {
  // Filename prefixed with high-resolution timestamp so sort() gives
  // launch order (random suffix breaks collisions within same ms).
  const stamp = String(Date.now()).padStart(16, '0') + '-' + process.hrtime.bigint().toString().padStart(20, '0');
  const dumpFile = path.join(dumpDir, 'argv-' + stamp + '-' + crypto.randomBytes(3).toString('hex') + '.json');
  fs.writeFileSync(dumpFile, JSON.stringify({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    has_resume: process.argv.includes('--resume'),
    has_mcp_config: process.argv.includes('--mcp-config'),
    has_strict_mcp_config: process.argv.includes('--strict-mcp-config'),
    has_bypass: process.argv.includes('bypassPermissions'),
    pid: process.pid,
    captured_at: Date.now(),
  }, null, 2));
} catch (_e) {}

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

// Seed the project with a .mcp.json holding a non-cairn server entry so
// smoke can verify the merge: project's `notion-mcp` should survive,
// `cairn-wedge` gets overridden with canonical path.
const projectMcpPath = path.join(_projectDir, '.mcp.json');
fs.writeFileSync(projectMcpPath, JSON.stringify({
  mcpServers: {
    'notion-mcp': { command: 'node', args: ['./notion-mcp.js'] },
    'cairn-wedge': { command: 'node', args: ['STALE-PATH-SHOULD-BE-OVERRIDDEN'] },
  },
}, null, 2));

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

  // Phase 3 argv assertions: --mcp-config <path> + --strict-mcp-config + bypassPermissions.
  ok(Array.isArray(meta.argv) && meta.argv.includes('--mcp-config'), 'argv contains --mcp-config');
  ok(meta.argv.includes('--strict-mcp-config'), 'argv contains --strict-mcp-config');
  ok(typeof meta.mcp_config_path === 'string' && meta.mcp_config_path.length > 0, 'meta.mcp_config_path set (got ' + meta.mcp_config_path + ')');
  ok(meta.mcp_server_count === 2, 'mcp_server_count=2 (notion + cairn-wedge), got ' + meta.mcp_server_count);

  // Phase 3 cleanup: the temp file must be gone after child exit.
  ok(!fs.existsSync(meta.mcp_config_path), 'mcp-config temp file cleaned up on exit');

  // Phase 2 negative: no resumeSessionId given → no --resume in argv.
  ok(!meta.argv.includes('--resume'), 'argv does NOT contain --resume (no prior session)');
  ok(meta.resume_session_id === null, 'meta.resume_session_id is null');

  // Phase 3 argv on the child side (what the fake binary actually received).
  const argvFiles = fs.readdirSync(argvDumpDir).filter(f => f.startsWith('argv-')).sort();
  ok(argvFiles.length >= 1, 'fake claude dumped ≥1 argv file (got ' + argvFiles.length + ')');
  const lastDump = JSON.parse(fs.readFileSync(path.join(argvDumpDir, argvFiles[argvFiles.length - 1]), 'utf8'));
  ok(lastDump.has_mcp_config === true, 'child saw --mcp-config in its argv');
  ok(lastDump.has_strict_mcp_config === true, 'child saw --strict-mcp-config in its argv');
  ok(lastDump.has_bypass === true, 'child saw bypassPermissions');
  ok(lastDump.has_resume === false, 'child did NOT see --resume on cold start');
}

section('5 Phase 3 — mcp-config file content + canonical cairn-wedge override');
{
  // Build a config file directly via the helper and inspect.
  const mcpHelper = require(path.join(dsRoot, 'claude-mcp-config.cjs'));
  const res = mcpHelper.buildMcpConfigFile({
    projectRoot: _projectDir,
    runId: 'smoke_p3_' + Date.now(),
    tmpDir: _tmpDir,
  });
  ok(res.ok === true, 'buildMcpConfigFile ok');
  ok(fs.existsSync(res.tempPath), 'temp file exists');
  ok(res.projectHadCairnWedge === true, 'detected stale cairn-wedge in project .mcp.json');

  const parsed = JSON.parse(fs.readFileSync(res.tempPath, 'utf8'));
  ok(parsed.mcpServers && typeof parsed.mcpServers === 'object', 'file has mcpServers map');
  ok(parsed.mcpServers['notion-mcp'] != null, 'notion-mcp survives merge');
  ok(parsed.mcpServers['cairn-wedge'] != null, 'cairn-wedge present');
  const cw = parsed.mcpServers['cairn-wedge'];
  ok(cw.command === 'node', 'cairn-wedge.command = node');
  ok(Array.isArray(cw.args) && cw.args.length === 1, 'cairn-wedge.args length 1');
  ok(!String(cw.args[0]).includes('STALE'), 'STALE path overridden by canonical (got ' + cw.args[0] + ')');
  ok(/mcp-server[\\/]dist[\\/]index\.js$/.test(cw.args[0]), 'canonical points at mcp-server/dist/index.js');

  res.cleanup();
  ok(!fs.existsSync(res.tempPath), 'cleanup() removes the temp file');
}

section('6 Phase 3 — no project .mcp.json still injects canonical cairn-wedge');
{
  const mcpHelper = require(path.join(dsRoot, 'claude-mcp-config.cjs'));
  const bareDir = path.join(_tmpDir, 'bare-project');
  fs.mkdirSync(bareDir, { recursive: true });
  const res = mcpHelper.buildMcpConfigFile({
    projectRoot: bareDir,
    runId: 'smoke_p3_bare_' + Date.now(),
    tmpDir: _tmpDir,
  });
  ok(res.ok === true, 'buildMcpConfigFile ok on bare project');
  ok(res.projectHadCairnWedge === false, 'projectHadCairnWedge=false (no .mcp.json)');
  ok(res.serverCount === 1, 'serverCount=1 (cairn-wedge only)');
  const parsed = JSON.parse(fs.readFileSync(res.tempPath, 'utf8'));
  ok(parsed.mcpServers && parsed.mcpServers['cairn-wedge'], 'cairn-wedge auto-injected');
  res.cleanup();
}

section('7 Phase 2 — resumeSessionId puts --resume in argv');
{
  // Second launch with resumeSessionId — verify argv mutation + meta recording.
  const fakeSession = 'sess_fake_resumed_xyz';
  const res = launcher.launchStreamWorker({
    cwd: _projectDir,
    prompt: 'continue please',
    project_id: 'p_test',
    iteration_id: 'smoke-resume',
    env: process.env,
    resumeSessionId: fakeSession,
  }, { home: _tmpDir });

  ok(res.ok === true, 'launch with resumeSessionId returns ok');
  const runJsonPath = path.join(_tmpDir, '.cairn', 'worker-runs', res.run_id, 'run.json');
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
  const meta = JSON.parse(fs.readFileSync(runJsonPath, 'utf8'));
  ok(meta.argv.includes('--resume'), 'argv contains --resume');
  const idx = meta.argv.indexOf('--resume');
  ok(meta.argv[idx + 1] === fakeSession, 'argv has the session_id after --resume');
  ok(meta.resume_session_id === fakeSession, 'meta.resume_session_id = ' + fakeSession);

  // Verify the fake binary actually received --resume too.
  const argvFiles2 = fs.readdirSync(argvDumpDir).filter(f => f.startsWith('argv-')).sort();
  const lastDump2 = JSON.parse(fs.readFileSync(path.join(argvDumpDir, argvFiles2[argvFiles2.length - 1]), 'utf8'));
  ok(lastDump2.has_resume === true, 'child saw --resume in its argv on resume launch');
  ok(lastDump2.argv.includes(fakeSession), 'child argv includes the session_id literal');
}

section('8 Phase 2 — invalid resumeSessionId rejected');
{
  const res = launcher.launchStreamWorker({
    cwd: _projectDir,
    prompt: 'x',
    project_id: 'p_test',
    env: process.env,
    resumeSessionId: '   ',
  }, { home: _tmpDir });
  ok(res.ok === false, 'empty/whitespace resumeSessionId rejected');
  ok(res.error === 'resumeSessionId_must_be_nonempty_string', 'error = resumeSessionId_must_be_nonempty_string (got ' + res.error + ')');

  const res2 = launcher.launchStreamWorker({
    cwd: _projectDir,
    prompt: 'x',
    project_id: 'p_test',
    env: process.env,
    resumeSessionId: 42, // non-string
  }, { home: _tmpDir });
  ok(res2.ok === false, 'non-string resumeSessionId rejected');
  ok(res2.error === 'resumeSessionId_must_be_nonempty_string', 'error matches');
}

header(`${asserts - fails}/${asserts} assertions passed (${fails} failed)`);
if (fails) {
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
  process.exit(1);
}
process.exit(0);
