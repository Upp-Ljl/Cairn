#!/usr/bin/env node
/**
 * Real-Claude Review-Bind Dogfood — Three-Stage Loop / Day 4.
 *
 * Strategy: fixture-worker for the Worker round (no API spend, no
 * file ambiguity), real Claude Code for the Review round. The
 * dogfood validates that Claude can:
 *   - read the candidate description + Worker diff + Worker Report
 *   - emit a deterministic `## Review Verdict` block in the closed set
 *   - leave the temp repo byte-for-byte unchanged (review is read-only)
 *
 * Throwaway temp git repo (NOT agent-game-platform) — same blast-
 * radius pattern as Day 3.
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

const args = new Set(process.argv.slice(2));
const useRealHome = args.has('--use-real-home');
const POLL_MS = 1000;
const MAX_WAIT_MS = 240000;

let asserts = 0, fails = 0;
const failures = [];
function ok(c, l) { asserts++; if (c) console.log(`  ok    ${l}`); else { fails++; failures.push(l); console.log(`  FAIL  ${l}`); } }

if (!useRealHome) {
  const cairnTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-dogfood-rb-'));
  os.homedir = () => cairnTmp;
  fs.mkdirSync(path.join(cairnTmp, '.cairn'), { recursive: true });
  console.log(`(sandboxed Cairn writes: ${cairnTmp}; child inherits real HOME)`);
}

const handlers     = require(path.join(root, 'managed-loop-handlers.cjs'));
const launcher     = require(path.join(root, 'worker-launcher.cjs'));
const candidates   = require(path.join(root, 'project-candidates.cjs'));
const reviewPrompt = require(path.join(root, 'review-prompt.cjs'));

console.log('\n========================================');
console.log('  Cairn Real-Claude Review-Bind Dogfood (Day 4)');
console.log('========================================');

// -------- Build a throwaway target repo --------

const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-day4-target-'));
console.log(`Temp repo: ${tempRepo}`);
function git(args) { return spawnSync('git', args, { cwd: tempRepo, encoding: 'utf8' }); }
git(['init']);
git(['config', 'user.email', 'rb@example.local']);
git(['config', 'user.name', 'Cairn Day4 Dogfood']);
git(['checkout', '-b', 'main']);
fs.mkdirSync(path.join(tempRepo, 'src'));
fs.writeFileSync(path.join(tempRepo, 'package.json'), JSON.stringify({
  name: 'cairn-day4-target', version: '0.1.0',
}, null, 2));
fs.writeFileSync(path.join(tempRepo, 'package-lock.json'), '{}');
fs.writeFileSync(path.join(tempRepo, 'README.md'), '# cairn-day4-target\n\nThrowaway target.\n');
fs.writeFileSync(path.join(tempRepo, 'src', 'index.ts'),
  'export function hello() {\n  return "hello";\n}\n');
git(['add', '.']);
git(['commit', '-m', 'initial']);
const initialHead = git(['rev-parse', 'HEAD']).stdout.trim();
console.log(`  initial HEAD: ${initialHead}`);

// Detect real claude
const provs = launcher.detectWorkerProviders();
const claude = provs.find(p => p.id === 'claude-code');
ok(claude && claude.available, 'claude-code available');
if (!claude || !claude.available) {
  console.log('FAIL: claude-code not on PATH; aborting (cleaning up).');
  fs.rmSync(tempRepo, { recursive: true, force: true });
  process.exit(1);
}

// Register
const PID = 'p_dogfood_day4';
const reg = {
  projects: [{ id: PID, label: 'cairn-day4-target', project_root: tempRepo, db_path: '/dev/null', agent_id_hints: [] }],
};
ok(handlers.registerManagedProject(reg, PID, {}).ok, 'register temp repo as managed project');

// Seed a candidate.
const c = candidates.proposeCandidate(PID, {
  description: 'Add a JSDoc comment block to src/index.ts hello() explaining its return value.',
  candidate_kind: 'doc',
  source_iteration_id: 'i_seed', source_run_id: 'wr_seed',
});
ok(c.ok, 'seed candidate proposed');
console.log(`  candidate: ${c.candidate.id}`);

// Worker round = fixture-worker (no API, deterministic file write).
console.log('\n[worker] pickCandidateAndLaunchWorker(provider=fixture-worker)');
const wbRes = handlers.pickCandidateAndLaunchWorker(PID, {
  candidate_id: c.candidate.id, provider: 'fixture-worker',
});
ok(wbRes.ok, 'fixture-worker launched');
await new Promise(r => setTimeout(r, 1000));
const wbRun = handlers.getWorkerRun(wbRes.run_id);
ok(wbRun && wbRun.status === 'exited', `fixture-worker exited (${wbRun && wbRun.status})`);

// fixture-worker creates an untracked marker file. Stage with -N so
// `git diff` (Working tree vs HEAD) sees content for review.
git(['add', '-N', 'cairn-worker-fixture-touched.txt']);

// Worker Report extraction (so review prompt has it).
const wrep = handlers.extractManagedWorkerReport(PID, { run_id: wbRes.run_id });
ok(wrep.ok, 'worker report extracted');

// Snapshot working-tree state right before Review (post-Worker).
const preReviewHead   = git(['rev-parse', 'HEAD']).stdout.trim();
const preReviewStatus = git(['status', '--short']).stdout;
const preReviewDiff   = git(['diff', '--no-color']).stdout;
console.log('\n[pre-review state]');
console.log(`  HEAD:    ${preReviewHead}`);
console.log(`  status:  ${preReviewStatus.trim() || '(clean)'}`);
console.log(`  diff bytes: ${preReviewDiff.length}`);

// Review round = real claude-code.
console.log('\n[review] runReviewForCandidate(provider=claude-code)');
const t0 = Date.now();
const rbRes = handlers.runReviewForCandidate(PID, {
  candidate_id: c.candidate.id, provider: 'claude-code',
});
ok(rbRes.ok, `runReviewForCandidate ok (${rbRes.error || ''})`);
if (!rbRes.ok) {
  console.log('FAIL: review launch failed; cleaning up.');
  fs.rmSync(tempRepo, { recursive: true, force: true });
  process.exit(1);
}
console.log(`  review run_id:           ${rbRes.run_id}`);
console.log(`  review_iteration_id:     ${rbRes.review_iteration_id}`);
console.log(`  candidate_status:        ${rbRes.candidate_status}`);
ok(rbRes.candidate_status === 'REVIEWED', 'candidate_status returned REVIEWED');

// Poll until exit.
let final = null, stopped = false;
console.log('\n[poll] up to 4 min');
while ((Date.now() - t0) < MAX_WAIT_MS) {
  await new Promise(r => setTimeout(r, POLL_MS));
  final = handlers.getWorkerRun(rbRes.run_id);
  if (!final) break;
  if (final.status !== 'running' && final.status !== 'queued') break;
  process.stdout.write(`  · ${Math.floor((Date.now() - t0) / 1000)}s elapsed, status=${final.status}\r`);
}
if (!final) final = handlers.getWorkerRun(rbRes.run_id);
console.log('');
const elapsed = Math.floor((Date.now() - t0) / 1000);
if (final && (final.status === 'running' || final.status === 'queued')) {
  console.log(`  worker still running after ${elapsed}s — stopping`);
  handlers.stopWorkerRun(rbRes.run_id);
  await new Promise(r => setTimeout(r, 1000));
  final = handlers.getWorkerRun(rbRes.run_id);
  stopped = true;
}
console.log(`  elapsed: ${elapsed}s · status: ${final && final.status} · exit: ${final && final.exit_code}`);
ok(final && (final.status === 'exited' || final.status === 'failed' || final.status === 'stopped'),
   'review final status is terminal');

// Tail + secret leak grep
const tailRes = handlers.tailWorkerRun(rbRes.run_id, 16384);
ok(tailRes.ok && tailRes.text.length > 0, 'review tail non-empty');
const tail = tailRes.text;
console.log('\n[tail head]');
console.log(tail.split(/\r?\n/).slice(0, 6).map(l => '  | ' + l).join('\n'));
console.log('[tail end]');
console.log(tail.split(/\r?\n/).slice(-10).map(l => '  | ' + l).join('\n'));

const leaks = [
  ['ANTHROPIC_API_KEY', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['OpenAI sk-',         /\bsk-[A-Za-z0-9]{40,}\b/],
  ['GitHub PAT',         /\bghp_[A-Za-z0-9]{20,}\b/],
  ['Bearer header',      /Bearer\s+[A-Za-z0-9_\-\.]{30,}/],
];
for (const [name, rx] of leaks) ok(!rx.test(tail), `tail does NOT contain ${name}`);

// candidate id echo
ok(tail.includes('cairn-candidate-id: ' + c.candidate.id), 'tail echoes candidate id');

// Verdict extraction (handler).
const ev = handlers.extractReviewVerdict(PID, { candidate_id: c.candidate.id });
if (!ev.ok) {
  console.log(`  verdict extraction failed: ${ev.error}`);
  ok(false, `extractReviewVerdict failed: ${ev.error}`);
} else {
  ok(true, 'extractReviewVerdict ok');
  console.log(`  verdict: ${ev.verdict}`);
  console.log(`  reason:  ${ev.reason}`);
  ok(reviewPrompt.VERDICT_VALUES.includes(ev.verdict), 'verdict in closed set');
  ok(ev.reason && ev.reason.length > 0 && ev.reason.length <= 200, 'reason non-empty and ≤200');
}

// candidate state.
const cAfter = candidates.getCandidate(PID, c.candidate.id);
ok(cAfter.status === 'REVIEWED', 'candidate is REVIEWED');
ok(cAfter.review_iteration_id === rbRes.review_iteration_id, 'candidate.review_iteration_id stamped');

// Critical: review must NOT have changed the temp repo.
const postReviewHead   = git(['rev-parse', 'HEAD']).stdout.trim();
const postReviewStatus = git(['status', '--short']).stdout;
const postReviewDiff   = git(['diff', '--no-color']).stdout;
console.log('\n[post-review state]');
console.log(`  HEAD:    ${postReviewHead}`);
console.log(`  status:  ${postReviewStatus.trim() || '(clean)'}`);
console.log(`  diff bytes: ${postReviewDiff.length}`);

ok(preReviewHead === postReviewHead, 'review did not commit (HEAD unchanged)');
ok(preReviewStatus === postReviewStatus, 'review did not change working-tree status');
ok(preReviewDiff === postReviewDiff, 'review did not modify diff bytes');

// Cleanup.
console.log('\n[cleanup] removing temp repo');
let cleanupOk = true;
try { fs.rmSync(tempRepo, { recursive: true, force: true }); }
catch (e) { cleanupOk = false; console.log(`  cleanup error: ${e.message}`); }
ok(cleanupOk && !fs.existsSync(tempRepo), 'temp repo cleaned up');

console.log('\n========================================');
console.log(`  ${asserts - fails}/${asserts} assertions passed (${fails} failed)`);
if (stopped) console.log('  NOTE: review was stopped (timeout)');
console.log('========================================\n');

if (fails) { console.log('FAILURES:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }
