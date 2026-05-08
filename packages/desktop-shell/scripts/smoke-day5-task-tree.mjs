// Day 5 smoke — project-aware Tasks tab + task tree + checkpoints.
//
// What this exercises:
//   1. queryProjectScopedTasks filters by agent_id_hints; rows include
//      blockers_open / blockers_total / outcome_status / checkpoints_total.
//   2. Empty hints → { available:true, hints_empty:true, tasks:[] }
//      (the panel's "no agent_id_hints yet" empty state condition).
//   3. queryTaskCheckpoints returns checkpoints attached to a task,
//      ordered by COALESCE(ready_at, created_at) DESC, with the
//      schema-real columns only (id, label, snapshot_status, git_head,
//      size_bytes, created_at, ready_at).
//   4. Tree shape from parent_task_id can be reconstructed (roots and
//      child counts match what the panel will render).
//   5. queryRunLogEvents now includes checkpoint.* events, ordered with
//      the rest of the feed.
//   6. Cairn SQLite mtime unchanged across the entire run (read-only).

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-day5-smoke-'));
const dbPath = path.join(tmpDir, 'smoke.db');

// Daemon's better-sqlite3 (system Node ABI) — desktop-shell's copy is built
// for Electron and won't load under plain node.
const Database       = require(path.join(__dirname, '..', '..', 'daemon', 'node_modules', 'better-sqlite3'));
const queries        = require(path.join(__dirname, '..', 'queries.cjs'));
const projectQueries = require(path.join(__dirname, '..', 'project-queries.cjs'));

const db = new Database(dbPath);
db.exec(`
  CREATE TABLE processes (agent_id TEXT, agent_type TEXT, capabilities TEXT, status TEXT,
    registered_at INTEGER, last_heartbeat INTEGER, heartbeat_ttl INTEGER);
  CREATE TABLE tasks (task_id TEXT PRIMARY KEY, parent_task_id TEXT, state TEXT,
    intent TEXT, created_at INTEGER, updated_at INTEGER, created_by_agent_id TEXT,
    metadata_json TEXT);
  CREATE TABLE blockers (blocker_id TEXT, task_id TEXT, status TEXT, question TEXT,
    raised_at INTEGER, answered_at INTEGER);
  CREATE TABLE outcomes (outcome_id TEXT, task_id TEXT, status TEXT, criteria_json TEXT,
    evaluated_at INTEGER, evaluation_summary TEXT, created_at INTEGER, updated_at INTEGER);
  CREATE TABLE checkpoints (id TEXT PRIMARY KEY, task_id TEXT, label TEXT, git_head TEXT,
    snapshot_dir TEXT, snapshot_status TEXT, size_bytes INTEGER,
    created_at INTEGER, ready_at INTEGER);
  CREATE TABLE conflicts (id TEXT, agent_a TEXT, agent_b TEXT, conflict_type TEXT,
    summary TEXT, status TEXT, detected_at INTEGER, resolved_at INTEGER);
  CREATE TABLE dispatch_requests (id TEXT, nl_intent TEXT, status TEXT, target_agent TEXT,
    task_id TEXT, created_at INTEGER, confirmed_at INTEGER);
`);

const TABLES = new Set([
  'processes','tasks','blockers','outcomes','checkpoints','conflicts','dispatch_requests',
]);

const now = Date.now();
const HINT_A = 'cairn-aaa';
const HINT_B = 'cairn-bbb';
const ORPHAN = 'cairn-orphan';

// Tree shape (5 owned by HINT_A + HINT_B + 1 orphan task):
//   t-root         (HINT_A)
//   ├── t-child-a  (HINT_A)
//   │     └── t-grand (HINT_B)        // cross-agent within project
//   ├── t-child-b  (HINT_A)            // sibling
//   t-orphan-root  (ORPHAN)            // not in project hints
const insT = db.prepare(`INSERT INTO tasks
  (task_id, parent_task_id, state, intent, created_at, updated_at, created_by_agent_id)
  VALUES (?,?,?,?,?,?,?)`);
insT.run('t-root',        null,         'RUNNING',        'root task',         now-5000, now-100, HINT_A);
insT.run('t-child-a',     't-root',     'BLOCKED',        'first child',       now-4000, now-200, HINT_A);
insT.run('t-grand',       't-child-a',  'WAITING_REVIEW', 'grandchild',        now-3000, now-50,  HINT_B);
insT.run('t-child-b',     't-root',     'DONE',           'second child',      now-3500, now-90,  HINT_A);
insT.run('t-orphan-root', null,         'PENDING',        'unattributed work', now-2000, now-10,  ORPHAN);

