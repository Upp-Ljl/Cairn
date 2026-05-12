#!/usr/bin/env node
/**
 * smoke-cockpit-rewind.mjs — Phase 4 of panel-cockpit-redesign.
 *
 * Verifies the rewind path against a real disposable git repo:
 *
 *   - previewRewind returns checkpoint info + dirty state
 *   - performRewind handles the "clean tree" no-op case
 *   - performRewind handles the "dirty tree" stash-then-restore case
 *   - rejects missing git_head / not-a-git-repo / unknown checkpoint
 *   - records an auto-checkpoint row
 *
 * Builds a tmp git repo with 3 commits, inserts checkpoints
 * referencing 2 of them, then drives the rewind module against it.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dsRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(dsRoot, '..', '..');

const Database = require(path.join(repoRoot, 'packages', 'daemon', 'node_modules', 'better-sqlite3'));
const rewind = require(path.join(dsRoot, 'cockpit-rewind.cjs'));

let asserts = 0, fails = 0;
const failures = [];
function ok(c, l) {
  asserts++;
  if (c) process.stdout.write(`  ok    ${l}\n`);
  else   { fails++; failures.push(l); process.stdout.write(`  FAIL  ${l}\n`); }
}
function header(t) { process.stdout.write(`\n${'='.repeat(56)}\n${t}\n${'='.repeat(56)}\n`); }
function section(t) { process.stdout.write(`\n[${t}]\n`); }

header('smoke-cockpit-rewind — Phase 4');

// ---------------------------------------------------------------------------
// Set up a disposable git repo
// ---------------------------------------------------------------------------

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-rewind-smoke-'));
function gitR(args) {
  return spawnSync('git', args, {
    cwd: tmpRoot,
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, GIT_AUTHOR_NAME: 'smoke', GIT_AUTHOR_EMAIL: 's@s', GIT_COMMITTER_NAME: 'smoke', GIT_COMMITTER_EMAIL: 's@s' },
  });
}
gitR(['init', '-q']);
gitR(['config', 'commit.gpgsign', 'false']);
fs.writeFileSync(path.join(tmpRoot, 'a.txt'), 'first content\n');
gitR(['add', 'a.txt']);
gitR(['commit', '-q', '-m', 'first commit']);
const sha1 = gitR(['rev-parse', 'HEAD']).stdout.trim();

fs.writeFileSync(path.join(tmpRoot, 'a.txt'), 'second content\n');
gitR(['commit', '-aq', '-m', 'second commit']);
const sha2 = gitR(['rev-parse', 'HEAD']).stdout.trim();

fs.writeFileSync(path.join(tmpRoot, 'a.txt'), 'third content\n');
gitR(['commit', '-aq', '-m', 'third commit']);
const sha3 = gitR(['rev-parse', 'HEAD']).stdout.trim();

ok(sha1.length === 40 && sha2.length === 40 && sha3.length === 40, '3 commits created in tmp repo');

// ---------------------------------------------------------------------------
// Set up in-memory DB
// ---------------------------------------------------------------------------

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE checkpoints (
    id TEXT PRIMARY KEY, task_id TEXT, git_head TEXT,
    snapshot_status TEXT NOT NULL, created_at INTEGER NOT NULL, label TEXT
  );
`);
const tables = new Set(['checkpoints']);
const now = Date.now();
db.prepare(`INSERT INTO checkpoints (id, task_id, git_head, snapshot_status, created_at, label) VALUES (?, NULL, ?, 'READY', ?, ?)`).run('ck_first', sha1, now - 10000, 'first commit');
db.prepare(`INSERT INTO checkpoints (id, task_id, git_head, snapshot_status, created_at, label) VALUES (?, NULL, ?, 'READY', ?, ?)`).run('ck_second', sha2, now - 5000, 'second commit');
db.prepare(`INSERT INTO checkpoints (id, task_id, git_head, snapshot_status, created_at, label) VALUES (?, NULL, NULL, 'READY', ?, ?)`).run('ck_no_head', now - 2000, 'no git_head');
db.prepare(`INSERT INTO checkpoints (id, task_id, git_head, snapshot_status, created_at, label) VALUES (?, NULL, ?, 'PENDING', ?, ?)`).run('ck_pending', sha1, now - 1000, 'incomplete');

const PROJECT = { id: 'p_rewind_smoke', label: 'rewind smoke', project_root: tmpRoot, db_path: ':memory:' };

// ---------------------------------------------------------------------------
// Test 1 — preview against clean tree
// ---------------------------------------------------------------------------

section('1 preview against clean tree');
const p1 = rewind.previewRewind(db, tables, PROJECT, 'ck_first');
ok(p1.ok, 'preview ok');
ok(p1.checkpoint && p1.checkpoint.id === 'ck_first', 'echoes checkpoint');
ok(p1.git_head_reachable === true, 'git_head reachable');
ok(p1.head_matches === false, 'head does not match (we are at sha3)');
ok(p1.working_tree.dirty === false, 'working tree clean');

// ---------------------------------------------------------------------------
// Test 2 — preview rejects bad inputs
// ---------------------------------------------------------------------------

section('2 preview rejects bad inputs');
const p_unknown = rewind.previewRewind(db, tables, PROJECT, 'ck_does_not_exist');
ok(!p_unknown.ok && p_unknown.error === 'checkpoint_not_found', 'unknown checkpoint flagged');

const p_pending = rewind.previewRewind(db, tables, PROJECT, 'ck_pending');
ok(!p_pending.ok && p_pending.error === 'checkpoint_not_ready', 'PENDING ckpt rejected');

const p_no_head = rewind.previewRewind(db, tables, PROJECT, 'ck_no_head');
ok(!p_no_head.ok && p_no_head.error === 'no_git_head', 'missing git_head flagged');

const p_no_proj = rewind.previewRewind(db, tables, { project_root: '/tmp/does-not-exist-xxx' }, 'ck_first');
ok(!p_no_proj.ok && p_no_proj.error === 'not_a_git_repo', 'non-git-repo flagged');

// ---------------------------------------------------------------------------
// Test 3 — perform rewind on clean tree (sha3 → sha1)
// ---------------------------------------------------------------------------

section('3 perform rewind (clean tree: sha3 → sha1)');
const r1 = rewind.performRewind(db, tables, PROJECT, 'ck_first');
ok(r1.ok, 'rewind ok');
ok(r1.mode === 'checkout', `mode = checkout (got ${r1.mode})`);
const fileAfter1 = fs.readFileSync(path.join(tmpRoot, 'a.txt'), 'utf8').replace(/\r\n/g, '\n');
ok(fileAfter1 === 'first content\n', `a.txt content reverted to first (got ${JSON.stringify(fileAfter1)})`);
ok(r1.auto_checkpoint_id && r1.auto_checkpoint_id.startsWith('ck_auto_'), `auto-checkpoint id recorded`);
const autoRow = db.prepare('SELECT * FROM checkpoints WHERE id = ?').get(r1.auto_checkpoint_id);
ok(autoRow !== undefined, 'auto-checkpoint row exists');
ok(autoRow.git_head === sha3, 'auto-checkpoint records pre-rewind HEAD (sha3)');

// HEAD itself should NOT have moved (we used `git checkout <sha> -- .`).
const headAfter1 = gitR(['rev-parse', 'HEAD']).stdout.trim();
ok(headAfter1 === sha3, `HEAD ref unchanged after rewind (still at sha3)`);

// ---------------------------------------------------------------------------
// Test 4 — perform rewind with dirty tree (stash + restore)
// ---------------------------------------------------------------------------

section('4 perform rewind with dirty tree (stash path)');
fs.writeFileSync(path.join(tmpRoot, 'a.txt'), 'dirty content\n');
fs.writeFileSync(path.join(tmpRoot, 'untracked.txt'), 'new file\n');

const preview4 = rewind.previewRewind(db, tables, PROJECT, 'ck_second');
ok(preview4.working_tree.dirty === true, 'preview sees dirty tree');
ok(preview4.working_tree.total_changed >= 2, `≥2 dirty entries (got ${preview4.working_tree.total_changed})`);

const r2 = rewind.performRewind(db, tables, PROJECT, 'ck_second');
ok(r2.ok, 'dirty rewind ok');
ok(r2.stash_ref && r2.stash_ref.startsWith('stash@{'), `stash_ref recorded (got ${r2.stash_ref})`);
const fileAfter2 = fs.readFileSync(path.join(tmpRoot, 'a.txt'), 'utf8').replace(/\r\n/g, '\n');
ok(fileAfter2 === 'second content\n', `a.txt content matches sha2`);

// stash list has at least 1 entry from us.
const stashList = gitR(['stash', 'list']).stdout || '';
ok(stashList.includes('cairn-cockpit-rewind-'), 'stash list contains our safety stash');

// ---------------------------------------------------------------------------
// Test 5 — no-op when already at target with clean tree
// ---------------------------------------------------------------------------

section('5 no-op (already at target, clean tree)');
// First, restore tree fully by checking out sha3 then committing nothing.
gitR(['checkout', sha3, '--', '.']);
// Drop the untracked file we made earlier.
try { fs.unlinkSync(path.join(tmpRoot, 'untracked.txt')); } catch (_e) {}
// Tree should match sha3 again; head still at sha3.
// Insert a fresh ckpt at sha3 to test no-op.
db.prepare(`INSERT INTO checkpoints (id, task_id, git_head, snapshot_status, created_at, label) VALUES (?, NULL, ?, 'READY', ?, ?)`).run('ck_third', sha3, now, 'third commit');
const r_noop = rewind.performRewind(db, tables, PROJECT, 'ck_third');
ok(r_noop.ok, 'no-op ok');
ok(r_noop.mode === 'no-op', `mode = no-op (got ${r_noop.mode})`);

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

db.close();
try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_e) {}

header(`${asserts - fails}/${asserts} assertions passed (${fails} failed)`);
if (fails) {
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
  process.exit(1);
}
process.exit(0);
