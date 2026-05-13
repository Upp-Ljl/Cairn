#!/usr/bin/env node
/**
 * Dogfood: cairn session timeline protocol (A1.1 data-layer).
 *
 * Validates the convention-over-new-tool approach:
 *   - Agents write timeline events to scratchpad key
 *     "session_timeline/<agent_id>/<ulid>"
 *   - Events are plain JSON with ts/kind/label/agent_id/source fields
 *   - parent_event_id links subagent events back to parent spawn events
 *
 * Does NOT depend on a built mcp-server.  Opens the DB directly via
 * better-sqlite3 (same pattern as dogfood-session-naming.mjs).
 *
 * Assertions: >= 15
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const daemonRoot = path.resolve(root, '..', 'daemon');

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

let asserts = 0, fails = 0;
const failures = [];

function ok(cond, label) {
  asserts++;
  if (cond) {
    console.log(`  ok    ${label}`);
  } else {
    fails++;
    failures.push(label);
    console.log(`  FAIL  ${label}`);
  }
}

function eq(a, b, label) {
  ok(a === b, `${label} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);
}

// ---------------------------------------------------------------------------
// ULID generator (Crockford base-32, matches protocol spec)
// Monotonic: if two calls land in the same millisecond, the second ULID
// is guaranteed strictly greater by incrementing the time portion by 1.
// ---------------------------------------------------------------------------

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

let _lastUlidMs = 0;
let _lastUlidTs = '';

function encodeTime(ms) {
  let t = ms, ts = '';
  for (let i = 9; i >= 0; i--) {
    ts = CROCKFORD[t % 32] + ts;
    t = Math.floor(t / 32);
  }
  return ts;
}

function newUlid() {
  let t = Date.now();
  // Ensure monotonic: if same ms as last call, bump by 1
  if (t <= _lastUlidMs) t = _lastUlidMs + 1;
  _lastUlidMs = t;
  const ts = encodeTime(t);
  let rand = '';
  for (let i = 0; i < 16; i++) rand += CROCKFORD[Math.floor(Math.random() * 32)];
  return ts + rand;
}

// ---------------------------------------------------------------------------
// Setup: temp DB with migrations
// ---------------------------------------------------------------------------

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-dogfood-timeline-'));
const dbPath = path.join(tmpDir, 'cairn.db');

let db;
try {
  const { openDatabase } = await import(
    pathToFileURL(path.join(daemonRoot, 'dist', 'storage', 'db.js')).href
  );
  const { runMigrations } = await import(
    pathToFileURL(path.join(daemonRoot, 'dist', 'storage', 'migrations', 'runner.js')).href
  );
  const { ALL_MIGRATIONS } = await import(
    pathToFileURL(path.join(daemonRoot, 'dist', 'storage', 'migrations', 'index.js')).href
  );
  db = openDatabase(dbPath);
  runMigrations(db, ALL_MIGRATIONS);
} catch (e) {
  console.error(`SKIP: could not open daemon DB (${e.message}) — is daemon built?`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(0);
}

// Helper: write a timeline event to the scratchpad table directly
// (simulates what cairn.scratchpad.write does)
function writeEvent(agentId, ulid, eventObj) {
  const key = `session_timeline/${agentId}/${ulid}`;
  const value = JSON.stringify(eventObj);
  const now = Date.now();
  db.prepare(
    'INSERT OR REPLACE INTO scratchpad (key, value_json, created_at, updated_at) VALUES (?, ?, ?, ?)'
  ).run(key, value, now, now);
  return key;
}

// Helper: read all timeline events for an agent, sorted by key (= ULID = chronological)
function readTimeline(agentId) {
  const rows = db.prepare(
    "SELECT key, value_json FROM scratchpad WHERE key LIKE ? ORDER BY key ASC"
  ).all(`session_timeline/${agentId}/%`);
  return rows.map(r => ({ key: r.key, event: JSON.parse(r.value_json) }));
}

// ---------------------------------------------------------------------------
// Agent IDs
// ---------------------------------------------------------------------------

const PARENT_AGENT_ID = 'cairn-session-dogfood0001';
const SUB_AGENT_ID    = 'cairn-session-dogfoodsub1';
const TASK_ID         = 'task-timeline-dogfood-01';

// ---------------------------------------------------------------------------
// Step 1: Parent agent — start event
// ---------------------------------------------------------------------------

console.log('\n==> Step 1: parent agent writes start event');

const startUlid = newUlid();
const startKey = writeEvent(PARENT_AGENT_ID, startUlid, {
  ts: Date.now(),
  kind: 'start',
  label: 'refactor auth tests — extract shared setup',
  agent_id: PARENT_AGENT_ID,
  task_id: TASK_ID,
  source: 'agent',
});

ok(startKey.startsWith('session_timeline/'), 'start key has correct prefix');
ok(startKey.includes(PARENT_AGENT_ID), 'start key contains agent_id');
ok(startKey.endsWith(startUlid), 'start key ends with ULID');

// ---------------------------------------------------------------------------
// Step 2: Parent agent — progress event
// ---------------------------------------------------------------------------

console.log('\n==> Step 2: parent agent writes progress event');

const progressUlid = newUlid();
writeEvent(PARENT_AGENT_ID, progressUlid, {
  ts: Date.now(),
  kind: 'progress',
  label: '38/51 tests passing',
  agent_id: PARENT_AGENT_ID,
  task_id: TASK_ID,
  parent_event_id: startUlid,
  source: 'agent',
});

// ---------------------------------------------------------------------------
// Step 3: Parent agent — spawn event (before spawning subagent)
// ---------------------------------------------------------------------------

console.log('\n==> Step 3: parent agent writes spawn event');

const spawnUlid = newUlid();
writeEvent(PARENT_AGENT_ID, spawnUlid, {
  ts: Date.now(),
  kind: 'spawn',
  label: 'spawn subagent: investigate flaky integration test',
  agent_id: PARENT_AGENT_ID,
  task_id: TASK_ID,
  source: 'agent',
});

// ---------------------------------------------------------------------------
// Step 4: Subagent — start event (parent_event_id = spawnUlid)
// ---------------------------------------------------------------------------

console.log('\n==> Step 4: subagent writes start event with parent_event_id');

const subStartUlid = newUlid();
writeEvent(SUB_AGENT_ID, subStartUlid, {
  ts: Date.now(),
  kind: 'start',
  label: 'investigate flaky integration test in auth module',
  agent_id: SUB_AGENT_ID,
  task_id: TASK_ID,
  parent_event_id: spawnUlid,
  source: 'agent',
});

// ---------------------------------------------------------------------------
// Step 5: Subagent — done event
// ---------------------------------------------------------------------------

console.log('\n==> Step 5: subagent writes done event');

const subDoneUlid = newUlid();
writeEvent(SUB_AGENT_ID, subDoneUlid, {
  ts: Date.now(),
  kind: 'done',
  label: 'flaky test root cause found: missing teardown in beforeEach',
  agent_id: SUB_AGENT_ID,
  task_id: TASK_ID,
  parent_event_id: subStartUlid,
  source: 'agent',
});

// ---------------------------------------------------------------------------
// Step 6: Parent agent — subagent_return event
// ---------------------------------------------------------------------------

console.log('\n==> Step 6: parent agent writes subagent_return event');

const returnUlid = newUlid();
writeEvent(PARENT_AGENT_ID, returnUlid, {
  ts: Date.now(),
  kind: 'subagent_return',
  label: 'subagent returned: missing teardown fixed — 51/51 passing',
  agent_id: PARENT_AGENT_ID,
  task_id: TASK_ID,
  parent_event_id: spawnUlid,
  source: 'agent',
});

// ---------------------------------------------------------------------------
// Step 7: Parent agent — done event
// ---------------------------------------------------------------------------

console.log('\n==> Step 7: parent agent writes done event');

const doneUlid = newUlid();
writeEvent(PARENT_AGENT_ID, doneUlid, {
  ts: Date.now(),
  kind: 'done',
  label: 'auth tests refactored — 51/51 passing',
  agent_id: PARENT_AGENT_ID,
  task_id: TASK_ID,
  parent_event_id: startUlid,
  source: 'agent',
});

// ---------------------------------------------------------------------------
// Verification: read back all events and assert
// ---------------------------------------------------------------------------

console.log('\n==> Verifying: read back parent timeline');

const parentTimeline = readTimeline(PARENT_AGENT_ID);

// parent has 5 events: start, progress, spawn, subagent_return, done
eq(parentTimeline.length, 5, 'parent timeline has 5 events');

// events are in chronological (ULID sort) order
const parentKinds = parentTimeline.map(r => r.event.kind);
eq(parentKinds[0], 'start',           'parent event[0].kind = start');
eq(parentKinds[1], 'progress',        'parent event[1].kind = progress');
eq(parentKinds[2], 'spawn',           'parent event[2].kind = spawn');
eq(parentKinds[3], 'subagent_return', 'parent event[3].kind = subagent_return');
eq(parentKinds[4], 'done',            'parent event[4].kind = done');

// all events have required fields
for (const { event, key } of parentTimeline) {
  ok(typeof event.ts === 'number' && event.ts > 0, `event ${event.kind}: ts is positive number`);
  eq(event.agent_id, PARENT_AGENT_ID, `event ${event.kind}: agent_id matches`);
  eq(event.source, 'agent', `event ${event.kind}: source = agent`);
  ok(typeof event.label === 'string' && event.label.length > 0, `event ${event.kind}: label non-empty`);
  ok(event.label.length <= 120, `event ${event.kind}: label <= 120 chars`);
}

// parent_event_id links
const progressEvent = parentTimeline[1].event;
eq(progressEvent.parent_event_id, startUlid, 'progress.parent_event_id = startUlid');

const spawnEvent = parentTimeline[2].event;
ok(!spawnEvent.parent_event_id, 'spawn event has no parent_event_id (root of subagent branch)');

const returnEvent = parentTimeline[3].event;
eq(returnEvent.parent_event_id, spawnUlid, 'subagent_return.parent_event_id = spawnUlid');

const doneEvent = parentTimeline[4].event;
eq(doneEvent.parent_event_id, startUlid, 'done.parent_event_id = startUlid');

console.log('\n==> Verifying: read back subagent timeline');

const subTimeline = readTimeline(SUB_AGENT_ID);

// subagent has 2 events: start, done
eq(subTimeline.length, 2, 'subagent timeline has 2 events');

const subStart = subTimeline[0].event;
eq(subStart.kind, 'start', 'subagent event[0].kind = start');
eq(subStart.agent_id, SUB_AGENT_ID, 'subagent start: agent_id matches SUB_AGENT_ID');
eq(subStart.parent_event_id, spawnUlid, 'subagent start.parent_event_id = spawnUlid (links to parent spawn)');

const subDone = subTimeline[1].event;
eq(subDone.kind, 'done', 'subagent event[1].kind = done');
eq(subDone.parent_event_id, subStartUlid, 'subagent done.parent_event_id = subStartUlid');

console.log('\n==> Verifying: scratchpad key namespace pattern');

// All session_timeline keys follow the expected pattern
const allKeys = db.prepare(
  "SELECT key FROM scratchpad WHERE key LIKE 'session_timeline/%' ORDER BY key ASC"
).all().map(r => r.key);

eq(allKeys.length, 7, 'total 7 timeline entries in scratchpad (5 parent + 2 subagent)');

for (const key of allKeys) {
  const parts = key.split('/');
  ok(parts.length === 3, `key has 3 segments: ${key}`);
  eq(parts[0], 'session_timeline', `key starts with session_timeline: ${key}`);
  ok(parts[2].length === 26, `ULID segment is 26 chars: ${key}`);
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

db.close();
fs.rmSync(tmpDir, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n==> ${asserts - fails}/${asserts} assertions passed`);
if (fails > 0) {
  console.error(`FAIL: ${fails} assertion(s) failed`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('PASS');
