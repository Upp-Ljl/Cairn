#!/usr/bin/env node
/**
 * Smoke for Three-Stage Loop Day 4 — Review Bind.
 *
 * Part A — generateReviewPrompt unit
 * Part B — extractReviewVerdictFromText parse matrix
 * Part C — runReviewForCandidate state-machine (fixture-review)
 * Part D — extractReviewVerdict (handler) two entry points
 * Part E — IPC + preload exposure
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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-review-bind-smoke-'));
os.homedir = () => tmpDir;
fs.mkdirSync(path.join(tmpDir, '.cairn'), { recursive: true });

const handlers     = require(path.join(root, 'managed-loop-handlers.cjs'));
const launcher     = require(path.join(root, 'worker-launcher.cjs'));
const candidates   = require(path.join(root, 'project-candidates.cjs'));
const reviewPrompt = require(path.join(root, 'review-prompt.cjs'));

console.log('==> Part A: generateReviewPrompt unit');

const sampleReport = {
  completed: ['added comment to src/index.ts'],
  remaining: ['(none)'],
  blockers:  [],
  next_steps: ['nothing'],
};
const samplePack = reviewPrompt.generateReviewPrompt({
  goal: { id: 'g', title: 'Smoke review', desired_outcome: '' },
  project_rules: { non_goals: [] },
  recent_reports: [],
}, {
  candidate: {
    id: 'c_rev_aaa',
    description: 'Add a JSDoc to hello() in src/index.ts',
    candidate_kind: 'doc',
  },
  worker_diff_text: 'diff --git a/src/index.ts b/src/index.ts\n+/** says hello */\n',
  worker_diff_truncated: false,
  worker_report: sampleReport,
  managed_record: null,
  forceDeterministic: true,
});

ok(samplePack.is_review === true && samplePack.mode === 'review', 'pack tagged is_review=true / mode=review');
ok(samplePack.candidate_id === 'c_rev_aaa', 'candidate_id surfaced');
ok(samplePack.prompt.includes('c_rev_aaa'), 'candidate id in prompt body');
ok(samplePack.prompt.includes('cairn-candidate-id: c_rev_aaa'), 'cairn-candidate-id echo line in prompt');
ok(samplePack.prompt.includes('Add a JSDoc to hello()'), 'candidate description in prompt');
ok(samplePack.prompt.includes('diff --git a/src/index.ts'), 'worker_diff_text embedded');
ok(samplePack.prompt.includes('added comment to src/index.ts'), 'worker_report Completed embedded');

const truncatedPack = reviewPrompt.generateReviewPrompt({}, {
  candidate: { id: 'c_t', description: 'd', candidate_kind: 'doc' },
  worker_diff_text: 'diff content',
  worker_diff_truncated: true,
  worker_report: null,
  managed_record: null,
  forceDeterministic: true,
});
ok(truncatedPack.prompt.includes('[NOTE: diff truncated to 16KB'), 'truncated note appears when worker_diff_truncated=true');
ok(truncatedPack.prompt.includes('(no Worker Report attached'), 'null worker_report renders fallback');

ok(samplePack.prompt.includes(reviewPrompt.REVIEW_VERDICT_HEADER), 'REVIEW_VERDICT_HEADER appears in prompt');
ok(reviewPrompt.REVIEW_VERDICT_HEADER === '## Review Verdict', 'REVIEW_VERDICT_HEADER literal');
ok(JSON.stringify(reviewPrompt.VERDICT_VALUES) === JSON.stringify(['pass', 'fail', 'needs_human']),
   'VERDICT_VALUES is the closed set');
for (const v of reviewPrompt.VERDICT_VALUES) {
  ok(samplePack.prompt.includes('`' + v + '`'), `verdict value "${v}" mentioned in hard-rules`);
}

// Review must NOT include encouragement to commit/push.
ok(!/please commit|please push|run git push|run git commit/i.test(samplePack.prompt),
   'no commit/push encouragement in review prompt');

// Missing required inputs throw.
let threw = false;
try { reviewPrompt.generateReviewPrompt({}, { worker_diff_text: '' }); } catch (_e) { threw = true; }
ok(threw, 'missing candidate throws');
threw = false;
try { reviewPrompt.generateReviewPrompt({}, { candidate: { id: 'x', description: 'y' } }); } catch (_e) { threw = true; }
ok(threw, 'missing worker_diff_text throws');

