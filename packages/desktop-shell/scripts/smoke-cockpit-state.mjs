#!/usr/bin/env node
/**
 * smoke-cockpit-state.mjs — Phase 1 of panel-cockpit-redesign.
 *
 * Verifies `buildCockpitState` returns the documented payload shape
 * against an in-memory SQLite DB seeded with one project's worth of
 * data. No real worker spawn; pure data layer.
 *
 * Invariants asserted:
 *   - top-level keys present and typed correctly
 *   - autopilot_status enum returns expected branch given inputs
 *   - empty-state branches (no project / no db / no hints) return
 *     a well-formed empty payload
 *   - activity events sorted by ts DESC and truncated to limit
 *   - mentor nudge surfaces from scratchpad keys 'mentor/<pid>/nudge/*'
 *   - escalations surface from scratchpad keys 'escalation/<pid>/*'
 *     and PENDING status flips autopilot to MENTOR_BLOCKED_NEED_USER
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dsRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(dsRoot, '..', '..');

const Database = require(path.join(repoRoot, 'packages', 'daemon', 'node_modules', 'better-sqlite3'));
const cockpit = require(path.join(dsRoot, 'cockpit-state.cjs'));

let asserts = 0, fails = 0;
const failures = [];
function ok(c, l) {
  asserts++;
  if (c) process.stdout.write(`  ok    ${l}\n`);
  else   { fails++; failures.push(l); process.stdout.write(`  FAIL  ${l}\n`); }
}
function section(t) { process.stdout.write(`\n[${t}]\n`); }
function header(t) { process.stdout.write(`\n${'='.repeat(56)}\n${t}\n${'='.repeat(56)}\n`); }

header('smoke-cockpit-state — Phase 1');

// ---------------------------------------------------------------------------
// Build a minimal in-memory schema (mirrors the relevant subset of the
// real migrations; we do NOT call runMigrations because we don't want a
// checksum dance, and the seeded schema is a deliberate subset).
// ---------------------------------------------------------------------------

const db = new Database(':memory:');
db.pragma('foreign_keys = ON');
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
    status TEXT NOT NULL, raised_at INTEGER NOT NULL, answered_at INTEGER,
    answer TEXT, FOREIGN KEY (task_id) REFERENCES tasks(task_id)
  );
  CREATE TABLE outcomes (
    outcome_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL UNIQUE,
    criteria_json TEXT,
    status TEXT NOT NULL,
    evaluated_at INTEGER,
    evaluation_summary TEXT,
    grader_agent_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    metadata_json TEXT,
    FOREIGN KEY (task_id) REFERENCES tasks(task_id)
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
    snapshot_status TEXT NOT NULL, created_at INTEGER NOT NULL, label TEXT,
    FOREIGN KEY (task_id) REFERENCES tasks(task_id)
  );
  CREATE TABLE scratchpad (
    key TEXT PRIMARY KEY, value_json TEXT, value_path TEXT, task_id TEXT,
    expires_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
`);
const tables = new Set([
  'processes', 'tasks', 'blockers', 'outcomes', 'conflicts',
  'dispatch_requests', 'checkpoints', 'scratchpad',
]);

const PROJ = {
  id: 'p_cockpit_test',
  label: 'cockpit smoke',
  project_root: '/tmp/cockpit-smoke',
  db_path: ':memory:',
  leader: 'claude-code',
  agent_id_hints: ['cairn-session-aaaa11111111', 'cairn-session-bbbb22222222'],
};
const AGENT_A = 'cairn-session-aaaa11111111';
const AGENT_B = 'cairn-session-bbbb22222222';
const NOW = Date.now();

// ---------------------------------------------------------------------------
// Test 1 — empty inputs → well-formed empty payload
// ---------------------------------------------------------------------------

section('1 empty inputs');
const empty1 = cockpit.buildCockpitState(null, null, null, null, [], {});
ok(empty1 && typeof empty1 === 'object', 'returns object');
ok(empty1.autopilot_status === cockpit.AUTOPILOT_STATUS.AGENT_IDLE, 'empty → AGENT_IDLE');
ok(Array.isArray(empty1.activity) && empty1.activity.length === 0, 'empty activity is []');
ok(empty1.project === null, 'no project → null project');

const empty2 = cockpit.buildCockpitState(db, tables, PROJ, null, [], {});
ok(empty2.project && empty2.project.id === PROJ.id, 'project echoed back');
ok(empty2.goal === null, 'goal null when not passed');
ok(empty2.autopilot_status === cockpit.AUTOPILOT_STATUS.NO_GOAL, 'no goal → NO_GOAL');

// ---------------------------------------------------------------------------
// Test 2 — seed agents + tasks + check basic counts + autopilot
// ---------------------------------------------------------------------------

section('2 seed agents + tasks');
db.prepare(`INSERT INTO processes
  (agent_id, agent_type, capabilities, status, registered_at, last_heartbeat, heartbeat_ttl)
  VALUES (?, 'mcp-server', NULL, 'ACTIVE', ?, ?, 60000)`).run(AGENT_A, NOW - 300000, NOW - 1000);
db.prepare(`INSERT INTO processes
  (agent_id, agent_type, capabilities, status, registered_at, last_heartbeat, heartbeat_ttl)
  VALUES (?, 'mcp-server', NULL, 'ACTIVE', ?, ?, 60000)`).run(AGENT_B, NOW - 200000, NOW - 1500);

db.prepare(`INSERT INTO tasks
  (task_id, intent, state, created_at, updated_at, created_by_agent_id)
  VALUES (?, ?, ?, ?, ?, ?)`).run('t_001', 'task one', 'RUNNING', NOW - 100000, NOW - 5000, AGENT_A);
db.prepare(`INSERT INTO tasks
  (task_id, intent, state, created_at, updated_at, created_by_agent_id)
  VALUES (?, ?, ?, ?, ?, ?)`).run('t_002', 'task two', 'DONE', NOW - 90000, NOW - 8000, AGENT_A);
db.prepare(`INSERT INTO tasks
  (task_id, intent, state, created_at, updated_at, created_by_agent_id)
  VALUES (?, ?, ?, ?, ?, ?)`).run('t_003', 'task three', 'BLOCKED', NOW - 80000, NOW - 6000, AGENT_B);

const s1 = cockpit.buildCockpitState(db, tables, PROJ, 'build the cockpit', PROJ.agent_id_hints, {});
ok(s1.agents.length === 2, '2 agent rows surfaced');
ok(s1.progress.tasks_total === 3, 'progress.tasks_total = 3');
ok(s1.progress.tasks_done === 1, 'progress.tasks_done = 1');
ok(s1.progress.tasks_running === 1, 'progress.tasks_running = 1');
ok(s1.progress.tasks_blocked === 1, 'progress.tasks_blocked = 1');
ok(s1.progress.percent > 0 && s1.progress.percent < 1, 'progress.percent in (0,1)');
ok(s1.current_task && s1.current_task.task_id === 't_001', 'current_task = t_001 (most recent RUNNING)');
ok(s1.autopilot_status === cockpit.AUTOPILOT_STATUS.AGENT_WORKING, 'goal + live agent → AGENT_WORKING');
// schema v2 surface fields (always present, may be null when CAIRN.md absent)
ok('whole_sentence' in s1, 'cockpit state exposes whole_sentence field');
ok('cairn_md_present' in s1, 'cockpit state exposes cairn_md_present field');
ok('in_flight' in s1, 'cockpit state exposes in_flight field');
ok(s1.cairn_md_present === false, 'no CAIRN.md → cairn_md_present = false');
ok(s1.whole_sentence === null, 'no CAIRN.md → whole_sentence = null');
// Phase 5 (2026-05-14): productivity-feedback counter
ok('mentor_decisions' in s1, 'cockpit state exposes mentor_decisions field');
ok(s1.mentor_decisions && typeof s1.mentor_decisions === 'object', 'mentor_decisions is an object');
ok(s1.mentor_decisions.total === 0, 'fresh DB → mentor_decisions.total === 0');
ok(s1.mentor_decisions.auto_resolve === 0, 'fresh DB → auto_resolve counter zero');
ok(s1.mentor_decisions.auto_decide === 0, 'fresh DB → auto_decide counter zero');
ok(s1.mentor_decisions.announce === 0, 'fresh DB → announce counter zero');
ok(s1.mentor_decisions.escalate === 0, 'fresh DB → escalate counter zero');

// Seed 4 kernel-sync mentor scratchpad rows for AGENT_A — each route bumps.
{
  const seedAt = NOW - 1000;
  const insertSp = db.prepare(`INSERT INTO scratchpad
    (key, value_json, value_path, task_id, expires_at, created_at, updated_at)
    VALUES (?, ?, NULL, NULL, NULL, ?, ?)`);
  insertSp.run(`mentor/${AGENT_A}/auto_resolve/01R1`, JSON.stringify({}), seedAt, seedAt);
  insertSp.run(`mentor/${AGENT_A}/auto_decide/01D1`, JSON.stringify({}), seedAt, seedAt);
  insertSp.run(`mentor/${AGENT_A}/announce/01A1`, JSON.stringify({}), seedAt, seedAt);
  insertSp.run(`mentor/${AGENT_A}/escalate/01E2`, JSON.stringify({}), seedAt, seedAt);
  const sCount = cockpit.buildCockpitState(db, tables, PROJ, 'build the cockpit', PROJ.agent_id_hints, {});
  ok(sCount.mentor_decisions.auto_resolve === 1, 'auto_resolve counter increments after seed');
  ok(sCount.mentor_decisions.auto_decide === 1, 'auto_decide counter increments after seed');
  ok(sCount.mentor_decisions.announce === 1, 'announce counter increments after seed');
  ok(sCount.mentor_decisions.escalate === 1, 'escalate counter increments after seed');
  ok(sCount.mentor_decisions.total === 4, 'mentor_decisions.total = sum of 4 routes');
}

// Phase 6 (2026-05-14): stale-agent + orphan task surface
{
  const hasProcesses = tables.has('processes');
  if (!hasProcesses) {
    ok(true, 'SKIP: processes table absent in fixture');
  } else {
    const stale_hb = NOW - 30 * 60_000;
    const fresh_hb = NOW - 5_000;
    db.prepare(`UPDATE processes SET status = 'active', last_heartbeat = ?, heartbeat_ttl = 30000 WHERE agent_id = ?`)
      .run(stale_hb, AGENT_A);
    db.prepare(`UPDATE processes SET status = 'active', last_heartbeat = ?, heartbeat_ttl = 30000 WHERE agent_id = ?`)
      .run(fresh_hb, AGENT_B);
    const sStale = cockpit.buildCockpitState(db, tables, PROJ, 'build the cockpit', PROJ.agent_id_hints, {});
    ok(Array.isArray(sStale.stale_agents), 'stale_agents is an array');
    ok(sStale.stale_agents.length === 1, `one stale agent detected (got ${sStale.stale_agents.length})`);
    if (sStale.stale_agents.length === 1) {
      const s = sStale.stale_agents[0];
      ok(s.agent_id === AGENT_A, 'stale agent_id = AGENT_A');
      ok(s.last_seen_ago_ms >= 30 * 60_000 - 10_000, 'last_seen_ago_ms reflects ~30 min');
      ok(typeof s.orphan_count === 'number', 'orphan_count is numeric');
      ok(s.orphan_count >= 1, 'AGENT_A has ≥1 orphan (t_001 RUNNING)');
      ok(Array.isArray(s.orphans), 'orphans is array');
    }
  }
}

// ---------------------------------------------------------------------------
// Test 3 — seed scratchpad mentor + escalation
// ---------------------------------------------------------------------------

section('3 mentor nudge + escalation surface');
db.prepare(`INSERT INTO scratchpad
  (key, value_json, value_path, task_id, expires_at, created_at, updated_at)
  VALUES (?, ?, NULL, NULL, NULL, ?, ?)`).run(
  `mentor/${PROJ.id}/nudge/01N1`,
  JSON.stringify({ message: 'try sanity check first', to_agent_id: AGENT_A }),
  NOW - 4000, NOW - 4000,
);
db.prepare(`INSERT INTO scratchpad
  (key, value_json, value_path, task_id, expires_at, created_at, updated_at)
  VALUES (?, ?, NULL, NULL, NULL, ?, ?)`).run(
  `escalation/${PROJ.id}/01E1`,
  JSON.stringify({ reason: 'AGENT_BLOCKED_QUESTION', task_id: 't_003', body: 'vitest or bun:test?', status: 'PENDING' }),
  NOW - 3000, NOW - 3000,
);

const s2 = cockpit.buildCockpitState(db, tables, PROJ, 'build the cockpit', PROJ.agent_id_hints, {});
ok(s2.latest_mentor_nudge && s2.latest_mentor_nudge.message === 'try sanity check first', 'latest mentor nudge surfaced');
ok(s2.latest_mentor_nudge.to_agent_id === AGENT_A, 'mentor nudge to_agent_id correct');
ok(s2.escalations.length === 1, '1 escalation surfaced');
ok(s2.escalations[0].status === 'PENDING', 'escalation status PENDING');
ok(s2.autopilot_status === cockpit.AUTOPILOT_STATUS.MENTOR_BLOCKED_NEED_USER, 'PENDING escalation → MENTOR_BLOCKED_NEED_USER');

// ---------------------------------------------------------------------------
// Test 4 — activity feed merges sources + sorts DESC
// ---------------------------------------------------------------------------

section('4 activity feed merge + sort');
db.prepare(`INSERT INTO conflicts
  (id, detected_at, conflict_type, agent_a, agent_b, paths_json, summary, status)
  VALUES (?, ?, 'FILE_OVERLAP', ?, ?, ?, ?, 'OPEN')`).run(
  'c_001', NOW - 2000, AGENT_A, AGENT_B, JSON.stringify(['src/foo.ts']), 'overlap on foo',
);
db.prepare(`INSERT INTO blockers
  (blocker_id, task_id, question, status, raised_at)
  VALUES (?, ?, ?, 'OPEN', ?)`).run('b_001', 't_003', 'which test runner?', NOW - 1000);
db.prepare(`INSERT INTO checkpoints
  (id, task_id, git_head, snapshot_status, created_at, label)
  VALUES (?, ?, ?, 'READY', ?, ?)`).run('ck_001', 't_001', 'abc123de', NOW - 7000, 'before commit');

const s3 = cockpit.buildCockpitState(db, tables, PROJ, 'build the cockpit', PROJ.agent_id_hints, { activityLimit: 30 });
ok(s3.activity.length > 0, 'activity feed has items');
ok(s3.activity.every((e, i, a) => i === 0 || (e.ts <= a[i-1].ts)), 'activity sorted DESC by ts');

const kinds = new Set(s3.activity.map(e => e.kind));
ok(kinds.has('mentor_nudge'), 'feed contains mentor_nudge');
ok(kinds.has('conflict_detected'), 'feed contains conflict_detected');
ok(kinds.has('blocker_raised'), 'feed contains blocker_raised');
ok(kinds.has('checkpoint_created'), 'feed contains checkpoint_created');
ok(kinds.has('task_running'), 'feed contains task_running');

// ---------------------------------------------------------------------------
// Test 5 — checkpoint module surfaces READY only
// ---------------------------------------------------------------------------

section('5 checkpoint surface (READY only)');
db.prepare(`INSERT INTO checkpoints
  (id, task_id, git_head, snapshot_status, created_at, label)
  VALUES (?, ?, ?, 'PENDING', ?, ?)`).run('ck_002', 't_001', 'pending1', NOW - 1000, 'incomplete');

const s4 = cockpit.buildCockpitState(db, tables, PROJ, 'build the cockpit', PROJ.agent_id_hints, {});
const ckptIds = s4.checkpoints.map(c => c.id);
ok(ckptIds.includes('ck_001'), 'READY ckpt surfaced');
ok(!ckptIds.includes('ck_002'), 'PENDING ckpt suppressed');

// ---------------------------------------------------------------------------
// Test 6 — top-level shape stability
// ---------------------------------------------------------------------------

section('6 top-level shape contract');
const required = [
  'project', 'goal', 'leader', 'autopilot_status', 'autopilot_reason',
  'agents', 'progress', 'current_task', 'latest_mentor_nudge',
  'activity', 'checkpoints', 'escalations', 'ts',
];
for (const k of required) {
  ok(Object.prototype.hasOwnProperty.call(s4, k), `payload has key: ${k}`);
}
ok(typeof s4.ts === 'number' && s4.ts > 0, 'ts is positive number');
ok(Array.isArray(s4.agents), 'agents is array');
ok(Array.isArray(s4.activity), 'activity is array');
ok(Array.isArray(s4.checkpoints), 'checkpoints is array');
ok(Array.isArray(s4.escalations), 'escalations is array');
ok(typeof s4.progress === 'object', 'progress is object');

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

db.close();
header(`${asserts - fails}/${asserts} assertions passed (${fails} failed)`);
if (fails) {
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
  process.exit(1);
}
process.exit(0);
