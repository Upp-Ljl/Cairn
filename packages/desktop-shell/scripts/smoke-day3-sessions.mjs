// Day 3 smoke — Sessions tab + Unassigned drill-down + Add-to-project flow.
//
// What this exercises:
//   1. queryProjectScopedSessions returns the project's hint-attributed
//      processes rows with computed_state and owns_tasks bucket.
//   2. queryUnassignedDetail lists agents NOT in any project's hints,
//      together with parity counts (agents/tasks/blockers/...).
//   3. The addHint registry mutation moves an unassigned agent into
//      a target project: subsequent queries show count=−1 in Unassigned
//      and count=+1 in the project's session list.
//   4. The Cairn SQLite file mtime is unchanged across the entire run
//      (panel writes registry JSON, not the DB).
//
// All against a temp SQLite + temp registry JSON. Daemon copy of
// better-sqlite3 (system-Node ABI) since desktop-shell's is built for
// Electron.

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-day3-smoke-'));
const dbPath = path.join(tmpDir, 'smoke.db');

// Shim HOME so registry writes into our temp dir, not the real ~/.cairn.
// Must happen BEFORE requiring registry.cjs because that module captures
// REGISTRY_PATH = path.join(os.homedir(), '.cairn', 'projects.json') at
// module-load time.
const fakeHome = tmpDir;
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
const origHomedir = os.homedir;
os.homedir = () => fakeHome;
fs.mkdirSync(path.join(fakeHome, '.cairn'), { recursive: true });

const Database = require(path.join(__dirname, '..', '..', 'daemon', 'node_modules', 'better-sqlite3'));
const projectQueries = require(path.join(__dirname, '..', 'project-queries.cjs'));
const registry       = require(path.join(__dirname, '..', 'registry.cjs'));

const db = new Database(dbPath);

db.exec(`
  CREATE TABLE processes (
    agent_id TEXT PRIMARY KEY,
    agent_type TEXT,
    capabilities TEXT,
    status TEXT,
    registered_at INTEGER,
    last_heartbeat INTEGER,
    heartbeat_ttl INTEGER
  );
  CREATE TABLE tasks (
    task_id TEXT PRIMARY KEY,
    state TEXT,
    intent TEXT,
    parent_task_id TEXT,
    created_at INTEGER,
    updated_at INTEGER,
    created_by_agent_id TEXT
  );
  CREATE TABLE blockers (blocker_id TEXT, task_id TEXT, status TEXT, raised_at INTEGER, answered_at INTEGER);
  CREATE TABLE outcomes (outcome_id TEXT, task_id TEXT, status TEXT, evaluated_at INTEGER, updated_at INTEGER);
  CREATE TABLE conflicts (id TEXT, agent_a TEXT, agent_b TEXT, status TEXT, detected_at INTEGER, resolved_at INTEGER);
  CREATE TABLE dispatch_requests (id TEXT, target_agent TEXT, task_id TEXT, status TEXT, created_at INTEGER, confirmed_at INTEGER);
  CREATE TABLE checkpoints (id TEXT, task_id TEXT, created_at INTEGER, ready_at INTEGER);
`);

const now = Date.now();
const TTL = 60000;

// Two attributed agents (one ACTIVE, one STALE), two unassigned (one
// ACTIVE, one DEAD — DEAD is to confirm the OTHER bucket fires).
const insProc = db.prepare(`INSERT INTO processes
  (agent_id, agent_type, capabilities, status, registered_at, last_heartbeat, heartbeat_ttl)
  VALUES (?, ?, ?, ?, ?, ?, ?)`);
insProc.run('cairn-aaa-active',  'mcp-server', JSON.stringify(['fs','net']),  'ACTIVE', now - 10*1000, now,                 TTL);
insProc.run('cairn-bbb-stale',   'mcp-server', JSON.stringify(['fs']),         'ACTIVE', now - 600*1000, now - 5*TTL,        TTL);
insProc.run('cairn-ccc-orphan',  'aider',      JSON.stringify(['shell']),      'ACTIVE', now - 30*1000, now - 5*1000,        TTL);
insProc.run('cairn-ddd-dead',    'subagent',   null,                            'DEAD',   now - 3600*1000, now - 1800*1000,  TTL);

