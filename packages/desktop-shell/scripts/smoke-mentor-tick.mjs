#!/usr/bin/env node
/**
 * smoke-mentor-tick.mjs — Phase 8 of panel-cockpit-redesign.
 *
 * Verifies that the auto-tick driver:
 *   - Iterates registered projects
 *   - Skips projects with empty hints (no attribution)
 *   - Pulls RUNNING/BLOCKED/WAITING_REVIEW tasks per project
 *   - Feeds context to mentor-policy.evaluatePolicy
 *   - Writes scratchpad nudges/escalations
 *   - Records errors per project without aborting the tick
 *   - Idempotent start() (calling twice doesn't spawn 2 timers)
 *
 * Uses an in-memory SQLite + a minimal fake registry; no real DB read.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dsRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(dsRoot, '..', '..');

const Database = require(path.join(repoRoot, 'packages', 'daemon', 'node_modules', 'better-sqlite3'));
const tick = require(path.join(dsRoot, 'mentor-tick.cjs'));
const mentorPolicy = require(path.join(dsRoot, 'mentor-policy.cjs'));
const projectQueries = require(path.join(dsRoot, 'project-queries.cjs'));
const registry = require(path.join(dsRoot, 'registry.cjs'));

let asserts = 0, fails = 0;
const failures = [];
function ok(c, l) {
  asserts++;
  if (c) process.stdout.write(`  ok    ${l}\n`);
  else   { fails++; failures.push(l); process.stdout.write(`  FAIL  ${l}\n`); }
}
function header(t) { process.stdout.write(`\n${'='.repeat(56)}\n${t}\n${'='.repeat(56)}\n`); }
function section(t) { process.stdout.write(`\n[${t}]\n`); }

header('smoke-mentor-tick — Phase 8');

// ---------------------------------------------------------------------------
// Set up in-memory DB with realistic state.
// ---------------------------------------------------------------------------
const db = new Database(':memory:');
db.exec(`
  CREATE TABLE processes (
    agent_id TEXT PRIMARY KEY, agent_type TEXT, capabilities TEXT,
    status TEXT NOT NULL, registered_at INTEGER NOT NULL,
    last_heartbeat INTEGER NOT NULL, heartbeat_ttl INTEGER NOT NULL
  );
  CREATE TABLE tasks (
    task_id TEXT PRIMARY KEY, intent TEXT NOT NULL, state TEXT NOT NULL,
    parent_task_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    created_by_agent_id TEXT, metadata_json TEXT
  );
  CREATE TABLE blockers (
    blocker_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, question TEXT,
    status TEXT NOT NULL, raised_at INTEGER NOT NULL, answered_at INTEGER, answer TEXT
  );
  CREATE TABLE outcomes (
    outcome_id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE,
    criteria_json TEXT, status TEXT NOT NULL,
    evaluated_at INTEGER, evaluation_summary TEXT, grader_agent_id TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, metadata_json TEXT
  );
  CREATE TABLE conflicts (
    id TEXT PRIMARY KEY, detected_at INTEGER NOT NULL, conflict_type TEXT,
    agent_a TEXT, agent_b TEXT, paths_json TEXT, summary TEXT,
    status TEXT NOT NULL, resolved_at INTEGER, resolution TEXT
  );
  CREATE TABLE dispatch_requests (
    id TEXT PRIMARY KEY, status TEXT NOT NULL, target_agent TEXT,
    created_at INTEGER NOT NULL, decided_at INTEGER
  );
  CREATE TABLE checkpoints (
    id TEXT PRIMARY KEY, task_id TEXT, git_head TEXT,
    snapshot_status TEXT NOT NULL, created_at INTEGER NOT NULL, label TEXT
  );
  CREATE TABLE scratchpad (
    key TEXT PRIMARY KEY, value_json TEXT, value_path TEXT, task_id TEXT,
    expires_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
`);
const tableNames = new Set([
  'processes', 'tasks', 'blockers', 'outcomes',
  'conflicts', 'dispatch_requests', 'checkpoints', 'scratchpad',
]);

const AGENT = 'cairn-session-aaa11111';
const NOW = Date.now();
db.prepare(`INSERT INTO processes (agent_id, agent_type, status, registered_at, last_heartbeat, heartbeat_ttl) VALUES (?, 'mcp-server', 'ACTIVE', ?, ?, 60000)`)
  .run(AGENT, NOW - 60000, NOW - 5000);

// Task in BLOCKED state with an unanswered question → Rule D should fire
db.prepare(`INSERT INTO tasks (task_id, intent, state, created_at, updated_at, created_by_agent_id) VALUES ('t_blocked', 'task with question', 'BLOCKED', ?, ?, ?)`)
  .run(NOW - 60000, NOW - 5000, AGENT);
db.prepare(`INSERT INTO blockers (blocker_id, task_id, question, status, raised_at) VALUES ('b_001', 't_blocked', 'should I use a graph DB here?', 'OPEN', ?)`)
  .run(NOW - 4000);

// Task with overdue time budget → Rule E should fire
db.prepare(`INSERT INTO tasks (task_id, intent, state, created_at, updated_at, created_by_agent_id, metadata_json) VALUES ('t_overbudget', 'long task', 'RUNNING', ?, ?, ?, ?)`)
  .run(NOW - 120000, NOW - 1000, AGENT, JSON.stringify({ budget_ms: 100000 }));

// Task with FAILED outcome → Rule G should fire (nudge first time)
db.prepare(`INSERT INTO tasks (task_id, intent, state, created_at, updated_at, created_by_agent_id) VALUES ('t_failed', 'failing task', 'WAITING_REVIEW', ?, ?, ?)`)
  .run(NOW - 50000, NOW - 1000, AGENT);
db.prepare(`INSERT INTO outcomes (outcome_id, task_id, status, created_at, updated_at) VALUES ('o_001', 't_failed', 'FAILED', ?, ?)`)
  .run(NOW - 10000, NOW - 1000);

// Mock registry (just one project for this smoke).
const fakeReg = {
  version: 2,
  projects: [{
    id: 'p_tick',
    label: 'tick test',
    project_root: '/tmp/tick',
    db_path: '/tmp/tick.db',
    agent_id_hints: [AGENT],
  }],
};

// ensureDbHandle stub returns our in-memory db for any path
const stubEnsure = (_p) => ({ db, tables: tableNames });

// ---------------------------------------------------------------------------
// 1 — runOnce on a populated state should produce decisions
// ---------------------------------------------------------------------------
section('1 single tick fires expected rules');
const decisionsObserved = [];
const r1 = tick.runOnce({
  reg: fakeReg,
  ensureDbHandle: stubEnsure,
  projectQueries,
  mentorPolicy,
  registry,
  onDecision: (pid, dec) => decisionsObserved.push({ pid, ...dec }),
});
ok(r1.ticks_run === 1, 'ticks_run = 1');
ok(r1.projects_scanned === 1, 'projects_scanned = 1');
ok(r1.decisions >= 2, `decisions >= 2 (got ${r1.decisions})`);
ok(r1.errors.length === 0, `no errors (got ${JSON.stringify(r1.errors)})`);

const rules = new Set(decisionsObserved.map(d => d.rule));
ok(rules.has('D'), 'Rule D fired (BLOCKED)');
ok(rules.has('E'), 'Rule E fired (over budget)');
ok(rules.has('G'), 'Rule G fired (outcomes FAILED)');

// ---------------------------------------------------------------------------
// 2 — scratchpad now has nudges + escalations
// ---------------------------------------------------------------------------
section('2 scratchpad has nudges + escalations');
const scratchKeys = db.prepare('SELECT key FROM scratchpad ORDER BY key').all().map(r => r.key);
ok(scratchKeys.some(k => k.startsWith('mentor/p_tick/nudge/')), 'mentor nudge written');
ok(scratchKeys.some(k => k.startsWith('escalation/p_tick/')), 'escalation written');
ok(scratchKeys.some(k => k.startsWith('mentor_state/')), 'mentor_state written');

// ---------------------------------------------------------------------------
// 3 — empty hints project should be skipped silently
// ---------------------------------------------------------------------------
section('3 empty hints skipped');
const regNoHints = { projects: [{ id: 'p_empty', label: 'empty', project_root: '/x', db_path: '/x.db', agent_id_hints: [] }] };
const r2 = tick.runOnce({ reg: regNoHints, ensureDbHandle: stubEnsure, projectQueries, mentorPolicy, registry });
ok(r2.projects_scanned === 1, 'project counted as scanned');
ok(r2.decisions === 0, 'no decisions (no hints → skipped)');

// ---------------------------------------------------------------------------
// 4 — second tick re-evaluates; existing decisions don't duplicate-escalate
//      blindly (mentor_state guards via last_check_at)
// ---------------------------------------------------------------------------
section('4 idempotent second tick');
const r3 = tick.runOnce({
  reg: fakeReg, ensureDbHandle: stubEnsure, projectQueries, mentorPolicy, registry,
});
ok(r3.errors.length === 0, '2nd tick no errors');
// 2nd tick should produce ≤ first tick's decisions (mentor_state suppresses
// some rules that have already fired against the same task state).
ok(r3.decisions <= r1.decisions,
   `2nd tick decisions (${r3.decisions}) ≤ 1st tick (${r1.decisions})`);

// ---------------------------------------------------------------------------
// 5 — error in one project doesn't abort the loop
// ---------------------------------------------------------------------------
section('5 per-project error isolation');
const stubEnsureThrowy = (p) => p === '/throw.db' ? null : { db, tables: tableNames };
const regMixed = {
  projects: [
    { id: 'p_throw', label: 'broken', project_root: '/throw', db_path: '/throw.db', agent_id_hints: [AGENT] },
    fakeReg.projects[0],
  ],
};
const r4 = tick.runOnce({ reg: regMixed, ensureDbHandle: stubEnsureThrowy, projectQueries, mentorPolicy, registry });
ok(r4.projects_scanned === 1, 'good project still scanned (bad ones return null entry)');

// ---------------------------------------------------------------------------
// 6 — start() is idempotent; stop() halts
// ---------------------------------------------------------------------------
section('6 start/stop lifecycle');
const h1 = tick.start({ reg: fakeReg, ensureDbHandle: stubEnsure, projectQueries, mentorPolicy, registry }, { intervalMs: 60000 });
const h2 = tick.start({ reg: fakeReg, ensureDbHandle: stubEnsure, projectQueries, mentorPolicy, registry }, { intervalMs: 60000 });
ok(h2.already_running === true, '2nd start returns already_running=true');
tick.stop();

// ---------------------------------------------------------------------------
db.close();
header(`${asserts - fails}/${asserts} assertions passed (${fails} failed)`);
if (fails) {
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
  process.exit(1);
}
process.exit(0);
