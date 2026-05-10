#!/usr/bin/env node
/**
 * Smoke for project-evidence.cjs — read-only git evidence collection.
 *
 * Builds an isolated git repo in a tmpdir, exercises the whitelist,
 * confirms output truncation, and re-asserts read-only invariants.
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

let asserts = 0, fails = 0;
const failures = [];
function ok(c, l) { asserts++; if (c) console.log(`  ok    ${l}`); else { fails++; failures.push(l); console.log(`  FAIL  ${l}`); } }

const realCairnDb = path.join(os.homedir(), '.cairn', 'cairn.db');
function safeMtime(p) { try { return fs.statSync(p).mtimeMs; } catch (_e) { return null; } }
const beforeCairn = safeMtime(realCairnDb);

const ev = require(path.join(root, 'project-evidence.cjs'));

// -------- Part A: whitelist enforcement (no git invocation needed)

ok(ev.isAllowedGitArgs(['status', '--short']), 'status --short is allowed');
ok(ev.isAllowedGitArgs(['rev-parse', 'HEAD']), 'rev-parse HEAD is allowed');
ok(!ev.isAllowedGitArgs(['push', 'origin', 'main']), 'push is NOT allowed');
ok(!ev.isAllowedGitArgs(['fetch']), 'fetch is NOT allowed');
ok(!ev.isAllowedGitArgs(['checkout', 'main']), 'checkout NOT allowed');
ok(!ev.isAllowedGitArgs(['reset', '--hard']), 'reset --hard NOT allowed');
ok(!ev.isAllowedGitArgs(['clean', '-f']), 'clean -f NOT allowed');
ok(!ev.isAllowedGitArgs(['stash']), 'stash NOT allowed');
ok(!ev.isAllowedGitArgs(['status', '--short', '--ignore-submodules']), 'flag smuggling NOT allowed');

// runGit with non-allowed argv must error before exec.
const denied = ev.runGit(['push', 'origin', 'main'], process.cwd());
ok(!denied.ok && denied.error === 'argv_not_allowed', 'runGit refuses non-allowed argv');

// -------- Part B: live fixture repo

const fix = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-evidence-'));
function git(args, opts) {
  return spawnSync('git', args, { cwd: fix, encoding: 'utf8', ...(opts || {}) });
}
git(['init']);
git(['config', 'user.email', 'smoke@example.com']);
git(['config', 'user.name', 'Smoke']);
git(['checkout', '-b', 'main']);
fs.writeFileSync(path.join(fix, 'README.md'), '# fixture\n');
git(['add', 'README.md']);
git(['commit', '-m', 'initial commit']);

// Add a dirty file so status reports it.
fs.writeFileSync(path.join(fix, 'changed.txt'), 'edits\n');
git(['add', 'changed.txt']);

const profile = {
  scripts_detected: [{ name: 'test', value: 'jest' }, { name: 'build', value: 'webpack' }],
  test_commands: ['npm run test'],
};
const e = ev.collectGitEvidence(fix, { profile });
ok(typeof e.git_head === 'string' && e.git_head.length === 40, 'git_head detected');
ok(e.git_short && e.git_short.length === 12, 'git_short truncated');
ok(e.branch === 'main', 'branch is main');
ok(e.dirty === true, 'dirty=true after staging');
ok(e.changed_files.includes('changed.txt'), 'changed_files lists changed.txt');
ok(e.last_commit && e.last_commit.subject === 'initial commit', 'last_commit subject correct');
ok(e.scripts_detected.length === 2, 'scripts_detected propagated from profile');
ok(e.tests_suggested.length > 0, 'tests_suggested non-empty');
ok(e.tests_run.length === 0, 'tests_run empty by default (no allow_run_tests)');
ok(Array.isArray(e.errors) && e.errors.length === 0, 'no errors on clean fixture');

// Summarize.
const sum = ev.summarizeEvidence(e);
ok(sum.dirty === true && sum.changed_file_count === 1, 'summarize compact shape');
ok(sum.tests_run_count === 0, 'summary tests_run_count zero');

// -------- Part C: missing local_path graceful

const missing = ev.collectGitEvidence(path.join(fix, 'no-such-dir'), { profile });
ok(missing.errors.includes('local_path_missing'), 'missing local_path error');
ok(missing.git_head === null, 'git_head null on missing path');

// -------- Part D: not-a-git-repo graceful

const notGit = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-not-git-'));
fs.writeFileSync(path.join(notGit, 'x.txt'), 'plain');
const ngEv = ev.collectGitEvidence(notGit, { profile });
ok(ngEv.errors.some(e => e.includes('not_a_git_repo')), 'not_a_git_repo error');
ok(ngEv.tests_suggested.length > 0, 'profile-derived suggestions still flow');

// -------- Part D2: collectWorkerDiff (Day 4 — full diff for review)

ok(ev.isAllowedGitArgs(['diff', '--no-color']), 'diff --no-color is in ALLOWED_GIT_ARGS');

// fixture repo currently has staged `changed.txt` (added) — git diff
// on staged-only changes returns empty; modify a tracked file instead
// to make the diff non-empty for the assertion.
fs.writeFileSync(path.join(fix, 'README.md'), '# fixture\n\nedited line\n');
const wd1 = ev.collectWorkerDiff(fix);
ok(wd1.ok, 'collectWorkerDiff ok on dirty repo');
ok(typeof wd1.diff_text === 'string' && wd1.diff_text.length > 0, 'diff_text non-empty for modified file');
ok(wd1.byte_count === wd1.diff_text.length, 'byte_count matches diff length');
ok(wd1.truncated === false, 'small diff is not truncated');

const wdMissing = ev.collectWorkerDiff(path.join(fix, 'no-such'));
ok(!wdMissing.ok && wdMissing.error === 'local_path_missing', 'collectWorkerDiff: missing path → local_path_missing');

const wdNotGit = ev.collectWorkerDiff(notGit);
ok(!wdNotGit.ok && wdNotGit.error === 'not_a_git_repo', 'collectWorkerDiff: not a git repo → not_a_git_repo');

// truncation flag — write a tracked file, then bloat it past 16KB.
import { spawnSync as _ssTrunc } from 'node:child_process';
const fixBig = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-evidence-big-'));
function gitBig(args) { return _ssTrunc('git', args, { cwd: fixBig, encoding: 'utf8' }); }
gitBig(['init']);
gitBig(['config', 'user.email', 'big@example.com']);
gitBig(['config', 'user.name', 'Big']);
gitBig(['checkout', '-b', 'main']);
fs.writeFileSync(path.join(fixBig, 'huge.txt'), 'x\n'.repeat(100));
gitBig(['add', '.']);
gitBig(['commit', '-m', 'init']);
fs.writeFileSync(path.join(fixBig, 'huge.txt'), 'y this is a long replacement line that makes diff bigger\n'.repeat(2000));
const wdBig = ev.collectWorkerDiff(fixBig);
ok(wdBig.ok, 'collectWorkerDiff ok on big diff');
ok(wdBig.truncated === true, 'big diff sets truncated=true');

// -------- Part E: source-level safety greps

const src = fs.readFileSync(path.join(root, 'project-evidence.cjs'), 'utf8');
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
ok(!/['"]push['"]/.test(code), 'no string literal "push" in code');
ok(!/['"]rebase['"]|['"]reset['"]|['"]clean['"]|['"]checkout['"]|['"]stash['"]/.test(code),
   'no destructive git verbs in code');
ok(!/cairn\.db/.test(code), 'no cairn.db ref in code');

// -------- Part F: read-only invariants

ok(safeMtime(realCairnDb) === beforeCairn, 'real cairn.db mtime unchanged');

console.log(`\n${asserts - fails}/${asserts} passed (${fails} failed)`);
if (fails) { console.log('FAILURES:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }
