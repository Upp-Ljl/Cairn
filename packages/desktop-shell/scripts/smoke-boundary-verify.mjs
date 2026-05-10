#!/usr/bin/env node
/**
 * Smoke for Three-Stage Loop Day 6 — boundary verify.
 *
 * Part A — heuristic unit (no spawn): inferScopeFromCandidate +
 *          classifyChangedFiles
 * Part B — verifyWorkerBoundary state-machine errors
 * Part C — fixture-worker-rogue end-to-end (real spawn)
 * Part D — IPC + preload exposure
 * Part E — safety invariants
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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-bv-smoke-'));
os.homedir = () => tmpDir;
fs.mkdirSync(path.join(tmpDir, '.cairn'), { recursive: true });

const handlers   = require(path.join(root, 'managed-loop-handlers.cjs'));
const candidates = require(path.join(root, 'project-candidates.cjs'));
const launcher   = require(path.join(root, 'worker-launcher.cjs'));

console.log('==> Part A: heuristic unit (inferScopeFromCandidate + classifyChangedFiles)');

function classify(candidate, files) {
  const scope = handlers.inferScopeFromCandidate(candidate);
  if (scope.noScope) return { noScope: true, scope };
  return Object.assign({ noScope: false, scope }, handlers.classifyChangedFiles(scope, files));
}

// A.1 — explicit src path + doc kind
const a1 = classify(
  { description: 'Add JSDoc to src/index.ts hello()', candidate_kind: 'doc' },
  ['src/index.ts'],
);
ok(!a1.noScope, 'A.1: scope inferred from explicit src path');
ok(a1.inScope.includes('src/index.ts') && a1.outOfScope.length === 0,
   'A.1: src/index.ts in_scope, no violations');

// A.2 — README is in_scope for kind=doc by default
const a2 = classify(
  { description: 'Add JSDoc to src/index.ts hello()', candidate_kind: 'doc' },
  ['src/index.ts', 'README.md'],
);
ok(a2.inScope.includes('README.md'), 'A.2: README.md in_scope for kind=doc');
ok(a2.outOfScope.length === 0, 'A.2: still no violations');

// A.3 — prompts/ out-of-scope for kind=doc with src description
const a3 = classify(
  { description: 'Add JSDoc to src/index.ts hello()', candidate_kind: 'doc' },
  ['prompts/x.md'],
);
ok(a3.outOfScope.includes('prompts/x.md'), 'A.3: prompts/x.md flagged out_of_scope');
ok(a3.inScope.length === 0, 'A.3: nothing in_scope');

// A.4 — kind=missing_test, description references src/foo.ts; tests/foo.test.ts auto-in-scope
const a4 = classify(
  { description: 'Add tests for src/foo.ts', candidate_kind: 'missing_test' },
  ['tests/foo.test.ts'],
);
ok(a4.inScope.includes('tests/foo.test.ts'),
   'A.4: tests/foo.test.ts in_scope for missing_test (auto-derived from src path)');

// A.5 — kind=other with abstract description → no_scope_inferred
const a5 = classify(
  { description: 'refactor things', candidate_kind: 'other' },
  ['anything.txt'],
);
ok(a5.noScope === true, 'A.5: kind=other + abstract desc → noScope=true');

// A.6 — empty changed_files array
const a6 = classify(
  { description: 'Add JSDoc to src/index.ts hello()', candidate_kind: 'doc' },
  [],
);
ok(!a6.noScope && a6.inScope.length === 0 && a6.outOfScope.length === 0,
   'A.6: empty changed_files → empty in/out_of_scope, scope still inferable');

// A.7 — missing_test with directory hint
const a7 = classify(
  { description: 'tests/api/play-loop.test.ts has no assertions', candidate_kind: 'missing_test' },
  ['tests/api/play-loop.test.ts', 'src/api/play-loop.ts'],
);
ok(a7.inScope.includes('tests/api/play-loop.test.ts'),
   'A.7: tests/api/play-loop.test.ts in_scope (explicit + kind default)');

// A.8 — bug_fix narrow scope
const a8 = classify(
  { description: 'fix race in lib/feed-format.ts SAFE_TAG_RE', candidate_kind: 'bug_fix' },
  ['lib/feed-format.ts', 'docs/architecture.md'],
);
ok(a8.inScope.includes('lib/feed-format.ts'), 'A.8: lib/feed-format.ts in_scope for bug_fix');
ok(a8.outOfScope.includes('docs/architecture.md'),
   'A.8: docs/architecture.md flagged out_of_scope (bug_fix does not include docs)');

// A.9 — kind=missing_test default scope alone (no explicit src ref)
const a9 = classify(
  { description: 'add coverage for the engine', candidate_kind: 'missing_test' },
  ['tests/engine/equity.test.ts', 'src/lib/engine/equity.ts'],
);
ok(a9.inScope.includes('tests/engine/equity.test.ts'),
   'A.9: tests/ in_scope from kind default even without explicit src ref');

console.log('\n==> Part B: verifyWorkerBoundary state-machine errors');

// Build a fixture managed project + a candidate.
function makeFixtureRepo() {
  const fix = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-bv-fix-'));
  function git(args) { return spawnSync('git', args, { cwd: fix, encoding: 'utf8' }); }
  git(['init']);
  git(['config', 'user.email', 'bv@example.com']);
  git(['config', 'user.name', 'bv']);
  git(['checkout', '-b', 'main']);
  fs.mkdirSync(path.join(fix, 'src'));
  fs.mkdirSync(path.join(fix, 'tests'));
  fs.writeFileSync(path.join(fix, 'package.json'), JSON.stringify({ name: 'fix' }));
  fs.writeFileSync(path.join(fix, 'package-lock.json'), '{}');
  fs.writeFileSync(path.join(fix, 'README.md'), '# fix\n');
  fs.writeFileSync(path.join(fix, 'src', 'index.ts'), 'export function hello(){return "hi";}\n');
  git(['add', '.']);
  git(['commit', '-m', 'initial']);
  return fix;
}

const fix1 = makeFixtureRepo();
const PID = 'p_bv_smoke';
const reg = { projects: [{ id: PID, label: 'bv', project_root: fix1, db_path: '/dev/null', agent_id_hints: [] }] };
handlers.registerManagedProject(reg, PID, {});

// candidate_not_found
const e_nf = handlers.verifyWorkerBoundary(PID, { candidate_id: 'c_nope' });
ok(!e_nf.ok && e_nf.error === 'candidate_not_found', 'verify: candidate_not_found');

// missing inputs
const e_noPid = handlers.verifyWorkerBoundary(null, { candidate_id: 'c_x' });
ok(!e_noPid.ok && e_noPid.error === 'project_id_required', 'verify: project_id_required');
const e_noCid = handlers.verifyWorkerBoundary(PID, {});
ok(!e_noCid.ok && e_noCid.error === 'candidate_id_required', 'verify: candidate_id_required');

// PROPOSED → worker_not_run
const cP = candidates.proposeCandidate(PID, { description: 'still proposed', candidate_kind: 'doc' });
const e_wnr = handlers.verifyWorkerBoundary(PID, { candidate_id: cP.candidate.id });
ok(!e_wnr.ok && e_wnr.error === 'worker_not_run',
   'verify: PROPOSED → worker_not_run');
ok(e_wnr.current_status === 'PROPOSED', 'verify: error detail current_status=PROPOSED');

// PICKED → worker_not_run (still no worker run completed)
const cPicked = candidates.proposeCandidate(PID, { description: 'picked-not-worked', candidate_kind: 'doc' });
candidates.setCandidateStatus(PID, cPicked.candidate.id, 'PICKED');
const e_picked = handlers.verifyWorkerBoundary(PID, { candidate_id: cPicked.candidate.id });
ok(!e_picked.ok && e_picked.error === 'worker_not_run',
   'verify: PICKED → worker_not_run (no worker iteration done)');

// project_id_mismatch via forged row
const candFile2 = candidates.candFile('p_bv_mismatch');
fs.mkdirSync(path.dirname(candFile2), { recursive: true });
const forged = {
  id: 'c_forged_bv', project_id: 'p_someone_else',
  source_iteration_id: null, source_run_id: null,
  description: 'forged', candidate_kind: 'doc', status: 'WORKING',
  worker_iteration_id: 'i_x', review_iteration_id: null,
  boundary_violations: [],
  created_at: Date.now(), updated_at: Date.now(),
};
fs.writeFileSync(candFile2, JSON.stringify(forged) + '\n');
const e_mis = handlers.verifyWorkerBoundary('p_bv_mismatch', { candidate_id: 'c_forged_bv' });
ok(!e_mis.ok && e_mis.error === 'project_id_mismatch', 'verify: project_id_mismatch');

// worker_iteration_missing — synth WORKING with null worker_iteration_id
const cWim = candidates.proposeCandidate(PID, { description: 'wim probe', candidate_kind: 'doc' });
const cWimFile = candidates.candFile(PID);
fs.appendFileSync(cWimFile, JSON.stringify({
  id: cWim.candidate.id, project_id: PID,
  source_iteration_id: null, source_run_id: null,
  description: 'wim probe', candidate_kind: 'doc', status: 'WORKING',
  worker_iteration_id: null, review_iteration_id: null,
  boundary_violations: [],
  created_at: Date.now(), updated_at: Date.now() + 1,
}) + '\n');
const e_wim = handlers.verifyWorkerBoundary(PID, { candidate_id: cWim.candidate.id });
ok(!e_wim.ok && e_wim.error === 'worker_iteration_missing',
   'verify: WORKING with null worker_iteration_id → worker_iteration_missing');

console.log('\n==> Part C: fixture-worker-rogue end-to-end');

// fixture-worker-rogue is in catalog and available.
const provs = launcher.detectWorkerProviders();
ok(provs.find(p => p.id === 'fixture-worker-rogue' && p.available), 'fixture-worker-rogue available');

const fix2 = makeFixtureRepo();
const PID2 = 'p_bv_e2e';
const reg2 = { projects: [{ id: PID2, label: 'bv-e2e', project_root: fix2, db_path: '/dev/null', agent_id_hints: [] }] };
handlers.registerManagedProject(reg2, PID2, {});

// Description mentions src/index.ts → in-scope contains src/.
// fixture-worker-rogue writes both src/cairn-rogue-touched.ts (in-scope)
// and cairn-rogue-out-of-scope.md (out-of-scope).
const cR = candidates.proposeCandidate(PID2, {
  description: 'Add JSDoc to src/index.ts hello()',
  candidate_kind: 'doc',
});
ok(cR.ok, 'rogue path: candidate proposed');
const launchRes = handlers.pickCandidateAndLaunchWorker(PID2, {
  candidate_id: cR.candidate.id, provider: 'fixture-worker-rogue',
});
ok(launchRes.ok, 'rogue path: pick + launch ok');
await new Promise(r => setTimeout(r, 1200));
const finalRun = handlers.getWorkerRun(launchRes.run_id);
ok(finalRun && finalRun.status === 'exited', `rogue worker exited (${finalRun && finalRun.status})`);

// Confirm both files exist on disk + intent-to-add them so git diff sees them.
ok(fs.existsSync(path.join(fix2, 'src', 'cairn-rogue-touched.ts')), 'in-scope file written by rogue');
ok(fs.existsSync(path.join(fix2, 'cairn-rogue-out-of-scope.md')), 'out-of-scope file written by rogue');
spawnSync('git', ['add', '-N', 'src/cairn-rogue-touched.ts', 'cairn-rogue-out-of-scope.md'],
          { cwd: fix2 });

// Verify.
const verify1 = handlers.verifyWorkerBoundary(PID2, { candidate_id: cR.candidate.id });
ok(verify1.ok, `verify ok (${verify1.error || ''})`);
ok(verify1.violations.includes('cairn-rogue-out-of-scope.md'),
   'violations include cairn-rogue-out-of-scope.md');
ok(verify1.in_scope.includes('src/cairn-rogue-touched.ts'),
   'in_scope includes src/cairn-rogue-touched.ts');
ok(typeof verify1.heuristic_notes === 'string' && verify1.heuristic_notes.length > 0,
   'heuristic_notes non-empty');

// Persisted on the candidate row.
const cAfter1 = candidates.getCandidate(PID2, cR.candidate.id);
ok(cAfter1.boundary_violations.length === 1
   && cAfter1.boundary_violations[0] === 'cairn-rogue-out-of-scope.md',
   'candidate.boundary_violations persisted');

// Worker iteration's evidence_summary got the counts merged in.
const itersM = require(path.join(root, 'project-iterations.cjs'));
const wIter = itersM.getIteration(PID2, cAfter1.worker_iteration_id);
ok(wIter && wIter.evidence_summary
   && wIter.evidence_summary.boundary_violations_count === 1
   && wIter.evidence_summary.boundary_in_scope_count === 1,
   'worker iteration evidence_summary has boundary counts');

// Idempotency — re-run verify with the same diff.
const updatedAtBefore = candidates.getCandidate(PID2, cR.candidate.id).updated_at;
await new Promise(r => setTimeout(r, 30));
const verify2 = handlers.verifyWorkerBoundary(PID2, { candidate_id: cR.candidate.id });
ok(verify2.ok && verify2.violations.length === 1, 'idempotent: violations stable on re-run');
const cAfter2 = candidates.getCandidate(PID2, cR.candidate.id);
ok(cAfter2.boundary_violations.length === 1
   && cAfter2.boundary_violations[0] === 'cairn-rogue-out-of-scope.md',
   'idempotent: candidate.boundary_violations stable');
const wIter2 = itersM.getIteration(PID2, cAfter1.worker_iteration_id);
ok(wIter2.evidence_summary.boundary_violations_count === 1,
   'idempotent: evidence_summary count stable (no double-count)');

// no_scope_inferred path: a kind=other candidate with abstract description
// should NOT write boundary_violations even when files exist.
const fix3 = makeFixtureRepo();
const PID3 = 'p_bv_noscope';
const reg3 = { projects: [{ id: PID3, label: 'noscope', project_root: fix3, db_path: '/dev/null', agent_id_hints: [] }] };
handlers.registerManagedProject(reg3, PID3, {});
const cN = candidates.proposeCandidate(PID3, {
  description: 'general improvements', candidate_kind: 'other',
});
const launchN = handlers.pickCandidateAndLaunchWorker(PID3, {
  candidate_id: cN.candidate.id, provider: 'fixture-worker',
});
ok(launchN.ok, 'no-scope path: launch ok');
await new Promise(r => setTimeout(r, 1100));
spawnSync('git', ['add', '-N', 'cairn-worker-fixture-touched.txt'], { cwd: fix3 });
const verifyN = handlers.verifyWorkerBoundary(PID3, { candidate_id: cN.candidate.id });
ok(verifyN.ok && verifyN.heuristic_notes === 'no_scope_inferred',
   'no_scope_inferred returned for kind=other + abstract description');
ok(verifyN.violations.length === 0, 'no_scope_inferred returns empty violations');
const cNAfter = candidates.getCandidate(PID3, cN.candidate.id);
ok(cNAfter.boundary_violations.length === 0,
   'no_scope_inferred does NOT write boundary_violations (avoid false positive)');

console.log('\n==> Part D: IPC + preload exposure');

const main = fs.readFileSync(path.join(root, 'main.cjs'), 'utf8');
ok(main.includes("'verify-worker-boundary'"), 'main.cjs registers verify-worker-boundary IPC');
const preload = fs.readFileSync(path.join(root, 'preload.cjs'), 'utf8');
ok(/verifyWorkerBoundary:\s/.test(preload), 'preload exposes verifyWorkerBoundary');

console.log('\n==> Part E: safety invariants');

ok(safeMtime(realCairnDb) === beforeDb, 'real ~/.cairn/cairn.db mtime unchanged');

console.log(`\n${asserts - fails}/${asserts} passed (${fails} failed)`);
if (fails) { console.log('FAILURES:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }
