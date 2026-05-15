#!/usr/bin/env node
/**
 * smoke-harness-pool.mjs — smoke test for harness-pool.cjs (Module 8).
 *
 * Covers:
 *   1. createPool with project + plan -> state has empty worker + reviewer
 *   2. getWorker(0) first call -> spawns, slotState=READY
 *   3. getWorker(1) second call -> reuses child, stepCount increments
 *   4. getWorker after maxStepsBeforeRestart -> spawns fresh (auto-restart)
 *   5. getReviewer() -> spawns reviewer with 'cairn-reviewer-' prefix
 *   6. getReviewer() second call -> reuses existing reviewer
 *   7. Worker crash (emit 'exit') -> slot becomes DEAD
 *   8. getWorker after crash -> spawns fresh (crash recovery)
 *   9. writeNextTurn writes JSON envelope to child.stdin
 *  10. teardown() kills all alive children
 *  11. getState() returns correct slot states throughout
 *  12. Reviewer agentId pattern differs from worker
 *
 * HOME sandbox: mandatory (prevents real ~/.cairn/projects.json pollution).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

// ---------------------------------------------------------------------------
// HOME sandbox — must be first, before any require that might touch HOME.
// ---------------------------------------------------------------------------
const _realHome = os.homedir();
const _realProjectsJson = path.join(_realHome, '.cairn', 'projects.json');
const _tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-harness-pool-'));
fs.mkdirSync(path.join(_tmpDir, '.cairn'), { recursive: true });
process.env.HOME = _tmpDir;
process.env.USERPROFILE = _tmpDir;

const _mtimeBefore = fs.existsSync(_realProjectsJson)
  ? fs.statSync(_realProjectsJson).mtimeMs
  : null;

process.on('exit', () => {
  const _mtimeAfter = fs.existsSync(_realProjectsJson)
    ? fs.statSync(_realProjectsJson).mtimeMs
    : null;
  if (_mtimeBefore !== _mtimeAfter) {
    console.error('FATAL: smoke wrote to REAL ~/.cairn/projects.json');
    process.exit(3);
  }
});

// ---------------------------------------------------------------------------
// Require harness-pool
// ---------------------------------------------------------------------------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dsRoot = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const { createPool, SLOT_STATES, SLOT_TYPES } = require(path.join(dsRoot, 'harness-pool.cjs'));

// ---------------------------------------------------------------------------
// Mock launcher
// ---------------------------------------------------------------------------

let _spawnCount = 0;

function mockLauncher(opts) {
  _spawnCount++;
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.pid = Math.floor(Math.random() * 99999) + 1;
  child.killed = false;
  child.exitCode = null;
  child.kill = (sig) => {
    if (!child.killed) {
      child.killed = true;
      child.exitCode = 0;
      child.emit('exit', 0, sig || 'SIGTERM');
    }
  };
  return {
    ok: true,
    child,
    run_id: 'run_' + Date.now() + '_' + _spawnCount,
    agent_id: opts.agentId || 'mock-agent',
  };
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let asserts = 0;
let fails = 0;
const failures = [];

function ok(cond, label) {
  asserts++;
  if (cond) {
    process.stdout.write(`  ok    ${label}\n`);
  } else {
    fails++;
    failures.push(label);
    process.stdout.write(`  FAIL  ${label}\n`);
  }
}

function header(t) {
  process.stdout.write(`\n${'='.repeat(64)}\n${t}\n${'='.repeat(64)}\n`);
}

function section(t) {
  process.stdout.write(`\n[${t}]\n`);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const project = {
  id: 'proj-test-001',
  project_root: _tmpDir,
};

const plan = {
  plan_id: 'plan-abc-123',
  steps: [
    { idx: 0, label: 'Step 0' },
    { idx: 1, label: 'Step 1' },
    { idx: 2, label: 'Step 2' },
  ],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

header('smoke-harness-pool');

// ---------------------------------------------------------------------------
section('1. SLOT_STATES and SLOT_TYPES exported');
// ---------------------------------------------------------------------------
{
  ok(typeof SLOT_STATES === 'object' && SLOT_STATES !== null, 'SLOT_STATES is object');
  ok(SLOT_STATES.EMPTY === 'EMPTY', 'SLOT_STATES.EMPTY = EMPTY');
  ok(SLOT_STATES.READY === 'READY', 'SLOT_STATES.READY = READY');
  ok(SLOT_STATES.DEAD === 'DEAD', 'SLOT_STATES.DEAD = DEAD');
  ok(SLOT_TYPES.WORKER === 'WORKER', 'SLOT_TYPES.WORKER = WORKER');
  ok(SLOT_TYPES.REVIEWER === 'REVIEWER', 'SLOT_TYPES.REVIEWER = REVIEWER');
}

// ---------------------------------------------------------------------------
section('2. createPool -> initial state has empty worker + reviewer');
// ---------------------------------------------------------------------------
let pool;
{
  _spawnCount = 0;
  pool = createPool({ project, plan, launcherFn: mockLauncher });

  const state = pool.getState();
  ok(state.planId === plan.plan_id, `planId = ${plan.plan_id}`);
  ok(state.worker.slotState === SLOT_STATES.EMPTY, 'worker starts EMPTY');
  ok(state.reviewer.slotState === SLOT_STATES.EMPTY, 'reviewer starts EMPTY');
  ok(state.worker.agentId === null, 'worker agentId null initially');
  ok(state.reviewer.agentId === null, 'reviewer agentId null initially');
  ok(_spawnCount === 0, 'no spawns at createPool time');
}

// ---------------------------------------------------------------------------
section('3. getWorker(0) -> spawns, slotState=READY, agentId has cairn-worker- prefix');
// ---------------------------------------------------------------------------
let worker0;
{
  _spawnCount = 0;
  worker0 = pool.getWorker(0);

  ok(_spawnCount === 1, 'first getWorker spawns once');
  ok(worker0.slotState === SLOT_STATES.READY, 'slotState READY after first spawn');
  ok(worker0.agentId !== null, 'agentId assigned');
  ok(worker0.agentId.startsWith('cairn-worker-'), `agentId starts with cairn-worker- (got ${worker0.agentId})`);
  ok(worker0.stepCount === 1, 'stepCount is 1 after first getWorker');
  ok(worker0.child !== null, 'child handle returned');
  ok(typeof worker0.writeNextTurn === 'function', 'writeNextTurn is a function');
  ok(typeof worker0.isAlive === 'function', 'isAlive is a function');
  ok(worker0.isAlive(), 'worker is alive after spawn');
}

// ---------------------------------------------------------------------------
section('4. getWorker(1) -> reuses existing child, stepCount increments, no new spawn');
// ---------------------------------------------------------------------------
let worker1;
{
  _spawnCount = 0;
  const agentIdBefore = worker0.agentId;
  worker1 = pool.getWorker(1);

  ok(_spawnCount === 0, 'second getWorker reuses child (no new spawn)');
  ok(worker1.agentId === agentIdBefore, 'same agentId on reuse');
  ok(worker1.stepCount === 2, 'stepCount incremented to 2');
  ok(worker1.isAlive(), 'worker still alive on reuse');
}

// ---------------------------------------------------------------------------
section('5. getState() reflects current worker info');
// ---------------------------------------------------------------------------
{
  const state = pool.getState();
  ok(state.worker.agentId === worker1.agentId, 'getState worker agentId matches');
  ok(state.worker.stepCount === 2, 'getState worker stepCount = 2');
  ok(state.reviewer.slotState === SLOT_STATES.EMPTY, 'reviewer still EMPTY (not yet requested)');
}

// ---------------------------------------------------------------------------
section('6. getReviewer() -> spawns reviewer with cairn-reviewer- prefix');
// ---------------------------------------------------------------------------
let reviewer0;
{
  _spawnCount = 0;
  reviewer0 = pool.getReviewer();

  ok(_spawnCount === 1, 'first getReviewer spawns once');
  ok(reviewer0.slotState === SLOT_STATES.READY, 'reviewer slotState READY');
  ok(reviewer0.agentId !== null, 'reviewer agentId assigned');
  ok(reviewer0.agentId.startsWith('cairn-reviewer-'), `agentId starts with cairn-reviewer- (got ${reviewer0.agentId})`);
  ok(reviewer0.isAlive(), 'reviewer is alive after spawn');
}

// ---------------------------------------------------------------------------
section('7. Reviewer agentId pattern differs from worker agentId');
// ---------------------------------------------------------------------------
{
  ok(worker1.agentId !== reviewer0.agentId, 'worker and reviewer have different agentIds');
  ok(worker1.agentId.startsWith('cairn-worker-'), 'worker has worker prefix');
  ok(reviewer0.agentId.startsWith('cairn-reviewer-'), 'reviewer has reviewer prefix');
}

// ---------------------------------------------------------------------------
section('8. getReviewer() second call -> reuses existing reviewer, no new spawn');
// ---------------------------------------------------------------------------
let reviewer1;
{
  _spawnCount = 0;
  const reviewerAgentIdBefore = reviewer0.agentId;
  reviewer1 = pool.getReviewer();

  ok(_spawnCount === 0, 'second getReviewer reuses (no new spawn)');
  ok(reviewer1.agentId === reviewerAgentIdBefore, 'same reviewer agentId on reuse');
}

// ---------------------------------------------------------------------------
section('9. writeNextTurn writes JSON envelope to child.stdin');
// ---------------------------------------------------------------------------
{
  const chunks = [];
  worker1.child.stdin.on('data', (chunk) => chunks.push(chunk));

  const testPrompt = 'Run tests and verify the output';
  worker1.writeNextTurn(testPrompt);

  // Give PassThrough a tick to emit.
  await new Promise((resolve) => setImmediate(resolve));

  const written = Buffer.concat(chunks).toString('utf8');
  let parsed;
  try {
    parsed = JSON.parse(written.trim());
  } catch (e) {
    parsed = null;
  }

  ok(written.endsWith('\n'), 'envelope ends with newline');
  ok(parsed !== null, 'envelope is valid JSON');
  ok(parsed && parsed.type === 'user', 'envelope type = user');
  ok(parsed && parsed.message && parsed.message.role === 'user', 'envelope message.role = user');
  ok(parsed && parsed.message && parsed.message.content === testPrompt, 'envelope content matches prompt');
}

// ---------------------------------------------------------------------------
section('10. getWorker after maxStepsBeforeRestart (default 5) -> spawns fresh');
// ---------------------------------------------------------------------------
{
  // Create a fresh pool with maxStepsBeforeRestart=3 so we don't need 5 steps.
  _spawnCount = 0;
  const poolRestart = createPool({
    project,
    plan,
    launcherFn: mockLauncher,
    opts: { maxStepsBeforeRestart: 3, gracePeriodMs: 0 },
  });

  // Step 0, 1, 2: fill the slot up to the limit.
  const wA0 = poolRestart.getWorker(0);
  const wA1 = poolRestart.getWorker(1);
  const wA2 = poolRestart.getWorker(2);
  ok(_spawnCount === 1, 'first 3 steps use same spawn (1 total)');
  ok(wA2.stepCount === 3, 'stepCount = 3 after 3 steps');

  const agentIdBeforeRestart = wA2.agentId;

  // Step 3: stepCount >= maxStepsBeforeRestart -> auto-restart.
  _spawnCount = 0;
  const wA3 = poolRestart.getWorker(3);

  ok(_spawnCount === 1, 'step 4 triggers restart (new spawn)');
  ok(wA3.agentId !== agentIdBeforeRestart, 'new agentId after restart');
  ok(wA3.stepCount === 1, 'stepCount resets to 1 after restart');
}

// ---------------------------------------------------------------------------
section('11. Worker crash -> slot becomes DEAD, next getWorker spawns fresh');
// ---------------------------------------------------------------------------
{
  _spawnCount = 0;
  const poolCrash = createPool({
    project,
    plan,
    launcherFn: mockLauncher,
    opts: { maxStepsBeforeRestart: 10, gracePeriodMs: 0 },
  });

  const crashWorker = poolCrash.getWorker(0);
  ok(_spawnCount === 1, 'spawned once initially');
  ok(crashWorker.isAlive(), 'worker alive before crash');

  const agentIdBeforeCrash = crashWorker.agentId;

  // Simulate unexpected crash.
  crashWorker.child.emit('exit', 1, null);

  // After crash event, slot should be DEAD.
  const state = poolCrash.getState();
  ok(state.worker.slotState === SLOT_STATES.DEAD, 'slot is DEAD after crash');
  ok(!crashWorker.isAlive(), 'isAlive() returns false after crash');

  // Next getWorker should spawn fresh.
  _spawnCount = 0;
  const recoveredWorker = poolCrash.getWorker(1);

  ok(_spawnCount === 1, 'crash recovery spawns a new worker');
  ok(recoveredWorker.agentId !== agentIdBeforeCrash, 'new agentId after crash recovery');
  ok(recoveredWorker.isAlive(), 'recovered worker is alive');
}

// ---------------------------------------------------------------------------
section('12. teardown() kills all alive children');
// ---------------------------------------------------------------------------
{
  _spawnCount = 0;
  const poolTeardown = createPool({
    project,
    plan,
    launcherFn: mockLauncher,
    opts: { maxStepsBeforeRestart: 10, gracePeriodMs: 50 },
  });

  const tw = poolTeardown.getWorker(0);
  const tr = poolTeardown.getReviewer();

  ok(tw.isAlive(), 'worker alive before teardown');
  ok(tr.isAlive(), 'reviewer alive before teardown');

  await poolTeardown.teardown();

  // After teardown, both slots should be EMPTY and children killed.
  const state = poolTeardown.getState();
  ok(state.worker.slotState === SLOT_STATES.EMPTY, 'worker slot EMPTY after teardown');
  ok(state.reviewer.slotState === SLOT_STATES.EMPTY, 'reviewer slot EMPTY after teardown');
}

// ---------------------------------------------------------------------------
section('13. createPool requires launcherFn to be a function');
// ---------------------------------------------------------------------------
{
  let threw = false;
  try {
    createPool({ project, plan, launcherFn: 'not-a-function' });
  } catch (e) {
    threw = true;
    ok(e instanceof TypeError, 'throws TypeError for non-function launcherFn');
  }
  ok(threw, 'createPool throws when launcherFn is not a function');
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

process.stdout.write(`\n${'='.repeat(64)}\n`);
process.stdout.write(`smoke-harness-pool: ${asserts} assertions, ${fails} failures\n`);
if (failures.length > 0) {
  process.stdout.write('\nFailed:\n');
  for (const f of failures) {
    process.stdout.write(`  - ${f}\n`);
  }
}
process.stdout.write(`${'='.repeat(64)}\n`);

if (fails > 0) {
  process.exit(1);
}
