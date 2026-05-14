#!/usr/bin/env node
/**
 * smoke-mode-a-session-store.mjs — Phase 2 session_id persistence.
 *
 * Scratchpad-backed (project_id, plan_id) → session_id store used by
 * Mode A to thread `--resume <id>` across plan steps.
 *
 * HOME sandbox per registry-pollution lesson.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const _realHome = os.homedir();
const _realProjectsJson = path.join(_realHome, '.cairn', 'projects.json');
const _tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-session-store-smk-'));
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
const sessionStore = require(path.join(dsRoot, 'mode-a-session-store.cjs'));
// Use daemon's better-sqlite3 — it's the one compiled for the Node we're
// running under (desktop-shell's build is for Electron). Smoke is
// schema-only, no Electron deps.
const repoRoot = path.resolve(dsRoot, '..', '..');
const Database = require(path.join(repoRoot, 'packages', 'daemon', 'node_modules', 'better-sqlite3'));

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
  `);
  return db;
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

header('smoke-mode-a-session-store (Phase 2)');

section('1 key shape');
{
  ok(sessionStore._key('p1', 'plan_x') === 'mode_a_session/p1/plan_x', 'key built correctly');
  ok(sessionStore._key('', 'plan_x') === null, 'empty project_id → null key');
  ok(sessionStore._key('p1', '') === null, 'empty plan_id → null key');
  ok(sessionStore._key(null, 'plan_x') === null, 'null project_id → null key');
  ok(sessionStore.PREFIX === 'mode_a_session/', 'PREFIX exported');
}

section('2 getSessionId on empty store returns null');
{
  const db = makeDb();
  ok(sessionStore.getSessionId(db, 'p1', 'plan_a') === null, 'absent → null');
  ok(sessionStore.getSessionId(null, 'p1', 'plan_a') === null, 'null db → null');
  ok(sessionStore.getSessionId(db, '', 'plan_a') === null, 'empty project → null');
}

section('3 setSessionId persists + getSessionId reads back');
{
  const db = makeDb();
  const r = sessionStore.setSessionId(db, 'p1', 'plan_a', 'sess_abc', 'wr_xyz', 1000);
  ok(r.ok === true, 'set returns ok');
  ok(r.key === 'mode_a_session/p1/plan_a', 'key returned');

  ok(sessionStore.getSessionId(db, 'p1', 'plan_a') === 'sess_abc', 'read back the session_id');

  const rec = sessionStore.getSessionRecord(db, 'p1', 'plan_a');
  ok(rec && rec.session_id === 'sess_abc', 'record session_id matches');
  ok(rec.run_id === 'wr_xyz', 'record run_id matches');
  ok(rec.plan_id === 'plan_a', 'record plan_id matches');
  ok(rec.captured_at === 1000, 'record captured_at matches');
  ok(rec._row_created_at === 1000, 'row created_at matches');
}

section('4 upsert semantics — second set replaces first');
{
  const db = makeDb();
  sessionStore.setSessionId(db, 'p1', 'plan_a', 'sess_v1', 'wr_1', 1000);
  sessionStore.setSessionId(db, 'p1', 'plan_a', 'sess_v2', 'wr_2', 2000);
  ok(sessionStore.getSessionId(db, 'p1', 'plan_a') === 'sess_v2', 'second value wins');
  const rec = sessionStore.getSessionRecord(db, 'p1', 'plan_a');
  ok(rec.captured_at === 2000, 'captured_at updated');
  ok(rec._row_updated_at === 2000, 'row updated_at refreshed');
  ok(rec._row_created_at === 1000, 'row created_at preserved (insert time)');

  // Verify only one row exists
  const count = db.prepare("SELECT COUNT(*) AS c FROM scratchpad WHERE key LIKE 'mode_a_session/%'").get().c;
  ok(count === 1, 'still one row after upsert (got ' + count + ')');
}

section('5 plan supersession isolation — different plan_id → different row');
{
  const db = makeDb();
  sessionStore.setSessionId(db, 'p1', 'plan_a', 'sess_for_a', 'wr_a', 1000);
  sessionStore.setSessionId(db, 'p1', 'plan_b', 'sess_for_b', 'wr_b', 2000);
  ok(sessionStore.getSessionId(db, 'p1', 'plan_a') === 'sess_for_a', 'plan_a unaffected by plan_b write');
  ok(sessionStore.getSessionId(db, 'p1', 'plan_b') === 'sess_for_b', 'plan_b row written');
  const count = db.prepare("SELECT COUNT(*) AS c FROM scratchpad WHERE key LIKE 'mode_a_session/%'").get().c;
  ok(count === 2, '2 distinct rows');
}

section('6 project isolation — different project_id → different row');
{
  const db = makeDb();
  sessionStore.setSessionId(db, 'p1', 'plan_a', 'sess_p1', 'wr_p1', 1000);
  sessionStore.setSessionId(db, 'p2', 'plan_a', 'sess_p2', 'wr_p2', 2000);
  ok(sessionStore.getSessionId(db, 'p1', 'plan_a') === 'sess_p1', 'p1 untouched');
  ok(sessionStore.getSessionId(db, 'p2', 'plan_a') === 'sess_p2', 'p2 row written');
}

section('7 input validation');
{
  const db = makeDb();
  ok(sessionStore.setSessionId(null, 'p1', 'plan_a', 'x', 'wr').error === 'db_required', 'null db rejected');
  ok(sessionStore.setSessionId(db, '', 'plan_a', 'x', 'wr').error === 'project_id_required', 'empty project_id rejected');
  ok(sessionStore.setSessionId(db, 'p1', '', 'x', 'wr').error === 'plan_id_required', 'empty plan_id rejected');
  ok(sessionStore.setSessionId(db, 'p1', 'plan_a', '', 'wr').error === 'session_id_required', 'empty session_id rejected');
  ok(sessionStore.setSessionId(db, 'p1', 'plan_a', 42, 'wr').error === 'session_id_required', 'non-string session_id rejected');
}

section('8 clearSessionId removes the row');
{
  const db = makeDb();
  sessionStore.setSessionId(db, 'p1', 'plan_a', 'sess_x', 'wr_x', 1000);
  ok(sessionStore.getSessionId(db, 'p1', 'plan_a') === 'sess_x', 'pre: row exists');
  const r = sessionStore.clearSessionId(db, 'p1', 'plan_a');
  ok(r.ok === true, 'clear returns ok');
  ok(r.deleted === 1, '1 row deleted');
  ok(sessionStore.getSessionId(db, 'p1', 'plan_a') === null, 'post: row gone');

  // Clearing absent row is harmless
  const r2 = sessionStore.clearSessionId(db, 'p1', 'plan_a');
  ok(r2.ok === true, 'clear on absent row returns ok');
  ok(r2.deleted === 0, '0 rows deleted on already-gone row');
}

section('9 malformed scratchpad row returns null (not throw)');
{
  const db = makeDb();
  // Write a bogus row directly
  db.prepare(`
    INSERT INTO scratchpad (key, value_json, value_path, task_id, expires_at, created_at, updated_at)
    VALUES (?, ?, NULL, NULL, NULL, ?, ?)
  `).run('mode_a_session/p1/plan_a', 'not-valid-json{', 1000, 1000);
  ok(sessionStore.getSessionId(db, 'p1', 'plan_a') === null, 'malformed JSON → null (no throw)');

  // Write a row without session_id field
  db.prepare(`
    UPDATE scratchpad SET value_json = ? WHERE key = ?
  `).run(JSON.stringify({ other: 'data' }), 'mode_a_session/p1/plan_a');
  ok(sessionStore.getSessionId(db, 'p1', 'plan_a') === null, 'row without session_id → null');
}

header(`${asserts - fails}/${asserts} assertions passed (${fails} failed)`);
if (fails) {
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
  process.exit(1);
}
process.exit(0);
