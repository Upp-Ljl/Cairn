#!/usr/bin/env node
/**
 * Smoke for Three-Stage Loop Day 5 — terminal user actions.
 *
 * Part A — accept/reject/rollback state-machine
 * Part B — reject's multiple legal entry points (PROPOSED/PICKED/WORKING/REVIEWED)
 * Part C — accept/rollback REVIEWED-only constraint
 * Part D — terminal states reject re-transition
 * Part E — IPC + preload exposure (incl. read accessors)
 * Part F — safety invariants
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
const beforeDb = safeMtime(realCairnDb);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-ts-actions-smoke-'));
os.homedir = () => tmpDir;
fs.mkdirSync(path.join(tmpDir, '.cairn'), { recursive: true });

const handlers     = require(path.join(root, 'managed-loop-handlers.cjs'));
const candidates   = require(path.join(root, 'project-candidates.cjs'));

function makeFixtureRepo() {
  const fix = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-ts-fix-'));
  function git(args) { return spawnSync('git', args, { cwd: fix, encoding: 'utf8' }); }
  git(['init']);
  git(['config', 'user.email', 'ts@example.com']);
  git(['config', 'user.name', 'ts']);
  git(['checkout', '-b', 'main']);
  fs.writeFileSync(path.join(fix, 'package.json'), JSON.stringify({ name: 'fix' }));
  fs.writeFileSync(path.join(fix, 'package-lock.json'), '{}');
  fs.writeFileSync(path.join(fix, 'README.md'), '# fix\n');
  git(['add', '.']);
  git(['commit', '-m', 'initial']);
  return fix;
}

const fix = makeFixtureRepo();
const PID = 'p_ts_smoke';
const reg = { projects: [{ id: PID, label: 'ts', project_root: fix, db_path: '/dev/null', agent_id_hints: [] }] };
handlers.registerManagedProject(reg, PID, {});

function freshProposed(label) {
  return candidates.proposeCandidate(PID, { description: label, candidate_kind: 'doc' }).candidate.id;
}

console.log('==> Part A: accept happy path');

// Walk a candidate to REVIEWED via fixture providers, then accept.
const cAcc = freshProposed('accept happy');
const wbA = handlers.pickCandidateAndLaunchWorker(PID, { candidate_id: cAcc, provider: 'fixture-worker' });
ok(wbA.ok, 'pick worker (accept-path) ok');
await new Promise(r => setTimeout(r, 1000));
spawnSync('git', ['add', '-N', 'cairn-worker-fixture-touched.txt'], { cwd: fix });
const rbA = handlers.runReviewForCandidate(PID, { candidate_id: cAcc, provider: 'fixture-review' });
ok(rbA.ok, 'review run ok');
await new Promise(r => setTimeout(r, 800));

const accept1 = handlers.acceptCandidate(PID, cAcc);
ok(accept1.ok, 'acceptCandidate(REVIEWED) ok');
ok(accept1.candidate.status === 'ACCEPTED', 'candidate is ACCEPTED');

// accept on a non-REVIEWED candidate → rejected
const cAccBad = freshProposed('accept on PROPOSED');
const acceptBad = handlers.acceptCandidate(PID, cAccBad);
ok(!acceptBad.ok && acceptBad.error === 'candidate_not_reviewed', 'accept on PROPOSED → candidate_not_reviewed');
ok(acceptBad.current_status === 'PROPOSED', 'detail.current_status correct');

// accept candidate_not_found
const acceptNF = handlers.acceptCandidate(PID, 'c_nope');
ok(!acceptNF.ok && acceptNF.error === 'candidate_not_found', 'accept: candidate_not_found');

console.log('\n==> Part B: reject multi-entry (PROPOSED/PICKED/WORKING/REVIEWED)');

// PROPOSED → REJECTED
const cP = freshProposed('reject from PROPOSED');
const rP = handlers.rejectCandidate(PID, cP);
ok(rP.ok && rP.candidate.status === 'REJECTED', 'reject from PROPOSED → REJECTED');

// PICKED → REJECTED — we synth via setCandidateStatus rather than running a real worker.
const cPicked = freshProposed('reject from PICKED');
candidates.setCandidateStatus(PID, cPicked, 'PICKED');
const rPicked = handlers.rejectCandidate(PID, cPicked);
ok(rPicked.ok && rPicked.candidate.status === 'REJECTED', 'reject from PICKED → REJECTED');

// WORKING → REJECTED — same approach (drive registry directly to WORKING).
const cWorking = freshProposed('reject from WORKING');
candidates.setCandidateStatus(PID, cWorking, 'PICKED');
candidates.bindWorkerIteration(PID, cWorking, 'i_synth_w');
const rW = handlers.rejectCandidate(PID, cWorking);
ok(rW.ok && rW.candidate.status === 'REJECTED', 'reject from WORKING → REJECTED');

// REVIEWED → REJECTED — drive to REVIEWED via the workflow.
const cR = freshProposed('reject from REVIEWED');
const wb = handlers.pickCandidateAndLaunchWorker(PID, { candidate_id: cR, provider: 'fixture-worker' });
ok(wb.ok, 'reviewed-path: worker launched');
await new Promise(r => setTimeout(r, 1000));
spawnSync('git', ['add', '-N', 'cairn-worker-fixture-touched.txt'], { cwd: fix });
const rb = handlers.runReviewForCandidate(PID, { candidate_id: cR, provider: 'fixture-review' });
ok(rb.ok, 'reviewed-path: review launched');
await new Promise(r => setTimeout(r, 800));
const rRev = handlers.rejectCandidate(PID, cR);
ok(rRev.ok && rRev.candidate.status === 'REJECTED', 'reject from REVIEWED → REJECTED');

// candidate_not_found
const rNF = handlers.rejectCandidate(PID, 'c_nope2');
ok(!rNF.ok && rNF.error === 'candidate_not_found', 'reject: candidate_not_found');

console.log('\n==> Part C: roll back REVIEWED-only');

// rollback only allowed from REVIEWED.
const cRB = freshProposed('rollback happy');
const wbR = handlers.pickCandidateAndLaunchWorker(PID, { candidate_id: cRB, provider: 'fixture-worker' });
ok(wbR.ok, 'rollback-path: worker launched');
await new Promise(r => setTimeout(r, 1000));
spawnSync('git', ['add', '-N', 'cairn-worker-fixture-touched.txt'], { cwd: fix });
const rbR = handlers.runReviewForCandidate(PID, { candidate_id: cRB, provider: 'fixture-review' });
ok(rbR.ok, 'rollback-path: review launched');
await new Promise(r => setTimeout(r, 800));

const roll1 = handlers.rollBackCandidate(PID, cRB);
ok(roll1.ok && roll1.candidate.status === 'ROLLED_BACK', 'rollBackCandidate(REVIEWED) ok');
ok(typeof roll1.hint === 'string' && /git checkout/i.test(roll1.hint), 'rollback returns manual-revert hint');

// rollback on PROPOSED → rejected
const cRBbad = freshProposed('rollback on PROPOSED');
const rollBad = handlers.rollBackCandidate(PID, cRBbad);
ok(!rollBad.ok && rollBad.error === 'candidate_not_reviewed', 'rollback on PROPOSED → candidate_not_reviewed');

// rollback on PICKED → also rejected (only REVIEWED allowed)
const cRBpicked = freshProposed('rollback on PICKED');
candidates.setCandidateStatus(PID, cRBpicked, 'PICKED');
const rollPickedBad = handlers.rollBackCandidate(PID, cRBpicked);
ok(!rollPickedBad.ok && rollPickedBad.error === 'candidate_not_reviewed', 'rollback on PICKED → candidate_not_reviewed');

console.log('\n==> Part D: terminal states reject re-transition');

// cAcc is ACCEPTED. Re-accept should fail.
const reAccept = handlers.acceptCandidate(PID, cAcc);
ok(!reAccept.ok && reAccept.error === 'candidate_not_reviewed',
   're-accept on already-ACCEPTED → candidate_not_reviewed (not REVIEWED any more)');

// reject on ACCEPTED → candidate_terminal
const rejAccepted = handlers.rejectCandidate(PID, cAcc);
ok(!rejAccepted.ok && rejAccepted.error === 'candidate_terminal',
   'reject on ACCEPTED → candidate_terminal');

// reject on REJECTED (cP) → candidate_terminal
const rejRej = handlers.rejectCandidate(PID, cP);
ok(!rejRej.ok && rejRej.error === 'candidate_terminal',
   'reject on REJECTED → candidate_terminal');

// rollback on ROLLED_BACK → candidate_not_reviewed (status no longer REVIEWED)
const rollRolled = handlers.rollBackCandidate(PID, cRB);
ok(!rollRolled.ok && rollRolled.error === 'candidate_not_reviewed',
   'rollback on ROLLED_BACK → candidate_not_reviewed');

console.log('\n==> Part D2: project_id_mismatch (forged row)');

// Forge a row whose stored project_id disagrees with file name.
const mismatchPid = 'p_mismatch_dst';
const candDir = path.join(tmpDir, '.cairn', 'project-candidates');
fs.mkdirSync(candDir, { recursive: true });
const forged = {
  id: 'c_forged', project_id: 'p_someone_else',
  source_iteration_id: null, source_run_id: null,
  description: 'forged', candidate_kind: 'doc', status: 'REVIEWED',
  worker_iteration_id: 'i_x', review_iteration_id: 'i_y',
  created_at: Date.now(), updated_at: Date.now(),
};
fs.writeFileSync(path.join(candDir, mismatchPid + '.jsonl'), JSON.stringify(forged) + '\n');
const accMis = handlers.acceptCandidate(mismatchPid, 'c_forged');
ok(!accMis.ok && accMis.error === 'project_id_mismatch', 'accept: project_id_mismatch');
const rejMis = handlers.rejectCandidate(mismatchPid, 'c_forged');
ok(!rejMis.ok && rejMis.error === 'project_id_mismatch', 'reject: project_id_mismatch');
const rolMis = handlers.rollBackCandidate(mismatchPid, 'c_forged');
ok(!rolMis.ok && rolMis.error === 'project_id_mismatch', 'rollback: project_id_mismatch');

console.log('\n==> Part D3: read-only accessors via handler module');

const list = handlers.listCandidates(PID, 50);
ok(Array.isArray(list) && list.length >= 5, 'listCandidates returns array of >=5 rows');
const byStatus = handlers.listCandidatesByStatus(PID, 'REJECTED');
ok(Array.isArray(byStatus) && byStatus.every(c => c.status === 'REJECTED'),
   'listCandidatesByStatus filters correctly');
const got = handlers.getCandidate(PID, cAcc);
ok(got && got.id === cAcc && got.status === 'ACCEPTED', 'getCandidate round-trips');
ok(handlers.listCandidates(null) instanceof Array && handlers.listCandidates(null).length === 0,
   'listCandidates(null) → []');
ok(handlers.getCandidate(null, null) === null, 'getCandidate(null) → null');

console.log('\n==> Part E: IPC + preload exposure');

const main = fs.readFileSync(path.join(root, 'main.cjs'), 'utf8');
ok(main.includes("'list-candidates'"), 'main.cjs registers list-candidates IPC');
ok(main.includes("'list-candidates-by-status'"), 'main.cjs registers list-candidates-by-status IPC');
ok(main.includes("'get-candidate'"), 'main.cjs registers get-candidate IPC');
ok(main.includes("'accept-candidate'"), 'main.cjs registers accept-candidate IPC (under MUTATIONS_ENABLED)');
ok(main.includes("'reject-candidate'"), 'main.cjs registers reject-candidate IPC');
ok(main.includes("'roll-back-candidate'"), 'main.cjs registers roll-back-candidate IPC');
// Mutations must be GATED by MUTATIONS_ENABLED in main.cjs.
const acceptIdx = main.indexOf("'accept-candidate'");
const muIdx = main.indexOf('if (MUTATIONS_ENABLED)');
ok(muIdx > 0 && acceptIdx > muIdx, "accept-candidate IPC sits inside `if (MUTATIONS_ENABLED)` block");

const preload = fs.readFileSync(path.join(root, 'preload.cjs'), 'utf8');
ok(/listCandidates:\s/.test(preload), 'preload exposes listCandidates');
ok(/listCandidatesByStatus:\s/.test(preload), 'preload exposes listCandidatesByStatus');
ok(/getCandidate:\s/.test(preload), 'preload exposes getCandidate');
// Mutations gated.
ok(/api\.acceptCandidate\s*=/.test(preload), 'preload exposes acceptCandidate (gated)');
ok(/api\.rejectCandidate\s*=/.test(preload), 'preload exposes rejectCandidate (gated)');
ok(/api\.rollBackCandidate\s*=/.test(preload), 'preload exposes rollBackCandidate (gated)');
const preloadMu = preload.indexOf('if (MUTATIONS_ENABLED)');
const preloadAccept = preload.indexOf('api.acceptCandidate');
ok(preloadMu > 0 && preloadAccept > preloadMu, 'acceptCandidate preload sits inside MUTATIONS_ENABLED block');

console.log('\n==> Part F: safety invariants');

ok(safeMtime(realCairnDb) === beforeDb, 'real ~/.cairn/cairn.db mtime unchanged');

console.log(`\n${asserts - fails}/${asserts} passed (${fails} failed)`);
if (fails) { console.log('FAILURES:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }
