#!/usr/bin/env node
/**
 * smoke-harness-gc.mjs — GC harness smoke test.
 *
 * Tests reapStaleProcesses and recoverOrphanedTasks against an in-memory
 * SQLite DB. Uses daemon's better-sqlite3 (compiled for Node 24, not Electron).
 *
 * HOME sandbox mandatory per registry-pollution lesson.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// ── HOME sandbox ──────────────────────────────────────────────────────────────
const _realHome = os.homedir();
const _realProjectsJson = path.join(_realHome, '.cairn', 'projects.json');
const _tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-harness-gc-smk-'));
fs.mkdirSync(path.join(_tmpDir, '.cairn'), { recursive: true });
process.env.HOME = _tmpDir;
process.env.USERPROFILE = _tmpDir;
const _mtimeBefore = fs.existsSync(_realProjectsJson)
  ? fs.statSync(_realProjectsJson).mtimeMs
  : null;
process.on('exit', () => {
  const _mtimeAfter = fs.existsSync(_realProjectsJson)
    ? fs.statSync(_realProjectsJson).mtimeMs
    : null;
  if (_mtimeBefore !== _mtimeAfter) {
    console.error('FATAL: smoke wrote to REAL ~/.cairn/projects.json');
    process.exit(3);
  }
});

// ── Module setup ──────────────────────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dsRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(dsRoot, '..', '..');
const require = createRequire(import.meta.url);

// Use daemon's better-sqlite3 — compiled for Node 24, not Electron.
const Database = require(
  path.resolve(repoRoot, 'packages', 'daemon', 'node_modules', 'better-sqlite3'),
);

const gc = require(path.join(dsRoot, 'harness-gc.cjs'));
const { reapStaleProcesses, recoverOrphanedTasks, DEFAULT_STALE_THRESHOLD_MS } = gc;

// ── Assertion helpers ─────────────────────────────────────────────────────────
let asserts = 0;
let fails = 0;
const failures = [];

function ok(cond, label) {
  asserts++;
  if (cond) {
    process.stdout.write(`  ok    ${label}\n`);
  } else {
    fails++;
    failures.push(label);
    process.stdout.write(`  FAIL  ${label}\n`);
  }
}

function header(t) {
  process.stdout.write(`\n${'='.repeat(64)}\n${t}\n${'='.repeat(64)}\n`);
}

function section(t) {
  process.stdout.write(`\n[${t}]\n`);
}

// ── DB factory ────────────────────────────────────────────────────────────────
function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE processes (
      agent_id        TEXT PRIMARY KEY,
      agent_type      TEXT,
      status          TEXT,
      capabilities    TEXT,
      registered_at   INTEGER,
      last_heartbeat  INTEGER,
      heartbeat_ttl   INTEGER
    );
    CREATE TABLE tasks (
      task_id             TEXT PRIMARY KEY,
      intent              TEXT,
      state               TEXT NOT NULL DEFAULT 'PENDING',
      parent_task_id      TEXT,
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL,
      created_by_agent_id TEXT,
      metadata_json       TEXT
    );
  `);
  return db;
}

// Helper: insert a process row.
function insertProcess(db, agent_id, status, last_heartbeat) {
  db.prepare(
    `INSERT INTO processes (agent_id, agent_type, status, registered_at, last_heartbeat, heartbeat_ttl)
     VALUES (?, 'test', ?, ?, ?, 60000)`,
  ).run(agent_id, status, Date.now(), last_heartbeat);
}

// Helper: insert a task row.
function insertTask(db, task_id, state, created_by_agent_id, metadata_json) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO tasks (task_id, intent, state, created_at, updated_at, created_by_agent_id, metadata_json)
     VALUES (?, 'test intent', ?, ?, ?, ?, ?)`,
  ).run(task_id, state, now, now, created_by_agent_id ?? null, metadata_json ?? null);
}

// Helper: get a process row.
function getProcess(db, agent_id) {
  return db.prepare('SELECT * FROM processes WHERE agent_id = ?').get(agent_id);
}

// Helper: get a task row.
function getTask(db, task_id) {
  return db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(task_id);
}

// ── Tests ─────────────────────────────────────────────────────────────────────
header('smoke-harness-gc');

// Sanity check exports
section('0 exports');
{
  ok(typeof reapStaleProcesses === 'function', 'reapStaleProcesses exported');
  ok(typeof recoverOrphanedTasks === 'function', 'recoverOrphanedTasks exported');
  ok(typeof DEFAULT_STALE_THRESHOLD_MS === 'number', 'DEFAULT_STALE_THRESHOLD_MS exported');
  ok(DEFAULT_STALE_THRESHOLD_MS === 5 * 60 * 1000, 'DEFAULT_STALE_THRESHOLD_MS is 5 min');
}

// ── reapStaleProcesses ────────────────────────────────────────────────────────
section('1 reapStaleProcesses: no ACTIVE rows → reaped=0');
{
  const db = makeDb();
  const r = reapStaleProcesses(db, { staleThresholdMs: 60_000, nowFn: () => Date.now() });
  ok(r.reaped === 0, 'reaped=0 on empty table');
  ok(Array.isArray(r.agent_ids) && r.agent_ids.length === 0, 'agent_ids=[]');
}

section('2 reapStaleProcesses: ACTIVE with fresh heartbeat → not reaped');
{
  const db = makeDb();
  const now = Date.now();
  insertProcess(db, 'agent-fresh', 'ACTIVE', now); // fresh
  const r = reapStaleProcesses(db, { staleThresholdMs: 60_000, nowFn: () => now });
  ok(r.reaped === 0, 'fresh agent not reaped');
  ok(getProcess(db, 'agent-fresh').status === 'ACTIVE', 'status still ACTIVE');
}

section('3 reapStaleProcesses: ACTIVE with stale heartbeat → reaped, status=STALE');
{
  const db = makeDb();
  const now = Date.now();
  const staleAt = now - 200_000; // 200s ago, threshold is 60s
  insertProcess(db, 'agent-stale', 'ACTIVE', staleAt);
  const r = reapStaleProcesses(db, { staleThresholdMs: 60_000, nowFn: () => now });
  ok(r.reaped === 1, 'reaped=1');
  ok(r.agent_ids.includes('agent-stale'), 'agent_ids includes stale agent');
  ok(getProcess(db, 'agent-stale').status === 'STALE', 'status updated to STALE');
}

section('4 reapStaleProcesses: mix of fresh + stale → only stale reaped');
{
  const db = makeDb();
  const now = Date.now();
  insertProcess(db, 'agent-a', 'ACTIVE', now - 10_000);  // fresh (10s ago)
  insertProcess(db, 'agent-b', 'ACTIVE', now - 120_000); // stale (120s ago)
  insertProcess(db, 'agent-c', 'ACTIVE', now - 5_000);   // fresh (5s ago)
  const r = reapStaleProcesses(db, { staleThresholdMs: 60_000, nowFn: () => now });
  ok(r.reaped === 1, 'only 1 reaped');
  ok(r.agent_ids.includes('agent-b'), 'stale agent in list');
  ok(!r.agent_ids.includes('agent-a'), 'fresh agent-a not in list');
  ok(!r.agent_ids.includes('agent-c'), 'fresh agent-c not in list');
  ok(getProcess(db, 'agent-a').status === 'ACTIVE', 'agent-a still ACTIVE');
  ok(getProcess(db, 'agent-b').status === 'STALE', 'agent-b now STALE');
  ok(getProcess(db, 'agent-c').status === 'ACTIVE', 'agent-c still ACTIVE');
}

section('5 reapStaleProcesses: already STALE → not double-reaped');
{
  const db = makeDb();
  const now = Date.now();
  insertProcess(db, 'agent-already-stale', 'STALE', now - 200_000);
  const r = reapStaleProcesses(db, { staleThresholdMs: 60_000, nowFn: () => now });
  ok(r.reaped === 0, 'already-STALE not counted again');
  ok(r.agent_ids.length === 0, 'agent_ids empty');
  ok(getProcess(db, 'agent-already-stale').status === 'STALE', 'remains STALE');
}

// ── recoverOrphanedTasks ──────────────────────────────────────────────────────
section('6 recoverOrphanedTasks: no RUNNING tasks → recovered=0');
{
  const db = makeDb();
  const r = recoverOrphanedTasks(db, { nowFn: () => Date.now() });
  ok(r.recovered === 0, 'recovered=0 on empty table');
  ok(Array.isArray(r.task_ids) && r.task_ids.length === 0, 'task_ids=[]');
}

section('7 recoverOrphanedTasks: RUNNING task with ACTIVE agent → not recovered');
{
  const db = makeDb();
  const now = Date.now();
  insertProcess(db, 'alive-agent', 'ACTIVE', now);
  insertTask(db, 'task-1', 'RUNNING', 'alive-agent');
  const r = recoverOrphanedTasks(db, { nowFn: () => now });
  ok(r.recovered === 0, 'task with ACTIVE agent not recovered');
  ok(getTask(db, 'task-1').state === 'RUNNING', 'task state unchanged');
}

section('8 recoverOrphanedTasks: RUNNING task with no matching process → recovered, state=FAILED');
{
  const db = makeDb();
  const now = Date.now();
  // No process row at all for 'ghost-agent'.
  insertTask(db, 'task-orphan', 'RUNNING', 'ghost-agent');
  const r = recoverOrphanedTasks(db, { nowFn: () => now });
  ok(r.recovered === 1, 'recovered=1');
  ok(r.task_ids.includes('task-orphan'), 'task_ids includes orphaned task');
  ok(getTask(db, 'task-orphan').state === 'FAILED', 'state updated to FAILED');
}

section('9 recoverOrphanedTasks: RUNNING task with STALE agent → recovered');
{
  const db = makeDb();
  const now = Date.now();
  insertProcess(db, 'stale-agent', 'STALE', now - 200_000);
  insertTask(db, 'task-stale-owner', 'RUNNING', 'stale-agent');
  const r = recoverOrphanedTasks(db, { nowFn: () => now });
  ok(r.recovered === 1, 'STALE agent counts as dead → recovered');
  ok(getTask(db, 'task-stale-owner').state === 'FAILED', 'state=FAILED');
}

section('10 recoverOrphanedTasks: DONE/PENDING tasks with dead agent → not touched');
{
  const db = makeDb();
  const now = Date.now();
  // No process row for 'dead-agent'.
  insertTask(db, 'task-done', 'DONE', 'dead-agent');
  insertTask(db, 'task-pending', 'PENDING', 'dead-agent');
  insertTask(db, 'task-cancelled', 'CANCELLED', 'dead-agent');
  const r = recoverOrphanedTasks(db, { nowFn: () => now });
  ok(r.recovered === 0, 'non-RUNNING tasks not touched');
  ok(getTask(db, 'task-done').state === 'DONE', 'DONE task unchanged');
  ok(getTask(db, 'task-pending').state === 'PENDING', 'PENDING task unchanged');
  ok(getTask(db, 'task-cancelled').state === 'CANCELLED', 'CANCELLED task unchanged');
}

section('11 recoverOrphanedTasks: metadata_json updated with gc_reason + gc_at');
{
  const db = makeDb();
  const now = 1_700_000_000_000;
  insertTask(db, 'task-meta', 'RUNNING', 'phantom-agent');
  const r = recoverOrphanedTasks(db, { nowFn: () => now });
  ok(r.recovered === 1, 'task recovered');
  const row = getTask(db, 'task-meta');
  const meta = JSON.parse(row.metadata_json);
  ok(meta.gc_reason === 'agent_dead', 'gc_reason = agent_dead');
  ok(meta.gc_at === now, 'gc_at = nowFn() value');
  ok(row.updated_at === now, 'updated_at set to nowFn()');
}

section('11b recoverOrphanedTasks: existing metadata_json is preserved + gc fields added');
{
  const db = makeDb();
  const now = Date.now();
  insertTask(db, 'task-with-meta', 'RUNNING', 'ghost2', JSON.stringify({ foo: 'bar', attempt: 3 }));
  recoverOrphanedTasks(db, { nowFn: () => now });
  const meta = JSON.parse(getTask(db, 'task-with-meta').metadata_json);
  ok(meta.foo === 'bar', 'pre-existing foo field preserved');
  ok(meta.attempt === 3, 'pre-existing attempt field preserved');
  ok(meta.gc_reason === 'agent_dead', 'gc_reason added');
}

section('12 Combined: reap then recover → both work together');
{
  const db = makeDb();
  const now = Date.now();

  // Active fresh agent — owns a RUNNING task (should NOT be recovered).
  insertProcess(db, 'fresh-a', 'ACTIVE', now - 5_000);
  insertTask(db, 'task-ok', 'RUNNING', 'fresh-a');

  // Stale agent (heartbeat 2h ago) — owns a RUNNING task.
  insertProcess(db, 'stale-b', 'ACTIVE', now - 7_200_000);
  insertTask(db, 'task-zombie', 'RUNNING', 'stale-b');

  // No-process agent — owns a RUNNING task (ghost).
  insertTask(db, 'task-ghost', 'RUNNING', 'no-such-agent');

  // Step 1: reap stale processes.
  const r1 = reapStaleProcesses(db, { staleThresholdMs: 60_000, nowFn: () => now });
  ok(r1.reaped === 1, 'combined: 1 process reaped');
  ok(r1.agent_ids.includes('stale-b'), 'combined: stale-b reaped');
  ok(getProcess(db, 'fresh-a').status === 'ACTIVE', 'combined: fresh-a still ACTIVE');

  // Step 2: recover orphaned tasks (stale-b is now STALE, no-such-agent absent).
  const r2 = recoverOrphanedTasks(db, { nowFn: () => now });
  ok(r2.recovered === 2, 'combined: 2 tasks recovered');
  ok(r2.task_ids.includes('task-zombie'), 'combined: zombie task recovered');
  ok(r2.task_ids.includes('task-ghost'), 'combined: ghost task recovered');
  ok(getTask(db, 'task-ok').state === 'RUNNING', 'combined: task-ok still RUNNING');
  ok(getTask(db, 'task-zombie').state === 'FAILED', 'combined: task-zombie FAILED');
  ok(getTask(db, 'task-ghost').state === 'FAILED', 'combined: task-ghost FAILED');
}

section('13 idempotency: run twice, same result');
{
  const db = makeDb();
  const now = Date.now();
  insertProcess(db, 'stale-idem', 'ACTIVE', now - 200_000);
  insertTask(db, 'task-idem', 'RUNNING', 'stale-idem');

  reapStaleProcesses(db, { staleThresholdMs: 60_000, nowFn: () => now });
  recoverOrphanedTasks(db, { nowFn: () => now });

  // Second pass should be a no-op.
  const r1b = reapStaleProcesses(db, { staleThresholdMs: 60_000, nowFn: () => now });
  const r2b = recoverOrphanedTasks(db, { nowFn: () => now });

  ok(r1b.reaped === 0, 'idempotent: reap second pass = 0');
  ok(r2b.recovered === 0, 'idempotent: recover second pass = 0');
  ok(getProcess(db, 'stale-idem').status === 'STALE', 'idempotent: status still STALE');
  ok(getTask(db, 'task-idem').state === 'FAILED', 'idempotent: state still FAILED');
}

// ── Summary ───────────────────────────────────────────────────────────────────
header('Results');
process.stdout.write(`\n${asserts} assertions, ${fails} failures\n`);
if (failures.length > 0) {
  process.stdout.write('\nFailed:\n');
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
}
process.stdout.write('\n');

process.exit(fails > 0 ? 1 : 0);
