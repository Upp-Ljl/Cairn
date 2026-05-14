#!/usr/bin/env node
/**
 * smoke-mode-b-suggester.mjs — MA-3 Mode B ranked suggestion heuristics.
 *
 * HOME sandboxed.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const _realHome = os.homedir();
const _realProjectsJson = path.join(_realHome, '.cairn', 'projects.json');
const _tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-modeb-smoke-'));
fs.mkdirSync(path.join(_tmpDir, '.cairn'), { recursive: true });
process.env.HOME = _tmpDir;
process.env.USERPROFILE = _tmpDir;
const _mtimeBefore = fs.existsSync(_realProjectsJson) ? fs.statSync(_realProjectsJson).mtimeMs : null;
process.on('exit', () => {
  const _mtimeAfter = fs.existsSync(_realProjectsJson) ? fs.statSync(_realProjectsJson).mtimeMs : null;
  if (_mtimeBefore !== _mtimeAfter) {
    console.error('FATAL: smoke wrote to REAL ~/.cairn/projects.json');
    process.exit(3);
  }
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dsRoot = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const modeB = require(path.join(dsRoot, 'mode-b-suggester.cjs'));
const Database = require(path.join(dsRoot, 'node_modules', 'better-sqlite3'));

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE scratchpad (
      key TEXT PRIMARY KEY,
      value_json TEXT,
      value_path TEXT,
      task_id TEXT,
      expires_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE tasks (
      task_id TEXT PRIMARY KEY,
      created_by_agent_id TEXT,
      state TEXT,
      updated_at INTEGER
    );
    CREATE TABLE outcomes (
      task_id TEXT,
      status TEXT,
      created_at INTEGER
    );
  `);
  return db;
}
function tableSet(db) {
  const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all();
  return new Set(rows.map(r => r.name));
}

let asserts = 0, fails = 0;
const failures = [];
function ok(c, l) {
  asserts++;
  if (c) process.stdout.write(`  ok    ${l}\n`);
  else { fails++; failures.push(l); process.stdout.write(`  FAIL  ${l}\n`); }
}
function header(t) { process.stdout.write(`\n${'='.repeat(64)}\n${t}\n${'='.repeat(64)}\n`); }
function section(t) { process.stdout.write(`\n[${t}]\n`); }

header('smoke-mode-b-suggester (MA-3)');

const project = { id: 'p_a' };

// ---------------------------------------------------------------------------
section('1 H1 running_task_overload fires at 2+ RUNNING');
{
  const tasks = [
    { task_id: 't1', state: 'RUNNING' },
    { task_id: 't2', state: 'RUNNING' },
  ];
  const r = modeB.suggestRunningOverload(tasks, project, 0);
  ok(!!r, 'fires at 2 RUNNING');
  ok(r.rule === 'H1', 'rule = H1');
  ok(r.priority === 2, `priority=2 (got ${r.priority})`);

  const r2 = modeB.suggestRunningOverload([{ state: 'RUNNING' }], project, 0);
  ok(r2 === null, 'does NOT fire at 1 RUNNING');
}

// ---------------------------------------------------------------------------
section('2 H2 outcomes_repeated_fail fires on ≥2 FAILED per task');
{
  const outcomes = [
    { task_id: 'tx', status: 'FAILED' },
    { task_id: 'tx', status: 'FAILED' },
    { task_id: 'ty', status: 'PASS' },
  ];
  const r = modeB.suggestRepeatedFailures(outcomes, project, 0);
  ok(!!r, 'fires on 2 FAILED for same task');
  ok(r.rule === 'H2', 'rule = H2');
  ok(r.task_id === 'tx', 'task_id surfaced');
  ok(r.priority === 3, 'priority=3 (work blocked)');
}

// ---------------------------------------------------------------------------
section('3 H3 running_task_stale fires after 30min');
{
  const now = 2_000_000_000;
  const tasks = [
    { task_id: 'old_running', state: 'RUNNING', updated_at: now - 31 * 60 * 1000 },
    { task_id: 'fresh_running', state: 'RUNNING', updated_at: now - 10 * 60 * 1000 },
  ];
  const r = modeB.suggestStaleRunning(tasks, project, now);
  ok(!!r, 'fires for stale RUNNING task');
  ok(r.task_id === 'old_running', `picked stalest (got ${r.task_id})`);
  ok(/分钟/.test(r.label), 'label mentions minutes');

  const fresh = modeB.suggestStaleRunning([{ task_id: 'f', state: 'RUNNING', updated_at: now - 5000 }], project, now);
  ok(fresh === null, 'does NOT fire for fresh task');
}

// ---------------------------------------------------------------------------
section('4 H4 agent_proposal_idle fires for >5min unrouted proposals');
{
  const now = 1000_000;
  const proposals = [
    { key: 'agent_proposal/a1/x', value: { ts: now - 6 * 60_000 } },
    { key: 'agent_proposal/a1/y', value: { ts: now - 10 * 60_000 } },
    // Dispatched one — should be excluded.
    { key: 'agent_proposal/a1/z', value: { ts: now - 60 * 60_000, dispatched_to: 'a_cc' } },
  ];
  const r = modeB.suggestIdleProposals(proposals, project, now);
  ok(!!r, 'fires on idle proposals');
  ok(/2 个/.test(r.label), `mentions count=2 (got ${r.label})`);
  ok(r.rule === 'H4', 'rule = H4');
}

// ---------------------------------------------------------------------------
section('5 rankSuggestions sorts by priority desc');
{
  const tasks = [
    { task_id: 't1', state: 'RUNNING', updated_at: 1 },
    { task_id: 't2', state: 'RUNNING', updated_at: 1 },
  ];
  const outcomes = [
    { task_id: 'tx', status: 'FAILED' },
    { task_id: 'tx', status: 'FAILED' },
  ];
  const all = modeB.rankSuggestions({ project, tasks, outcomes, proposals: [], nowFn: () => 1000 });
  ok(all.length === 2, `2 suggestions (got ${all.length})`);
  ok(all[0].priority >= all[1].priority, `sorted desc (${all[0].priority} >= ${all[1].priority})`);
  ok(all[0].rule === 'H2', 'highest priority is H2 (work blocked)');
}

// ---------------------------------------------------------------------------
section('6 persistSuggestions writes scratchpad row + is idempotent');
{
  const db = makeDb();
  const tasks = [
    { task_id: 't1', state: 'RUNNING' },
    { task_id: 't2', state: 'RUNNING' },
  ];
  const all = modeB.rankSuggestions({ project, tasks });
  const r1 = modeB.persistSuggestions(db, project, all);
  ok(r1.length === 1, '1 suggestion produced');
  ok(r1[0].action === 'added', `first persist: added (got ${r1[0].action})`);

  // Re-run same heuristic → signature collision → skipped.
  const r2 = modeB.persistSuggestions(db, project, all);
  ok(r2[0].action === 'skipped', `second persist: skipped (got ${r2[0].action})`);

  // Verify scratchpad row content.
  const rows = db.prepare(`SELECT key, value_json FROM scratchpad WHERE key LIKE 'mentor_todo/p_a/%'`).all();
  ok(rows.length === 1, `1 mentor_todo row persisted (got ${rows.length})`);
  const v = JSON.parse(rows[0].value_json);
  ok(v.source === 'mentor_todo', "source === 'mentor_todo' (panel routes by this)");
  ok(v.signature && v.signature.startsWith('running_task_overload:'), 'signature stored');
  ok(typeof v.priority === 'number', 'priority is number');
  ok(typeof v.ts === 'number', 'ts set');
}

// ---------------------------------------------------------------------------
section('7 persistSuggestions: once dispatched, signature can re-fire');
{
  const db = makeDb();
  const sigSugg = { signature: 'sig:x', label: 'do thing', priority: 1, rule: 'H?', why: 'test' };
  // First write.
  const r1 = modeB.persistSuggestions(db, project, [sigSugg]);
  ok(r1[0].action === 'added', 'added');

  // Manually flip dispatched_to (simulates user dispatching).
  const row = db.prepare(`SELECT key, value_json FROM scratchpad WHERE key LIKE 'mentor_todo/p_a/%'`).get();
  const val = JSON.parse(row.value_json);
  val.dispatched_to = 'a_cc';
  db.prepare(`UPDATE scratchpad SET value_json = ? WHERE key = ?`).run(JSON.stringify(val), row.key);

  // Second run: signature should NOT be in pending-set, so adds again.
  const r2 = modeB.persistSuggestions(db, project, [sigSugg]);
  ok(r2[0].action === 'added', `re-adds after dispatch (got ${r2[0].action})`);
  const rows = db.prepare(`SELECT key FROM scratchpad WHERE key LIKE 'mentor_todo/p_a/%'`).all();
  ok(rows.length === 2, `2 rows now (got ${rows.length})`);
}

// ---------------------------------------------------------------------------
section('8 runOnceForProject end-to-end: tick once, panel sees suggestions');
{
  const db = makeDb();
  // Seed: 2 RUNNING tasks → H1 fires.
  db.prepare(`INSERT INTO tasks (task_id, created_by_agent_id, state, updated_at) VALUES (?, ?, ?, ?)`)
    .run('t1', 'a_cc', 'RUNNING', Date.now());
  db.prepare(`INSERT INTO tasks (task_id, created_by_agent_id, state, updated_at) VALUES (?, ?, ?, ?)`)
    .run('t2', 'a_cc', 'RUNNING', Date.now());
  const tables = tableSet(db);
  const r = modeB.runOnceForProject({ db, tables, project, agentIds: ['a_cc'] });
  ok(r.action === 'ran', `action=ran (got ${r.action})`);
  ok(r.added === 1, `1 added (got ${r.added})`);

  // Tick again — idempotent.
  const r2 = modeB.runOnceForProject({ db, tables, project, agentIds: ['a_cc'] });
  ok(r2.skipped === 1, `2nd tick: 1 skipped (got ${r2.skipped})`);
  ok(r2.added === 0, '2nd tick: 0 added');
}

// ---------------------------------------------------------------------------
section('9 runOnceForProject: no hints → noop');
{
  const db = makeDb();
  const r = modeB.runOnceForProject({ db, tables: tableSet(db), project, agentIds: [] });
  ok(r.action === 'noop', `action=noop (got ${r.action})`);
}

// ---------------------------------------------------------------------------
section('10 runOnceForProject: missing tables tolerated');
{
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE scratchpad (
    key TEXT PRIMARY KEY, value_json TEXT, value_path TEXT, task_id TEXT,
    expires_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );`);
  const r = modeB.runOnceForProject({ db, tables: new Set(['scratchpad']), project, agentIds: ['a_cc'] });
  ok(r.action === 'ran', `action=ran even without tasks/outcomes tables (got ${r.action})`);
}

// ---------------------------------------------------------------------------
section('11 signatures are count-stable (subagent fixes A/H3)');
{
  // H1 — count fluctuation should NOT change signature.
  const h1a = modeB.suggestRunningOverload([{state:'RUNNING'},{state:'RUNNING'}], project, 0);
  const h1b = modeB.suggestRunningOverload([{state:'RUNNING'},{state:'RUNNING'},{state:'RUNNING'}], project, 0);
  ok(h1a.signature === h1b.signature, `H1 sig stable across 2→3 RUNNING (${h1a.signature} === ${h1b.signature})`);
  ok(!/[:](2|3)$/.test(h1a.signature), `H1 sig does NOT end with count (${h1a.signature})`);

  // H3 — minute drift should NOT change signature.
  const now = 1_000_000_000;
  const t = [{ task_id: 'stuck', state: 'RUNNING', updated_at: now - 31 * 60 * 1000 }];
  const h3a = modeB.suggestStaleRunning(t, project, now);
  const h3b = modeB.suggestStaleRunning(t, project, now + 60 * 1000); // 1 min later
  ok(h3a.signature === h3b.signature, `H3 sig stable across 1min drift (${h3a.signature})`);
  ok(!/:\d+$/.test(h3a.signature), `H3 sig does NOT end with minutes (${h3a.signature})`);

  // H4 — count change should NOT spawn new sig.
  const props2 = [{ value: { ts: 0 } }, { value: { ts: 0 } }];
  const props3 = [{ value: { ts: 0 } }, { value: { ts: 0 } }, { value: { ts: 0 } }];
  const h4a = modeB.suggestIdleProposals(props2, project, 600_000);
  const h4b = modeB.suggestIdleProposals(props3, project, 600_000);
  ok(h4a.signature === h4b.signature, `H4 sig stable across 2→3 proposals (${h4a.signature})`);
}

// ---------------------------------------------------------------------------
header(`${asserts - fails}/${asserts} assertions passed (${fails} failed)`);
if (fails) {
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
  process.exit(1);
}
process.exit(0);