// Blockers — t-child-a has 1 OPEN, 1 ANSWERED.
const insB = db.prepare(`INSERT INTO blockers
  (blocker_id, task_id, status, question, raised_at, answered_at) VALUES (?,?,?,?,?,?)`);
insB.run('b1', 't-child-a', 'OPEN',     'why is X?', now-3500, null);
insB.run('b2', 't-child-a', 'ANSWERED', 'old Q',     now-4500, now-4400);

// Outcomes — t-grand has PASS, t-child-b has FAIL, root has PENDING.
const insO = db.prepare(`INSERT INTO outcomes
  (outcome_id, task_id, status, criteria_json, evaluated_at, evaluation_summary, created_at, updated_at)
  VALUES (?,?,?,?,?,?,?,?)`);
insO.run('o1', 't-grand',    'PASS',    JSON.stringify([{a:1},{b:2}]), now-100,  'looks good', now-200, now-100);
insO.run('o2', 't-child-b',  'FAIL',    JSON.stringify([{a:1}]),       now-90,   'broke',      now-200, now-90);
insO.run('o3', 't-root',     'PENDING', JSON.stringify([]),            null,     null,         now-200, now-200);

// Checkpoints — 2 on t-root (one READY, one CORRUPTED), 1 PENDING on t-child-a.
const insC = db.prepare(`INSERT INTO checkpoints
  (id, task_id, label, git_head, snapshot_dir, snapshot_status, size_bytes, created_at, ready_at)
  VALUES (?,?,?,?,?,?,?,?,?)`);
insC.run('ckpt-1', 't-root',    'before refactor', 'abcdef1234567890', '/snap/1', 'READY',     1024 * 12,  now-1000, now-900);
insC.run('ckpt-2', 't-root',    'midway',          '0123456789abcdef', '/snap/2', 'CORRUPTED', 0,          now-500,  null);
insC.run('ckpt-3', 't-child-a', 'pre-block',       'fedcba9876543210', '/snap/3', 'PENDING',   1024 * 4,   now-600,  null);
// Anchor with no task — must NOT appear in queryTaskCheckpoints('t-root').
insC.run('ckpt-4', null,        'global anchor',   '99999999',         '/snap/4', 'READY',     2048,       now-300,  now-280);

const failures = [];
const check = (cond, msg) => { if (!cond) failures.push(msg); };

// ---- 1. Project-scoped tasks: hints = [HINT_A, HINT_B] -----------------
const PROJ_HINTS = [HINT_A, HINT_B];
const projTasks = projectQueries.queryProjectScopedTasks(db, TABLES, PROJ_HINTS);
check(projTasks.available === true, '1.available');
check(projTasks.hints_empty === false, '1.hints_empty=false');
check(projTasks.tasks.length === 4, `1.tasks.length expected 4, got ${projTasks.tasks.length}`);
const byId = new Map(projTasks.tasks.map(t => [t.task_id, t]));
check(!byId.has('t-orphan-root'), '1.orphan should be excluded by hint filter');

const root  = byId.get('t-root');
const cA    = byId.get('t-child-a');
const cB    = byId.get('t-child-b');
const grand = byId.get('t-grand');

check(root && root.checkpoints_total === 2, `1.root checkpoints_total expected 2, got ${root && root.checkpoints_total}`);
check(cA   && cA.blockers_open === 1 && cA.blockers_total === 2,
  `1.child-a blockers expected open=1 total=2, got open=${cA && cA.blockers_open} total=${cA && cA.blockers_total}`);
check(cA   && cA.checkpoints_total === 1, `1.child-a checkpoints_total expected 1, got ${cA && cA.checkpoints_total}`);
check(grand && grand.outcome_status === 'PASS', `1.grand outcome_status expected PASS, got ${grand && grand.outcome_status}`);
check(cB && cB.outcome_status === 'FAIL', `1.child-b outcome_status expected FAIL, got ${cB && cB.outcome_status}`);
check(root && root.outcome_status === 'PENDING', `1.root outcome_status expected PENDING, got ${root && root.outcome_status}`);

// ---- 2. No-hints empty state ------------------------------------------
const empty = projectQueries.queryProjectScopedTasks(db, TABLES, []);
check(empty.available === true, '2.available');
check(empty.hints_empty === true, '2.hints_empty=true');
check(empty.tasks.length === 0, '2.tasks should be []');

