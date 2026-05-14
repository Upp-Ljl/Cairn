#!/usr/bin/env node
/**
 * dogfood-mode-a-end-to-end.mjs — full Mode A loop closure proof.
 *
 * CLAUDE.md gate: "改 IPC / 跨进程 / SQLite state / desktop-shell ...
 * 单测绿不算完成。必须跑真实 dogfood 或 smoke". This dogfood runs
 * mentor-tick.runOnce against a real SQLite database (full schema via
 * daemon migrations) with all production wiring, then simulates the
 * agent-side of the loop (dispatch pickup, blocker raise, outcomes
 * write) and verifies the plan advances all the way to COMPLETE.
 *
 * NOT a unit test. NOT a per-module smoke. The integration glue is what
 * breaks in production — this exercises it.
 *
 * HOME sandboxed per registry-pollution lesson.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const _realHome = os.homedir();
const _realProjectsJson = path.join(_realHome, '.cairn', 'projects.json');
const _tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-ma-dogfood-'));
fs.mkdirSync(path.join(_tmpDir, '.cairn'), { recursive: true });
process.env.HOME = _tmpDir;
process.env.USERPROFILE = _tmpDir;
const _mtimeBefore = fs.existsSync(_realProjectsJson) ? fs.statSync(_realProjectsJson).mtimeMs : null;
process.on('exit', () => {
  const _mtimeAfter = fs.existsSync(_realProjectsJson) ? fs.statSync(_realProjectsJson).mtimeMs : null;
  if (_mtimeBefore !== _mtimeAfter) {
    console.error('FATAL: dogfood wrote to REAL ~/.cairn/projects.json');
    process.exit(3);
  }
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dsRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(dsRoot, '..', '..');
const require = createRequire(import.meta.url);

// Real production modules.
const Database = require(path.join(dsRoot, 'node_modules', 'better-sqlite3'));
const { runMigrations } = require(path.join(repoRoot, 'packages', 'daemon', 'dist', 'storage', 'migrations', 'runner.js'));
const { ALL_MIGRATIONS } = require(path.join(repoRoot, 'packages', 'daemon', 'dist', 'storage', 'migrations', 'index.js'));
const registry = require(path.join(dsRoot, 'registry.cjs'));
const projectQueries = require(path.join(dsRoot, 'project-queries.cjs'));
const mentorTick = require(path.join(dsRoot, 'mentor-tick.cjs'));
const mentorPolicy = require(path.join(dsRoot, 'mentor-policy.cjs'));
const modeALoop = require(path.join(dsRoot, 'mode-a-loop.cjs'));

let asserts = 0, fails = 0;
const failures = [];
function ok(c, l) {
  asserts++;
  if (c) process.stdout.write(`  ok    ${l}\n`);
  else { fails++; failures.push(l); process.stdout.write(`  FAIL  ${l}\n`); }
}
function header(t) { process.stdout.write(`\n${'='.repeat(64)}\n${t}\n${'='.repeat(64)}\n`); }
function section(t) { process.stdout.write(`\n[${t}]\n`); }

header('dogfood-mode-a-end-to-end');

// ===========================================================================
// SETUP — real SQLite with full daemon migrations, real registry.
// ===========================================================================
section('SETUP: spin up real SQLite + full migrations + register project');

const dbPath = path.join(_tmpDir, 'dogfood.db');
const db = new Database(dbPath);
runMigrations(db, ALL_MIGRATIONS);
const tables = new Set(
  db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(r => r.name)
);
ok(tables.has('tasks') && tables.has('blockers') && tables.has('outcomes')
   && tables.has('dispatch_requests') && tables.has('scratchpad') && tables.has('processes'),
   `all 6 W5/W4 tables present (got ${[...tables].sort().join(',')})`);

// Build a registry with one project, Mode A enabled, with a 2-step goal.
const projectRoot = path.join(_tmpDir, 'dogfood-proj');
fs.mkdirSync(projectRoot, { recursive: true });
let reg = {
  version: 2,
  projects: [
    {
      id: 'p_dogfood',
      label: 'Dogfood Project',
      project_root: projectRoot,
      db_path: dbPath,
      agent_id_hints: ['agent_cc'],
      added_at: Date.now(),
      last_opened_at: Date.now(),
      cockpit_settings: { mode: 'A', leader: 'claude-code' },
      active_goal: {
        id: 'goal_001',
        title: 'Ship feature X',
        desired_outcome: 'feature X demoable',
        success_criteria: ['implement core logic', 'add tests for X'],
        non_goals: [],
        created_at: Date.now(),
        updated_at: Date.now(),
      },
    },
  ],
};
ok(reg.projects[0].cockpit_settings.mode === 'A', 'project is Mode A');
ok(reg.projects[0].active_goal.success_criteria.length === 2, '2 success_criteria → 2 plan steps expected');

// Pretend an agent is registered + ACTIVE in this project.
db.prepare(`INSERT INTO processes (agent_id, agent_type, status, registered_at, last_heartbeat, heartbeat_ttl, capabilities) VALUES (?, ?, ?, ?, ?, ?, ?)`)
  .run('agent_cc', 'mcp-server', 'ACTIVE', Date.now(), Date.now(), 60000, '["client:claude-code","git_root:' + projectRoot.replace(/\\/g, '/') + '"]');
ok(db.prepare(`SELECT COUNT(*) AS n FROM processes WHERE status='ACTIVE'`).get().n === 1, '1 ACTIVE agent seeded');

// Wire mentor-tick dep injection. ensureDbHandle returns the live handle.
const ensureDbHandle = () => ({ db, tables });
const baseDeps = {
  reg,
  ensureDbHandle,
  projectQueries,
  mentorPolicy,
  registry,
  ruleCEnabled: false,  // disable LLM-helpers path; no llmHelpers available in dogfood
  llmHelpers: null,
};

// ===========================================================================
// TICK 1 — drafts plan + dispatches step 0.
// ===========================================================================
section('TICK 1: plan drafted + first step dispatched');

const t1 = mentorTick.runOnce(baseDeps);
ok(t1.projects_scanned === 1, `scanned 1 project (got ${t1.projects_scanned})`);
ok(t1.errors.length === 0, `no errors (got ${JSON.stringify(t1.errors)})`);

// Verify plan exists in scratchpad.
const plan1 = modeALoop.getPlan(db, 'p_dogfood');
ok(plan1 && Array.isArray(plan1.steps), 'plan persisted in scratchpad');
ok(plan1.steps.length === 2, `2 steps drafted (got ${plan1.steps.length})`);
ok(plan1.steps[0].label === 'implement core logic', 'step 0 label matches success_criteria[0]');
ok(plan1.steps[0].state === 'DISPATCHED', `step 0 state=DISPATCHED after first tick (got ${plan1.steps[0].state})`);
ok(plan1.current_idx === 0, 'current_idx still 0 (step pending completion)');

// Verify dispatch_requests row created.
const dispatchRows1 = db.prepare(`SELECT * FROM dispatch_requests`).all();
ok(dispatchRows1.length === 1, `1 dispatch_requests row (got ${dispatchRows1.length})`);
ok(dispatchRows1[0].target_agent === 'agent_cc', 'targets the registered agent');
ok(dispatchRows1[0].status === 'PENDING', `dispatch status=PENDING (got ${dispatchRows1[0].status})`);
ok(/implement core logic/.test(dispatchRows1[0].nl_intent), 'nl_intent carries step label');

// ===========================================================================
// AGENT SIM 1 — agent picks up dispatch, creates a task, then raises a blocker
// that Mode A should auto-answer.
// ===========================================================================
section('AGENT SIM 1: task created from dispatch, agent raises a blocker');

const stepDispatchId = dispatchRows1[0].id;
const taskId1 = 'task_step0';
db.prepare(`INSERT INTO tasks (task_id, intent, state, created_by_agent_id, created_at, updated_at, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?)`)
  .run(taskId1, 'implement core logic', 'RUNNING', 'agent_cc', Date.now(), Date.now(), '{}');
db.prepare(`UPDATE dispatch_requests SET status = 'CONFIRMED', confirmed_at = ?, task_id = ? WHERE id = ?`)
  .run(Date.now(), taskId1, stepDispatchId);
// Agent gets blocked on a yes/no.
db.prepare(`INSERT INTO blockers (blocker_id, task_id, question, status, raised_by, raised_at, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?)`)
  .run('blk_01', taskId1, 'Should I add an extra log statement?', 'OPEN', 'agent_cc', Date.now(), '{}');
ok(db.prepare(`SELECT status FROM blockers WHERE blocker_id = 'blk_01'`).get().status === 'OPEN', 'blocker OPEN seeded');

// ===========================================================================
// TICK 2 — auto-answer the blocker, no new dispatch (step 0 still DISPATCHED).
// ===========================================================================
section('TICK 2: auto-answer fires; no double-dispatch');

const t2 = mentorTick.runOnce(baseDeps);
ok(t2.errors.length === 0, `no errors (got ${JSON.stringify(t2.errors)})`);

const blockerAfter = db.prepare(`SELECT * FROM blockers WHERE blocker_id = 'blk_01'`).get();
ok(blockerAfter.status === 'ANSWERED', `blocker auto-answered (got ${blockerAfter.status})`);
ok(blockerAfter.answer === 'yes', `yes/no detector picked 'yes' (got ${JSON.stringify(blockerAfter.answer)})`);
ok(/mode-a-auto:yesno/.test(blockerAfter.answered_by), `answered_by tag (got ${blockerAfter.answered_by})`);

const plan2 = modeALoop.getPlan(db, 'p_dogfood');
ok(plan2.steps[0].state === 'DISPATCHED', 'step 0 still DISPATCHED (waiting on outcome)');
const dispatchRows2 = db.prepare(`SELECT * FROM dispatch_requests`).all();
ok(dispatchRows2.length === 1, `still 1 dispatch row (no double-dispatch) (got ${dispatchRows2.length})`);

// ===========================================================================
// AGENT SIM 2 — agent completes the task, writes outcomes PASS.
// ===========================================================================
section('AGENT SIM 2: outcomes PASS written for step 0');

db.prepare(`UPDATE tasks SET state = 'WAITING_REVIEW', updated_at = ? WHERE task_id = ?`).run(Date.now(), taskId1);
db.prepare(`INSERT INTO outcomes (outcome_id, task_id, criteria_json, status, evaluated_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
  .run('oc_001', taskId1, '[]', 'PASS', Date.now(), Date.now(), Date.now());
ok(db.prepare(`SELECT status FROM outcomes WHERE task_id = ?`).get(taskId1).status === 'PASS', 'outcomes PASS seeded');

// ===========================================================================
// TICK 3 — plan advances to step 1 + dispatches step 1.
// ===========================================================================
section('TICK 3: plan advances to step 1 + dispatches step 1');

const t3 = mentorTick.runOnce(baseDeps);
ok(t3.errors.length === 0, `no errors (got ${JSON.stringify(t3.errors)})`);

const plan3 = modeALoop.getPlan(db, 'p_dogfood');
ok(plan3.steps[0].state === 'DONE', `step 0 now DONE (got ${plan3.steps[0].state})`);
ok(plan3.steps[0].task_id === taskId1, 'step 0 carries task_id linkage');
ok(plan3.current_idx === 1, `current_idx advanced to 1 (got ${plan3.current_idx})`);
ok(plan3.steps[1].state === 'DISPATCHED', `step 1 now DISPATCHED (got ${plan3.steps[1].state})`);
ok(plan3.status === 'ACTIVE', `plan still ACTIVE (got ${plan3.status})`);

const dispatchRows3 = db.prepare(`SELECT * FROM dispatch_requests ORDER BY created_at`).all();
ok(dispatchRows3.length === 2, `2 dispatch rows now (got ${dispatchRows3.length})`);
ok(/add tests for X/.test(dispatchRows3[1].nl_intent), 'second dispatch labels step 1');

// ===========================================================================
// AGENT SIM 3 — agent completes step 1, outcomes PASS.
// ===========================================================================
section('AGENT SIM 3: outcomes PASS for step 1');

const taskId2 = 'task_step1';
const step1DispatchId = dispatchRows3[1].id;
db.prepare(`INSERT INTO tasks (task_id, intent, state, created_by_agent_id, created_at, updated_at, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?)`)
  .run(taskId2, 'add tests for X', 'WAITING_REVIEW', 'agent_cc', Date.now(), Date.now(), '{}');
db.prepare(`UPDATE dispatch_requests SET status = 'CONFIRMED', confirmed_at = ?, task_id = ? WHERE id = ?`)
  .run(Date.now(), taskId2, step1DispatchId);
db.prepare(`INSERT INTO outcomes (outcome_id, task_id, criteria_json, status, evaluated_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
  .run('oc_002', taskId2, '[]', 'PASS', Date.now(), Date.now(), Date.now());

// ===========================================================================
// TICK 4 — plan COMPLETE.
// ===========================================================================
section('TICK 4: plan reaches COMPLETE');

const t4 = mentorTick.runOnce(baseDeps);
ok(t4.errors.length === 0, `no errors (got ${JSON.stringify(t4.errors)})`);

const plan4 = modeALoop.getPlan(db, 'p_dogfood');
ok(plan4.status === 'COMPLETE', `plan.status === COMPLETE (got ${plan4.status})`);
ok(plan4.completed_at != null, 'completed_at set');
ok(plan4.steps[1].state === 'DONE', 'step 1 DONE');
ok(plan4.current_idx === 2, 'current_idx === steps.length');

// No new dispatch — plan_complete means decideNextDispatch returned that.
const dispatchRows4 = db.prepare(`SELECT * FROM dispatch_requests ORDER BY created_at`).all();
ok(dispatchRows4.length === 2, `still 2 dispatch rows — no spurious extra (got ${dispatchRows4.length})`);

// ===========================================================================
// TICK 5 — idempotent: re-tick should be a no-op.
// ===========================================================================
section('TICK 5: post-COMPLETE re-tick is idempotent');

const t5 = mentorTick.runOnce(baseDeps);
ok(t5.errors.length === 0, `no errors (got ${JSON.stringify(t5.errors)})`);
const plan5 = modeALoop.getPlan(db, 'p_dogfood');
ok(plan5.status === 'COMPLETE', 'still COMPLETE');
ok(db.prepare(`SELECT COUNT(*) AS n FROM dispatch_requests`).get().n === 2, 'no spurious dispatch on re-tick');

// ===========================================================================
header(`${asserts - fails}/${asserts} assertions passed (${fails} failed)`);
if (fails) {
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
  process.exit(1);
}
process.exit(0);