console.log('\n==> Part B: extractReviewVerdictFromText parse matrix');

function block(verdict, reason, withId) {
  const lines = ['## Review Verdict'];
  if (withId) lines.push('cairn-candidate-id: c_xyz');
  if (verdict !== undefined) lines.push('verdict: ' + verdict);
  if (reason !== undefined) lines.push('reason: ' + reason);
  return lines.join('\n');
}

const e1 = launcher.extractReviewVerdictFromText(block('pass', 'looks ok', true));
ok(e1.ok && e1.verdict === 'pass' && e1.reason === 'looks ok', 'parse: pass + reason');

const e2 = launcher.extractReviewVerdictFromText(block('fail', 'broken', true));
ok(e2.ok && e2.verdict === 'fail', 'parse: fail');

const e3 = launcher.extractReviewVerdictFromText(block('needs_human', 'unclear', true));
ok(e3.ok && e3.verdict === 'needs_human', 'parse: needs_human');

const e4 = launcher.extractReviewVerdictFromText(block('PASS', 'r', true));
ok(e4.ok && e4.verdict === 'pass', 'PASS uppercase normalized to lowercase');
const e5 = launcher.extractReviewVerdictFromText(block('Pass', 'r', true));
ok(e5.ok && e5.verdict === 'pass', 'Pass mixed-case normalized');

for (const bad of ['approved', 'lgtm', 'ok', 'rejected', 'unknown']) {
  const r = launcher.extractReviewVerdictFromText(block(bad, 'r', true));
  ok(!r.ok && r.error === 'invalid_verdict_value' && r.got && r.got.toLowerCase() === bad,
     `invalid value "${bad}" rejected as invalid_verdict_value`);
}

// Reason multi-line collapse + clip
const reasonMulti = '## Review Verdict\nverdict: pass\nreason: line one\n  continuing on next line\n  and another line that should also fold';
const eMulti = launcher.extractReviewVerdictFromText(reasonMulti);
ok(eMulti.ok && !/\n/.test(eMulti.reason), 'multi-line reason single-lined');

const longReason = '## Review Verdict\nverdict: pass\nreason: ' + 'X'.repeat(500);
const eLong = launcher.extractReviewVerdictFromText(longReason);
ok(eLong.ok && eLong.reason.length === 200, 'reason clipped to 200');

// No header
const eNo = launcher.extractReviewVerdictFromText('hello world\nno verdict here');
ok(!eNo.ok && eNo.error === 'no_verdict_block', 'missing header → no_verdict_block');

// Reason missing but verdict present → ok with empty reason
const eNoReason = launcher.extractReviewVerdictFromText('## Review Verdict\nverdict: pass\n');
ok(eNoReason.ok && eNoReason.verdict === 'pass' && eNoReason.reason === '',
   'reason missing → verdict still ok, reason empty');

// Multiple headers — last wins
const eLast = launcher.extractReviewVerdictFromText([
  '## Review Verdict', 'verdict: fail', 'reason: early',
  '## Review Verdict', 'verdict: pass', 'reason: late',
].join('\n'));
ok(eLast.ok && eLast.verdict === 'pass' && eLast.reason === 'late', 'last verdict block wins');

console.log('\n==> Part C: runReviewForCandidate state-machine');

function makeFixtureRepo() {
  const fix = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-rb-fix-'));
  function git(args) { return spawnSync('git', args, { cwd: fix, encoding: 'utf8' }); }
  git(['init']);
  git(['config', 'user.email', 'rb@example.com']);
  git(['config', 'user.name', 'rb']);
  git(['checkout', '-b', 'main']);
  fs.writeFileSync(path.join(fix, 'package.json'), JSON.stringify({ name: 'fix' }));
  fs.writeFileSync(path.join(fix, 'package-lock.json'), '{}');
  fs.writeFileSync(path.join(fix, 'README.md'), '# fix\n');
  fs.mkdirSync(path.join(fix, 'src'));
  fs.writeFileSync(path.join(fix, 'src', 'index.ts'), 'export function hello(){return "hi";}\n');
  git(['add', '.']);
  git(['commit', '-m', 'initial']);
  return fix;
}

