// Real Agent Presence v2 smoke — capability-tag-based project attribution.
//
// Validates:
//   1. Two distinct sessions in the same git_root attribute to one project,
//      not collapse into a single row.
//   2. resolveProjectAgentIds returns hints ∪ capability matches.
//   3. Sessions with non-matching capabilities go to Unassigned.
//   4. Path normalization (backslash / forward slash / case).
//   5. Historical tasks created by legacy project-level ids still
//      attribute via manually added hints.
//   6. Tasks created by new session-level ids attribute via the
//      capability-match path (no hint needed).
//   7. Cairn SQLite mtime unchanged across the run (read-only).

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-v2-smoke-'));
const dbPath = path.join(tmpDir, 'smoke.db');

const Database       = require(path.join(__dirname, '..', '..', 'daemon', 'node_modules', 'better-sqlite3'));
const projectQueries = require(path.join(__dirname, '..', 'project-queries.cjs'));

const db = new Database(dbPath);
db.exec(`
  CREATE TABLE processes (agent_id TEXT PRIMARY KEY, agent_type TEXT, capabilities TEXT,
    status TEXT, registered_at INTEGER, last_heartbeat INTEGER, heartbeat_ttl INTEGER);
  CREATE TABLE tasks (task_id TEXT PRIMARY KEY, parent_task_id TEXT, state TEXT, intent TEXT,
    created_at INTEGER, updated_at INTEGER, created_by_agent_id TEXT, metadata_json TEXT);
  CREATE TABLE blockers (blocker_id TEXT, task_id TEXT, status TEXT, raised_at INTEGER, answered_at INTEGER);
  CREATE TABLE outcomes (outcome_id TEXT, task_id TEXT, status TEXT, evaluated_at INTEGER, updated_at INTEGER);
  CREATE TABLE conflicts (id TEXT, agent_a TEXT, agent_b TEXT, status TEXT, detected_at INTEGER, resolved_at INTEGER);
  CREATE TABLE dispatch_requests (id TEXT, target_agent TEXT, task_id TEXT, status TEXT,
    created_at INTEGER, confirmed_at INTEGER);
  CREATE TABLE checkpoints (id TEXT, task_id TEXT, created_at INTEGER, ready_at INTEGER);
`);
const TABLES = new Set(['processes','tasks','blockers','outcomes','conflicts','dispatch_requests','checkpoints']);

const now = Date.now();
const TTL = 60_000;

// Project we'll attribute against. Use a forward-slash path to mirror
// what desktop-shell stores after canonicalizeToGitToplevel.
const PROJECT_ROOT = process.platform === 'win32'
  ? 'D:\\projects\\demo'
  : '/home/dev/demo';

// Two real v2 sessions in the same project (different agent_ids,
// matching capabilities). Capability tags are exactly what mcp-server
// presence emits in production.
function caps(extra = {}) {
  const cwd     = extra.cwd     ?? PROJECT_ROOT;
  const gitRoot = extra.gitRoot ?? PROJECT_ROOT;
  return JSON.stringify([
    'client:mcp-server',
    `cwd:${cwd}`,
    `git_root:${gitRoot}`,
    `pid:${extra.pid ?? 1234}`,
    `host:${extra.host ?? 'devbox'}`,
    `session:${extra.session ?? '000000000000'}`,
  ]);
}

const insP = db.prepare(`INSERT INTO processes
  (agent_id, agent_type, capabilities, status, registered_at, last_heartbeat, heartbeat_ttl)
  VALUES (?, ?, ?, ?, ?, ?, ?)`);

// Two new-style sessions in the project (different ids, same git_root):
const SESS_A = 'cairn-session-aaaaaaaaaaaa';
const SESS_B = 'cairn-session-bbbbbbbbbbbb';
insP.run(SESS_A, 'mcp-server', caps({ session: 'aaaaaaaaaaaa', pid: 1001 }), 'ACTIVE', now-10_000, now,             TTL);
insP.run(SESS_B, 'mcp-server', caps({ session: 'bbbbbbbbbbbb', pid: 1002 }), 'ACTIVE', now-5_000,  now-2_000,        TTL);

// One new-style session in a SUBDIRECTORY of the project (cwd inside,
// git_root still resolves to project_root → matches via either tag):
const SESS_SUB = 'cairn-session-ccccccccccc1';
const subdir   = process.platform === 'win32'
  ? PROJECT_ROOT + '\\packages\\sub'
  : PROJECT_ROOT + '/packages/sub';
insP.run(SESS_SUB, 'mcp-server', caps({ cwd: subdir, session: 'cccccccccccc', pid: 1003 }), 'ACTIVE', now-3_000, now-500, TTL);