// Tasks owned by the agents (some attributed, one unassigned).
const insTask = db.prepare(`INSERT INTO tasks
  (task_id, state, intent, parent_task_id, created_at, updated_at, created_by_agent_id)
  VALUES (?, ?, ?, NULL, ?, ?, ?)`);
insTask.run('t1', 'RUNNING',        'do thing 1', now-1000, now, 'cairn-aaa-active');
insTask.run('t2', 'BLOCKED',        'do thing 2', now-2000, now, 'cairn-aaa-active');
insTask.run('t3', 'DONE',           'done',       now-3000, now, 'cairn-aaa-active');
insTask.run('t4', 'WAITING_REVIEW', 'review me',  now-1500, now, 'cairn-bbb-stale');
insTask.run('t5', 'FAILED',         'broke',      now-1500, now, 'cairn-bbb-stale');
insTask.run('t6', 'RUNNING',        'orphan run', now-500,  now, 'cairn-ccc-orphan');
insTask.run('t7', 'PENDING',        'no owner',   now-100,  now, null);

const TABLES = new Set(['processes','tasks','blockers','outcomes','conflicts','dispatch_requests','checkpoints']);

const failures = [];
function check(cond, msg) { if (!cond) failures.push(msg); }

// ---- 1. Project sessions -----------------------------------------------
const PROJ_HINTS = ['cairn-aaa-active', 'cairn-bbb-stale'];
const sessionsPayload = projectQueries.queryProjectScopedSessions(db, TABLES, PROJ_HINTS);
check(sessionsPayload.available === true, 'sessions: available=true expected');
check(sessionsPayload.sessions.length === 2, `sessions: expected 2 rows, got ${sessionsPayload.sessions.length}`);
const aaa = sessionsPayload.sessions.find(s => s.agent_id === 'cairn-aaa-active');
const bbb = sessionsPayload.sessions.find(s => s.agent_id === 'cairn-bbb-stale');
check(aaa && aaa.computed_state === 'ACTIVE', 'sessions: aaa should be ACTIVE');
check(bbb && bbb.computed_state === 'STALE',  'sessions: bbb should be STALE');
check(aaa && aaa.owns_tasks.RUNNING === 1 && aaa.owns_tasks.BLOCKED === 1 && aaa.owns_tasks.DONE === 1,
  `sessions: aaa owns_tasks wrong: ${JSON.stringify(aaa && aaa.owns_tasks)}`);
check(bbb && bbb.owns_tasks.WAITING_REVIEW === 1 && bbb.owns_tasks.FAILED === 1,
  `sessions: bbb owns_tasks wrong: ${JSON.stringify(bbb && bbb.owns_tasks)}`);
check(aaa && Array.isArray(aaa.capabilities) && aaa.capabilities.includes('fs'),
  'sessions: aaa capabilities should parse');

// Empty hints -> empty session list.
const emptySessions = projectQueries.queryProjectScopedSessions(db, TABLES, []);
check(emptySessions.sessions.length === 0, 'sessions: empty hints should yield zero sessions');

// ---- 2. Unassigned detail ----------------------------------------------
const allHints = new Set(PROJ_HINTS);
const ua = projectQueries.queryUnassignedDetail(db, TABLES, dbPath, allHints);
check(ua.available === true, 'unassigned: available=true expected');
check(ua.agents.length === 2, `unassigned: expected 2 agents, got ${ua.agents.length}`);
const ccc = ua.agents.find(a => a.agent_id === 'cairn-ccc-orphan');
const ddd = ua.agents.find(a => a.agent_id === 'cairn-ddd-dead');
check(ccc && ccc.computed_state === 'ACTIVE', 'unassigned: ccc should compute ACTIVE');
check(ddd && ddd.computed_state === 'DEAD',  'unassigned: ddd should compute DEAD');
check(ccc && ccc.owns_tasks.RUNNING === 1, 'unassigned: ccc owns_tasks.RUNNING expected 1');
check(ua.tasks === 2, `unassigned: expected 2 tasks (t6 + t7 with NULL owner), got ${ua.tasks}`);

