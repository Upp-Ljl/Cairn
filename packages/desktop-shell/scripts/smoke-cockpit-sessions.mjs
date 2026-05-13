#!/usr/bin/env node
/**
 * smoke-cockpit-sessions.mjs — A3-part2 (panel-cockpit-redesign 2026-05-14).
 *
 * Validates cockpit-state.cjs::querySessions:
 *   - working/blocked/idle/stale classification
 *   - display_name fallback (hex short prefix) + scratchpad session_name override
 *   - very-old (>24h stale) rows dropped
 *   - empty inputs → []
 *   - sort order: working > blocked > idle > stale
 *   - current_task threading
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

function freshDb() {
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
    CREATE TABLE scratchpad (
      key TEXT PRIMARY KEY, value_json TEXT, value_path TEXT, task_id TEXT,
      expires_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
  `);
  return db;
}

const TABLES = new Set(['processes', 'tasks', 'scratchpad']);

header('smoke-cockpit-sessions — A3-part2');

// ---------------------------------------------------------------------------
section('1 empty inputs');
{
  const db = freshDb();
  const sess = cockpit.querySessions(db, TABLES, [], Date.now());
  ok(Array.isArray(sess) && sess.length === 0, 'no hints → empty array');
  db.close();
}

// ---------------------------------------------------------------------------
section('2 deriveSessionDisplayName fallback');
{
  ok(cockpit.deriveSessionDisplayName('cairn-session-746e4cea197e') === '746e4cea', 'cairn-session hex → 8-char short prefix');
  ok(cockpit.deriveSessionDisplayName('claude:7f5bf59f') === '7f5bf59f', 'generic long id → last 8 chars');
  ok(cockpit.deriveSessionDisplayName('short') === 'short', 'short id passes through');
  ok(cockpit.deriveSessionDisplayName('') === '(unknown)', 'empty → (unknown) sentinel');
  ok(cockpit.deriveSessionDisplayName(null) === '(unknown)', 'null → (unknown) sentinel');
}

// ---------------------------------------------------------------------------
section('3 state classification (working / blocked / idle / stale)');
{
  const db = freshDb();
  const now = Date.now();
  // working: fresh heartbeat + RUNNING task
  db.prepare(`INSERT INTO processes VALUES (?, 'mcp', '[]', 'ACTIVE', ?, ?, 60000)`)
    .run('cairn-session-aaaa11111111', now - 100000, now - 5000);
  db.prepare(`INSERT INTO tasks VALUES (?, ?, ?, NULL, ?, ?, ?, NULL)`)
    .run('t_work', 'refactor auth', 'RUNNING', now - 10000, now - 1000, 'cairn-session-aaaa11111111');

  // blocked: fresh heartbeat + BLOCKED task
  db.prepare(`INSERT INTO processes VALUES (?, 'mcp', '[]', 'ACTIVE', ?, ?, 60000)`)
    .run('cairn-session-bbbb22222222', now - 100000, now - 3000);
  db.prepare(`INSERT INTO tasks VALUES (?, ?, ?, NULL, ?, ?, ?, NULL)`)
    .run('t_block', 'fix tests', 'BLOCKED', now - 10000, now - 2000, 'cairn-session-bbbb22222222');

  // idle: fresh heartbeat, no active task
  db.prepare(`INSERT INTO processes VALUES (?, 'mcp', '[]', 'ACTIVE', ?, ?, 60000)`)
    .run('cairn-session-cccc33333333', now - 100000, now - 10000);

  // stale: heartbeat > ttl×2 but within 24h
  db.prepare(`INSERT INTO processes VALUES (?, 'mcp', '[]', 'ACTIVE', ?, ?, 60000)`)
    .run('cairn-session-dddd44444444', now - 1000000, now - 200000);

  // very-old: should be dropped
  db.prepare(`INSERT INTO processes VALUES (?, 'mcp', '[]', 'ACTIVE', ?, ?, 60000)`)
    .run('cairn-session-eeee55555555', now - 100000000, now - 50 * 60 * 60_000);

  const hints = [
    'cairn-session-aaaa11111111',
    'cairn-session-bbbb22222222',
    'cairn-session-cccc33333333',
    'cairn-session-dddd44444444',
    'cairn-session-eeee55555555',
  ];
  const sess = cockpit.querySessions(db, TABLES, hints, now);

  ok(sess.length === 4, `4 sessions kept (very-old dropped) — got ${sess.length}`);
  const find = (id) => sess.find(s => s.agent_id === id);
  ok(find('cairn-session-aaaa11111111').state === 'working', 'aaa → working');
  ok(find('cairn-session-bbbb22222222').state === 'blocked', 'bbb → blocked');
  ok(find('cairn-session-cccc33333333').state === 'idle', 'ccc → idle');
  ok(find('cairn-session-dddd44444444').state === 'stale', 'ddd → stale');
  ok(!find('cairn-session-eeee55555555'), 'eee dropped (older than 24h)');

  // Sort order: working > blocked > idle > stale
  ok(sess[0].state === 'working', 'sort: 0 = working');
  ok(sess[1].state === 'blocked', 'sort: 1 = blocked');
  ok(sess[2].state === 'idle',    'sort: 2 = idle');
  ok(sess[3].state === 'stale',   'sort: 3 = stale');

  // current_task threading
  ok(find('cairn-session-aaaa11111111').current_task.intent === 'refactor auth', 'working session has current_task.intent');
  ok(find('cairn-session-bbbb22222222').current_task.state === 'BLOCKED', 'blocked session has current_task.state=BLOCKED');
  ok(find('cairn-session-cccc33333333').current_task === null, 'idle session has no current_task');

  // display_name fallback (no session_name written → hex prefix)
  ok(find('cairn-session-aaaa11111111').display_name === 'aaaa1111', 'display_name = hex short prefix when no override');

  db.close();
}

// ---------------------------------------------------------------------------
section('4 scratchpad session_name override (forward-compat A3-part1)');
{
  const db = freshDb();
  const now = Date.now();
  db.prepare(`INSERT INTO processes VALUES (?, 'mcp', '[]', 'ACTIVE', ?, ?, 60000)`)
    .run('cairn-session-ffff66666666', now - 100000, now - 1000);
  db.prepare(`INSERT INTO scratchpad (key, value_json, created_at, updated_at) VALUES (?, ?, ?, ?)`)
    .run('session_name/cairn-session-ffff66666666',
         JSON.stringify({ name: 'ship Phase 8 §8 Rule C', set_by: 'agent' }),
         now, now);

  const sess = cockpit.querySessions(db, TABLES, ['cairn-session-ffff66666666'], now);
  ok(sess.length === 1, '1 session returned');
  ok(sess[0].display_name === 'ship Phase 8 §8 Rule C', 'display_name uses scratchpad override');
  db.close();
}

// ---------------------------------------------------------------------------
section('5 limit cap');
{
  const db = freshDb();
  const now = Date.now();
  const hints = [];
  for (let i = 0; i < 30; i++) {
    const id = `cairn-session-1111${i.toString().padStart(8, '0')}`;
    db.prepare(`INSERT INTO processes VALUES (?, 'mcp', '[]', 'ACTIVE', ?, ?, 60000)`)
      .run(id, now - 100000, now - 1000);
    hints.push(id);
  }
  const sess = cockpit.querySessions(db, TABLES, hints, now);
  ok(sess.length === 20, `default cap = 20 (got ${sess.length})`);
  const sess5 = cockpit.querySessions(db, TABLES, hints, now, { limit: 5 });
  ok(sess5.length === 5, 'limit override works');
  db.close();
}

// ---------------------------------------------------------------------------
section('6 buildCockpitState includes sessions key');
{
  const db = freshDb();
  const now = Date.now();
  db.prepare(`INSERT INTO processes VALUES (?, 'mcp', '[]', 'ACTIVE', ?, ?, 60000)`)
    .run('cairn-session-7777aaaa1234', now - 100000, now - 1000);
  // emulate the registry surface so buildCockpitState has a project
  const proj = { id: 'p_smoke', label: 'smoke', project_root: '/tmp/smoke', db_path: ':memory:' };
  const state = cockpit.buildCockpitState(db, TABLES, proj, null, ['cairn-session-7777aaaa1234']);
  ok(Array.isArray(state.sessions), 'state.sessions is array');
  ok(state.sessions.length === 1, '1 session in cockpit state');
  ok(state.sessions[0].agent_id === 'cairn-session-7777aaaa1234', 'agent_id threaded');
  ok(state.sessions[0].state === 'idle', 'no active task → idle');
  db.close();
}

// ---------------------------------------------------------------------------
header(`${asserts - fails}/${asserts} assertions passed (${fails} failed)`);
if (fails) {
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
  process.exit(1);
}
process.exit(0);
