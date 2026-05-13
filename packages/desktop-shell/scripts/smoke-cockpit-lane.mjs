#!/usr/bin/env node
/**
 * smoke-cockpit-lane.mjs — Mode B Continuous Iteration slice 1.
 *
 * Validates cockpit-lane.cjs lane data layer:
 *   - createLane writes scratchpad row with correct payload
 *   - queryLanes lists newest-first
 *   - getLane fetches by id
 *   - advanceLane bumps current_idx; final advance → DONE
 *   - pauseLane / resumeLane state machine
 *   - error paths: empty candidates, no project_id, lane_not_found
 *   - defensive double-encoded parse (consistent with cockpit-state)
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dsRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(dsRoot, '..', '..');

const Database = require(path.join(repoRoot, 'packages', 'daemon', 'node_modules', 'better-sqlite3'));
const lane = require(path.join(dsRoot, 'cockpit-lane.cjs'));

let asserts = 0, fails = 0;
const failures = [];
function ok(c, l) {
  asserts++;
  if (c) process.stdout.write(`  ok    ${l}\n`);
  else { fails++; failures.push(l); process.stdout.write(`  FAIL  ${l}\n`); }
}
function header(t) { process.stdout.write(`\n${'='.repeat(56)}\n${t}\n${'='.repeat(56)}\n`); }
function section(t) { process.stdout.write(`\n[${t}]\n`); }

function freshDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE scratchpad (
      key TEXT PRIMARY KEY, value_json TEXT, value_path TEXT, task_id TEXT,
      expires_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
  `);
  return db;
}

header('smoke-cockpit-lane — Mode B slice 1');

// ---------------------------------------------------------------------------
section('1 createLane — happy path');
{
  const db = freshDb();
  const r = lane.createLane(db, 'p_cairn', ['t_001', 't_002', 't_003'], 'cairn-session-aaaa1111');
  ok(r.ok === true, 'createLane returns ok');
  ok(typeof r.id === 'string' && r.id.length === 26, `id is 26-char ulid (got ${r.id.length})`);
  ok(typeof r.key === 'string' && r.key.startsWith('lane/p_cairn/'), 'key has lane/<project>/ prefix');
  // Read back row directly
  const row = db.prepare('SELECT value_json FROM scratchpad WHERE key = ?').get(r.key);
  ok(row !== undefined, 'scratchpad row inserted');
  const body = JSON.parse(row.value_json);
  ok(body.project_id === 'p_cairn', 'project_id in payload');
  ok(Array.isArray(body.candidates) && body.candidates.length === 3, '3 candidates');
  ok(body.current_idx === 0, 'current_idx starts at 0');
  ok(body.state === 'PENDING', 'state starts as PENDING');
  ok(body.authorized_by === 'cairn-session-aaaa1111', 'authorized_by threaded');
  db.close();
}

// ---------------------------------------------------------------------------
section('2 createLane error paths');
{
  const db = freshDb();
  ok(lane.createLane(null, 'p', ['t']).ok === false, 'no db → error');
  ok(lane.createLane(db, '', ['t']).ok === false, 'empty project_id → error');
  ok(lane.createLane(db, 'p', []).ok === false, 'empty candidates → error');
  ok(lane.createLane(db, 'p', null).ok === false, 'null candidates → error');
  ok(lane.createLane(db, 'p', ['t', '']).ok === false, 'empty candidate → error');
  db.close();
}

// ---------------------------------------------------------------------------
section('3 queryLanes — newest-first ordering');
{
  const db = freshDb();
  const r1 = lane.createLane(db, 'p_cairn', ['t_a'], 'user');
  // Force second to have a later updated_at
  db.prepare('UPDATE scratchpad SET updated_at = updated_at + 1000 WHERE key = ?').run(r1.key);
  const r2 = lane.createLane(db, 'p_cairn', ['t_b'], 'user');
  db.prepare('UPDATE scratchpad SET updated_at = updated_at + 2000 WHERE key = ?').run(r2.key);
  const list = lane.queryLanes(db, 'p_cairn');
  ok(list.length === 2, '2 lanes returned');
  ok(list[0].id === r2.id, 'newest first');
  ok(list[1].id === r1.id, 'older second');
  // Filter by project — other project's lanes don't bleed in
  lane.createLane(db, 'p_other', ['t_c'], 'user');
  ok(lane.queryLanes(db, 'p_cairn').length === 2, 'other project lanes not included');
  ok(lane.queryLanes(db, 'p_other').length === 1, 'other project has 1');
  db.close();
}

// ---------------------------------------------------------------------------
section('4 getLane — fetch by id');
{
  const db = freshDb();
  const r = lane.createLane(db, 'p_cairn', ['t_x', 't_y'], 'user');
  const got = lane.getLane(db, 'p_cairn', r.id);
  ok(got !== null, 'getLane returns lane');
  ok(got.candidates[0] === 't_x' && got.candidates[1] === 't_y', 'candidates intact');
  ok(lane.getLane(db, 'p_cairn', 'nonexistent') === null, 'missing → null');
  ok(lane.getLane(db, '', 'x') === null, 'no project → null');
  db.close();
}

// ---------------------------------------------------------------------------
section('5 advanceLane — bump current_idx + final → DONE');
{
  const db = freshDb();
  const r = lane.createLane(db, 'p_cairn', ['t_1', 't_2', 't_3'], 'user');
  const a1 = lane.advanceLane(db, 'p_cairn', r.id);
  ok(a1.ok === true && a1.lane.current_idx === 1 && a1.lane.state === 'RUNNING', 'advance 0→1 RUNNING');
  const a2 = lane.advanceLane(db, 'p_cairn', r.id);
  ok(a2.ok === true && a2.lane.current_idx === 2 && a2.lane.state === 'RUNNING', 'advance 1→2 RUNNING');
  const a3 = lane.advanceLane(db, 'p_cairn', r.id);
  ok(a3.ok === true && a3.lane.state === 'DONE', 'final advance → DONE');
  const a4 = lane.advanceLane(db, 'p_cairn', r.id);
  ok(a4.ok === true && a4.note === 'already_done', 'idempotent already_done');
  db.close();
}

// ---------------------------------------------------------------------------
section('6 advanceLane error paths');
{
  const db = freshDb();
  ok(lane.advanceLane(db, 'p_cairn', 'nope').ok === false, 'unknown lane_id → error');
}

// ---------------------------------------------------------------------------
section('7 pauseLane / resumeLane');
{
  const db = freshDb();
  const r = lane.createLane(db, 'p_cairn', ['t_a', 't_b'], 'user');
  const p1 = lane.pauseLane(db, 'p_cairn', r.id);
  ok(p1.ok === true && p1.lane.state === 'PAUSED', 'pause from PENDING → PAUSED');
  const adv = lane.advanceLane(db, 'p_cairn', r.id);
  ok(adv.ok === false && adv.error === 'lane_paused', 'cannot advance PAUSED');
  const res = lane.resumeLane(db, 'p_cairn', r.id);
  ok(res.ok === true && res.lane.state === 'PENDING', 'resume PENDING (idx still 0)');
  lane.advanceLane(db, 'p_cairn', r.id);  // → RUNNING idx 1
  const p2 = lane.pauseLane(db, 'p_cairn', r.id);
  ok(p2.ok === true && p2.lane.state === 'PAUSED', 'pause from RUNNING → PAUSED');
  const res2 = lane.resumeLane(db, 'p_cairn', r.id);
  ok(res2.ok === true && res2.lane.state === 'RUNNING', 'resume RUNNING (idx > 0)');
  // Can't pause DONE
  lane.advanceLane(db, 'p_cairn', r.id);  // DONE
  const pDone = lane.pauseLane(db, 'p_cairn', r.id);
  ok(pDone.ok === false && pDone.error === 'lane_already_done', 'cannot pause DONE lane');
  db.close();
}

// ---------------------------------------------------------------------------
section('8 defensive double-encoded parse');
{
  const db = freshDb();
  // Manually insert a double-encoded row (simulating cairn.scratchpad.write
  // pre-stringify bug discovered 2026-05-14)
  const payload = { id: 'X', project_id: 'p', candidates: ['t'], current_idx: 0, state: 'PENDING' };
  const doubleEnc = JSON.stringify(JSON.stringify(payload));
  const now = Date.now();
  db.prepare('INSERT INTO scratchpad (key, value_json, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run('lane/p/X', doubleEnc, now, now);
  const list = lane.queryLanes(db, 'p');
  ok(list.length === 1, 'double-encoded row recovered');
  ok(list[0].id === 'X', 'id preserved');
  ok(list[0].candidates[0] === 't', 'candidates preserved');
  db.close();
}

// ---------------------------------------------------------------------------
header(`${asserts - fails}/${asserts} assertions passed (${fails} failed)`);
if (fails) {
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
  process.exit(1);
}
process.exit(0);