// C.1 Happy path: full Worker→Review chain
const fix1 = makeFixtureRepo();
const PID1 = 'p_rb_smoke';
const reg1 = { projects: [{ id: PID1, label: 'rb', project_root: fix1, db_path: '/dev/null', agent_id_hints: [] }] };
handlers.registerManagedProject(reg1, PID1, {});

const c1 = candidates.proposeCandidate(PID1, {
  description: 'Touch a marker file to test review bind',
  candidate_kind: 'other',
  source_iteration_id: 'i_seed', source_run_id: 'wr_seed',
});
ok(c1.ok, 'seed candidate proposed');

const wbRes = handlers.pickCandidateAndLaunchWorker(PID1, {
  candidate_id: c1.candidate.id, provider: 'fixture-worker',
});
ok(wbRes.ok, 'fixture-worker launched ok');
await new Promise(r => setTimeout(r, 1000));
const wbRun = handlers.getWorkerRun(wbRes.run_id);
ok(wbRun && wbRun.status === 'exited', `fixture-worker exited (${wbRun && wbRun.status})`);

// Worker created cairn-worker-fixture-touched.txt — that file is
// untracked, so `git diff` (working tree vs HEAD) returns empty.
// Stage it so the diff is non-empty for review.
function git1(args) { return spawnSync('git', args, { cwd: fix1, encoding: 'utf8' }); }
git1(['add', '-N', 'cairn-worker-fixture-touched.txt']); // intent-to-add → diff sees it

// Attach a Worker Report
const wrep = handlers.extractManagedWorkerReport(PID1, { run_id: wbRes.run_id });
ok(wrep.ok, 'worker report extracted');

const rbRes = handlers.runReviewForCandidate(PID1, {
  candidate_id: c1.candidate.id, provider: 'fixture-review',
});
ok(rbRes.ok, `runReviewForCandidate happy path ok (${rbRes.error || ''})`);
ok(rbRes.candidate_status === 'REVIEWED', 'candidate_status returned REVIEWED');
ok(rbRes.review_iteration_id && /^i_/.test(rbRes.review_iteration_id), 'review_iteration_id valid');

await new Promise(r => setTimeout(r, 800));
const finalRun = handlers.getWorkerRun(rbRes.run_id);
ok(finalRun && finalRun.status === 'exited', `fixture-review exited (${finalRun && finalRun.status})`);

const c1After = candidates.getCandidate(PID1, c1.candidate.id);
ok(c1After.status === 'REVIEWED', 'candidate is REVIEWED post-launch');
ok(c1After.review_iteration_id === rbRes.review_iteration_id, 'candidate.review_iteration_id stamped');

// C.2 candidate_not_found
const e_nf = handlers.runReviewForCandidate(PID1, { candidate_id: 'c_nope', provider: 'fixture-review' });
ok(!e_nf.ok && e_nf.error === 'candidate_not_found', 'candidate_not_found stable error');

// C.3 candidate_not_working (use a fresh PROPOSED one)
const c2 = candidates.proposeCandidate(PID1, { description: 'still proposed', candidate_kind: 'doc' });
const e_nw = handlers.runReviewForCandidate(PID1, { candidate_id: c2.candidate.id, provider: 'fixture-review' });
ok(!e_nw.ok && e_nw.error === 'candidate_not_working', 'candidate_not_working from PROPOSED rejected');
ok(e_nw.current_status === 'PROPOSED', 'error detail includes current_status=PROPOSED');

// C.4 worker_iteration_missing — defensive: forge a row whose status is
// WORKING but worker_iteration_id stays null.
const candFile = path.join(tmpDir, '.cairn', 'project-candidates', PID1 + '.jsonl');
const forged = {
  id: 'c_forged_wb', project_id: PID1, source_iteration_id: null, source_run_id: null,
  description: 'forged', candidate_kind: 'doc', status: 'WORKING',
  worker_iteration_id: null, review_iteration_id: null,
  created_at: Date.now(), updated_at: Date.now(),
};
fs.appendFileSync(candFile, JSON.stringify(forged) + '\n');
const e_wim = handlers.runReviewForCandidate(PID1, { candidate_id: 'c_forged_wb', provider: 'fixture-review' });
ok(!e_wim.ok && e_wim.error === 'worker_iteration_missing',
   'forged WORKING with null worker_iteration_id → worker_iteration_missing');

