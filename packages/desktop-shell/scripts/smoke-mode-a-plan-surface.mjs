#!/usr/bin/env node
/**
 * smoke-mode-a-plan-surface.mjs — MA-2b panel surface for the Mode A plan.
 *
 * Verifies cockpit-state.buildCockpitState exposes `mode_a_plan` when the
 * scratchpad has a plan, and `null` otherwise. HOME sandboxed.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const _realHome = os.homedir();
const _realProjectsJson = path.join(_realHome, '.cairn', 'projects.json');
const _tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-ma-plan-surface-'));
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
const cockpitState = require(path.join(dsRoot, 'cockpit-state.cjs'));
const Database = require(path.join(dsRoot, 'node_modules', 'better-sqlite3'));

function makeDb() {
  const db = new Database(':memory:');
  // Minimal cockpit-state surface needs many tables — create the
  // schema that buildCockpitState actually reads. Missing tables are
  // tolerated via `tables.has(...)` guards inside the function.
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

function tablesFromDb(db) {
  const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all();
  return new Set(rows.map(r => r.name));
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

header('smoke-mode-a-plan-surface (MA-2b)');

// ---------------------------------------------------------------------------
section('1 empty-state payload includes mode_a_plan: null');
{
  const empty = cockpitState.emptyCockpitState(
    { id: 'p_a', label: 'A', project_root: '/x', mode: 'A' },
    '/x.db',
    'no_goal',
  );
  ok('mode_a_plan' in empty, 'empty payload has mode_a_plan key');
  ok(empty.mode_a_plan === null, `mode_a_plan === null (got ${empty.mode_a_plan})`);
  ok(empty.mode === 'A', 'mode preserved (MA-1 regression)');
}

// ---------------------------------------------------------------------------
section('2 full payload exposes existing plan from scratchpad');
{
  const db = makeDb();
  const project = { id: 'p_a', label: 'A', project_root: '/x', db_path: '/x.db', mode: 'A' };
  const goal = { id: 'g1', title: 'Ship MA-2b', success_criteria: ['render plan', 'wire toggle'] };
  modeALoop.ensurePlan(db, project, goal, null, {});
  const tables = tablesFromDb(db);
  const payload = cockpitState.buildCockpitState(
    db, tables, project, goal.title, [], {},
  );
  ok(payload.mode_a_plan, 'mode_a_plan is set');
  ok(payload.mode_a_plan.goal_id === 'g1', `mode_a_plan.goal_id === 'g1' (got ${payload.mode_a_plan.goal_id})`);
  ok(Array.isArray(payload.mode_a_plan.steps), 'steps is array');
  ok(payload.mode_a_plan.steps.length === 2, `2 steps (got ${payload.mode_a_plan.steps.length})`);
  ok(payload.mode_a_plan.steps[0].label === 'render plan', 'first step label correct');
}

// ---------------------------------------------------------------------------
section('3 full payload returns mode_a_plan: null when no plan written');
{
  const db = makeDb();
  const project = { id: 'p_b', label: 'B', project_root: '/y', db_path: '/y.db', mode: 'B' };
  const tables = tablesFromDb(db);
  const payload = cockpitState.buildCockpitState(
    db, tables, project, null, [], {},
  );
  ok('mode_a_plan' in payload, 'payload has key');
  ok(payload.mode_a_plan === null, `mode_a_plan === null (got ${payload.mode_a_plan})`);
}

// ---------------------------------------------------------------------------
section('4 D9 read-only invariant: buildCockpitState did NOT mutate the plan');
{
  const db = makeDb();
  const project = { id: 'p_a', label: 'A', project_root: '/x', db_path: '/x.db', mode: 'A' };
  const goal = { id: 'g1', title: 'X', success_criteria: ['a', 'b'] };
  modeALoop.ensurePlan(db, project, goal, null, {});
  const before = modeALoop.getPlan(db, 'p_a');
  const tables = tablesFromDb(db);
  // Call buildCockpitState 5 times — no writes should happen.
  for (let i = 0; i < 5; i++) {
    cockpitState.buildCockpitState(db, tables, project, goal.title, [], {});
  }
  const after = modeALoop.getPlan(db, 'p_a');
  ok(after.plan_id === before.plan_id, 'plan_id unchanged (no rewrite)');
  ok(after.drafted_at === before.drafted_at, 'drafted_at unchanged');
}

// ---------------------------------------------------------------------------
header(`${asserts - fails}/${asserts} assertions passed (${fails} failed)`);
if (fails) {
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
  process.exit(1);
}
process.exit(0);
