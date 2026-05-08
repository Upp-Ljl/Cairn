// Smoke for Project-Aware Day 2 patch fix #1:
// stale-only project must report health='warn' (not 'idle').
//
// Spins up a temp SQLite DB with the columns project-queries needs,
// inserts ONE ACTIVE process row whose heartbeat is well past
// ttl × STALE_GRACE_FACTOR, and asserts queryProjectScopedSummary
// reports agents_active=0, agents_stale=1, health='warn'.

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// desktop-shell's better-sqlite3 is compiled for Electron's Node ABI;
// the daemon copy is compiled for system Node, so use that for smoke.
const Database = require(path.join(__dirname, '..', '..', 'daemon', 'node_modules', 'better-sqlite3'));
const projectQueries = require(path.join(__dirname, '..', 'project-queries.cjs'));

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-stale-smoke-'));
const dbPath = path.join(tmpDir, 'smoke.db');
const db = new Database(dbPath);

db.exec(`
  CREATE TABLE processes (
    agent_id TEXT PRIMARY KEY,
    status TEXT,
    last_heartbeat INTEGER,
    heartbeat_ttl INTEGER
  );
  CREATE TABLE tasks (
    task_id TEXT PRIMARY KEY,
    state TEXT,
    updated_at INTEGER,
    created_by_agent_id TEXT
  );
  CREATE TABLE blockers (task_id TEXT, status TEXT, raised_at INTEGER, answered_at INTEGER);
  CREATE TABLE outcomes (task_id TEXT, status TEXT, evaluated_at INTEGER, updated_at INTEGER);
  CREATE TABLE conflicts (id INTEGER, agent_a TEXT, agent_b TEXT, status TEXT, detected_at INTEGER, resolved_at INTEGER);
  CREATE TABLE dispatch_requests (id INTEGER, target_agent TEXT, task_id TEXT, created_at INTEGER, confirmed_at INTEGER);
  CREATE TABLE checkpoints (id INTEGER, task_id TEXT, created_at INTEGER, ready_at INTEGER);
`);

const HINT = 'cairn-staletest1';
const now = Date.now();
const TTL = 60000;
const STALE_AGE = TTL * 5; // > ttl * STALE_GRACE_FACTOR (1.5)

db.prepare(`INSERT INTO processes (agent_id, status, last_heartbeat, heartbeat_ttl)
            VALUES (?, 'ACTIVE', ?, ?)`)
  .run(HINT, now - STALE_AGE, TTL);

const tables = new Set(['processes','tasks','blockers','outcomes','conflicts','dispatch_requests','checkpoints']);
const summary = projectQueries.queryProjectScopedSummary(db, tables, dbPath, [HINT]);

const failures = [];
if (summary.agents_active !== 0) failures.push(`agents_active expected 0, got ${summary.agents_active}`);
if (summary.agents_stale  !== 1) failures.push(`agents_stale  expected 1, got ${summary.agents_stale}`);
if (summary.health !== 'warn')  failures.push(`health expected 'warn', got '${summary.health}'`);

// Sanity: empty-hints path must remain idle (no false-positive warn).
const emptySummary = projectQueries.queryProjectScopedSummary(db, tables, dbPath, []);
if (emptySummary.health !== 'idle') failures.push(`empty-hints health expected 'idle', got '${emptySummary.health}'`);

// Sanity: a fresh active heartbeat must produce active=1, health=idle.
db.prepare(`UPDATE processes SET last_heartbeat = ? WHERE agent_id = ?`).run(now, HINT);
const liveSummary = projectQueries.queryProjectScopedSummary(db, tables, dbPath, [HINT]);
if (liveSummary.agents_active !== 1) failures.push(`live: agents_active expected 1, got ${liveSummary.agents_active}`);
if (liveSummary.agents_stale  !== 0) failures.push(`live: agents_stale  expected 0, got ${liveSummary.agents_stale}`);
if (liveSummary.health !== 'idle')  failures.push(`live: health expected 'idle', got '${liveSummary.health}'`);

db.close();
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

if (failures.length) {
  console.error('SMOKE FAIL:');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('SMOKE OK — stale-only project => health=warn; empty-hints => idle; live heartbeat => idle');
console.log(JSON.stringify({ stale: summary, empty: emptySummary, live: liveSummary }, null, 2));