// C.5 launch_failed → candidate stays at WORKING
//   Build a fresh worker round so we have a clean candidate at WORKING.
const fix2 = makeFixtureRepo();
const PID2 = 'p_rb_lf';
const reg2 = { projects: [{ id: PID2, label: 'rb-lf', project_root: fix2, db_path: '/dev/null', agent_id_hints: [] }] };
handlers.registerManagedProject(reg2, PID2, {});
const c3 = candidates.proposeCandidate(PID2, { description: 'lf candidate', candidate_kind: 'other' });
const wb3 = handlers.pickCandidateAndLaunchWorker(PID2, { candidate_id: c3.candidate.id, provider: 'fixture-worker' });
ok(wb3.ok, 'launch_failed prep: worker launched');
await new Promise(r => setTimeout(r, 1000));

const e_lf = handlers.runReviewForCandidate(PID2, {
  candidate_id: c3.candidate.id, provider: 'no-such-provider',
});
ok(!e_lf.ok && e_lf.error === 'launch_failed', 'unknown provider → launch_failed');
ok(e_lf.candidate_status === 'WORKING', 'launch_failed: candidate_status returned WORKING');
const c3After = candidates.getCandidate(PID2, c3.candidate.id);
ok(c3After.status === 'WORKING', 'candidate persisted at WORKING after launch_failed (no auto-rollback)');
ok(c3After.review_iteration_id == null, 'candidate.review_iteration_id remains null after launch_failed');

console.log('\n==> Part D: extractReviewVerdict (handler) two entry points');

// D.1 by run_id
const evRun = handlers.extractReviewVerdict(PID1, { run_id: rbRes.run_id });
ok(evRun.ok && evRun.verdict === 'pass', 'extractReviewVerdict by run_id ok with verdict=pass');
ok(evRun.reason && evRun.reason.includes('approves'), 'reason text propagated');

// D.2 by candidate_id
const evCand = handlers.extractReviewVerdict(PID1, { candidate_id: c1.candidate.id });
ok(evCand.ok && evCand.verdict === 'pass', 'extractReviewVerdict by candidate_id ok');
ok(evCand.review_iteration_id === rbRes.review_iteration_id, 'review_iteration_id surfaced from candidate path');

// D.3 candidate_not_reviewed (still WORKING)
const evNR = handlers.extractReviewVerdict(PID2, { candidate_id: c3.candidate.id });
ok(!evNR.ok && evNR.error === 'candidate_not_reviewed',
   'candidate still WORKING → candidate_not_reviewed');

// D.4 verdict extraction does NOT mutate candidate
const c1AfterExtract = candidates.getCandidate(PID1, c1.candidate.id);
ok(c1AfterExtract.status === 'REVIEWED',
   'candidate stays at REVIEWED after extractReviewVerdict (verdict=pass does NOT auto-promote to ACCEPTED)');

console.log('\n==> Part E: IPC + preload exposure');

const preload = fs.readFileSync(path.join(root, 'preload.cjs'), 'utf8');
ok(/runReviewForCandidate:\s/.test(preload), 'preload exposes runReviewForCandidate');
ok(/extractReviewVerdict:\s/.test(preload), 'preload exposes extractReviewVerdict');
const main = fs.readFileSync(path.join(root, 'main.cjs'), 'utf8');
ok(main.includes("'run-review-for-candidate'"), 'main.cjs registers run-review-for-candidate IPC');
ok(main.includes("'extract-review-verdict'"), 'main.cjs registers extract-review-verdict IPC');

console.log('\n==> Part F: safety invariants');

ok(safeMtime(realCairnDb) === beforeDb, 'real ~/.cairn/cairn.db mtime unchanged');

const rpSrc = fs.readFileSync(path.join(root, 'review-prompt.cjs'), 'utf8');
const rpCode = rpSrc.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
ok(!/require\(['"]better-sqlite3/.test(rpCode), 'review-prompt does not import better-sqlite3');
ok(!/require\(['"]electron/.test(rpCode), 'review-prompt does not import electron');
ok(!/require\(['"]child_process/.test(rpCode), 'review-prompt does not import child_process');

console.log(`\n${asserts - fails}/${asserts} passed (${fails} failed)`);
if (fails) { console.log('FAILURES:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }
