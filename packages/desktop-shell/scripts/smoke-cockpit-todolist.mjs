#!/usr/bin/env node
/**
 * smoke-cockpit-todolist.mjs — A2.1 M2 Todolist UI.
 *
 * Verifies queryTodoList merges three scratchpad namespaces correctly:
 *   - agent_proposal/<agent_id>/<ulid>
 *   - mentor_todo/<project_id>/<ulid>
 *   - user_todo/<project_id>/<ulid>
 *
 * Invariants asserted (≥ 18):
 *   - empty DB returns []
 *   - agent_proposal rows surface with source='agent_proposal'
 *   - mentor_todo rows surface with source='mentor_todo'
 *   - user_todo rows surface with source='user_todo'
 *   - entries sorted by ts DESC (most recent first)
 *   - limit cap respected
 *   - entries with missing/empty label are silently skipped
 *   - agent_id threaded through from body or key fallback
 *   - project_id threaded through
 *   - task_id / why surfaced from agent_proposal body
 *   - buildCockpitState exposes state.todolist array
 *   - state.todolist sorted DESC and contains all three sources
 *   - unattributed agent (not in hints) not included
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

header('smoke-cockpit-todolist — A2.1');

// ---------------------------------------------------------------------------
// Minimal in-memory schema (scratchpad only for targeted queryTodoList tests;
// will add full tables for buildCockpitState integration test).
// ---------------------------------------------------------------------------

const db = new Database(':memory:');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE scratchpad (
    key TEXT PRIMARY KEY, value_json TEXT, value_path TEXT, task_id TEXT,
    expires_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
`);
const tables = new Set(['scratchpad']);

const PROJ_ID = 'p_todo_test';
const AGENT_A = 'cairn-session-aaaa11111111';
const AGENT_B = 'cairn-session-bbbb22222222';
const UNRELATED = 'cairn-session-ccccxxxxxxxx';
const NOW = Date.now();

// Helper: insert scratchpad row
const ins = db.prepare(`
  INSERT INTO scratchpad (key, value_json, value_path, task_id, expires_at, created_at, updated_at)
  VALUES (?, ?, NULL, NULL, NULL, ?, ?)
`);

// ---------------------------------------------------------------------------
// Test 1 — empty DB returns []
// ---------------------------------------------------------------------------

section('1 empty DB');
const empty = cockpit.queryTodoList(db, tables, PROJ_ID, [AGENT_A], {});
ok(Array.isArray(empty), 'returns array');
ok(empty.length === 0, 'empty DB → length 0');

// ---------------------------------------------------------------------------
// Test 2 — agent_proposal namespace
// ---------------------------------------------------------------------------

section('2 agent_proposal namespace');

// ULID suffixes — just use sortable keys so older < newer in string order.
const ULID_OLD = '01JZAAAA000000000000000001';
const ULID_NEW = '01JZAAAA000000000000000002';

ins.run(
  `agent_proposal/${AGENT_A}/${ULID_OLD}`,
  JSON.stringify({ ts: NOW - 5000, label: 'old agent proposal', agent_id: AGENT_A, task_id: 'task-001', why: 'needed this' }),
  NOW - 5000, NOW - 5000,
);
ins.run(
  `agent_proposal/${AGENT_A}/${ULID_NEW}`,
  JSON.stringify({ ts: NOW - 1000, label: 'new agent proposal', agent_id: AGENT_A }),
  NOW - 1000, NOW - 1000,
);

const ag = cockpit.queryTodoList(db, tables, PROJ_ID, [AGENT_A], {});
ok(ag.length === 2, `2 agent_proposal entries (got ${ag.length})`);
ok(ag[0].source === 'agent_proposal', 'source = agent_proposal');
ok(ag[0].label === 'new agent proposal', 'newest entry first (ts DESC)');
ok(ag[0].agent_id === AGENT_A, 'agent_id threaded through');
ok(ag[1].task_id === 'task-001', 'task_id from body');
ok(ag[1].why === 'needed this', 'why from body');

// ---------------------------------------------------------------------------
// Test 3 — mentor_todo namespace
// ---------------------------------------------------------------------------

section('3 mentor_todo namespace');

ins.run(
  `mentor_todo/${PROJ_ID}/01JZMNT0000000000000000001`,
  JSON.stringify({ ts: NOW - 2000, label: 'mentor recommendation', project_id: PROJ_ID, source: 'mentor' }),
  NOW - 2000, NOW - 2000,
);

const mt = cockpit.queryTodoList(db, tables, PROJ_ID, [AGENT_A], {});
const mentorEntries = mt.filter(t => t.source === 'mentor_todo');
ok(mentorEntries.length === 1, `1 mentor_todo entry (got ${mentorEntries.length})`);
ok(mentorEntries[0].label === 'mentor recommendation', 'mentor label correct');
ok(mentorEntries[0].project_id === PROJ_ID, 'project_id threaded through');
ok(mentorEntries[0].agent_id === null, 'mentor_todo agent_id is null');

// ---------------------------------------------------------------------------
// Test 4 — user_todo namespace
// ---------------------------------------------------------------------------

section('4 user_todo namespace');

ins.run(
  `user_todo/${PROJ_ID}/01JZUSR0000000000000000001`,
  JSON.stringify({ ts: NOW - 500, label: 'user hand-written todo', project_id: PROJ_ID, source: 'user' }),
  NOW - 500, NOW - 500,
);

const ut = cockpit.queryTodoList(db, tables, PROJ_ID, [AGENT_A], {});
const userEntries = ut.filter(t => t.source === 'user_todo');
ok(userEntries.length === 1, `1 user_todo entry (got ${userEntries.length})`);
ok(userEntries[0].label === 'user hand-written todo', 'user label correct');
ok(userEntries[0].source === 'user_todo', 'source = user_todo');

// ---------------------------------------------------------------------------
// Test 5 — sort order (ts DESC, most recent first)
// ---------------------------------------------------------------------------

section('5 sort order');

const all = cockpit.queryTodoList(db, tables, PROJ_ID, [AGENT_A], {});
ok(all.length === 4, `4 total entries (got ${all.length})`);
const sorted = all.every((e, i, arr) => i === 0 || arr[i - 1].ts >= e.ts);
ok(sorted, 'entries sorted ts DESC');
ok(all[0].label === 'user hand-written todo', `first entry is newest (got: ${all[0].label})`);

// ---------------------------------------------------------------------------
// Test 6 — limit cap
// ---------------------------------------------------------------------------

section('6 limit cap');

// Add 5 more user_todo entries to exceed limit=3
for (let i = 3; i <= 7; i++) {
  const ulid = `01JZLIM000000000000000000${i}`;
  ins.run(
    `user_todo/${PROJ_ID}/${ulid}`,
    JSON.stringify({ ts: NOW - i * 100, label: `extra todo ${i}`, project_id: PROJ_ID, source: 'user' }),
    NOW - i * 100, NOW - i * 100,
  );
}

const limited = cockpit.queryTodoList(db, tables, PROJ_ID, [AGENT_A], { limit: 3 });
ok(limited.length === 3, `limit=3 caps result at 3 (got ${limited.length})`);

// ---------------------------------------------------------------------------
// Test 7 — entries with empty/missing label are skipped
// ---------------------------------------------------------------------------

section('7 empty label skipped');

ins.run(
  `user_todo/${PROJ_ID}/01JZBAD0000000000000000001`,
  JSON.stringify({ ts: NOW, label: '', project_id: PROJ_ID, source: 'user' }),
  NOW, NOW,
);
ins.run(
  `user_todo/${PROJ_ID}/01JZBAD0000000000000000002`,
  JSON.stringify({ ts: NOW, project_id: PROJ_ID, source: 'user' }),
  NOW, NOW,
);

const beforeCount = cockpit.queryTodoList(db, tables, PROJ_ID, [AGENT_A], { limit: 100 }).length;
// Both empty-label rows should be absent
const noEmptyLabels = cockpit.queryTodoList(db, tables, PROJ_ID, [AGENT_A], { limit: 100 })
  .every(t => t.label && t.label.length > 0);
ok(noEmptyLabels, 'no entries with empty label survive');

// ---------------------------------------------------------------------------
// Test 8 — unrelated agent (not in hints) not surfaced
// ---------------------------------------------------------------------------

section('8 unrelated agent filtered');

ins.run(
  `agent_proposal/${UNRELATED}/01JZUNRELATED000000000001`,
  JSON.stringify({ ts: NOW, label: 'proposal from unrelated agent', agent_id: UNRELATED }),
  NOW, NOW,
);

const withHints = cockpit.queryTodoList(db, tables, PROJ_ID, [AGENT_A], { limit: 100 });
const unrelatedInResult = withHints.some(t => t.agent_id === UNRELATED);
ok(!unrelatedInResult, 'unrelated agent_id not surfaced when not in hints');

// ---------------------------------------------------------------------------
// Test 9 — multi-agent hints: AGENT_B entries included
// ---------------------------------------------------------------------------

section('9 multi-agent hints');

ins.run(
  `agent_proposal/${AGENT_B}/01JZAGENTB0000000000000001`,
  JSON.stringify({ ts: NOW - 100, label: 'agent B proposal', agent_id: AGENT_B }),
  NOW - 100, NOW - 100,
);

const multiHint = cockpit.queryTodoList(db, tables, PROJ_ID, [AGENT_A, AGENT_B], { limit: 100 });
const agentBEntries = multiHint.filter(t => t.agent_id === AGENT_B);
ok(agentBEntries.length === 1, `AGENT_B entry surfaced when in hints (got ${agentBEntries.length})`);

// ---------------------------------------------------------------------------
// Test 10 — buildCockpitState exposes todolist + three sources present
// ---------------------------------------------------------------------------

section('10 buildCockpitState integration');

// Add full schema for buildCockpitState
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
`);
const fullTables = new Set([
  'processes', 'tasks', 'blockers', 'outcomes', 'conflicts',
  'dispatch_requests', 'checkpoints', 'scratchpad',
]);

const PROJ = {
  id: PROJ_ID,
  label: 'todo smoke',
  project_root: '/tmp/todo-smoke',
  db_path: ':memory:',
  agent_id_hints: [AGENT_A, AGENT_B],
};

const state = cockpit.buildCockpitState(db, fullTables, PROJ, 'test goal', [AGENT_A, AGENT_B], {});
ok('todolist' in state, 'state.todolist key present');
ok(Array.isArray(state.todolist), 'state.todolist is array');
ok(state.todolist.length > 0, 'state.todolist has entries');

const sources = new Set(state.todolist.map(t => t.source));
ok(sources.has('agent_proposal'), 'todolist includes agent_proposal source');
ok(sources.has('mentor_todo'), 'todolist includes mentor_todo source');
ok(sources.has('user_todo'), 'todolist includes user_todo source');

const tsSorted = state.todolist.every((e, i, arr) => i === 0 || arr[i - 1].ts >= e.ts);
ok(tsSorted, 'state.todolist sorted ts DESC');

// ---------------------------------------------------------------------------
// Test 11 — queryTodoList constant exported
// ---------------------------------------------------------------------------

section('11 exports');
ok(typeof cockpit.queryTodoList === 'function', 'queryTodoList is exported');
ok(typeof cockpit.TODOLIST_LIMIT_DEFAULT === 'number', 'TODOLIST_LIMIT_DEFAULT is exported');
ok(cockpit.TODOLIST_LIMIT_DEFAULT === 30, `TODOLIST_LIMIT_DEFAULT = 30 (got ${cockpit.TODOLIST_LIMIT_DEFAULT})`);

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