// Session in a TOTALLY different project (should NOT match):
const SESS_OTHER = 'cairn-session-dddddddddddd';
insP.run(SESS_OTHER, 'mcp-server',
  caps({ cwd: '/elsewhere', gitRoot: '/elsewhere', session: 'dddddddddddd', pid: 1004 }),
  'ACTIVE', now-9_000, now-1_500, TTL);

// Legacy pre-v2 session row (no capabilities / wrong format) — must
// fall through to hint-based attribution if and only if the hint is
// added manually:
const LEGACY_ID = 'cairn-deadbeef0001';
insP.run(LEGACY_ID, 'mcp-server', null, 'ACTIVE', now-3_600_000, now-3_500_000, TTL);

// Session whose capabilities don't tag client/cwd/git_root — must NOT
// attribute via capability matching (just via explicit hint, if any):
const UNTAGGED = 'cairn-session-eeeeeeeeeeee';
insP.run(UNTAGGED, 'mcp-server', JSON.stringify(['scratch','rewind']),
  'ACTIVE', now-7_000, now-3_000, TTL);

// Tasks: some created by v2 sessions, some by legacy id, some unrelated.
const insT = db.prepare(`INSERT INTO tasks
  (task_id, parent_task_id, state, intent, created_at, updated_at, created_by_agent_id)
  VALUES (?, NULL, ?, ?, ?, ?, ?)`);
insT.run('t-A',     'RUNNING',  'session A task', now-1000, now, SESS_A);
insT.run('t-B',     'BLOCKED',  'session B task', now-2000, now, SESS_B);
insT.run('t-LEG',   'DONE',     'legacy task',    now-3000, now, LEGACY_ID);
insT.run('t-OTHER', 'PENDING',  'other proj',     now-1500, now, SESS_OTHER);

const failures = [];
const check = (cond, msg) => { if (!cond) failures.push(msg); };

// ---- 1. Path helpers ----------------------------------------------------
const norm = projectQueries.normalizePath;
if (process.platform === 'win32') {
  check(norm('D:\\Projects\\Demo') === 'd:/projects/demo',
    `1.normalize Win lowercase+slash: got ${norm('D:\\Projects\\Demo')}`);
  check(norm('D:/Projects/Demo/') === 'd:/projects/demo',
    `1.normalize trailing slash trim`);
} else {
  check(norm('/home/dev/demo/') === '/home/dev/demo', '1.normalize trailing slash trim');
  check(norm('/home/dev/demo') === '/home/dev/demo', '1.normalize identity');
}
check(projectQueries.pathInsideOrEqual(subdir, PROJECT_ROOT) === true,
  '1.pathInsideOrEqual: subdir of project_root → true');
check(projectQueries.pathInsideOrEqual(PROJECT_ROOT, PROJECT_ROOT) === true,
  '1.pathInsideOrEqual: identity → true');
check(projectQueries.pathInsideOrEqual('/elsewhere', PROJECT_ROOT) === false,
  '1.pathInsideOrEqual: different root → false');

// ---- 2. capabilitiesMatchProject ---------------------------------------
const matchCaps = c => projectQueries.capabilitiesMatchProject(JSON.parse(c), PROJECT_ROOT);
check(matchCaps(caps()) === true,                           '2.same git_root → match');
check(matchCaps(caps({ cwd: subdir })) === true,            '2.subdir cwd → match');
check(matchCaps(caps({ gitRoot: '/elsewhere', cwd: '/elsewhere' })) === false,
  '2.different project → no match');
check(projectQueries.capabilitiesMatchProject(['scratch','rewind'], PROJECT_ROOT) === false,
  '2.no tags → no match');
check(projectQueries.capabilitiesMatchProject(null, PROJECT_ROOT) === false,
  '2.null caps → no match');
check(projectQueries.capabilitiesMatchProject(JSON.parse(caps()), '(unknown)') === false,
  '2.(unknown) project_root → no match');

// ---- 3. resolveProjectAgentIds (no hints, capability-only) -------------
const project = { project_root: PROJECT_ROOT, db_path: dbPath, agent_id_hints: [] };
const ids = projectQueries.resolveProjectAgentIds(db, TABLES, project);
const idSet = new Set(ids);
check(idSet.has(SESS_A),     '3.resolves session A');
check(idSet.has(SESS_B),     '3.resolves session B');
check(idSet.has(SESS_SUB),   '3.resolves subdir session');
check(!idSet.has(SESS_OTHER),'3.does NOT resolve other-project session');
check(!idSet.has(LEGACY_ID), '3.does NOT auto-resolve legacy session (no caps tag, no hint)');
check(!idSet.has(UNTAGGED),  '3.does NOT resolve session with no attribution tags');

