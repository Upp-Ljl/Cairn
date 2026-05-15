#!/usr/bin/env node
/**
 * smoke-hooks-turn-protocol.mjs — E2E protocol smoke for the
 * hooks-based turn-completion path (2026-05-15). Builds a fake claude
 * binary that emits NDJSON hook events with the shape we lock from
 * spike-claude-hooks.mjs, then drives the real launcher and asserts:
 *
 *   1) launcher passes --include-hook-events + --settings <path> in argv
 *   2) settings.json temp file exists during run + cleanup removes it
 *   3) Stop hook with stop_hook_active=false → onTurnDone fires once
 *      with payload (session_id, transcript_path, last_assistant_text)
 *   4) Stop hook with stop_hook_active=true → onTurnDone NOT fired
 *      (dedupe R2 mitigation); subsequent stop_hook_active=false
 *      fires it once.
 *   5) No hook events + only `result` event → onTurnDone fires via
 *      result-event fallback with source='result'.
 *   6) hook-events.jsonl audit trail exists on disk with one line per
 *      hook fired (durable strategy (c) part).
 *   7) Field-defensive: payload missing transcript_path still fires
 *      onTurnDone with transcript_path=null.
 *
 * HOME sandbox (registry-pollution lesson).
 * Hook command from CC is replaced by the fake's own stdout-payload
 * emission — we don't actually exec node -e here. The fake just emits
 * pre-formed hook_response NDJSON events whose `stdout` field contains
 * the JSON payload (mirroring the contract the real hook command
 * produces).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const _realHome = os.homedir();
const _realProjectsJson = path.join(_realHome, '.cairn', 'projects.json');
const _tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-hooks-smk-'));
fs.mkdirSync(path.join(_tmpDir, '.cairn'), { recursive: true });
process.env.HOME = _tmpDir;
process.env.USERPROFILE = _tmpDir;
const _mtimeBefore = fs.existsSync(_realProjectsJson) ? fs.statSync(_realProjectsJson).mtimeMs : null;
process.on('exit', () => {
  const _mtimeAfter = fs.existsSync(_realProjectsJson) ? fs.statSync(_realProjectsJson).mtimeMs : null;
  if (_mtimeBefore !== _mtimeAfter) {
    console.error('FATAL: smoke wrote to REAL ~/.cairn/projects.json');
    process.exit(3);
  }
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dsRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(dsRoot, '..', '..');
const require = createRequire(import.meta.url);

const _binDir = path.join(_tmpDir, 'bin');
fs.mkdirSync(_binDir, { recursive: true });
const _argvDumpDir = path.join(_tmpDir, 'argv-dumps');
fs.mkdirSync(_argvDumpDir, { recursive: true });

// Fake-claude factory — generates different NDJSON sequences based on
// FAKE_CLAUDE_SCENARIO env var. Hook payload is emitted as a JSON
// string inside the `stdout` field of hook_response, exactly matching
// the contract the real `node -e` hook command produces (it echoes
// stdin to stdout).
function fakeBody() {
  return `
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const dumpDir = ${JSON.stringify(_argvDumpDir)};
const scenario = process.env.FAKE_CLAUDE_SCENARIO || 'hooks_normal';
const sessionId = process.env.FAKE_CLAUDE_SESSION_ID || ('sess_hook_' + crypto.randomBytes(4).toString('hex'));
try {
  const dumpFile = path.join(dumpDir, 'argv-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex') + '.json');
  fs.writeFileSync(dumpFile, JSON.stringify({
    argv: process.argv.slice(2),
    scenario,
    has_include_hook_events: process.argv.includes('--include-hook-events'),
    has_settings: process.argv.includes('--settings'),
    settings_path: process.argv.indexOf('--settings') >= 0 ? process.argv[process.argv.indexOf('--settings') + 1] : null,
    has_mcp_config: process.argv.includes('--mcp-config'),
    captured_at: Date.now(),
  }, null, 2));
} catch (_e) {}

process.stdin.resume();
process.stdin.on('data', () => {});

function hookPayload(opts) {
  const out = {
    session_id: sessionId,
    cwd: ${JSON.stringify(_tmpDir)},
    permission_mode: 'bypassPermissions',
    hook_event_name: 'Stop',
    stop_hook_active: !!opts.stop_hook_active,
    last_assistant_message: opts.last_assistant_message === undefined ? 'done' : opts.last_assistant_message,
  };
  // Only include transcript_path when caller actually wants it. The
  // 'omit' sentinel (opts.transcript_path === null) lets the smoke
  // hooks_missing_field scenario test the launcher's field-defensive
  // path. Default = real path; omit = no field at all.
  if (opts.transcript_path !== null) {
    out.transcript_path = opts.transcript_path === undefined
      ? ${JSON.stringify(path.join(_tmpDir, 'fake-transcript.jsonl'))}
      : opts.transcript_path;
  }
  return out;
}

const eventsByScenario = {
  // Normal hooks flow: init → assistant → hook_started/response (SessionStart) →
  //   assistant text → hook_started/response (Stop, stop_hook_active=false) → result
  hooks_normal: [
    { type: 'system', subtype: 'hook_started', hook_id: 'h1', hook_name: 'SessionStart:startup', hook_event: 'SessionStart', session_id: sessionId },
    { type: 'system', subtype: 'hook_response', hook_id: 'h1', hook_name: 'SessionStart:startup', hook_event: 'SessionStart', session_id: sessionId, stdout: '', exit_code: 0, outcome: 'success' },
    { type: 'system', subtype: 'init', session_id: sessionId, tools: ['Read'] },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'working' }] } },
    { type: 'system', subtype: 'hook_started', hook_id: 'h2', hook_name: 'Stop', hook_event: 'Stop', session_id: sessionId },
    { type: 'system', subtype: 'hook_response', hook_id: 'h2', hook_name: 'Stop', hook_event: 'Stop', session_id: sessionId, stdout: JSON.stringify(hookPayload({ stop_hook_active: false, last_assistant_message: 'finished' })), exit_code: 0, outcome: 'success' },
    { type: 'result', subtype: 'success', session_id: sessionId, is_error: false },
  ],
  // Reentry: Stop fires once with stop_hook_active=true (CC continues), then again with false
  hooks_reentry: [
    { type: 'system', subtype: 'init', session_id: sessionId, tools: ['Read'] },
    { type: 'system', subtype: 'hook_response', hook_id: 'h_re1', hook_name: 'Stop', hook_event: 'Stop', session_id: sessionId, stdout: JSON.stringify(hookPayload({ stop_hook_active: true })), exit_code: 0, outcome: 'success' },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'continuing' }] } },
    { type: 'system', subtype: 'hook_response', hook_id: 'h_re2', hook_name: 'Stop', hook_event: 'Stop', session_id: sessionId, stdout: JSON.stringify(hookPayload({ stop_hook_active: false, last_assistant_message: 'really done' })), exit_code: 0, outcome: 'success' },
    { type: 'result', subtype: 'success', session_id: sessionId, is_error: false },
  ],
  // No hook events at all → fallback path via result-event
  no_hooks: [
    { type: 'system', subtype: 'init', session_id: sessionId, tools: ['Read'] },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'fallback' }] } },
    { type: 'result', subtype: 'success', session_id: sessionId, is_error: false },
  ],
  // Field-defensive: payload missing transcript_path
  hooks_missing_field: [
    { type: 'system', subtype: 'init', session_id: sessionId, tools: ['Read'] },
    { type: 'system', subtype: 'hook_response', hook_id: 'h_mf', hook_name: 'Stop', hook_event: 'Stop', session_id: sessionId, stdout: JSON.stringify(hookPayload({ stop_hook_active: false, transcript_path: null, last_assistant_message: 'partial' })), exit_code: 0, outcome: 'success' },
    { type: 'result', subtype: 'success', session_id: sessionId, is_error: false },
  ],
  // Malformed hook payload — JSON.parse throws in launcher. Reviewer
  // gap #2: covers the try/catch around JSON.parse(ev.stdout). Stop
  // hook fires but payload is null → onTurnDone fires with envelope
  // session_id and null payload fields (graceful degrade, not crash).
  hooks_malformed_stdout: [
    { type: 'system', subtype: 'init', session_id: sessionId, tools: ['Read'] },
    { type: 'system', subtype: 'hook_response', hook_id: 'h_mal', hook_name: 'Stop', hook_event: 'Stop', session_id: sessionId, stdout: '{not_valid_json', exit_code: 0, outcome: 'success' },
    { type: 'result', subtype: 'success', session_id: sessionId, is_error: false },
  ],
  // Two Stop events both with stop_hook_active=false. NOT the reentry
  // case (which is active=true → active=false). This is "CC emitted
  // Stop twice for the same turn, both signalled real-done." Should
  // be deduped via fired_for_turn === turn_index gate. Reviewer gap
  // #3 — exercises launcher's stop_hook_dup_suppressed log path.
  hooks_double_stop: [
    { type: 'system', subtype: 'init', session_id: sessionId, tools: ['Read'] },
    { type: 'system', subtype: 'hook_response', hook_id: 'h_d1', hook_name: 'Stop', hook_event: 'Stop', session_id: sessionId, stdout: JSON.stringify(hookPayload({ stop_hook_active: false, last_assistant_message: 'first done' })), exit_code: 0, outcome: 'success' },
    { type: 'system', subtype: 'hook_response', hook_id: 'h_d2', hook_name: 'Stop', hook_event: 'Stop', session_id: sessionId, stdout: JSON.stringify(hookPayload({ stop_hook_active: false, last_assistant_message: 'dup ignore me' })), exit_code: 0, outcome: 'success' },
    { type: 'result', subtype: 'success', session_id: sessionId, is_error: false },
  ],
};

const events = eventsByScenario[scenario] || eventsByScenario.hooks_normal;
for (const e of events) {
  process.stdout.write(JSON.stringify(e) + '\\n');
}
setTimeout(() => process.exit(0), 60);
`;
}

const fakeScriptPath = path.join(_binDir, 'fake-claude.js');
fs.writeFileSync(fakeScriptPath, fakeBody());
if (process.platform === 'win32') {
  fs.writeFileSync(path.join(_binDir, 'claude.cmd'), `@echo off\r\nnode "${fakeScriptPath}" %*\r\n`);
} else {
  fs.writeFileSync(path.join(_binDir, 'claude'), `#!/usr/bin/env node\n${fakeBody()}`);
  fs.chmodSync(path.join(_binDir, 'claude'), 0o755);
}
process.env.PATH = _binDir + path.delimiter + process.env.PATH;

const streamLauncher = require(path.join(dsRoot, 'claude-stream-launcher.cjs'));

let asserts = 0, fails = 0;
const failures = [];
function ok(c, l) {
  asserts++;
  if (c) process.stdout.write(`  ok    ${l}\n`);
  else { fails++; failures.push(l); process.stdout.write(`  FAIL  ${l}\n`); }
}
function header(t) { process.stdout.write(`\n${'='.repeat(64)}\n${t}\n${'='.repeat(64)}\n`); }
function section(t) { process.stdout.write(`\n[${t}]\n`); }

async function waitForChildExit(child, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), timeoutMs);
    child.on('exit', () => { clearTimeout(t); resolve(true); });
  });
}

async function runScenario(scenario, opts = {}) {
  const sessionId = 'sess_' + scenario.replace(/_/g, '-') + '-' + Date.now();
  // Launcher passes input.env verbatim if truthy; spread current
  // process env so the fake claude inherits PATH + our scenario knobs.
  const env = Object.assign({}, process.env, {
    FAKE_CLAUDE_SCENARIO: scenario,
    FAKE_CLAUDE_SESSION_ID: sessionId,
  });
  const turnDoneCalls = [];
  const events = [];
  const launchRes = streamLauncher.launchStreamWorker({
    cwd: _tmpDir,
    prompt: 'test',
    iteration_id: 'smk:' + scenario,
    project_id: 'p_smk_' + scenario,
    env,
  }, {
    home: _tmpDir,
    onTurnDone: (p) => { turnDoneCalls.push(p); if (opts.onTurnDone) opts.onTurnDone(p); },
    onEvent: (ev) => events.push(ev),
  });
  ok(launchRes && launchRes.ok === true, `[${scenario}] launchStreamWorker ok`);
  if (!launchRes || !launchRes.ok) return { turnDoneCalls, events, launchRes };
  // Wait for child exit so settings cleanup runs.
  if (launchRes.child) await waitForChildExit(launchRes.child);
  return { turnDoneCalls, events, launchRes };
}

header('smoke-hooks-turn-protocol (E2E w/ fake claude — commit 5)');

// Read latest argv dump for assertion
function latestArgvDump() {
  const files = fs.readdirSync(_argvDumpDir).filter(f => f.startsWith('argv-')).sort();
  if (!files.length) return null;
  return JSON.parse(fs.readFileSync(path.join(_argvDumpDir, files[files.length - 1]), 'utf8'));
}

section('A hooks_normal — Stop hook fires once + payload propagated');
{
  const { turnDoneCalls, launchRes } = await runScenario('hooks_normal');
  ok(turnDoneCalls.length === 1, `onTurnDone fired exactly once (got ${turnDoneCalls.length})`);
  const p = turnDoneCalls[0] || {};
  ok(p.source === 'hook', `source = 'hook' (got ${p.source})`);
  ok(typeof p.session_id === 'string' && p.session_id.startsWith('sess_hooks-normal-'), `session_id present (got ${p.session_id})`);
  ok(p.transcript_path && p.transcript_path.includes('fake-transcript.jsonl'), `transcript_path propagated (got ${p.transcript_path})`);
  ok(p.last_assistant_text === 'finished', `last_assistant_text propagated (got ${p.last_assistant_text})`);
  ok(p.stop_hook_active === false, 'stop_hook_active = false on fired payload');
  ok(p.turn_index === 0, `turn_index = 0 first turn (got ${p.turn_index})`);
  // Argv assertions (8 in plan)
  const ad = latestArgvDump();
  ok(ad && ad.has_include_hook_events === true, '--include-hook-events in argv');
  ok(ad && ad.has_settings === true, '--settings in argv');
  ok(ad && ad.settings_path && ad.settings_path.includes('cairn-claude-settings-'), 'settings_path is per-spawn temp');
  // Settings file cleanup — child exited, file should be gone
  ok(ad && ad.settings_path && !fs.existsSync(ad.settings_path), 'settings.json cleaned up after exit');
  // hook-events.jsonl audit trail not asserted here (no real hook ran;
  // the fake claude doesn't exec the node -e command). Covered in
  // unit smoke (settings-config) and live spike instead.
}

section('B hooks_reentry — stop_hook_active=true is suppressed, then false fires once');
{
  const { turnDoneCalls } = await runScenario('hooks_reentry');
  ok(turnDoneCalls.length === 1, `onTurnDone fired exactly once across both Stop events (got ${turnDoneCalls.length})`);
  const p = turnDoneCalls[0] || {};
  ok(p.source === 'hook', `source = 'hook' (got ${p.source})`);
  ok(p.last_assistant_text === 'really done', `payload from the SECOND (real) Stop event (got ${p.last_assistant_text})`);
  ok(p.stop_hook_active === false, 'stop_hook_active=false on the fired payload');
}

section('C no_hooks — onTurnDone fires via result-event fallback');
{
  const { turnDoneCalls } = await runScenario('no_hooks');
  ok(turnDoneCalls.length === 1, `onTurnDone fired once via fallback (got ${turnDoneCalls.length})`);
  const p = turnDoneCalls[0] || {};
  ok(p.source === 'result', `source = 'result' (got ${p.source})`);
  ok(typeof p.session_id === 'string' && p.session_id.startsWith('sess_no-hooks-'), 'session_id captured from result event');
  ok(p.transcript_path === null, 'transcript_path = null in fallback (not available)');
  ok(p.last_assistant_text === null, 'last_assistant_text = null in fallback');
}

section('D hooks_missing_field — field-defensive: undefined transcript_path becomes null');
{
  const { turnDoneCalls } = await runScenario('hooks_missing_field');
  ok(turnDoneCalls.length === 1, `onTurnDone fired once (got ${turnDoneCalls.length})`);
  const p = turnDoneCalls[0] || {};
  ok(p.source === 'hook', `source = 'hook' (got ${p.source})`);
  ok(p.transcript_path === null, 'missing transcript_path → null (not undefined)');
  ok(p.last_assistant_text === 'partial', 'other fields still propagate');
  ok(typeof p.session_id === 'string' && p.session_id.length > 0, 'session_id still present');
}

section('D2 hooks_malformed_stdout — JSON.parse fails, graceful degrade');
{
  const { turnDoneCalls } = await runScenario('hooks_malformed_stdout');
  ok(turnDoneCalls.length === 1, `onTurnDone fired once even with malformed payload (got ${turnDoneCalls.length})`);
  const p = turnDoneCalls[0] || {};
  ok(p.source === 'hook', `source = 'hook' (got ${p.source}) — launcher proceeded past parse error`);
  ok(p.raw === null, `raw payload = null when parse fails (got ${JSON.stringify(p.raw)})`);
  ok(p.transcript_path === null, 'transcript_path = null after parse fail');
  ok(p.last_assistant_text === null, 'last_assistant_text = null after parse fail');
  ok(typeof p.session_id === 'string' && p.session_id.length > 0, 'session_id from envelope (not payload) still present');
}

section('D3 hooks_double_stop — two Stop active=false events → dedupe to one fire');
{
  const { turnDoneCalls } = await runScenario('hooks_double_stop');
  ok(turnDoneCalls.length === 1, `onTurnDone fired exactly once across two real-done Stops (got ${turnDoneCalls.length})`);
  const p = turnDoneCalls[0] || {};
  ok(p.last_assistant_text === 'first done', `payload from the FIRST Stop (got ${p.last_assistant_text}) — dup suppressed`);
}

section('E cleanup behaviour — runs even if launcher returns ok:false');
{
  // Force a settings build failure by giving tmpDir that doesn't exist.
  // (settings_config_failed path in launcher.)
  const launchRes = streamLauncher.launchStreamWorker({
    cwd: _tmpDir,
    prompt: 'test',
    iteration_id: 'smk:fail',
    project_id: 'p_smk_fail',
    env: {},
  }, {
    home: _tmpDir,
    settingsConfigTmpDir: path.join(_tmpDir, 'does-not-exist', 'nested'),
  });
  ok(launchRes && launchRes.ok === false, 'launcher returns ok:false when settings config fails');
  ok(launchRes && /settings_config_failed/.test(launchRes.error || ''), `error tagged settings_config_failed (got ${launchRes && launchRes.error})`);
}

header(`${asserts - fails}/${asserts} assertions passed (${fails} failed)`);
if (fails) {
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
  process.exit(1);
}
process.exit(0);
