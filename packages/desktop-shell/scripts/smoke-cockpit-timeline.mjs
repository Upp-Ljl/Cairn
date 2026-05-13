#!/usr/bin/env node
/**
 * smoke-cockpit-timeline.mjs — A1.2 (panel-cockpit-redesign 2026-05-14).
 *
 * Validates cockpit-state.cjs::querySessionTimeline:
 *   - scratchpad `session_timeline/<agent_id>/<ulid>` keys parsed
 *   - sort chronological ASC
 *   - bad JSON rows skipped (no throw)
 *   - checkpoint rows joined as synthetic kind='checkpoint' events
 *   - missing scratchpad table → []
 *   - parent_event_id threaded through
 *   - limit cap honored
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
function header(t) { process.stdout.write(`\n${'='.repeat(56)}\n${t}\n${'='.repeat(56)}\n`); }
function section(t) { process.stdout.write(`\n[${t}]\n`); }

function freshDb(withCheckpoints) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE scratchpad (
      key TEXT PRIMARY KEY, value_json TEXT, value_path TEXT, task_id TEXT,
      expires_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
  `);
  if (withCheckpoints) {
    db.exec(`
      CREATE TABLE tasks (
        task_id TEXT PRIMARY KEY, intent TEXT NOT NULL, state TEXT NOT NULL,
        parent_task_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        created_by_agent_id TEXT, metadata_json TEXT
      );
      CREATE TABLE checkpoints (
        id TEXT PRIMARY KEY, task_id TEXT, git_head TEXT,
        snapshot_status TEXT NOT NULL, created_at INTEGER NOT NULL, label TEXT
      );
    `);
  }
  return db;
}

header('smoke-cockpit-timeline — A1.2');

const AGENT = 'cairn-session-aaaa11111111';

// ---------------------------------------------------------------------------
section('1 empty inputs / missing args');
{
  const db = freshDb(false);
  const TABLES = new Set(['scratchpad']);
  ok(cockpit.querySessionTimeline(db, TABLES, '', Date.now()).length === 0, 'empty agentId → []');
  ok(cockpit.querySessionTimeline(db, new Set(), AGENT).length === 0, 'no scratchpad table → []');
  ok(cockpit.querySessionTimeline(db, TABLES, AGENT).length === 0, 'no rows → []');
  db.close();
}

// ---------------------------------------------------------------------------
section('2 chronological sort + JSON parse');
{
  const db = freshDb(false);
  const TABLES = new Set(['scratchpad']);
  const now = Date.now();
  // Insert in non-chronological order to verify sort
  db.prepare('INSERT INTO scratchpad (key, value_json, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(`session_timeline/${AGENT}/01J9XB`, JSON.stringify({ ts: now - 100, kind: 'done',  label: 'second', agent_id: AGENT }), now, now);
  db.prepare('INSERT INTO scratchpad (key, value_json, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(`session_timeline/${AGENT}/01J9XA`, JSON.stringify({ ts: now - 200, kind: 'start', label: 'first',  agent_id: AGENT }), now, now);
  db.prepare('INSERT INTO scratchpad (key, value_json, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(`session_timeline/${AGENT}/01J9XC`, JSON.stringify({ ts: now,       kind: 'blocked', label: 'third', agent_id: AGENT }), now, now);

  const events = cockpit.querySessionTimeline(db, TABLES, AGENT);
  ok(events.length === 3, '3 events read');
  ok(events[0].label === 'first',  'event 0 = first (oldest)');
  ok(events[1].label === 'second', 'event 1 = second');
  ok(events[2].label === 'third',  'event 2 = third (newest)');
  ok(events[0].kind === 'start',   'kind preserved');
  ok(events[2].kind === 'blocked', 'blocked kind preserved');
  db.close();
}

// ---------------------------------------------------------------------------
section('3 bad JSON rows skipped (no throw)');
{
  const db = freshDb(false);
  const TABLES = new Set(['scratchpad']);
  const now = Date.now();
  db.prepare('INSERT INTO scratchpad (key, value_json, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(`session_timeline/${AGENT}/01J9X1`, '{ not valid json ', now, now);
  db.prepare('INSERT INTO scratchpad (key, value_json, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(`session_timeline/${AGENT}/01J9X2`, JSON.stringify({ ts: now, kind: 'progress', label: 'good', agent_id: AGENT }), now, now);
  const events = cockpit.querySessionTimeline(db, TABLES, AGENT);
  ok(events.length === 1, 'bad JSON skipped, good kept');
  ok(events[0].label === 'good', 'good event preserved');
  db.close();
}

// ---------------------------------------------------------------------------
section('4 parent_event_id threaded through');
{
  const db = freshDb(false);
  const TABLES = new Set(['scratchpad']);
  const now = Date.now();
  db.prepare('INSERT INTO scratchpad (key, value_json, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(`session_timeline/${AGENT}/01J9Y1`, JSON.stringify({ ts: now - 200, kind: 'spawn', label: 'parent spawns', agent_id: AGENT }), now, now);
  db.prepare('INSERT INTO scratchpad (key, value_json, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(`session_timeline/${AGENT}/01J9Y2`, JSON.stringify({ ts: now - 100, kind: 'start', label: 'child step', agent_id: AGENT, parent_event_id: '01J9Y1' }), now, now);
  const events = cockpit.querySessionTimeline(db, TABLES, AGENT);
  ok(events.length === 2, '2 events');
  ok(events[1].parent_event_id === '01J9Y1', 'child has parent_event_id pointing back');
  ok(events[0].parent_event_id === null, 'parent has null parent_event_id');
  db.close();
}

// ---------------------------------------------------------------------------
section('5 checkpoints joined as synthetic events');
{
  const db = freshDb(true);
  const TABLES = new Set(['scratchpad', 'tasks', 'checkpoints']);
  const now = Date.now();
  db.prepare(`INSERT INTO tasks VALUES (?, ?, ?, NULL, ?, ?, ?, NULL)`)
    .run('t1', 'work', 'RUNNING', now - 10000, now - 1000, AGENT);
  db.prepare(`INSERT INTO checkpoints (id, task_id, git_head, snapshot_status, created_at, label) VALUES (?, ?, ?, ?, ?, ?)`)
    .run('ckpt_001', 't1', 'abc123def456', 'OK', now - 500, 'before mock rewrite');
  db.prepare('INSERT INTO scratchpad (key, value_json, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(`session_timeline/${AGENT}/01J9Z1`, JSON.stringify({ ts: now - 100, kind: 'start', label: 'real event', agent_id: AGENT }), now, now);
  const events = cockpit.querySessionTimeline(db, TABLES, AGENT);
  ok(events.length === 2, '1 scratchpad + 1 checkpoint = 2 events');
  const ckpt = events.find(e => e.kind === 'checkpoint');
  ok(ckpt !== undefined, 'checkpoint synthesized as event');
  ok(ckpt.label === 'before mock rewrite', 'checkpoint label preserved');
  ok(ckpt.checkpoint_id === 'ckpt_001', 'checkpoint_id threaded');
  ok(ckpt.source === 'kernel', 'checkpoint source = kernel');
  ok(ckpt.ts === now - 500, 'checkpoint ts from created_at');
  // sort: ckpt (now-500) < real event (now-100) → ckpt first
  ok(events[0].kind === 'checkpoint', 'checkpoint first by ts');
  db.close();
}

// ---------------------------------------------------------------------------
section('6 limit cap');
{
  const db = freshDb(false);
  const TABLES = new Set(['scratchpad']);
  const now = Date.now();
  for (let i = 0; i < 250; i++) {
    db.prepare('INSERT INTO scratchpad (key, value_json, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(`session_timeline/${AGENT}/${String(i).padStart(26, '0')}`,
           JSON.stringify({ ts: now - (250 - i), kind: 'progress', label: `step ${i}`, agent_id: AGENT }),
           now, now);
  }
  const events = cockpit.querySessionTimeline(db, TABLES, AGENT);
  ok(events.length === 200, `default cap 200 (got ${events.length})`);
  const events5 = cockpit.querySessionTimeline(db, TABLES, AGENT, { limit: 5 });
  ok(events5.length === 5, 'limit override = 5');
  // The last 5 by ts should be returned (events.slice(-limit))
  ok(events5[events5.length - 1].label === 'step 249', 'last event = step 249');
  db.close();
}

// ---------------------------------------------------------------------------
section('6b defensive double-encoded value_json (caller pre-stringified)');
{
  const db = freshDb(false);
  const TABLES = new Set(['scratchpad']);
  const now = Date.now();
  // Simulate the cairn.scratchpad.write double-encoding bug discovered by
  // real-agent dogfood 2026-05-14: a JSON string wrapped again by tool serialization.
  const inner = JSON.stringify({ ts: now, kind: 'start', label: 'double-encoded test', agent_id: AGENT, source: 'agent' });
  const doubleEncoded = JSON.stringify(inner);  // → "\"{\\\"ts\\\":...}\""
  db.prepare('INSERT INTO scratchpad (key, value_json, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(`session_timeline/${AGENT}/01JBB1`, doubleEncoded, now, now);
  const events = cockpit.querySessionTimeline(db, TABLES, AGENT);
  ok(events.length === 1, 'double-encoded row recovered (1 event)');
  ok(events[0].kind === 'start', 'kind survives double-parse');
  ok(events[0].label === 'double-encoded test', 'label survives');
  db.close();
}

// ---------------------------------------------------------------------------
section('7 mentor-sourced events tagged');
{
  const db = freshDb(false);
  const TABLES = new Set(['scratchpad']);
  const now = Date.now();
  db.prepare('INSERT INTO scratchpad (key, value_json, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(`session_timeline/${AGENT}/01JAA1`, JSON.stringify({ ts: now, kind: 'mentor', label: 'on path', agent_id: AGENT, source: 'mentor' }), now, now);
  const events = cockpit.querySessionTimeline(db, TABLES, AGENT);
  ok(events[0].source === 'mentor', 'mentor source preserved');
  ok(events[0].kind === 'mentor', 'mentor kind preserved');
  db.close();
}

// ---------------------------------------------------------------------------
header(`${asserts - fails}/${asserts} assertions passed (${fails} failed)`);
if (fails) {
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
  process.exit(1);
}
process.exit(0);
