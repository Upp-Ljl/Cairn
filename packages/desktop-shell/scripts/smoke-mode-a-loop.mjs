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
const Database = require(path.join(dsRoot, 'node_modules', 'better-sqlite3'));

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
header(`${asserts - fails}/${asserts} assertions passed (${fails} failed)`);
if (fails) {
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
  process.exit(1);
}
process.exit(0);