// ---- 4. resolveProjectAgentIds (hints + capability union) -------------
const projectWithHint = {
  project_root: PROJECT_ROOT, db_path: dbPath,
  agent_id_hints: [LEGACY_ID, UNTAGGED],
};
const ids2 = projectQueries.resolveProjectAgentIds(db, TABLES, projectWithHint);
const idSet2 = new Set(ids2);
check(idSet2.has(SESS_A) && idSet2.has(SESS_B) && idSet2.has(SESS_SUB),
  '4.union still includes capability-matched sessions');
check(idSet2.has(LEGACY_ID), '4.union includes manually hinted legacy id');
check(idSet2.has(UNTAGGED),  '4.union includes manually hinted untagged session');
check(!idSet2.has(SESS_OTHER), '4.other-project session still excluded');

// ---- 5. Tasks attribution after identity change -----------------------
// Project tasks query, called with the resolved agent ids:
const tasks = projectQueries.queryProjectScopedTasks(db, TABLES, ids2);
check(tasks.available === true && tasks.hints_empty === false,
  '5.tasks: available + hints_empty=false (hints+caps non-empty)');
const taskIds = new Set(tasks.tasks.map(t => t.task_id));
check(taskIds.has('t-A') && taskIds.has('t-B'), '5.v2 session tasks attributed via caps');
check(taskIds.has('t-LEG'), '5.legacy task attributed via manual hint');
check(!taskIds.has('t-OTHER'), '5.other-project task excluded');

// Empty hints + empty resolution:
const emptyProj = { project_root: '(unknown)', db_path: dbPath, agent_id_hints: [] };
const emptyIds = projectQueries.resolveProjectAgentIds(db, TABLES, emptyProj);
check(emptyIds.length === 0, '5.unknown project → empty resolved ids');

// ---- 6. Sessions tab returns multi-session rows -----------------------
const sess = projectQueries.queryProjectScopedSessions(db, TABLES, ids);
check(sess.available === true, '6.sessions available');
const sessIds = new Set(sess.sessions.map(s => s.agent_id));
check(sessIds.has(SESS_A) && sessIds.has(SESS_B) && sessIds.has(SESS_SUB),
  '6.three v2 sessions in one project, NOT collapsed');
check(sess.sessions.length === 3,
  `6.expected 3 sessions, got ${sess.sessions.length}`);

// ---- 7. Unassigned: per-DB attribution union --------------------------
const projects = [project]; // only the one project, no hints
const attributed = projectQueries.resolveAttributedAgentIdsForDb(db, TABLES, projects, dbPath);
const ua = projectQueries.queryUnassignedDetail(db, TABLES, dbPath, attributed);
const uaIds = new Set(ua.agents.map(a => a.agent_id));
// SESS_A, SESS_B, SESS_SUB were attributed → not in Unassigned.
check(!uaIds.has(SESS_A) && !uaIds.has(SESS_B) && !uaIds.has(SESS_SUB),
  '7.attributed v2 sessions excluded from Unassigned');
check(uaIds.has(SESS_OTHER), '7.other-project session is Unassigned');
check(uaIds.has(LEGACY_ID),  '7.legacy untagged session is Unassigned (no caps, no hint)');
check(uaIds.has(UNTAGGED),   '7.untagged-tags session is Unassigned');

// ---- 8. Read-only: SQLite mtime unchanged ------------------------------
const mtimeBefore = fs.statSync(dbPath).mtimeMs;
projectQueries.resolveProjectAgentIds(db, TABLES, projectWithHint);
projectQueries.queryProjectScopedSessions(db, TABLES, ids);
projectQueries.queryUnassignedDetail(db, TABLES, dbPath, attributed);
const mtimeAfter = fs.statSync(dbPath).mtimeMs;
check(mtimeBefore === mtimeAfter, `8.mtime unchanged: ${mtimeBefore} === ${mtimeAfter}`);

db.close();
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

if (failures.length) {
  console.error('SMOKE FAIL:');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('SMOKE OK — Real Agent Presence v2 attribution:');
console.log('  - normalizePath / pathInsideOrEqual: cross-platform OK');
console.log('  - capabilitiesMatchProject: git_root + cwd matching, both directions');
console.log('  - resolveProjectAgentIds: 3 v2 sessions + 0 legacy without hints');
console.log('  - resolveProjectAgentIds with hints: 3 v2 + 1 legacy + 1 untagged');
console.log('  - tasks attribution: v2 tasks via caps, legacy task via manual hint');
console.log('  - Sessions tab: 3 distinct rows for one project (NOT collapsed)');
console.log('  - Unassigned: includes other-project session + legacy + untagged');
console.log('  - read-only: SQLite mtime unchanged');
