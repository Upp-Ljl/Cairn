#!/usr/bin/env node
/**
 * Dogfood — Three-Stage Loop end-to-end with all fixture providers.
 *
 * No real LLM, no API spend. Walks three candidates through three
 * different terminal paths to prove the handler+IPC layer the
 * Inspector calls into is coherent:
 *
 *   Candidate A  PROPOSED -> PICKED -> WORKING -> REVIEWED -> ACCEPTED
 *   Candidate B  PROPOSED -> REJECTED                  (early abandon)
 *   Candidate C  PROPOSED -> PICKED -> WORKING -> REVIEWED -> ROLLED_BACK
 *
 * The whole loop runs against a throwaway temp git repo (per the
 * Day 3/4 mutation-blast-radius pattern). Cleanup at the end.
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

let asserts = 0, fails = 0;
const failures = [];
function ok(c, l) { asserts++; if (c) console.log(`  ok    ${l}`); else { fails++; failures.push(l); console.log(`  FAIL  ${l}`); } }

if (!useRealHome) {
  const cairnTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-dogfood-d5-'));
  os.homedir = () => cairnTmp;
  fs.mkdirSync(path.join(cairnTmp, '.cairn'), { recursive: true });
  console.log(`(sandboxed Cairn writes: ${cairnTmp})`);
}

const handlers   = require(path.join(root, 'managed-loop-handlers.cjs'));
const candidates = require(path.join(root, 'project-candidates.cjs'));
const launcher   = require(path.join(root, 'worker-launcher.cjs'));

console.log('\n========================================');
console.log('  Cairn Three-Stage Loop — Day 5 fixture E2E dogfood');
console.log('========================================');

// Build temp repo.
const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-d5-target-'));
console.log(`Temp repo: ${tempRepo}`);
function git(args) { return spawnSync('git', args, { cwd: tempRepo, encoding: 'utf8' }); }
git(['init']);
git(['config', 'user.email', 'd5@example.local']);
git(['config', 'user.name', 'Cairn Day5 Dogfood']);
git(['checkout', '-b', 'main']);
fs.mkdirSync(path.join(tempRepo, 'src'));
fs.writeFileSync(path.join(tempRepo, 'package.json'), JSON.stringify({ name: 'd5-target', version: '0.1.0' }, null, 2));
fs.writeFileSync(path.join(tempRepo, 'package-lock.json'), '{}');
fs.writeFileSync(path.join(tempRepo, 'README.md'), '# d5-target\n');
fs.writeFileSync(path.join(tempRepo, 'src', 'index.ts'), 'export function hi(){return "hi";}\n');
git(['add', '.']);
git(['commit', '-m', 'initial']);

const PID = 'p_dogfood_d5';
const reg = { projects: [{ id: PID, label: 'd5', project_root: tempRepo, db_path: '/dev/null', agent_id_hints: [] }] };
ok(handlers.registerManagedProject(reg, PID, {}).ok, 'register temp repo');

// Helper: drive PROPOSED → REVIEWED via fixture providers.
async function driveToReviewed(label) {
  const c = candidates.proposeCandidate(PID, { description: label, candidate_kind: 'other',
    source_iteration_id: 'i_seed', source_run_id: 'wr_seed' });
  ok(c.ok, `seed candidate "${label}"`);
  const wb = handlers.pickCandidateAndLaunchWorker(PID, { candidate_id: c.candidate.id, provider: 'fixture-worker' });
  ok(wb.ok, `pickCandidateAndLaunchWorker("${label}") ok`);
  await new Promise(r => setTimeout(r, 1000));
  // fixture-worker creates an untracked marker; intent-to-add it so the
  // working-tree diff is non-empty for the Review prompt.
  git(['add', '-N', 'cairn-worker-fixture-touched.txt']);
  const rb = handlers.runReviewForCandidate(PID, { candidate_id: c.candidate.id, provider: 'fixture-review' });
  ok(rb.ok, `runReviewForCandidate("${label}") ok`);
  await new Promise(r => setTimeout(r, 800));
  return c.candidate.id;
}

// ---- Path A: PROPOSED -> ... -> ACCEPTED (verdict=pass, then user clicks Accept)
console.log('\n[Path A] PROPOSED → ACCEPTED');
const cA = await driveToReviewed('A: accept path');
const verdictA = handlers.extractReviewVerdict(PID, { candidate_id: cA });
ok(verdictA.ok && verdictA.verdict === 'pass', 'fixture-review returned verdict=pass');
const cAStateBefore = candidates.getCandidate(PID, cA);
ok(cAStateBefore.status === 'REVIEWED', 'candidate is REVIEWED before user clicks Accept');
const accRes = handlers.acceptCandidate(PID, cA);
ok(accRes.ok && accRes.candidate.status === 'ACCEPTED', 'acceptCandidate flips to ACCEPTED');
const cAStateAfter = candidates.getCandidate(PID, cA);
ok(cAStateAfter.status === 'ACCEPTED', 'persisted: candidate is ACCEPTED');
ok(cAStateAfter.review_iteration_id === cAStateBefore.review_iteration_id,
   'review_iteration_id preserved through Accept');

// ---- Path B: PROPOSED -> REJECTED (user abandons early)
console.log('\n[Path B] PROPOSED → REJECTED (early)');
const cB = candidates.proposeCandidate(PID, { description: 'B: early-reject path', candidate_kind: 'doc' });
ok(cB.ok, 'B: seed candidate');
const cBState0 = candidates.getCandidate(PID, cB.candidate.id);
ok(cBState0.status === 'PROPOSED', 'B: candidate is PROPOSED before reject');
const rejRes = handlers.rejectCandidate(PID, cB.candidate.id);
ok(rejRes.ok && rejRes.candidate.status === 'REJECTED', 'B: rejectCandidate from PROPOSED ok');
const cBState1 = candidates.getCandidate(PID, cB.candidate.id);
ok(cBState1.status === 'REJECTED', 'B: persisted REJECTED');
ok(cBState1.worker_iteration_id == null && cBState1.review_iteration_id == null,
   'B: no iteration ids ever stamped (worker/review never ran)');

// ---- Path C: PROPOSED -> ... -> ROLLED_BACK (state-only; working tree retained)
console.log('\n[Path C] PROPOSED → ROLLED_BACK');
const cC = await driveToReviewed('C: rollback path');
// Snapshot temp repo state right before rollback so we can prove
// rollback is state-only and doesn't touch files.
const preRollHead   = git(['rev-parse', 'HEAD']).stdout.trim();
const preRollStatus = git(['status', '--short']).stdout;
const preRollDiff   = git(['diff', '--no-color']).stdout;
const rollRes = handlers.rollBackCandidate(PID, cC);
ok(rollRes.ok && rollRes.candidate.status === 'ROLLED_BACK', 'rollBackCandidate flips to ROLLED_BACK');
ok(rollRes.hint && /git checkout/i.test(rollRes.hint), 'rollback returns manual-revert hint');
const postRollHead   = git(['rev-parse', 'HEAD']).stdout.trim();
const postRollStatus = git(['status', '--short']).stdout;
const postRollDiff   = git(['diff', '--no-color']).stdout;
ok(preRollHead === postRollHead, 'rollback did not commit (HEAD unchanged)');
ok(preRollStatus === postRollStatus, 'rollback did not change working-tree status');
ok(preRollDiff === postRollDiff, 'rollback did not modify any file (worker diff retained)');
const cCState = candidates.getCandidate(PID, cC);
ok(cCState.status === 'ROLLED_BACK', 'persisted ROLLED_BACK');
ok(cCState.review_iteration_id, 'review_iteration_id preserved through Roll back');

// ---- Sanity: terminal-state re-transitions all rejected ----
console.log('\n[invariant] terminal states reject re-transition');
ok(!handlers.acceptCandidate(PID, cA).ok, 're-accept ACCEPTED is rejected');
ok(!handlers.rejectCandidate(PID, cA).ok, 'reject ACCEPTED is rejected (terminal)');
ok(!handlers.rollBackCandidate(PID, cB.candidate.id).ok, 'rollback REJECTED is rejected');
ok(!handlers.acceptCandidate(PID, cC).ok, 'accept ROLLED_BACK is rejected (not REVIEWED any more)');

// ---- listCandidates / listCandidatesByStatus reflect the three paths ----
console.log('\n[read accessors] post-walk shape');
const all = handlers.listCandidates(PID, 50);
ok(all.length === 3, `listCandidates returns 3 rows (got ${all.length})`);
const byAcc = handlers.listCandidatesByStatus(PID, 'ACCEPTED');
const byRej = handlers.listCandidatesByStatus(PID, 'REJECTED');
const byRoll = handlers.listCandidatesByStatus(PID, 'ROLLED_BACK');
ok(byAcc.length === 1 && byAcc[0].id === cA, 'listCandidatesByStatus(ACCEPTED) → [cA]');
ok(byRej.length === 1 && byRej[0].id === cB.candidate.id, 'listCandidatesByStatus(REJECTED) → [cB]');
ok(byRoll.length === 1 && byRoll[0].id === cC, 'listCandidatesByStatus(ROLLED_BACK) → [cC]');

// Cleanup
console.log('\n[cleanup]');
let cleanupOk = true;
try { fs.rmSync(tempRepo, { recursive: true, force: true }); }
catch (e) { cleanupOk = false; console.log(`  cleanup error: ${e.message}`); }
ok(cleanupOk && !fs.existsSync(tempRepo), 'temp repo cleaned up');

console.log('\n========================================');
console.log(`  ${asserts - fails}/${asserts} assertions passed (${fails} failed)`);
console.log('========================================\n');

if (fails) { console.log('FAILURES:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }
