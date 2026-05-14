#!/usr/bin/env node
/**
 * smoke-mode-a-autodispatch.mjs — MA-2c auto-dispatch + advance logic.
 *
 * Exercises decideNextDispatch / markStepDispatched / advanceOnComplete
 * against an in-memory SQLite with realistic processes / dispatch_requests
 * / outcomes shapes. HOME sandboxed.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const _realHome = os.homedir();
const _realProjectsJson = path.join(_realHome, '.cairn', 'projects.json');
const _tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-ma2c-smoke-'));
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
const require = createRequire(import.meta.url);
const modeALoop = require(path.join(dsRoot, 'mode-a-loop.cjs'));
const Database = require(path.join(dsRoot, 'node_modules', 'better-sqlite3'));

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
    CREATE TABLE processes (
      agent_id TEXT PRIMARY KEY,
      agent_type TEXT,
      status TEXT,
      last_heartbeat INTEGER,
      capabilities TEXT
    );
    CREATE TABLE dispatch_requests (
      id TEXT PRIMARY KEY,
      nl_intent TEXT,
      parsed_intent TEXT,
      context_keys TEXT,
      generated_prompt TEXT,
      target_agent TEXT,
      status TEXT,
      created_at INTEGER,
      confirmed_at INTEGER,
      task_id TEXT
    );
    CREATE TABLE outcomes (
      task_id TEXT PRIMARY KEY,
      status TEXT,
      created_at INTEGER
    );
  `);
  return db;
}

function seedAgent(db, agentId, agentType, status) {
  db.prepare(`INSERT INTO processes (agent_id, agent_type, status, last_heartbeat, capabilities) VALUES (?, ?, ?, ?, ?)`)
    .run(agentId, agentType, status || 'ACTIVE', Date.now(), '[]');
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

header('smoke-mode-a-autodispatch (MA-2c)');

// ---------------------------------------------------------------------------
section('1 decideNextDispatch: no plan → no_steps');
{
  const db = makeDb();
  const project = { id: 'p_a' };
  const r = modeALoop.decideNextDispatch(db, project, null, ['a1']);
  ok(r.action === 'no_steps', `null plan → no_steps (got ${r.action})`);

  const r2 = modeALoop.decideNextDispatch(db, project, { steps: [] }, ['a1']);
  ok(r2.action === 'no_steps', `empty steps → no_steps (got ${r2.action})`);
}

// ---------------------------------------------------------------------------
section('2 decideNextDispatch: no agents → no_agent');
{
  const db = makeDb();
  const project = { id: 'p_a' };
  const goal = { id: 'g1', title: 'X', success_criteria: ['step1'] };
  modeALoop.ensurePlan(db, project, goal, null, {});
  const plan = modeALoop.getPlan(db, 'p_a');
  const r = modeALoop.decideNextDispatch(db, project, plan, []);
  ok(r.action === 'no_agent', `empty hints → no_agent (got ${r.action})`);

  // hints non-empty but no ACTIVE process matches
  seedAgent(db, 'a_inactive', 'claude-code', 'DEAD');
  const r2 = modeALoop.decideNextDispatch(db, project, plan, ['a_inactive']);
  ok(r2.action === 'no_agent', `no ACTIVE → no_agent (got ${r2.action})`);
}

// ---------------------------------------------------------------------------
section('3 decideNextDispatch: ACTIVE agent → dispatch with target');
{
  const db = makeDb();
  const project = { id: 'p_a' };
  const goal = { id: 'g1', title: 'X', success_criteria: ['ship feature'] };
  modeALoop.ensurePlan(db, project, goal, null, {});
  seedAgent(db, 'a_cc', 'claude-code');
  const plan = modeALoop.getPlan(db, 'p_a');
  const r = modeALoop.decideNextDispatch(db, project, plan, ['a_cc']);
  ok(r.action === 'dispatch', `1 active agent → dispatch (got ${r.action})`);
  ok(r.target_agent_id === 'a_cc', 'target_agent_id picked');
  ok(r.step.label === 'ship feature', 'step.label preserved');
  ok(r.step_idx === 0, 'step_idx === 0 for first call');
}

// ---------------------------------------------------------------------------
section('4 decideNextDispatch: leader preference');
{
  const db = makeDb();
  const project = { id: 'p_a' };
  const goal = { id: 'g1', title: 'X', success_criteria: ['a'] };
  modeALoop.ensurePlan(db, project, goal, null, {});
  seedAgent(db, 'a_cc', 'claude-code');
  seedAgent(db, 'a_cursor', 'cursor');
  const plan = modeALoop.getPlan(db, 'p_a');

  // Leader = cursor → should pick cursor even if claude-code is also active.
  const r = modeALoop.decideNextDispatch(db, project, plan, ['a_cc', 'a_cursor'], { leader: 'cursor' });
  ok(r.action === 'dispatch', 'dispatch');
  ok(r.target_agent_id === 'a_cursor', `leader=cursor → a_cursor (got ${r.target_agent_id})`);

  // No leader: falls back to last_heartbeat DESC (first row).
  const r2 = modeALoop.decideNextDispatch(db, project, plan, ['a_cc', 'a_cursor']);
  ok(r2.action === 'dispatch', 'dispatch');
  // Either agent valid since we didn't differentiate heartbeats here.
  ok(['a_cc', 'a_cursor'].includes(r2.target_agent_id), 'falls back to first ACTIVE');
}

// ---------------------------------------------------------------------------
section('5 markStepDispatched: persists state + dispatch_id');
{
  const db = makeDb();
  const project = { id: 'p_a' };
  const goal = { id: 'g1', title: 'X', success_criteria: ['a', 'b'] };
  modeALoop.ensurePlan(db, project, goal, null, {});
  const updated = modeALoop.markStepDispatched(db, 'p_a', 0, 'disp_111', 9999);
  ok(updated.steps[0].state === 'DISPATCHED', 'step 0 state=DISPATCHED');
  ok(updated.steps[0].dispatch_id === 'disp_111', 'dispatch_id stored');
  ok(updated.steps[0].dispatched_at === 9999, 'dispatched_at stored');
  ok(updated.steps[1].state === 'PENDING', 'step 1 still PENDING');

  // Round-trip
  const reloaded = modeALoop.getPlan(db, 'p_a');
  ok(reloaded.steps[0].dispatch_id === 'disp_111', 'persisted dispatch_id reloaded');
}

// ---------------------------------------------------------------------------
section('6 decideNextDispatch: DISPATCHED step → waiting');
{
  const db = makeDb();
  const project = { id: 'p_a' };
  const goal = { id: 'g1', title: 'X', success_criteria: ['a'] };
  modeALoop.ensurePlan(db, project, goal, null, {});
  modeALoop.markStepDispatched(db, 'p_a', 0, 'disp_d', 100);
  seedAgent(db, 'a_cc', 'claude-code');
  const plan = modeALoop.getPlan(db, 'p_a');
  const r = modeALoop.decideNextDispatch(db, project, plan, ['a_cc']);
  ok(r.action === 'waiting', `DISPATCHED step → waiting (got ${r.action})`);
}

// ---------------------------------------------------------------------------
section('7 advanceOnComplete: no dispatch yet → no_change');
{
  const db = makeDb();
  const project = { id: 'p_a' };
  const goal = { id: 'g1', title: 'X', success_criteria: ['a'] };
  modeALoop.ensurePlan(db, project, goal, null, {});
  const r = modeALoop.advanceOnComplete(db, 'p_a', {});
  ok(r.action === 'no_change', 'PENDING step → no_change');
}

// ---------------------------------------------------------------------------
section('8 advanceOnComplete: dispatch row no task_id yet → no_change');
{
  const db = makeDb();
  const project = { id: 'p_a' };
  const goal = { id: 'g1', title: 'X', success_criteria: ['a'] };
  modeALoop.ensurePlan(db, project, goal, null, {});
  modeALoop.markStepDispatched(db, 'p_a', 0, 'disp_x', 100);
  db.prepare(`INSERT INTO dispatch_requests (id, nl_intent, status, target_agent, created_at, task_id) VALUES (?, ?, ?, ?, ?, ?)`)
    .run('disp_x', 'whatever', 'PENDING', 'a_cc', 100, null);
  const r = modeALoop.advanceOnComplete(db, 'p_a', {});
  ok(r.action === 'no_change', `dispatch w/o task_id → no_change (got ${r.action})`);
}

// ---------------------------------------------------------------------------
section('9 advanceOnComplete: outcomes PASS → advance + plan progresses');
{
  const db = makeDb();
  const project = { id: 'p_a' };
  const goal = { id: 'g1', title: 'X', success_criteria: ['step A', 'step B'] };
  modeALoop.ensurePlan(db, project, goal, null, {});
  modeALoop.markStepDispatched(db, 'p_a', 0, 'disp_pass', 100);
  db.prepare(`INSERT INTO dispatch_requests (id, nl_intent, status, target_agent, created_at, task_id) VALUES (?, ?, ?, ?, ?, ?)`)
    .run('disp_pass', 'do A', 'CONFIRMED', 'a_cc', 100, 'task_001');
  db.prepare(`INSERT INTO outcomes (task_id, status, created_at) VALUES (?, ?, ?)`)
    .run('task_001', 'PASS', 200);

  const r = modeALoop.advanceOnComplete(db, 'p_a', {});
  ok(r.action === 'advanced', `PASS → advanced (got ${r.action})`);
  ok(r.step_idx === 0, 'advanced from step 0');
  ok(r.to_idx === 1, 'advanced to step 1');
  ok(r.task_id === 'task_001', 'task_id surfaced');

  const plan = modeALoop.getPlan(db, 'p_a');
  ok(plan.steps[0].state === 'DONE', 'step 0 state=DONE');
  ok(plan.steps[0].task_id === 'task_001', 'task_id stored on step');
  ok(plan.current_idx === 1, 'current_idx bumped to 1');
  ok(plan.status === 'ACTIVE', 'plan still ACTIVE (more steps remain)');
  ok(plan.steps[1].state === 'PENDING', 'step 1 unchanged');
}

// ---------------------------------------------------------------------------
section('10 advanceOnComplete: PASS on last step → plan COMPLETE');
{
  const db = makeDb();
  const project = { id: 'p_a' };
  const goal = { id: 'g1', title: 'X', success_criteria: ['only step'] };
  modeALoop.ensurePlan(db, project, goal, null, {});
  modeALoop.markStepDispatched(db, 'p_a', 0, 'disp_last', 100);
  db.prepare(`INSERT INTO dispatch_requests (id, nl_intent, status, target_agent, created_at, task_id) VALUES (?, ?, ?, ?, ?, ?)`)
    .run('disp_last', 'only', 'CONFIRMED', 'a_cc', 100, 'task_999');
  db.prepare(`INSERT INTO outcomes (task_id, status, created_at) VALUES (?, ?, ?)`)
    .run('task_999', 'PASS', 200);

  const r = modeALoop.advanceOnComplete(db, 'p_a', {});
  ok(r.action === 'advanced', 'advanced');
  const plan = modeALoop.getPlan(db, 'p_a');
  ok(plan.status === 'COMPLETE', `plan.status === COMPLETE (got ${plan.status})`);
  ok(plan.completed_at != null, 'completed_at set');
  ok(plan.current_idx === 1, 'current_idx === steps.length');
}

// ---------------------------------------------------------------------------
section('11 advanceOnComplete: outcome FAILED → plan BLOCKED');
{
  const db = makeDb();
  const project = { id: 'p_a' };
  const goal = { id: 'g1', title: 'X', success_criteria: ['a', 'b'] };
  modeALoop.ensurePlan(db, project, goal, null, {});
  modeALoop.markStepDispatched(db, 'p_a', 0, 'disp_fail', 100);
  db.prepare(`INSERT INTO dispatch_requests (id, nl_intent, status, target_agent, created_at, task_id) VALUES (?, ?, ?, ?, ?, ?)`)
    .run('disp_fail', 'will fail', 'CONFIRMED', 'a_cc', 100, 'task_fail');
  db.prepare(`INSERT INTO outcomes (task_id, status, created_at) VALUES (?, ?, ?)`)
    .run('task_fail', 'FAILED', 200);

  const r = modeALoop.advanceOnComplete(db, 'p_a', {});
  ok(r.action === 'failed', `FAILED → action=failed (got ${r.action})`);
  const plan = modeALoop.getPlan(db, 'p_a');
  ok(plan.status === 'BLOCKED', 'plan.status === BLOCKED');
  ok(plan.steps[0].state === 'FAILED', 'step state=FAILED');
  ok(plan.current_idx === 0, 'current_idx NOT advanced on failure');
}

// ---------------------------------------------------------------------------
section('12 runOnceForProject composes: ensure → advance → decide');
{
  const db = makeDb();
  const project = { id: 'p_a' };
  const goal = { id: 'g1', title: 'X', success_criteria: ['only step'] };
  seedAgent(db, 'a_cc', 'claude-code');

  // First tick: drafts + decides dispatch.
  const r1 = modeALoop.runOnceForProject({ db, project, goal, profile: null, agentIds: ['a_cc'] });
  ok(r1.action === 'drafted', `first tick: drafted (got ${r1.action})`);
  ok(r1.dispatch_request && r1.dispatch_request.action === 'dispatch', 'dispatch decided');
  ok(r1.advance && r1.advance.action === 'no_change', 'no advance yet');

  // Simulate dispatch row + outcome PASS for that step.
  const planAfter = modeALoop.getPlan(db, 'p_a');
  modeALoop.markStepDispatched(db, 'p_a', 0, 'disp_sim', 100);
  db.prepare(`INSERT INTO dispatch_requests (id, nl_intent, status, target_agent, created_at, task_id) VALUES (?, ?, ?, ?, ?, ?)`)
    .run('disp_sim', 'X', 'CONFIRMED', 'a_cc', 100, 'task_sim');
  db.prepare(`INSERT INTO outcomes (task_id, status, created_at) VALUES (?, ?, ?)`)
    .run('task_sim', 'PASS', 200);

  // Second tick: should advance + plan complete + no further dispatch.
  const r2 = modeALoop.runOnceForProject({ db, project, goal, profile: null, agentIds: ['a_cc'] });
  ok(r2.action === 'unchanged', `second tick: plan unchanged (got ${r2.action})`);
  ok(r2.advance && r2.advance.action === 'advanced', `advanced (got ${r2.advance && r2.advance.action})`);
  ok(r2.dispatch_request && r2.dispatch_request.action === 'plan_complete',
     `no more to dispatch → plan_complete (got ${r2.dispatch_request && r2.dispatch_request.action})`);
}

// ---------------------------------------------------------------------------
section('13 cockpit-dispatch accepts source=mode-a-loop (subagent fix E)');
{
  // Regression: cockpit-dispatch.validateInput's validSources list MUST
  // include 'mode-a-loop' or every auto-dispatch silently fails.
  const cockpitDispatch = require(path.join(dsRoot, 'cockpit-dispatch.cjs'));
  const db = makeDb();
  seedAgent(db, 'a_cc', 'claude-code');
  const tables = new Set(['scratchpad', 'processes', 'dispatch_requests']);
  const res = cockpitDispatch.dispatchTodo(db, tables, {
    project_id: 'p_a',
    target_agent_id: 'a_cc',
    label: 'do the thing',
    source: 'mode-a-loop',
    todo_id: 'mode_a_step/plan_x/0',
    why: 'auto-dispatched',
  });
  ok(res && res.ok === true, `dispatchTodo returns ok (got ${res && JSON.stringify(res)})`);
  ok(typeof res.dispatch_id === 'string' && res.dispatch_id.length > 0, 'dispatch_id returned');

  // Also: bogus source still rejected (regression guard).
  const bogus = cockpitDispatch.dispatchTodo(db, tables, {
    project_id: 'p_a', target_agent_id: 'a_cc', label: 'x',
    source: 'made-up-source', todo_id: 't_2',
  });
  ok(bogus && bogus.ok === false, 'bogus source rejected');
  ok(/source_must_be/.test(bogus.error || ''), `error mentions source_must_be (got ${bogus.error})`);
}

// ---------------------------------------------------------------------------
header(`${asserts - fails}/${asserts} assertions passed (${fails} failed)`);
if (fails) {
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
  process.exit(1);
}
process.exit(0);
