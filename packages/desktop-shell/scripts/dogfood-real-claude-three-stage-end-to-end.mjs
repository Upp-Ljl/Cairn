#!/usr/bin/env node
/**
 * Three-Stage Loop v1 — final integration dogfood.
 *
 * Single throwaway repo, real Claude Code in all three stages:
 *
 *   1. Scout   (real claude-code) → propose candidates → pick one
 *   2. Worker  (real claude-code) → write actual diff
 *   3. Verify  (deterministic)    → boundary check
 *   4. Review  (real claude-code) → verdict
 *   5. Accept  (user click)       → ACCEPTED
 *
 * Estimated 4-6 minutes total runtime. Cost: 3 Claude API rounds.
 * Pre/post git probe + secret-leak grep + cleanup at the end.
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
  const cairnTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-dogfood-v1-final-'));
  os.homedir = () => cairnTmp;
  fs.mkdirSync(path.join(cairnTmp, '.cairn'), { recursive: true });
  console.log(`(sandboxed Cairn writes: ${cairnTmp})`);
}

const handlers     = require(path.join(root, 'managed-loop-handlers.cjs'));
const launcher     = require(path.join(root, 'worker-launcher.cjs'));
const candidates   = require(path.join(root, 'project-candidates.cjs'));
const scoutPrompt  = require(path.join(root, 'scout-prompt.cjs'));

console.log('\n=================================================');
console.log('  Cairn Three-Stage Loop v1 — final integration');
console.log('  Real Claude Code in Scout / Worker / Review');
console.log('=================================================');

// ---- Build target repo ----
const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-v1-target-'));
console.log(`Temp repo: ${tempRepo}`);
function git(args) { return spawnSync('git', args, { cwd: tempRepo, encoding: 'utf8' }); }
git(['init']);
git(['config', 'user.email', 'v1@example.local']);
git(['config', 'user.name', 'Cairn v1 Final']);
git(['checkout', '-b', 'main']);
fs.mkdirSync(path.join(tempRepo, 'src'));
fs.writeFileSync(path.join(tempRepo, 'package.json'), JSON.stringify({
  name: 'cairn-v1-final', version: '0.1.0',
}, null, 2));
fs.writeFileSync(path.join(tempRepo, 'package-lock.json'), '{}');
fs.writeFileSync(path.join(tempRepo, 'README.md'), '# cairn-v1-final\n\nA throwaway target with two functions.\n');
fs.writeFileSync(path.join(tempRepo, 'src', 'index.ts'),
  'export function hello() {\n  return "hello";\n}\n\n'
  + 'export function add(a: number, b: number): number {\n  return a + b;\n}\n');
git(['add', '.']);
git(['commit', '-m', 'initial']);

const initialHead = git(['rev-parse', 'HEAD']).stdout.trim();
console.log(`  initial HEAD: ${initialHead}`);

// claude available?
const provs = launcher.detectWorkerProviders();
const claude = provs.find(p => p.id === 'claude-code');
ok(claude && claude.available, 'claude-code available');
if (!claude || !claude.available) {
  fs.rmSync(tempRepo, { recursive: true, force: true });
  console.log('FAIL: claude-code not on PATH; aborting (cleaning up).');
  process.exit(1);
}

// Register
const PID = 'p_v1_final';
const reg = { projects: [{ id: PID, label: 'v1-final', project_root: tempRepo, db_path: '/dev/null', agent_id_hints: [] }] };
ok(handlers.registerManagedProject(reg, PID, {}).ok, 'register temp repo');

// =========================================================
// Stage 1 — SCOUT
// =========================================================
console.log('\n[1/4] SCOUT — real claude-code');
const goalScout = {
  id: 'g_v1_scout', title: 'Scout pass — propose candidates',
  desired_outcome: 'Up to 3 candidates the next round could pick up.',
  success_criteria: ['Output `## Scout Candidates` block'],
  non_goals: [],
};
const scoutIter = handlers.startManagedIteration(PID, { goal_id: 'g_v1_scout' });
const scoutPack = scoutPrompt.generateScoutPrompt({
  goal: goalScout, project_rules: { non_goals: [] }, recent_reports: [],
}, {
  managed_record: handlers.getManagedProjectProfile(PID),
  iteration_id: scoutIter.iteration.id, forceDeterministic: true,
});
const scoutLaunch = handlers.launchManagedWorker(PID, { provider: 'claude-code', prompt: scoutPack.prompt });
ok(scoutLaunch.ok, 'scout launch ok');
const scoutT0 = Date.now();
let scoutFinal = null;
while ((Date.now() - scoutT0) < MAX_WAIT_MS) {
  await new Promise(r => setTimeout(r, POLL_MS));
  scoutFinal = handlers.getWorkerRun(scoutLaunch.run_id);
  if (!scoutFinal || (scoutFinal.status !== 'running' && scoutFinal.status !== 'queued')) break;
  process.stdout.write(`  · scout ${Math.floor((Date.now() - scoutT0)/1000)}s\r`);
}
console.log('');
if (scoutFinal && (scoutFinal.status === 'running' || scoutFinal.status === 'queued')) {
  handlers.stopWorkerRun(scoutLaunch.run_id);
  scoutFinal = handlers.getWorkerRun(scoutLaunch.run_id);
}
console.log(`  scout exited in ${Math.floor((Date.now()-scoutT0)/1000)}s · status=${scoutFinal && scoutFinal.status}`);
ok(scoutFinal && scoutFinal.status === 'exited', 'scout exited cleanly');

const scoutExt = handlers.extractScoutCandidates(PID, { run_id: scoutLaunch.run_id });
ok(scoutExt.ok, `scout candidates extracted (${scoutExt.error || ''})`);
ok(scoutExt.candidates.length >= 1, `scout produced >=1 candidate (got ${scoutExt.candidates.length})`);
console.log(`  scout proposed ${scoutExt.candidates.length} candidate(s):`);
for (const c of scoutExt.candidates) console.log(`    [${c.kind}] ${c.description.slice(0, 100)}`);

// Pick the first candidate. (Real user picks via panel; we automate
// for the dogfood.)
const pickedId = scoutExt.candidate_ids[0];
ok(!!pickedId, 'have a candidate id to pick');
const pickedCand = candidates.getCandidate(PID, pickedId);
console.log(`  picking: [${pickedCand.candidate_kind}] ${pickedCand.description.slice(0, 100)}`);

// Sanity: post-Scout repo unchanged.
ok(git(['rev-parse', 'HEAD']).stdout.trim() === initialHead, 'post-Scout HEAD unchanged');
ok(git(['status', '--short']).stdout === '', 'post-Scout working tree clean');

// =========================================================
// Stage 2 — WORKER
// =========================================================
console.log('\n[2/4] WORKER — real claude-code');
const wbRes = handlers.pickCandidateAndLaunchWorker(PID, {
  candidate_id: pickedId, provider: 'claude-code',
});
ok(wbRes.ok, `worker launch ok (${wbRes.error || ''})`);
const workerT0 = Date.now();
let workerFinal = null;
while ((Date.now() - workerT0) < MAX_WAIT_MS) {
  await new Promise(r => setTimeout(r, POLL_MS));
  workerFinal = handlers.getWorkerRun(wbRes.run_id);
  if (!workerFinal || (workerFinal.status !== 'running' && workerFinal.status !== 'queued')) break;
  process.stdout.write(`  · worker ${Math.floor((Date.now() - workerT0)/1000)}s\r`);
}
console.log('');
if (workerFinal && (workerFinal.status === 'running' || workerFinal.status === 'queued')) {
  handlers.stopWorkerRun(wbRes.run_id);
  workerFinal = handlers.getWorkerRun(wbRes.run_id);
}
console.log(`  worker exited in ${Math.floor((Date.now()-workerT0)/1000)}s · status=${workerFinal && workerFinal.status}`);
ok(workerFinal && workerFinal.status === 'exited', 'worker exited cleanly');

const workerStatus = git(['status', '--short']).stdout;
const workerHead   = git(['rev-parse', 'HEAD']).stdout.trim();
console.log(`  post-worker HEAD: ${workerHead}`);
console.log(`  post-worker status:`);
workerStatus.split('\n').filter(Boolean).forEach(l => console.log(`    ${l}`));
ok(workerHead === initialHead, 'worker did not commit');

// Worker Report.
const wrep = handlers.extractManagedWorkerReport(PID, { run_id: wbRes.run_id });
ok(wrep.ok, 'worker report extracted');

// =========================================================
// Stage 3 — VERIFY (boundary)
// =========================================================
console.log('\n[3/4] VERIFY — boundary check');
// intent-to-add untracked files so collectGitEvidence sees them.
const allFiles = workerStatus.split('\n').filter(Boolean).map(l => l.replace(/^.{2}\s+/, '').trim());
if (allFiles.length) git(['add', '-N', ...allFiles]);
const verifyRes = handlers.verifyWorkerBoundary(PID, { candidate_id: pickedId });
ok(verifyRes.ok, `verify ok (${verifyRes.error || ''})`);
console.log(`  in_scope:      ${JSON.stringify(verifyRes.in_scope)}`);
console.log(`  out_of_scope:  ${JSON.stringify(verifyRes.out_of_scope)}`);
console.log(`  heuristic:     ${verifyRes.heuristic_notes}`);
const candAfterVerify = candidates.getCandidate(PID, pickedId);
ok(Array.isArray(candAfterVerify.boundary_violations),
   'candidate.boundary_violations is array post-verify');

// =========================================================
// Stage 4 — REVIEW
// =========================================================
console.log('\n[4/4] REVIEW — real claude-code');
const reviewRes = handlers.runReviewForCandidate(PID, {
  candidate_id: pickedId, provider: 'claude-code',
});
ok(reviewRes.ok, `review launch ok (${reviewRes.error || ''})`);
const reviewT0 = Date.now();
let reviewFinal = null;
while ((Date.now() - reviewT0) < MAX_WAIT_MS) {
  await new Promise(r => setTimeout(r, POLL_MS));
  reviewFinal = handlers.getWorkerRun(reviewRes.run_id);
  if (!reviewFinal || (reviewFinal.status !== 'running' && reviewFinal.status !== 'queued')) break;
  process.stdout.write(`  · review ${Math.floor((Date.now() - reviewT0)/1000)}s\r`);
}
console.log('');
if (reviewFinal && (reviewFinal.status === 'running' || reviewFinal.status === 'queued')) {
  handlers.stopWorkerRun(reviewRes.run_id);
  reviewFinal = handlers.getWorkerRun(reviewRes.run_id);
}
console.log(`  review exited in ${Math.floor((Date.now()-reviewT0)/1000)}s · status=${reviewFinal && reviewFinal.status}`);
ok(reviewFinal && reviewFinal.status === 'exited', 'review exited cleanly');

const verdict = handlers.extractReviewVerdict(PID, { candidate_id: pickedId });
ok(verdict.ok, `verdict extracted (${verdict.error || ''})`);
console.log(`  verdict: ${verdict.verdict}`);
console.log(`  reason:  ${verdict.reason}`);
ok(['pass','fail','needs_human'].includes(verdict.verdict), 'verdict in closed set');

// Tail secret-leak grep across all three runs.
for (const run of [scoutLaunch, wbRes, reviewRes]) {
  const tail = handlers.tailWorkerRun(run.run_id, 16384).text || '';
  ok(!/sk-ant-[A-Za-z0-9_-]{20,}/.test(tail), `${run.run_id}: no sk-ant leak`);
  ok(!/\bsk-[A-Za-z0-9]{40,}\b/.test(tail),   `${run.run_id}: no sk- leak`);
  ok(!/\bghp_[A-Za-z0-9]{20,}\b/.test(tail),  `${run.run_id}: no ghp_ leak`);
  ok(!/Bearer\s+[A-Za-z0-9_\-\.]{30,}/.test(tail), `${run.run_id}: no Bearer leak`);
}

// =========================================================
// Stage 5 — user clicks Accept (we automate for the dogfood)
// =========================================================
console.log('\n[final] Accept');
const acceptRes = handlers.acceptCandidate(PID, pickedId);
ok(acceptRes.ok && acceptRes.candidate.status === 'ACCEPTED',
   'acceptCandidate flips REVIEWED → ACCEPTED');
const final = candidates.getCandidate(PID, pickedId);
console.log(`  final candidate.status:           ${final.status}`);
console.log(`  final candidate.boundary_violations: ${JSON.stringify(final.boundary_violations)}`);
console.log(`  final candidate.worker_iteration_id: ${final.worker_iteration_id}`);
console.log(`  final candidate.review_iteration_id: ${final.review_iteration_id}`);

// Cleanup
console.log('\n[cleanup]');
let cleanupOk = true;
try { fs.rmSync(tempRepo, { recursive: true, force: true }); }
catch (e) { cleanupOk = false; console.log(`  cleanup error: ${e.message}`); }
ok(cleanupOk && !fs.existsSync(tempRepo), 'temp repo cleaned up');

console.log('\n=================================================');
console.log(`  ${asserts - fails}/${asserts} assertions passed (${fails} failed)`);
console.log('=================================================\n');

if (fails) { console.log('FAILURES:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }
