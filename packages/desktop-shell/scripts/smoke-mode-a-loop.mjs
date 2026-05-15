#!/usr/bin/env node
/**
 * smoke-mode-a-loop.mjs — MA-2a Mode A plan drafting (deterministic).
 *
 * HOME sandbox per registry-pollution lesson.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// Sandbox HOME first.
const _realHome = os.homedir();
const _realProjectsJson = path.join(_realHome, '.cairn', 'projects.json');
const _tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-mode-a-smoke-'));
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
// Use daemon's better-sqlite3 — desktop-shell's is Electron-rebuilt (NODE_MODULE_VERSION 128),
// Node 24 needs 137. See CLAUDE.md "better-sqlite3 NODE_MODULE_VERSION 坑".
const Database = require(path.resolve(dsRoot, '..', 'daemon', 'node_modules', 'better-sqlite3'));

function makeDb() {
  const db = new Database(':memory:');
  // Minimal scratchpad table — matches migration 002 columns the
  // mode-a-loop module actually touches (key/value_json/timestamps).
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

header('smoke-mode-a-loop (MA-2a)');

// ---------------------------------------------------------------------------
section('1 planStepsFromGoal: pure draft');
{
  const goal = {
    id: 'g1',
    title: 'Ship v0.3',
    success_criteria: ['add settings page', 'wire up help link', '', '  ', 'localize copy'],
    non_goals: [],
  };
  const steps = modeALoop.planStepsFromGoal(goal);
  ok(steps.length === 3, `3 valid steps (got ${steps.length})`);
  ok(steps[0].label === 'add settings page', 'first step label trimmed');
  ok(steps[2].label === 'localize copy', 'last step label preserved');
  ok(steps.every(s => s.state === 'PENDING'), 'all start PENDING');
  ok(steps[0].idx === 0 && steps[1].idx === 1 && steps[2].idx === 2, 'idx 0..N-1 contiguous');
}

// ---------------------------------------------------------------------------
section('2 planStepsFromGoal: string goal → single step');
{
  const steps = modeALoop.planStepsFromGoal('Just one thing');
  ok(steps.length === 1, '1 step for string goal');
  ok(steps[0].label === 'Just one thing', 'label preserved');
}

// ---------------------------------------------------------------------------
section('3 planStepsFromGoal: empty goal → 0 steps');
{
  ok(modeALoop.planStepsFromGoal(null).length === 0, 'null goal → []');
  ok(modeALoop.planStepsFromGoal({}).length === 0, 'empty object → []');
  ok(modeALoop.planStepsFromGoal({ success_criteria: [] }).length === 0, 'empty success_criteria → []');
  ok(modeALoop.planStepsFromGoal('').length === 0, 'empty string → []');
}

// ---------------------------------------------------------------------------
section('4 ensurePlan: first call drafts + persists');
{
  const db = makeDb();
  const project = { id: 'p_a' };
  const goal = { id: 'g1', title: 'X', success_criteria: ['a', 'b'] };
  const r = modeALoop.ensurePlan(db, project, goal, null, {});
  ok(r.action === 'drafted', `action=drafted (got ${r.action})`);
  ok(r.plan.steps.length === 2, '2 steps');
  ok(r.plan.goal_id === 'g1', 'goal_id stored');
  ok(r.plan.status === 'ACTIVE', 'status=ACTIVE');

  const persisted = modeALoop.getPlan(db, 'p_a');
  ok(persisted && persisted.plan_id === r.plan.plan_id, 'persisted plan_id matches');
}

// ---------------------------------------------------------------------------
section('5 ensurePlan: idempotent for same goal_id');
{
  const db = makeDb();
  const project = { id: 'p_a' };
  const goal = { id: 'g1', title: 'X', success_criteria: ['a'] };
  const r1 = modeALoop.ensurePlan(db, project, goal, null, {});
  ok(r1.action === 'drafted', 'first call: drafted');
  const r2 = modeALoop.ensurePlan(db, project, goal, null, {});
  ok(r2.action === 'unchanged', `second call: unchanged (got ${r2.action})`);
  ok(r2.plan.plan_id === r1.plan.plan_id, 'plan_id preserved across no-op');
}

// ---------------------------------------------------------------------------
section('6 ensurePlan: goal supersession');
{
  const db = makeDb();
  const project = { id: 'p_a' };
  const goalV1 = { id: 'g1', title: 'V1', success_criteria: ['a'] };
  const r1 = modeALoop.ensurePlan(db, project, goalV1, null, {});
  ok(r1.action === 'drafted', 'V1 drafted');

  // Force a different plan_id by delaying — ULID is time + random,
  // and we want to verify supersession even within the same ms.
  const goalV2 = { id: 'g2', title: 'V2', success_criteria: ['x', 'y'] };
  const r2 = modeALoop.ensurePlan(db, project, goalV2, null, {});
  ok(r2.action === 'superseded', `goal change → superseded (got ${r2.action})`);
  ok(r2.prior_plan_id === r1.plan.plan_id, 'prior_plan_id correct');
  ok(r2.plan.goal_id === 'g2', 'new plan tracks new goal_id');
  ok(r2.plan.steps.length === 2, 'new plan has new step count');

  const persisted = modeALoop.getPlan(db, 'p_a');
  ok(persisted.goal_id === 'g2', 'persisted goal_id is g2');
}

// ---------------------------------------------------------------------------
section('7 ensurePlan: no goal → no_goal');
{
  const db = makeDb();
  const project = { id: 'p_a' };
  const r = modeALoop.ensurePlan(db, project, null, null, {});
  ok(r.action === 'no_goal', `no_goal action (got ${r.action})`);
  ok(modeALoop.getPlan(db, 'p_a') === null, 'no plan persisted');
}

// ---------------------------------------------------------------------------
section('8 ensurePlan: no project → no_project');
{
  const db = makeDb();
  const r = modeALoop.ensurePlan(db, null, { id: 'g', title: 'X' }, null, {});
  ok(r.action === 'no_project', `no_project action (got ${r.action})`);
}

// ---------------------------------------------------------------------------
section('9 runOnceForProject: wraps ensurePlan; catches throws');
{
  const db = makeDb();
  const project = { id: 'p_a' };
  const goal = { id: 'g1', title: 'X', success_criteria: ['a'] };
  const r = modeALoop.runOnceForProject({ db, project, goal });
  ok(r.action === 'drafted', 'normal path drafts');

  // Throw path: pass a db that throws on prepare.
  const dbBad = {
    prepare: () => { throw new Error('boom'); },
  };
  const r2 = modeALoop.runOnceForProject({ db: dbBad, project, goal });
  ok(r2.action === 'error', `throws caught (got ${r2.action})`);
  ok(/boom/.test(r2.error || ''), 'error message preserved');
}

// ---------------------------------------------------------------------------
section('11 ensurePlan: string-goal idempotent (subagent fix — no super-loop)');
{
  const db = makeDb();
  const project = { id: 'p_str' };
  const r1 = modeALoop.ensurePlan(db, project, 'ship the thing', null, {});
  ok(r1.action === 'drafted', 'first call: drafted');
  // Re-tick with same string → must be unchanged, not superseded.
  const r2 = modeALoop.ensurePlan(db, project, 'ship the thing', null, {});
  ok(r2.action === 'unchanged', `second tick: unchanged (got ${r2.action})`);
  ok(r2.plan.plan_id === r1.plan.plan_id, 'plan_id preserved (no needless rewrite)');
  // Change the string goal → must be superseded.
  const r3 = modeALoop.ensurePlan(db, project, 'ship something else', null, {});
  ok(r3.action === 'superseded', `goal text change: superseded (got ${r3.action})`);
}

// ---------------------------------------------------------------------------
section('10 planKey is stable per project');
{
  ok(modeALoop.planKey('p_a') === 'mode_a_plan/p_a', 'key format');
  ok(modeALoop.planKey('proj-with-dashes') === 'mode_a_plan/proj-with-dashes', 'dashes ok');
}

// ---------------------------------------------------------------------------
// bindOrphanTask needs tasks + dispatch_requests tables.
function makeFullDb() {
  const db = makeDb();
  db.exec(`
    CREATE TABLE tasks (
      task_id TEXT PRIMARY KEY,
      intent TEXT,
      state TEXT NOT NULL DEFAULT 'PENDING',
      parent_task_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      created_by_agent_id TEXT,
      metadata_json TEXT
    );
    CREATE TABLE dispatch_requests (
      id TEXT PRIMARY KEY,
      nl_intent TEXT,
      parsed_intent TEXT,
      context_keys TEXT,
      generated_prompt TEXT,
      target_agent TEXT,
      status TEXT NOT NULL DEFAULT 'PENDING',
      created_at INTEGER NOT NULL,
      confirmed_at INTEGER,
      task_id TEXT
    );
  `);
  return db;
}

section('12 bindOrphanTask: dispatch_id precise match');
{
  const db = makeFullDb();
  const project = { id: 'p_bind' };
  const goal = { id: 'g1', title: 'T', success_criteria: ['implement the feature exactly right'] };
  const r = modeALoop.ensurePlan(db, project, goal, null, {});
  ok(r.action === 'drafted', 'plan drafted');

  // Mark step 0 DISPATCHED with a dispatch_id.
  const plan = modeALoop.getPlan(db, 'p_bind');
  plan.steps[0].state = 'DISPATCHED';
  plan.steps[0].dispatch_id = 'disp_abc123';
  modeALoop.writePlan(db, 'p_bind', plan, Date.now());

  // Insert a dispatch_requests row (task_id is NULL — the gap).
  db.prepare('INSERT INTO dispatch_requests (id, nl_intent, status, created_at) VALUES (?,?,?,?)').run(
    'disp_abc123', 'implement the feature exactly right', 'CONFIRMED', Date.now(),
  );

  // Insert a task whose intent is totally different (CC added metadata to it),
  // but metadata_json contains the matching dispatch_id.
  const now = Date.now();
  db.prepare(
    'INSERT INTO tasks (task_id, intent, state, created_at, updated_at, created_by_agent_id, metadata_json) VALUES (?,?,?,?,?,?,?)',
  ).run('t_001', 'Mode A · step 0/1 (retry-7) supersedes_task=xxx — implement the blah', 'RUNNING', now, now, 'agent_x', JSON.stringify({ dispatch_id: 'disp_abc123' }));

  const out = modeALoop.bindOrphanTask(db, project, ['agent_x'], {});
  ok(out.bound === 1, `bound=1 (got ${out.bound})`);
  ok(out.task_id === 't_001', `task_id=t_001 (got ${out.task_id})`);
  ok(out.match_strategy === 'dispatch_id', `matched by dispatch_id (got ${out.match_strategy})`);

  // Verify dispatch_requests.task_id was back-filled.
  const dr = db.prepare('SELECT task_id FROM dispatch_requests WHERE id = ?').get('disp_abc123');
  ok(dr && dr.task_id === 't_001', `dispatch_requests.task_id back-filled (got ${dr && dr.task_id})`);

  // Verify plan step has task_id.
  const planAfter = modeALoop.getPlan(db, 'p_bind');
  ok(planAfter.steps[0].task_id === 't_001', 'plan step task_id set');
}

section('13 bindOrphanTask: text fallback when no dispatch_id in metadata');
{
  const db = makeFullDb();
  const project = { id: 'p_text' };
  const goal = { id: 'g1', title: 'T', success_criteria: ['implement the settings page for all users'] };
  modeALoop.ensurePlan(db, project, goal, null, {});
  const plan = modeALoop.getPlan(db, 'p_text');
  plan.steps[0].state = 'DISPATCHED';
  plan.steps[0].dispatch_id = 'disp_xyz';
  modeALoop.writePlan(db, 'p_text', plan, Date.now());

  // Task with NO metadata_json (old-style), but intent matches label by substring.
  const now = Date.now();
  db.prepare(
    'INSERT INTO tasks (task_id, intent, state, created_at, updated_at, created_by_agent_id) VALUES (?,?,?,?,?,?)',
  ).run('t_text', 'implement the settings page for all users', 'RUNNING', now, now, 'agent_y');

  const out = modeALoop.bindOrphanTask(db, project, ['agent_y'], {});
  ok(out.bound === 1, `bound=1 via text (got ${out.bound})`);
  ok(out.match_strategy === 'text_match', `match_strategy=text_match (got ${out.match_strategy})`);
}

section('14 bindOrphanTask: already bound → no-op');
{
  const db = makeFullDb();
  const project = { id: 'p_noop' };
  const goal = { id: 'g1', title: 'T', success_criteria: ['do something very important here'] };
  modeALoop.ensurePlan(db, project, goal, null, {});
  const plan = modeALoop.getPlan(db, 'p_noop');
  plan.steps[0].state = 'DISPATCHED';
  plan.steps[0].task_id = 't_existing';
  modeALoop.writePlan(db, 'p_noop', plan, Date.now());

  const out = modeALoop.bindOrphanTask(db, project, ['agent_z'], {});
  ok(out.bound === 0, 'already bound → no-op');
}

section('15 bindOrphanTask: dispatch_id wins over text match');
{
  const db = makeFullDb();
  const project = { id: 'p_prio' };
  const goal = { id: 'g1', title: 'T', success_criteria: ['implement the settings page completely'] };
  modeALoop.ensurePlan(db, project, goal, null, {});
  const plan = modeALoop.getPlan(db, 'p_prio');
  plan.steps[0].state = 'DISPATCHED';
  plan.steps[0].dispatch_id = 'disp_prio';
  modeALoop.writePlan(db, 'p_prio', plan, Date.now());

  const now = Date.now();
  // Task A: text matches perfectly but NO dispatch_id in metadata.
  db.prepare(
    'INSERT INTO tasks (task_id, intent, state, created_at, updated_at, created_by_agent_id) VALUES (?,?,?,?,?,?)',
  ).run('t_text_only', 'implement the settings page completely', 'RUNNING', now, now, 'agent_p');
  // Task B: text doesn't match but has the correct dispatch_id.
  db.prepare(
    'INSERT INTO tasks (task_id, intent, state, created_at, updated_at, created_by_agent_id, metadata_json) VALUES (?,?,?,?,?,?,?)',
  ).run('t_dispatch', 'totally different intent string here', 'RUNNING', now - 100, now, 'agent_p', JSON.stringify({ dispatch_id: 'disp_prio' }));

  const out = modeALoop.bindOrphanTask(db, project, ['agent_p'], {});
  ok(out.bound === 1, 'one task bound');
  ok(out.task_id === 't_dispatch', `dispatch_id match wins (got ${out.task_id})`);
  ok(out.match_strategy === 'dispatch_id', `strategy=dispatch_id (got ${out.match_strategy})`);
}

// ---------------------------------------------------------------------------
header(`${asserts - fails}/${asserts} assertions passed (${fails} failed)`);
if (fails) {
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
  process.exit(1);
}
process.exit(0);