// ---- 3. Tree reconstruction (mirrors panel-side buildTaskTree) --------
const idSet = new Set(projTasks.tasks.map(t => t.task_id));
const childMap = new Map();
const roots = [];
for (const t of projTasks.tasks) {
  const p = t.parent_task_id;
  if (!p || !idSet.has(p)) roots.push(t);
  else {
    if (!childMap.has(p)) childMap.set(p, []);
    childMap.get(p).push(t);
  }
}
check(roots.length === 1 && roots[0].task_id === 't-root',
  `3.roots expected [t-root], got ${roots.map(r => r.task_id).join(',')}`);
check((childMap.get('t-root') || []).length === 2,
  `3.t-root children count expected 2, got ${(childMap.get('t-root')||[]).length}`);
check((childMap.get('t-child-a') || []).length === 1 &&
      (childMap.get('t-child-a') || [])[0].task_id === 't-grand',
  '3.t-child-a should have one child = t-grand');

// ---- 4. queryTaskCheckpoints: ordered, narrow shape ------------------
const ckptsRoot = queries.queryTaskCheckpoints(db, TABLES, 't-root');
check(ckptsRoot.length === 2, `4.t-root checkpoints expected 2, got ${ckptsRoot.length}`);
check(ckptsRoot[0].id === 'ckpt-1' || ckptsRoot[0].id === 'ckpt-2',
  '4.checkpoints should have known ids');
// ORDER: ckpt-1 has ready_at=now-900; ckpt-2 has only created_at=now-500.
// COALESCE(ready_at, created_at) DESC → ckpt-2 (now-500) > ckpt-1 (now-900).
check(ckptsRoot[0].id === 'ckpt-2',
  `4.first row should be ckpt-2 (newer COALESCE), got ${ckptsRoot[0].id}`);
const allowedKeys = new Set(['id','label','snapshot_status','git_head','size_bytes','created_at','ready_at']);
for (const c of ckptsRoot) {
  for (const k of Object.keys(c)) {
    check(allowedKeys.has(k), `4.unexpected column "${k}" in checkpoint row`);
  }
}
const ckptsChild = queries.queryTaskCheckpoints(db, TABLES, 't-child-a');
check(ckptsChild.length === 1 && ckptsChild[0].snapshot_status === 'PENDING',
  '4.t-child-a should have 1 PENDING checkpoint');
const ckptsOrphan = queries.queryTaskCheckpoints(db, TABLES, 't-orphan-root');
check(ckptsOrphan.length === 0, '4.t-orphan-root has no checkpoints');

// ---- 5. Run Log includes checkpoint.* events --------------------------
const events = queries.queryRunLogEvents(db, TABLES);
const ckptEvs = events.filter(e => e.source === 'checkpoints');
check(ckptEvs.length === 4, `5.checkpoint events expected 4, got ${ckptEvs.length}`);
check(ckptEvs.some(e => e.type === 'checkpoint.ready'),     '5.expected at least one checkpoint.ready');
check(ckptEvs.some(e => e.type === 'checkpoint.corrupted'), '5.expected at least one checkpoint.corrupted');
check(ckptEvs.some(e => e.type === 'checkpoint.pending'),   '5.expected at least one checkpoint.pending');

// ---- 6. SQLite mtime unchanged ----------------------------------------
const mtimeBefore = fs.statSync(dbPath).mtimeMs;
// Re-run a few queries to make sure none of them write.
projectQueries.queryProjectScopedTasks(db, TABLES, PROJ_HINTS);
queries.queryTaskCheckpoints(db, TABLES, 't-root');
queries.queryRunLogEvents(db, TABLES);
const mtimeAfter = fs.statSync(dbPath).mtimeMs;
check(mtimeBefore === mtimeAfter,
  `6.SQLite mtime changed during read-only flow (before=${mtimeBefore} after=${mtimeAfter})`);

db.close();
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

if (failures.length) {
  console.error('SMOKE FAIL:');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('SMOKE OK — Day 5 task-tree + checkpoints + run-log:');
console.log('  - project-scoped tasks:  4 of 5 (orphan filtered out)');
console.log('  - per-task aggregates:   blockers/outcome/checkpoints counts correct');
console.log('  - empty hints:           { available:true, hints_empty:true, tasks:[] }');
console.log('  - tree shape:            roots=[t-root], 2 children, 1 grandchild');
console.log('  - checkpoints query:     narrow column set, ORDER BY COALESCE DESC');
console.log('  - run log:               +4 checkpoint.* events with severity mapping');
console.log('  - read-only:             SQLite mtime unchanged across run');