// ---- 3. addHint mutation flow ------------------------------------------
const dbMtimeBefore = fs.statSync(dbPath).mtimeMs;

let reg = registry.loadRegistry();
const addRes = registry.addProject(reg, {
  project_root: '/fake/projA',
  db_path: dbPath,
  label: 'Project A',
  agent_id_hints: PROJ_HINTS,
});
reg = addRes.reg;
const projA = addRes.entry;

// Move ccc-orphan into Project A.
reg = registry.addHint(reg, projA.id, 'cairn-ccc-orphan');

// Re-query: ccc should now be in Project A's sessions, not Unassigned.
const newHints = reg.projects.find(p => p.id === projA.id).agent_id_hints;
const sessions2 = projectQueries.queryProjectScopedSessions(db, TABLES, newHints);
check(sessions2.sessions.some(s => s.agent_id === 'cairn-ccc-orphan'),
  'addHint: ccc should appear in project sessions after assignment');
check(sessions2.sessions.length === 3,
  `addHint: project sessions should be 3 after assigning ccc, got ${sessions2.sessions.length}`);

const allHints2 = new Set(newHints);
const ua2 = projectQueries.queryUnassignedDetail(db, TABLES, dbPath, allHints2);
check(!ua2.agents.some(a => a.agent_id === 'cairn-ccc-orphan'),
  'addHint: ccc should be gone from Unassigned');
check(ua2.agents.length === 1,
  `addHint: Unassigned agent count should be 1 after assignment, got ${ua2.agents.length}`);
check(ua2.tasks === 1, `addHint: unassigned tasks should drop to 1 (only NULL-owner left), got ${ua2.tasks}`);

// Idempotent re-add: hint count must NOT grow.
const before = reg.projects.find(p => p.id === projA.id).agent_id_hints.length;
reg = registry.addHint(reg, projA.id, 'cairn-ccc-orphan');
const after  = reg.projects.find(p => p.id === projA.id).agent_id_hints.length;
check(before === after, `addHint: idempotent re-add changed hint count ${before} -> ${after}`);

// ---- 4. SQLite file mtime unchanged across the whole flow --------------
const dbMtimeAfter = fs.statSync(dbPath).mtimeMs;
check(dbMtimeBefore === dbMtimeAfter,
  `read-only: SQLite mtime changed during flow (before=${dbMtimeBefore} after=${dbMtimeAfter})`);

// ---- 5. registry JSON exists where we expect ---------------------------
const regPath = path.join(fakeHome, '.cairn', 'projects.json');
check(fs.existsSync(regPath), `registry: ${regPath} should exist after addProject/addHint`);
if (fs.existsSync(regPath)) {
  const onDisk = JSON.parse(fs.readFileSync(regPath, 'utf8'));
  const proj = onDisk.projects.find(p => p.id === projA.id);
  check(proj && proj.agent_id_hints.includes('cairn-ccc-orphan'),
    'registry: persisted JSON should include the new hint');
}

// ---- cleanup ------------------------------------------------------------
db.close();
os.homedir = origHomedir;
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

if (failures.length) {
  console.error('SMOKE FAIL:');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('SMOKE OK — Day 3 sessions/unassigned/addHint flow:');
console.log('  - project sessions:    2 attributed (ACTIVE + STALE) with correct owns_tasks');
console.log('  - unassigned detail:   2 unassigned agents (ACTIVE orphan + DEAD)');
console.log('  - addHint flow:        ccc-orphan moved Unassigned→ProjectA, idempotent re-add');
console.log('  - read-only:           SQLite mtime unchanged across run');
console.log('  - registry persisted:  ~/.cairn/projects.json contains new hint');
