#!/usr/bin/env node
/**
 * smoke-cockpit-steer.mjs — Phase 3 of panel-cockpit-redesign.
 *
 * Verifies the tiered steer delivery contract (decision #5 / #20):
 *   - injection (scratchpad write to agent_inbox/<agent>/<ulid>) succeeds
 *     against an in-memory DB
 *   - clipboard fallback receives the wrapped text (via injected stub)
 *   - returned shape includes delivered list, supervisor_id, key
 *   - empty / missing inputs short-circuit cleanly
 *   - subsequent activity-feed surfaces the steer as 'user_steer' event
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dsRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(dsRoot, '..', '..');

const Database = require(path.join(repoRoot, 'packages', 'daemon', 'node_modules', 'better-sqlite3'));
const steer = require(path.join(dsRoot, 'cockpit-steer.cjs'));
const cockpit = require(path.join(dsRoot, 'cockpit-state.cjs'));

let asserts = 0, fails = 0;
const failures = [];
function ok(c, l) {
  asserts++;
  if (c) process.stdout.write(`  ok    ${l}\n`);
  else   { fails++; failures.push(l); process.stdout.write(`  FAIL  ${l}\n`); }
}
function header(t) { process.stdout.write(`\n${'='.repeat(56)}\n${t}\n${'='.repeat(56)}\n`); }
function section(t) { process.stdout.write(`\n[${t}]\n`); }

header('smoke-cockpit-steer — Phase 3');

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE scratchpad (
    key TEXT PRIMARY KEY, value_json TEXT, value_path TEXT, task_id TEXT,
    expires_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
`);
const tables = new Set(['scratchpad']);

const AGENT_A = 'cairn-session-aaaa11111111';
const PROJ_ID = 'p_steer_test';

// ---------------------------------------------------------------------------
// Test 1 — basic injection
// ---------------------------------------------------------------------------

section('1 basic injection');
let clipboardCalls = [];
const stubClipboard = (text) => clipboardCalls.push(text);

const r1 = steer.steerAgent(db, tables, {
  project_id: PROJ_ID, agent_id: AGENT_A, message: 'try sanity check first',
}, { copyToClipboard: stubClipboard });

ok(r1.ok === true, 'returns ok:true');
ok(Array.isArray(r1.delivered) && r1.delivered.includes('inject'), 'delivered includes inject');
ok(r1.delivered.includes('clipboard'), 'delivered includes clipboard');
ok(typeof r1.scratchpad_key === 'string' && r1.scratchpad_key.startsWith(`agent_inbox/${AGENT_A}/`),
   `scratchpad_key has correct prefix (got: ${r1.scratchpad_key})`);
ok(typeof r1.supervisor_id === 'string' && r1.supervisor_id.startsWith('cairn-supervisor-'),
   `supervisor_id has correct prefix`);
ok(clipboardCalls.length === 1, 'clipboard called exactly once');
ok(clipboardCalls[0].includes('try sanity check first'), 'clipboard text contains message');
ok(clipboardCalls[0].includes(AGENT_A), 'clipboard text contains target agent');

// ---------------------------------------------------------------------------
// Test 2 — scratchpad row actually persisted with correct shape
// ---------------------------------------------------------------------------

section('2 scratchpad row persistence');
const row = db.prepare('SELECT key, value_json FROM scratchpad WHERE key = ?').get(r1.scratchpad_key);
ok(row !== undefined, 'row exists');
const body = JSON.parse(row.value_json);
ok(body.message === 'try sanity check first', 'message persisted');
ok(body.project_id === PROJ_ID, 'project_id persisted');
ok(body.from && body.from.startsWith('user-supervisor:'), 'from = user-supervisor:<id>');
ok(body.source === 'cockpit', 'source = cockpit');
ok(typeof body.ts === 'number' && body.ts > 0, 'ts is positive number');

// ---------------------------------------------------------------------------
// Test 3 — empty / bad inputs
// ---------------------------------------------------------------------------

section('3 input validation');
const r_no_msg = steer.steerAgent(db, tables, { project_id: PROJ_ID, agent_id: AGENT_A, message: '   ' }, { copyToClipboard: stubClipboard });
ok(r_no_msg.ok === false, 'empty message → ok:false');
ok((r_no_msg.inject_error || '').includes('message_empty'), 'inject_error reports message_empty');

const r_no_agent = steer.steerAgent(db, tables, { project_id: PROJ_ID, message: 'hi' }, { copyToClipboard: stubClipboard });
ok((r_no_agent.inject_error || '').includes('agent_id_required'), 'missing agent_id flagged');

const r_no_proj = steer.steerAgent(db, tables, { agent_id: AGENT_A, message: 'hi' }, { copyToClipboard: stubClipboard });
ok((r_no_proj.inject_error || '').includes('project_id_required'), 'missing project_id flagged');

// ---------------------------------------------------------------------------
// Test 4 — long message clipped
// ---------------------------------------------------------------------------

section('4 long message clipped to MAX_STEER_BYTES');
const longMsg = 'x'.repeat(steer.MAX_STEER_BYTES + 500);
const r_long = steer.steerAgent(db, tables, {
  project_id: PROJ_ID, agent_id: AGENT_A, message: longMsg,
}, { copyToClipboard: stubClipboard });
ok(r_long.ok, 'long message still ok');
const longRow = db.prepare('SELECT value_json FROM scratchpad WHERE key = ?').get(r_long.scratchpad_key);
const longBody = JSON.parse(longRow.value_json);
ok(longBody.message.length === steer.MAX_STEER_BYTES, `message clipped to ${steer.MAX_STEER_BYTES}`);

// ---------------------------------------------------------------------------
// Test 5 — activity feed surfaces user_steer events
// ---------------------------------------------------------------------------

section('5 activity feed surfaces user_steer events');
// We need a richer schema for activity feed; reuse subset.
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
    answer TEXT
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
db.prepare(`INSERT INTO processes (agent_id, agent_type, status, registered_at, last_heartbeat, heartbeat_ttl) VALUES (?, 'mcp-server', 'ACTIVE', ?, ?, 60000)`).run(AGENT_A, Date.now() - 60000, Date.now() - 1000);

const state = cockpit.buildCockpitState(
  db, fullTables,
  { id: PROJ_ID, label: 'steer test', project_root: '/tmp', db_path: ':memory:', agent_id_hints: [AGENT_A] },
  'goal text',
  [AGENT_A],
  { activityLimit: 30 },
);
const steerEvents = state.activity.filter(e => e.kind === 'user_steer');
ok(steerEvents.length >= 2, `≥2 user_steer events in activity feed (got ${steerEvents.length})`);
ok(steerEvents.every(e => e.body.includes('You →')), 'every user_steer body has "You →" prefix');

// ---------------------------------------------------------------------------

db.close();
header(`${asserts - fails}/${asserts} assertions passed (${fails} failed)`);
if (fails) {
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
  process.exit(1);
}
process.exit(0);
