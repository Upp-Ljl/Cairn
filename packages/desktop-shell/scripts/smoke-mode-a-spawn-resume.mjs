#!/usr/bin/env node
/**
 * smoke-mode-a-spawn-resume.mjs — Phase 2+3 integration.
 *
 * Proves the end-to-end resume flow:
 *   1. Cold start: spawnModeAWorker with no prior session_id in
 *      scratchpad → argv has --mcp-config + --strict-mcp-config but
 *      NOT --resume. Fake claude emits result event with session_id.
 *      Spawner's onEvent persists it to scratchpad.
 *   2. Warm start: same project + same plan_id, second spawn →
 *      scratchpad has session_id from step 1 → argv includes
 *      `--resume <session_id>`. Fake claude's argv dump confirms.
 *   3. Plan supersession: change plan_id → no prior session for the
 *      new plan_id → fresh spawn (no --resume), independent session.
 *
 * Bypasses dispatch bookkeeping by passing tables=undefined.
 * preRegisterAgent fails silently on missing `processes` table.
 *
 * HOME sandbox per registry-pollution lesson.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const _realHome = os.homedir();
const _realProjectsJson = path.join(_realHome, '.cairn', 'projects.json');
const _tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-spawn-resume-smk-'));
const _binDir = path.join(_tmpDir, 'bin');
const _projectDir = path.join(_tmpDir, 'project');
const _argvDumpDir = path.join(_tmpDir, 'argv-dumps');
fs.mkdirSync(_binDir, { recursive: true });
fs.mkdirSync(_projectDir, { recursive: true });
fs.mkdirSync(_argvDumpDir, { recursive: true });
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

// Fake claude that emits a distinct session_id per invocation so we
// can verify capture-then-resume semantics.
const fakeBody = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const dumpDir = ${JSON.stringify(_argvDumpDir)};
const sessionEnv = process.env.FAKE_CLAUDE_SESSION_ID || ('sess_fake_' + crypto.randomBytes(4).toString('hex'));
try {
  const dumpFile = path.join(dumpDir, 'argv-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex') + '.json');
  fs.writeFileSync(dumpFile, JSON.stringify({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    has_resume: process.argv.includes('--resume'),
    resume_index: process.argv.indexOf('--resume'),
    resume_value: process.argv.indexOf('--resume') >= 0 ? process.argv[process.argv.indexOf('--resume') + 1] : null,
    has_mcp_config: process.argv.includes('--mcp-config'),
    session_emitted: sessionEnv,
    captured_at: Date.now(),
  }, null, 2));
} catch (_e) {}

process.stdin.resume();
process.stdin.on('data', () => {});

const events = [
  { type: 'system', subtype: 'init', session_id: sessionEnv, tools: ['Read'] },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'doing work' }] } },
  { type: 'result', subtype: 'success', session_id: sessionEnv, is_error: false },
];
for (const e of events) {
  process.stdout.write(JSON.stringify(e) + '\\n');
}
setTimeout(() => process.exit(0), 50);
`;
const fakeScriptPath = path.join(_binDir, 'fake-claude.js');
fs.writeFileSync(fakeScriptPath, fakeBody);
if (process.platform === 'win32') {
  fs.writeFileSync(path.join(_binDir, 'claude.cmd'), `@echo off\r\nnode "${fakeScriptPath}" %*\r\n`);
} else {
  fs.writeFileSync(path.join(_binDir, 'claude'), `#!/usr/bin/env node\n${fakeBody}`);
  fs.chmodSync(path.join(_binDir, 'claude'), 0o755);
}
process.env.PATH = _binDir + path.delimiter + process.env.PATH;

const spawner = require(path.join(dsRoot, 'mode-a-spawner.cjs'));
const sessionStore = require(path.join(dsRoot, 'mode-a-session-store.cjs'));
const streamLauncher = require(path.join(dsRoot, 'claude-stream-launcher.cjs'));
const Database = require(path.join(repoRoot, 'packages', 'daemon', 'node_modules', 'better-sqlite3'));

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE scratchpad (
      key TEXT PRIMARY KEY,
      value_json TEXT,
      value_path TEXT,
      task_id TEXT,
      expires_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  return db;
}

let asserts = 0, fails = 0;
const failures = [];
function ok(c, l) {
  asserts++;
  if (c) process.stdout.write(`  ok    ${l}\n`);
  else { fails++; failures.push(l); process.stdout.write(`  FAIL  ${l}\n`); }
}
function header(t) { process.stdout.write(`\n${'='.repeat(64)}\n${t}\n${'='.repeat(64)}\n`); }
function section(t) { process.stdout.write(`\n[${t}]\n`); }

async function waitForRunExit(runId, timeoutMs = 8000) {
  const runJsonPath = path.join(_tmpDir, '.cairn', 'worker-runs', runId, 'run.json');
  await new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
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
  return JSON.parse(fs.readFileSync(runJsonPath, 'utf8'));
}

function listArgvDumps() {
  return fs.readdirSync(_argvDumpDir)
    .filter(f => f.startsWith('argv-'))
    .sort()
    .map(f => JSON.parse(fs.readFileSync(path.join(_argvDumpDir, f), 'utf8')));
}

header('smoke-mode-a-spawn-resume (Phase 2+3 integration)');

const project = { id: 'p_integ', project_root: _projectDir };

section('1 cold start — no prior session_id → fresh spawn, NO --resume');
{
  // Pin the session_id the fake will emit so we can assert later.
  process.env.FAKE_CLAUDE_SESSION_ID = 'sess_cold_zzz';

  const db = makeDb();
  const plan = { plan_id: 'plan_alpha', current_idx: 0, steps: [{ idx: 0, label: 'step 0' }] };

  // Pre-check
  ok(sessionStore.getSessionId(db, project.id, 'plan_alpha') === null, 'pre: no session_id in scratchpad');

  const res = spawner.spawnModeAWorker({
    project, plan, db, tables: undefined, // skip dispatch bookkeeping
    profile: null,
  }, { home: _tmpDir, nowFn: () => 1_000_000 });

  ok(res.ok === true, 'spawnModeAWorker returned ok (got ' + JSON.stringify(res) + ')');
  ok(res.resume_session_id === null, 'spawn report: resume_session_id is null (cold start)');

  const meta = await waitForRunExit(res.run_id);
  ok(meta.status === 'exited', 'fake exited cleanly (got ' + meta.status + ')');
  ok(meta.argv.includes('--mcp-config'), 'argv has --mcp-config');
  ok(meta.argv.includes('--strict-mcp-config'), 'argv has --strict-mcp-config');
  ok(!meta.argv.includes('--resume'), 'argv has NO --resume on cold start');

  // Give the onEvent hook a beat to write (it runs synchronously on
  // each event, but exit fires the final flush). Best-effort poll.
  let persisted = null;
  for (let i = 0; i < 30; i++) {
    persisted = sessionStore.getSessionId(db, project.id, 'plan_alpha');
    if (persisted) break;
    await new Promise(r => setTimeout(r, 50));
  }
  ok(persisted === 'sess_cold_zzz', 'scratchpad now has captured session_id (got ' + persisted + ')');

  // Persist db for next section by stashing in closure scope.
  global._smokeDb = db;
}

section('2 warm start — prior session_id → argv includes --resume <id>');
{
  // Different session_id for this spawn so we can detect that the
  // launcher is being asked to RESUME the prior one, not start fresh.
  process.env.FAKE_CLAUDE_SESSION_ID = 'sess_warm_new';

  const db = global._smokeDb;
  // Confirm prior state survived from section 1
  ok(sessionStore.getSessionId(db, project.id, 'plan_alpha') === 'sess_cold_zzz', 'prior session_id still in scratchpad');

  // Same project + same plan_id = same scratchpad key
  const plan = { plan_id: 'plan_alpha', current_idx: 1, steps: [{ idx: 1, label: 'step 1' }] };
  const dumpsBefore = listArgvDumps().length;

  const res = spawner.spawnModeAWorker({
    project, plan, db, tables: undefined, profile: null,
  }, { home: _tmpDir, nowFn: () => 2_000_000 });

  ok(res.ok === true, 'warm spawn returned ok');
  ok(res.resume_session_id === 'sess_cold_zzz', 'spawn report: resume_session_id = sess_cold_zzz');

  const meta = await waitForRunExit(res.run_id);
  ok(meta.argv.includes('--resume'), 'argv has --resume on warm start');
  const idx = meta.argv.indexOf('--resume');
  ok(meta.argv[idx + 1] === 'sess_cold_zzz', 'argv has the cold session_id after --resume');
  ok(meta.resume_session_id === 'sess_cold_zzz', 'meta records resume target');

  // Verify the fake claude actually saw --resume on its argv
  const dumpsAfter = listArgvDumps();
  ok(dumpsAfter.length > dumpsBefore, 'new argv dump captured');
  const last = dumpsAfter[dumpsAfter.length - 1];
  ok(last.has_resume === true, 'fake claude saw --resume in its argv');
  ok(last.resume_value === 'sess_cold_zzz', 'fake claude saw the right session_id (got ' + last.resume_value + ')');

  // After this run, the scratchpad should have the NEW session_id (the
  // one the fake emitted in this second run) because onEvent persists
  // each new result.session_id. This is the documented behavior — CC
  // resume may return a different ID, and the new one is what we want
  // for the next step.
  let updated = null;
  for (let i = 0; i < 30; i++) {
    updated = sessionStore.getSessionId(db, project.id, 'plan_alpha');
    if (updated === 'sess_warm_new') break;
    await new Promise(r => setTimeout(r, 50));
  }
  ok(updated === 'sess_warm_new', 'scratchpad updated to new session_id after second run (got ' + updated + ')');
}

section('3 plan supersession — new plan_id → fresh spawn (no --resume)');
{
  process.env.FAKE_CLAUDE_SESSION_ID = 'sess_supersede_xyz';

  const db = global._smokeDb;
  const plan = { plan_id: 'plan_beta', current_idx: 0, steps: [{ idx: 0, label: 's0' }] };

  // No row for plan_beta yet
  ok(sessionStore.getSessionId(db, project.id, 'plan_beta') === null, 'pre: no session for plan_beta');
  // But plan_alpha row still there
  ok(sessionStore.getSessionId(db, project.id, 'plan_alpha') === 'sess_warm_new', 'plan_alpha row preserved');

  const dumpsBefore = listArgvDumps().length;

  const res = spawner.spawnModeAWorker({
    project, plan, db, tables: undefined, profile: null,
  }, { home: _tmpDir, nowFn: () => 3_000_000 });

  ok(res.ok === true, 'plan_beta spawn ok');
  ok(res.resume_session_id === null, 'spawn report: resume_session_id null (no prior for plan_beta)');

  const meta = await waitForRunExit(res.run_id);
  ok(!meta.argv.includes('--resume'), 'argv NO --resume for new plan_id');

  const dumpsAfter = listArgvDumps();
  ok(dumpsAfter.length > dumpsBefore, 'argv dump for plan_beta captured');
  const last = dumpsAfter[dumpsAfter.length - 1];
  ok(last.has_resume === false, 'fake claude did not see --resume on plan_beta');

  // Both rows now exist
  let plan_b_session = null;
  for (let i = 0; i < 30; i++) {
    plan_b_session = sessionStore.getSessionId(db, project.id, 'plan_beta');
    if (plan_b_session) break;
    await new Promise(r => setTimeout(r, 50));
  }
  ok(plan_b_session === 'sess_supersede_xyz', 'plan_beta row written');
  ok(sessionStore.getSessionId(db, project.id, 'plan_alpha') === 'sess_warm_new', 'plan_alpha row still preserved');

  const count = db.prepare("SELECT COUNT(*) AS c FROM scratchpad WHERE key LIKE 'mode_a_session/%'").get().c;
  ok(count === 2, '2 distinct rows (one per plan_id), got ' + count);
}

header(`${asserts - fails}/${asserts} assertions passed (${fails} failed)`);
if (fails) {
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
  process.exit(1);
}
process.exit(0);
