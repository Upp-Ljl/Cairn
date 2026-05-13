#!/usr/bin/env node
/**
 * smoke-cockpit-dispatch.mjs — A2.2 Dispatch Wire unit smoke.
 *
 * Verifies cockpit-dispatch.cjs contract:
 *   1. Happy path: inserts PENDING dispatch_requests row + marks todo 'dispatched'
 *   2. Unknown target agent → ok:false, error target_agent_not_found
 *   3. Empty label → ok:false, error label_required
 *   4. Missing scratchpad table → dispatch row still written (scratchpad optional)
 *   5. todo_id in scratchpad gets status=dispatched + dispatch_id field
 *   6. dispatch_id in returned result matches row inserted
 *   7. source must be one of the three valid values
 *   8. Missing project_id → error
 *   9. Missing todo_id → error
 *  10. Missing target_agent_id → error
 *  11. Dispatched todo with existing scratchpad entry merges dispatched_* fields
 *  12. Missing processes table → error processes_table_missing
 *  13. nl_intent in dispatch row contains source + label
 *  14. context_keys in dispatch row contains todo_id
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dsRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(dsRoot, '..', '..');

const Database = require(path.join(repoRoot, 'packages', 'daemon', 'node_modules', 'better-sqlite3'));
const dispatch = require(path.join(dsRoot, 'cockpit-dispatch.cjs'));

let asserts = 0, fails = 0;
const failures = [];

function ok(c, l) {
  asserts++;
  if (c) process.stdout.write(`  ok    ${l}\n`);
  else   { fails++; failures.push(l); process.stdout.write(`  FAIL  ${l}\n`); }
}
function header(t) { process.stdout.write(`\n${'='.repeat(60)}\n${t}\n${'='.repeat(60)}\n`); }
function section(t) { process.stdout.write(`\n[${t}]\n`); }

header('smoke-cockpit-dispatch — A2.2 Dispatch Wire');

// ---------------------------------------------------------------------------
// Build a minimal in-memory DB with all required tables
// ---------------------------------------------------------------------------

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE processes (
      agent_id TEXT PRIMARY KEY,
      agent_type TEXT NOT NULL,
      capabilities TEXT,
      status TEXT NOT NULL,
      registered_at INTEGER NOT NULL,
      last_heartbeat INTEGER NOT NULL,
      heartbeat_ttl INTEGER NOT NULL DEFAULT 60000
    );
    CREATE TABLE dispatch_requests (
      id TEXT PRIMARY KEY,
      nl_intent TEXT NOT NULL,
      parsed_intent TEXT,
      context_keys TEXT,
      generated_prompt TEXT,
      target_agent TEXT,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      confirmed_at INTEGER,
      task_id TEXT
    );
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

const FULL_TABLES = new Set(['processes', 'dispatch_requests', 'scratchpad']);

const AGENT_A = 'cairn-session-aabb112233cc';
const PROJECT = 'p_dispatch_test';
const TODO_KEY = 'agent_proposal/' + AGENT_A + '/01HZ0000000000TEST01';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function seedAgent(db, agentId) {
  db.prepare(`
    INSERT OR IGNORE INTO processes
      (agent_id, agent_type, status, registered_at, last_heartbeat)
    VALUES (?, 'mcp-server', 'ACTIVE', ?, ?)
  `).run(agentId, Date.now() - 60000, Date.now() - 500);
}

function seedTodo(db, key, value) {
  const now = Date.now();
  db.prepare(`
    INSERT OR REPLACE INTO scratchpad
      (key, value_json, value_path, task_id, expires_at, created_at, updated_at)
    VALUES (@key, @value_json, NULL, NULL, NULL, @now, @now)
  `).run({ key, value_json: JSON.stringify(value), now });
}

function baseInput(overrides) {
  return Object.assign({
    project_id: PROJECT,
    todo_id: TODO_KEY,
    source: 'agent_proposal',
    target_agent_id: AGENT_A,
    label: 'Wire dispatch button to Cairn primitives',
    why: 'Closes A2.2 requirement',
  }, overrides);
}

// ---------------------------------------------------------------------------
// Test 1 — happy path: dispatch row + scratchpad mark
// ---------------------------------------------------------------------------

section('1 happy path');
const db1 = makeDb();
seedAgent(db1, AGENT_A);
seedTodo(db1, TODO_KEY, { label: 'Wire dispatch button', source: 'agent', ts: Date.now() - 1000 });

const r1 = dispatch.dispatchTodo(db1, FULL_TABLES, baseInput());
ok(r1.ok === true,               'returns ok:true');
ok(typeof r1.dispatch_id === 'string' && r1.dispatch_id.length === 26,
   `dispatch_id is 26-char ULID (got: ${r1.dispatch_id})`);

// Verify dispatch row
const row1 = db1.prepare('SELECT * FROM dispatch_requests WHERE id = ?').get(r1.dispatch_id);
ok(row1 !== undefined,           'dispatch_requests row inserted');
ok(row1.status === 'PENDING',    'dispatch row status = PENDING');
ok(row1.target_agent === AGENT_A, 'dispatch row target_agent = AGENT_A');
ok(row1.created_at > 0,          'dispatch row created_at set');

db1.close();

// ---------------------------------------------------------------------------
// Test 2 — unknown target agent
// ---------------------------------------------------------------------------

section('2 unknown target agent');
const db2 = makeDb();
// No agent seeded

const r2 = dispatch.dispatchTodo(db2, FULL_TABLES, baseInput());
ok(r2.ok === false,              'ok:false for missing agent');
ok(r2.error === 'target_agent_not_found', `error=target_agent_not_found (got: ${r2.error})`);
db2.close();

// ---------------------------------------------------------------------------
// Test 3 — empty label
// ---------------------------------------------------------------------------

section('3 empty label');
const db3 = makeDb();
seedAgent(db3, AGENT_A);

const r3 = dispatch.dispatchTodo(db3, FULL_TABLES, baseInput({ label: '   ' }));
ok(r3.ok === false,              'ok:false for empty label');
ok(r3.error === 'label_required', `error=label_required (got: ${r3.error})`);
db3.close();

// ---------------------------------------------------------------------------
// Test 4 — missing scratchpad table → dispatch row still inserted
// ---------------------------------------------------------------------------

section('4 missing scratchpad table');
const db4 = makeDb();
seedAgent(db4, AGENT_A);
const tablesNoScratch = new Set(['processes', 'dispatch_requests']);

const r4 = dispatch.dispatchTodo(db4, tablesNoScratch, baseInput());
ok(r4.ok === true,               'ok:true even without scratchpad table');
const row4 = db4.prepare('SELECT id, status FROM dispatch_requests WHERE id = ?').get(r4.dispatch_id);
ok(row4 && row4.status === 'PENDING', 'dispatch row still written without scratchpad');
db4.close();

// ---------------------------------------------------------------------------
// Test 5 — scratchpad todo gets status=dispatched + dispatch_id
// ---------------------------------------------------------------------------

section('5 scratchpad todo marked dispatched');
const db5 = makeDb();
seedAgent(db5, AGENT_A);
seedTodo(db5, TODO_KEY, { label: 'My proposal', source: 'agent', ts: Date.now() - 2000 });

const r5 = dispatch.dispatchTodo(db5, FULL_TABLES, baseInput());
ok(r5.ok === true, 'ok:true');
const spRow = db5.prepare('SELECT value_json FROM scratchpad WHERE key = ?').get(TODO_KEY);
ok(spRow !== undefined, 'scratchpad row exists');
const spVal = JSON.parse(spRow.value_json);
ok(spVal.status === 'dispatched',        'scratchpad entry status=dispatched');
ok(spVal.dispatch_id === r5.dispatch_id, 'scratchpad dispatch_id matches returned dispatch_id');
ok(typeof spVal.dispatched_at === 'number' && spVal.dispatched_at > 0, 'dispatched_at is a timestamp');
ok(spVal.dispatched_to === AGENT_A,      'dispatched_to matches target_agent_id');
db5.close();

// ---------------------------------------------------------------------------
// Test 6 — dispatch_id in result matches row
// ---------------------------------------------------------------------------

section('6 dispatch_id consistency');
const db6 = makeDb();
seedAgent(db6, AGENT_A);

const r6 = dispatch.dispatchTodo(db6, FULL_TABLES, baseInput({ todo_id: 'mentor_todo/x/y' }));
ok(r6.ok === true, 'ok:true');
const row6 = db6.prepare('SELECT id FROM dispatch_requests WHERE id = ?').get(r6.dispatch_id);
ok(row6 !== undefined && row6.id === r6.dispatch_id, 'row id equals returned dispatch_id');
db6.close();

// ---------------------------------------------------------------------------
// Test 7 — invalid source → error
// ---------------------------------------------------------------------------

section('7 invalid source');
const db7 = makeDb();
seedAgent(db7, AGENT_A);

const r7 = dispatch.dispatchTodo(db7, FULL_TABLES, baseInput({ source: 'bad_source' }));
ok(r7.ok === false, 'ok:false for invalid source');
ok((r7.error || '').includes('source_must_be'), `error mentions source constraint (got: ${r7.error})`);
db7.close();

// ---------------------------------------------------------------------------
// Test 8 — missing project_id
// ---------------------------------------------------------------------------

section('8 missing project_id');
const db8 = makeDb();
const r8 = dispatch.dispatchTodo(db8, FULL_TABLES, baseInput({ project_id: '' }));
ok(r8.ok === false && r8.error === 'project_id_required',
   `error=project_id_required (got: ${r8.error})`);
db8.close();

// ---------------------------------------------------------------------------
// Test 9 — missing todo_id
// ---------------------------------------------------------------------------

section('9 missing todo_id');
const db9 = makeDb();
const r9 = dispatch.dispatchTodo(db9, FULL_TABLES, baseInput({ todo_id: '   ' }));
ok(r9.ok === false && r9.error === 'todo_id_required',
   `error=todo_id_required (got: ${r9.error})`);
db9.close();

// ---------------------------------------------------------------------------
// Test 10 — missing target_agent_id
// ---------------------------------------------------------------------------

section('10 missing target_agent_id');
const db10 = makeDb();
const r10 = dispatch.dispatchTodo(db10, FULL_TABLES, baseInput({ target_agent_id: '' }));
ok(r10.ok === false && r10.error === 'target_agent_id_required',
   `error=target_agent_id_required (got: ${r10.error})`);
db10.close();

// ---------------------------------------------------------------------------
// Test 11 — merges into existing scratchpad todo (keeps original fields)
// ---------------------------------------------------------------------------

section('11 merge into existing scratchpad todo');
const db11 = makeDb();
seedAgent(db11, AGENT_A);
const originalValue = {
  label: 'Build cockpit dispatch',
  source: 'agent',
  ts: Date.now() - 5000,
  task_id: 'task_abc123',
  agent_id: AGENT_A,
};
seedTodo(db11, TODO_KEY, originalValue);

const r11 = dispatch.dispatchTodo(db11, FULL_TABLES, baseInput({ why: 'Phase A2 completion' }));
ok(r11.ok === true, 'ok:true');
const spRow11 = db11.prepare('SELECT value_json FROM scratchpad WHERE key = ?').get(TODO_KEY);
const spVal11 = JSON.parse(spRow11.value_json);
ok(spVal11.task_id === 'task_abc123', 'original task_id preserved in merge');
ok(spVal11.agent_id === AGENT_A,     'original agent_id preserved in merge');
ok(spVal11.status === 'dispatched',  'status overwritten to dispatched');
db11.close();

// ---------------------------------------------------------------------------
// Test 12 — missing processes table
// ---------------------------------------------------------------------------

section('12 missing processes table');
const db12 = makeDb();
const tablesNoProc = new Set(['dispatch_requests', 'scratchpad']);
const r12 = dispatch.dispatchTodo(db12, tablesNoProc, baseInput());
ok(r12.ok === false && r12.error === 'processes_table_missing',
   `error=processes_table_missing (got: ${r12.error})`);
db12.close();

// ---------------------------------------------------------------------------
// Test 13 — nl_intent contains source + label
// ---------------------------------------------------------------------------

section('13 nl_intent contains source + label');
const db13 = makeDb();
seedAgent(db13, AGENT_A);

const r13 = dispatch.dispatchTodo(db13, FULL_TABLES, baseInput({
  source: 'mentor_todo',
  label: 'Run integration tests',
  why: 'CI not yet confirmed',
}));
ok(r13.ok === true, 'ok:true');
const row13 = db13.prepare('SELECT nl_intent FROM dispatch_requests WHERE id = ?').get(r13.dispatch_id);
ok(row13.nl_intent.includes('mentor_todo'),       'nl_intent contains source');
ok(row13.nl_intent.includes('Run integration tests'), 'nl_intent contains label');
ok(row13.nl_intent.includes('CI not yet confirmed'),  'nl_intent contains why');
db13.close();

// ---------------------------------------------------------------------------
// Test 14 — context_keys in dispatch row contains todo_id
// ---------------------------------------------------------------------------

section('14 context_keys contains todo_id');
const db14 = makeDb();
seedAgent(db14, AGENT_A);
const todoKey14 = 'agent_proposal/' + AGENT_A + '/UNIQUE_KEY_999';

const r14 = dispatch.dispatchTodo(db14, FULL_TABLES, baseInput({ todo_id: todoKey14 }));
ok(r14.ok === true, 'ok:true');
const row14 = db14.prepare('SELECT context_keys FROM dispatch_requests WHERE id = ?').get(r14.dispatch_id);
const keys14 = JSON.parse(row14.context_keys || '[]');
ok(Array.isArray(keys14) && keys14.includes(todoKey14),
   `context_keys JSON array contains todo_id (got: ${row14.context_keys})`);
db14.close();

// ---------------------------------------------------------------------------

header(`${asserts - fails}/${asserts} assertions passed (${fails} failed)`);
if (fails > 0) {
  process.stdout.write('\nFailed assertions:\n');
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
  process.exit(1);
}
process.exit(0);
