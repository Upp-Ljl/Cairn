#!/usr/bin/env node
/**
 * Smoke for project-candidates.cjs (Three-Stage Loop Day 1).
 *
 * Coverage:
 *   - propose + read round-trip
 *   - every legal transition runs
 *   - every illegal transition rejected with invalid_transition
 *   - terminal states reject all further transitions
 *   - fold-by-id (idempotent / latest-wins after multiple patches)
 *   - bindWorkerIteration / bindReviewIteration set status + id
 *   - newest-first sort by updated_at
 *   - listCandidatesByStatus filters
 *   - input clipping + unknown candidate_kind defaults to 'other'
 *   - path traversal sanitization
 *   - read-only invariants (no cairn.db touch)
 *   - source-level: no better-sqlite3 / electron import
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
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

// Sandboxed home (Cairn writes only — we don't spawn anything here).
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-cand-smoke-'));
process.env.HOME = tmpDir;
process.env.USERPROFILE = tmpDir;
os.homedir = () => tmpDir;
fs.mkdirSync(path.join(tmpDir, '.cairn'), { recursive: true });

const cand = require(path.join(root, 'project-candidates.cjs'));

const PID = 'p_cand_smoke';

// -------- Part A — propose + read round-trip --------

const r1 = cand.proposeCandidate(PID, {
  description: 'Add coverage for src/lib/engine/equity.ts',
  candidate_kind: 'missing_test',
  source_iteration_id: 'i_scout_001',
  source_run_id: 'wr_scout_001',
});
ok(r1.ok, 'proposeCandidate ok');
ok(/^c_/.test(r1.candidate.id), 'candidate id has c_ prefix');
ok(r1.candidate.status === 'PROPOSED', 'new candidate is PROPOSED');
ok(r1.candidate.candidate_kind === 'missing_test', 'kind preserved when known');
ok(r1.candidate.source_iteration_id === 'i_scout_001' && r1.candidate.source_run_id === 'wr_scout_001',
   'source iteration + run ids round-trip');

const C1 = r1.candidate.id;
const got = cand.getCandidate(PID, C1);
ok(got && got.id === C1, 'getCandidate round-trips by id');
ok(got.description === 'Add coverage for src/lib/engine/equity.ts', 'description round-trips');

// Missing description rejected
const e0 = cand.proposeCandidate(PID, { description: '   ' });
ok(!e0.ok && e0.error === 'description_required', 'empty description rejected');

// Unknown kind falls back to 'other'
const r1k = cand.proposeCandidate(PID, { description: 'kind defaulting test', candidate_kind: 'made-up-kind' });
ok(r1k.ok && r1k.candidate.candidate_kind === 'other', 'unknown kind → "other"');

// -------- Part B — every legal transition --------
//
// Walk one candidate per legal transition origin, then trip the
// transition, then assert the new status sticks AND was persisted.
//
// PROPOSED → PICKED
// PROPOSED → REJECTED
// PICKED   → WORKING  (via bindWorkerIteration)
// PICKED   → REJECTED
// WORKING  → REVIEWED (via bindReviewIteration)
// WORKING  → REJECTED
// REVIEWED → ACCEPTED
// REVIEWED → REJECTED
// REVIEWED → ROLLED_BACK

function freshProposed(label) {
  const r = cand.proposeCandidate(PID, { description: label });
  return r.ok ? r.candidate.id : null;
}

const tA = freshProposed('A: PROPOSED → PICKED');
const sA = cand.setCandidateStatus(PID, tA, 'PICKED');
ok(sA.ok && sA.candidate.status === 'PICKED', 'transition: PROPOSED → PICKED');

const tB = freshProposed('B: PROPOSED → REJECTED');
const sB = cand.setCandidateStatus(PID, tB, 'REJECTED');
ok(sB.ok && sB.candidate.status === 'REJECTED', 'transition: PROPOSED → REJECTED');

const tC = freshProposed('C: PICKED → WORKING via bindWorkerIteration');
cand.setCandidateStatus(PID, tC, 'PICKED');
const sC = cand.bindWorkerIteration(PID, tC, 'i_worker_aaa');
ok(sC.ok && sC.candidate.status === 'WORKING' && sC.candidate.worker_iteration_id === 'i_worker_aaa',
   'transition: PICKED → WORKING + worker_iteration_id stamped via bindWorkerIteration');

const tD = freshProposed('D: PICKED → REJECTED');
cand.setCandidateStatus(PID, tD, 'PICKED');
const sD = cand.setCandidateStatus(PID, tD, 'REJECTED');
ok(sD.ok && sD.candidate.status === 'REJECTED', 'transition: PICKED → REJECTED');

const tE = freshProposed('E: WORKING → REVIEWED via bindReviewIteration');
cand.setCandidateStatus(PID, tE, 'PICKED');
cand.bindWorkerIteration(PID, tE, 'i_worker_bbb');
const sE = cand.bindReviewIteration(PID, tE, 'i_review_bbb');
ok(sE.ok && sE.candidate.status === 'REVIEWED' && sE.candidate.review_iteration_id === 'i_review_bbb',
   'transition: WORKING → REVIEWED + review_iteration_id stamped via bindReviewIteration');

const tF = freshProposed('F: WORKING → REJECTED');
cand.setCandidateStatus(PID, tF, 'PICKED');
cand.setCandidateStatus(PID, tF, 'WORKING');
const sF = cand.setCandidateStatus(PID, tF, 'REJECTED');
ok(sF.ok && sF.candidate.status === 'REJECTED', 'transition: WORKING → REJECTED');

const tG = freshProposed('G: REVIEWED → ACCEPTED');
cand.setCandidateStatus(PID, tG, 'PICKED');
cand.setCandidateStatus(PID, tG, 'WORKING');
cand.setCandidateStatus(PID, tG, 'REVIEWED');
const sG = cand.setCandidateStatus(PID, tG, 'ACCEPTED');
ok(sG.ok && sG.candidate.status === 'ACCEPTED', 'transition: REVIEWED → ACCEPTED');

const tH = freshProposed('H: REVIEWED → REJECTED');
cand.setCandidateStatus(PID, tH, 'PICKED');
cand.setCandidateStatus(PID, tH, 'WORKING');
cand.setCandidateStatus(PID, tH, 'REVIEWED');
const sH = cand.setCandidateStatus(PID, tH, 'REJECTED');
ok(sH.ok && sH.candidate.status === 'REJECTED', 'transition: REVIEWED → REJECTED');

const tI = freshProposed('I: REVIEWED → ROLLED_BACK');
cand.setCandidateStatus(PID, tI, 'PICKED');
cand.setCandidateStatus(PID, tI, 'WORKING');
cand.setCandidateStatus(PID, tI, 'REVIEWED');
const sI = cand.setCandidateStatus(PID, tI, 'ROLLED_BACK');
ok(sI.ok && sI.candidate.status === 'ROLLED_BACK', 'transition: REVIEWED → ROLLED_BACK');

// -------- Part C — every illegal transition rejected --------
//
// Pick an exhaustive set: from each origin status, every status NOT
// in VALID_TRANSITIONS[origin] must yield invalid_transition (and
// must not throw). We seed one candidate per origin, drive it there,
// and probe every other status.

function illegalProbe(origin, candidateId) {
  for (const target of cand.STATUS_VALUES) {
    if (target === origin) continue;
    if (cand.VALID_TRANSITIONS[origin].has(target)) continue;
    const r = cand.setCandidateStatus(PID, candidateId, target);
    ok(!r.ok && r.error === 'invalid_transition',
       `illegal: ${origin} → ${target} rejected as invalid_transition`);
  }
}

// Origin = PROPOSED — illegals: WORKING, REVIEWED, ACCEPTED, ROLLED_BACK
const probeProposed = freshProposed('illegal probe PROPOSED');
illegalProbe('PROPOSED', probeProposed);

// Origin = PICKED — illegals: PROPOSED, REVIEWED, ACCEPTED, ROLLED_BACK
const probePicked = freshProposed('illegal probe PICKED');
cand.setCandidateStatus(PID, probePicked, 'PICKED');
illegalProbe('PICKED', probePicked);

// Origin = WORKING — illegals: PROPOSED, PICKED, ACCEPTED, ROLLED_BACK
const probeWorking = freshProposed('illegal probe WORKING');
cand.setCandidateStatus(PID, probeWorking, 'PICKED');
cand.setCandidateStatus(PID, probeWorking, 'WORKING');
illegalProbe('WORKING', probeWorking);

// Origin = REVIEWED — illegals: PROPOSED, PICKED, WORKING
const probeReviewed = freshProposed('illegal probe REVIEWED');
cand.setCandidateStatus(PID, probeReviewed, 'PICKED');
cand.setCandidateStatus(PID, probeReviewed, 'WORKING');
cand.setCandidateStatus(PID, probeReviewed, 'REVIEWED');
illegalProbe('REVIEWED', probeReviewed);

// Terminal states reject EVERY non-self transition.
const probeAccepted = freshProposed('terminal probe ACCEPTED');
cand.setCandidateStatus(PID, probeAccepted, 'PICKED');
cand.setCandidateStatus(PID, probeAccepted, 'WORKING');
cand.setCandidateStatus(PID, probeAccepted, 'REVIEWED');
cand.setCandidateStatus(PID, probeAccepted, 'ACCEPTED');
illegalProbe('ACCEPTED', probeAccepted);

const probeRejected = freshProposed('terminal probe REJECTED');
cand.setCandidateStatus(PID, probeRejected, 'REJECTED');
illegalProbe('REJECTED', probeRejected);

const probeRolled = freshProposed('terminal probe ROLLED_BACK');
cand.setCandidateStatus(PID, probeRolled, 'PICKED');
cand.setCandidateStatus(PID, probeRolled, 'WORKING');
cand.setCandidateStatus(PID, probeRolled, 'REVIEWED');
cand.setCandidateStatus(PID, probeRolled, 'ROLLED_BACK');
illegalProbe('ROLLED_BACK', probeRolled);

// Specific spot check: bindWorkerIteration on a candidate not in PICKED
// must reject as invalid_transition (not silently succeed).
const wrongOrigin = freshProposed('wrong-origin bind');
const wb = cand.bindWorkerIteration(PID, wrongOrigin, 'i_worker_x');
ok(!wb.ok && wb.error === 'invalid_transition',
   'bindWorkerIteration from PROPOSED (not PICKED) rejected');

// bindReviewIteration without prior worker run also rejected.
const wrongOrigin2 = freshProposed('wrong-origin bindReview');
cand.setCandidateStatus(PID, wrongOrigin2, 'PICKED');
const rb = cand.bindReviewIteration(PID, wrongOrigin2, 'i_review_x');
ok(!rb.ok && rb.error === 'invalid_transition',
   'bindReviewIteration from PICKED (not WORKING) rejected');

// Invalid status enum
const fresh2 = freshProposed('invalid status enum');
const bad = cand.setCandidateStatus(PID, fresh2, 'GIBBERISH');
ok(!bad.ok && bad.error === 'invalid_status', 'unknown status enum rejected');

// Unknown candidate id
const ghost = cand.setCandidateStatus(PID, 'c_does_not_exist', 'PICKED');
ok(!ghost.ok && ghost.error === 'candidate_not_found', 'unknown candidate id → candidate_not_found');

// -------- Part D — fold-by-id (one snapshot per id, latest wins) --------

// We've made 9 walk-through candidates + various probes. listCandidates
// must return ONE row per candidate id even though many of them have
// 2-4 appended lines (one per status transition).
const list = cand.listCandidates(PID, 200);
const ids = list.map(c => c.id);
const uniqueIds = new Set(ids);
ok(uniqueIds.size === ids.length, 'fold-by-id: no duplicate ids in list output');
ok(list.length >= 9, `list contains all walked candidates (got ${list.length})`);

// Newest-first sort by updated_at
let sorted = true;
for (let i = 1; i < list.length; i++) {
  if ((list[i - 1].updated_at || 0) < (list[i].updated_at || 0)) { sorted = false; break; }
}
ok(sorted, 'list sorted newest-first by updated_at');

// Newer patches override older snapshots — verify directly
const tG_final = cand.getCandidate(PID, tG);
ok(tG_final.status === 'ACCEPTED', 'fold: tG resolved to terminal ACCEPTED, not stale REVIEWED');

// -------- Part E — listCandidatesByStatus --------

const accepted = cand.listCandidatesByStatus(PID, 'ACCEPTED');
ok(accepted.length >= 1 && accepted.every(c => c.status === 'ACCEPTED'),
   'listCandidatesByStatus(ACCEPTED) only returns ACCEPTED');
const rolled = cand.listCandidatesByStatus(PID, 'ROLLED_BACK');
ok(rolled.length >= 1 && rolled.every(c => c.status === 'ROLLED_BACK'),
   'listCandidatesByStatus(ROLLED_BACK) only returns ROLLED_BACK');

// -------- Part F — sanitization (path traversal) --------

const evilId = '../../../etc/passwd';
const evilFile = cand.candFile(evilId);
ok(!evilFile.includes('..'), 'candFile sanitizes ".." out of project_id');
ok(!/[\/\\]passwd/.test(evilFile.replace(cand.candDir(), '')),
   'candFile does not escape candDir even with traversal-y project_id');
const evilProp = cand.proposeCandidate(evilId, { description: 'sandboxed' });
ok(evilProp.ok, 'proposing for an evil project_id still works (just sanitized to safe filename)');
// And it's stored in the sanitized path under candDir (not at /etc/passwd).
ok(fs.existsSync(evilFile), 'sanitized file exists in candDir');

// -------- Part G — input clipping --------

const longDesc = 'X'.repeat(500);
const clipped = cand.proposeCandidate(PID, { description: longDesc });
ok(clipped.ok && clipped.candidate.description.length === 240,
   'description clipped to 240 chars');

// -------- Part H — read-only invariants --------

ok(safeMtime(realCairnDb) === beforeDb, 'real ~/.cairn/cairn.db mtime unchanged');
ok(!fs.existsSync(path.join(os.homedir(), '.cairn', 'cairn.db')),
   'no cairn.db created in sandboxed home');

// -------- Part I — source-level safety --------

const src = fs.readFileSync(path.join(root, 'project-candidates.cjs'), 'utf8');
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
ok(!/require\(['"]better-sqlite3/.test(code), 'no better-sqlite3 import');
ok(!/require\(['"]electron/.test(code), 'no electron import');
ok(!/require\(['"]child_process/.test(code), 'no child_process import');
ok(!/cairn\.db/.test(code), 'no cairn.db reference in code');

// -------- Part J — exported constants --------

ok(Array.isArray(cand.STATUS_VALUES) && cand.STATUS_VALUES.length === 7,
   'STATUS_VALUES exported with 7 values');
ok(cand.VALID_TRANSITIONS && typeof cand.VALID_TRANSITIONS === 'object',
   'VALID_TRANSITIONS exported');
ok(cand.TERMINAL_STATES.has('ACCEPTED') && cand.TERMINAL_STATES.has('REJECTED') && cand.TERMINAL_STATES.has('ROLLED_BACK'),
   'TERMINAL_STATES covers ACCEPTED / REJECTED / ROLLED_BACK');

console.log(`\n${asserts - fails}/${asserts} passed (${fails} failed)`);
if (fails) { console.log('FAILURES:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }
