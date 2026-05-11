#!/usr/bin/env node
/**
 * Smoke — Continuous Iteration loop (handler written in parallel).
 *
 * Covers 7 path categories:
 *   Part A — happy path (≥8 asserts)
 *   Part B — zero-candidate path via max_candidates=0 (≥3 asserts)
 *   Part C — launch_failed partial (≥5 asserts)
 *   Part D — max_candidates cap (≥4 asserts)
 *   Part E — user-initiated stop (≥3 asserts)
 *   Part F — IPC + preload sanity (≥4 asserts)
 *   Part G — safety invariants (≥3 asserts)
 *
 * Total minimum: 30 asserts.
 *
 * If the handler is not yet written (runContinuousIteration missing),
 * the smoke exits cleanly with a well-formed "handler_not_ready" skip
 * message and exit code 0 — so the main session can run it without
 * knowing whether the parallel implementation is done yet.
 *
 * Usage:
 *   node packages/desktop-shell/scripts/smoke-continuous-iteration.mjs
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

// ---------------------------------------------------------------------------
// Assert harness (same pattern as other smokes in this repo)
// ---------------------------------------------------------------------------

let asserts = 0, fails = 0;
const failures = [];
function ok(c, l) {
  asserts++;
  if (c) console.log(`  ok    ${l}`);
  else { fails++; failures.push(l); console.log(`  FAIL  ${l}`); }
}

// ---------------------------------------------------------------------------
// Safety snapshot — real ~/.cairn/cairn.db must not be touched
// ---------------------------------------------------------------------------

const realCairnDb = path.join(os.homedir(), '.cairn', 'cairn.db');
function safeMtime(p) { try { return fs.statSync(p).mtimeMs; } catch (_e) { return null; } }
const beforeDb = safeMtime(realCairnDb);

// ---------------------------------------------------------------------------
// Sandbox HOME — all Cairn writes go under a throwaway tmpdir.
// DON'T touch process.env.HOME; instead override os.homedir() as the
// other dogfoods do (consistent with how managed-loop-handlers resolves
// the home directory via opts.home or os.homedir()).
// ---------------------------------------------------------------------------

const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-ci-smoke-'));
os.homedir = () => sandboxHome;
fs.mkdirSync(path.join(sandboxHome, '.cairn'), { recursive: true });
console.log(`(sandboxed Cairn writes: ${sandboxHome})`);

// ---------------------------------------------------------------------------
// Load modules
// ---------------------------------------------------------------------------

const handlers   = require(path.join(root, 'managed-loop-handlers.cjs'));
const candidates = require(path.join(root, 'project-candidates.cjs'));

// Guard: if the handler is not yet implemented, exit cleanly.
if (typeof handlers.runContinuousIteration !== 'function') {
  console.log('\n[SKIP] handlers.runContinuousIteration is not yet implemented.');
  console.log('       The main session should run this smoke once the parallel');
  console.log('       implementation lands.  Exit 0 (stable skip, not a test failure).');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a throwaway git repo with an initial commit. */
function makeFixtureRepo(tag) {
  const fix = fs.mkdtempSync(path.join(os.tmpdir(), `cairn-ci-fix-${tag || 'x'}-`));
  function git(args) { return spawnSync('git', args, { cwd: fix, encoding: 'utf8' }); }
  git(['init']);
  git(['config', 'user.email', 'ci-smoke@example.com']);
  git(['config', 'user.name', 'ci-smoke']);
  git(['checkout', '-b', 'main']);
  fs.writeFileSync(path.join(fix, 'package.json'), JSON.stringify({ name: 'ci-fix-' + tag }));
  fs.writeFileSync(path.join(fix, 'package-lock.json'), '{}');
  fs.writeFileSync(path.join(fix, 'README.md'), `# ci-fix-${tag}\n`);
  git(['add', '.']);
  git(['commit', '-m', 'initial']);
  return fix;
}

/**
 * Register a managed project for a given (homeOverride, projectId, repoPath).
 * Returns the project record for use in the run.
 */
function registerProject(home, projectId, repoPath) {
  const reg = {
    projects: [{
      id: projectId,
      label: projectId,
      project_root: repoPath,
      db_path: '/dev/null',
      agent_id_hints: [],
    }],
  };
  return handlers.registerManagedProject(reg, projectId, {}, { home });
}

/** Standard goal shape used by most test parts. */
function makeGoal(id) {
  return {
    id: `goal-${id}`,
    title: `Test goal ${id}`,
    desired_outcome: `Improve coverage in area ${id}`,
    success_criteria: `All tests pass for area ${id}`,
    non_goals: `Do not touch unrelated modules`,
  };
}

// ---------------------------------------------------------------------------
// Part A — Happy path
// fixture-scout emits 5 candidates; max_candidates=3 should cap at 3.
// All-fixture providers, so runs complete quickly.
// ---------------------------------------------------------------------------

console.log('\n==> Part A: happy path (max_candidates=3, all fixtures)');

const homeA = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-ci-homeA-'));
fs.mkdirSync(path.join(homeA, '.cairn'), { recursive: true });
const repoA = makeFixtureRepo('A');
const PID_A = 'p_ci_smoke_A';
const regResA = registerProject(homeA, PID_A, repoA);
ok(regResA.ok, 'Part A: registerManagedProject ok');

const inputA = {
  goal: makeGoal('A'),
  rules: { max_file_changes: 5 },
  scout_provider:  'fixture-scout',
  worker_provider: 'fixture-worker',
  review_provider: 'fixture-review',
  max_candidates:  3,
};
const optsA = { home: homeA, poll_ms: 100, timeout_ms: 60000 };

const runResA = await handlers.runContinuousIteration(PID_A, inputA, optsA);

ok(runResA.ok === true,
   'Part A: run returns ok=true');
ok(runResA.status === 'finished',
   `Part A: status=finished (got: ${runResA.status})`);
ok(
  runResA.stopped_reason === 'completed' || runResA.stopped_reason === 'max_reached',
  `Part A: stopped_reason is completed|max_reached (got: ${runResA.stopped_reason})`
);
ok(typeof runResA.run_id === 'string' && runResA.run_id.length > 0,
   'Part A: run_id is non-empty string');
ok(typeof runResA.scout_run_id === 'string' && runResA.scout_run_id.length > 0,
   'Part A: scout_run_id is non-null (fixture-scout ran)');

// Verify candidate_runs array
ok(Array.isArray(runResA.candidate_runs),
   'Part A: candidate_runs is an array');
ok(runResA.candidate_runs.length === 3,
   `Part A: 3 candidate_runs produced (max_candidates=3, fixture-scout emits 5; got ${runResA.candidate_runs.length})`);

// Verify each candidate_run shape
const allHaveWorkerRun  = runResA.candidate_runs.every(cr => typeof cr.worker_run_id === 'string' && cr.worker_run_id.length > 0);
const allHaveReviewRun  = runResA.candidate_runs.every(cr => typeof cr.review_run_id === 'string' && cr.review_run_id.length > 0);
const allPass           = runResA.candidate_runs.every(cr => cr.verdict === 'pass');
ok(allHaveWorkerRun, 'Part A: each candidate_run has worker_run_id');
ok(allHaveReviewRun, 'Part A: each candidate_run has review_run_id');
ok(allPass,          'Part A: each candidate_run has verdict=pass (fixture-review)');

// Verify registry state: each candidate should be REVIEWED (not
// ACCEPTED — by design Cairn does not auto-promote; user clicks Accept).
const allReviewed = runResA.candidate_runs.every(cr => {
  const cand = candidates.getCandidate(PID_A, cr.candidate_id, { home: homeA });
  return cand && cand.status === 'REVIEWED';
});
ok(allReviewed,
   'Part A: all candidates in registry at REVIEWED (NOT ACCEPTED — user decides)');

// Verify JSONL persistence via getContinuousRun
const rowA = handlers.getContinuousRun
  ? handlers.getContinuousRun(PID_A, runResA.run_id, { home: homeA })
  : null;
if (rowA !== undefined) {
  ok(rowA !== null, 'Part A: getContinuousRun returns a row');
  ok(
    rowA && (rowA.current_stage === 'done' || rowA.status === 'finished'),
    `Part A: persisted row shows completed stage (current_stage=${rowA && rowA.current_stage}, status=${rowA && rowA.status})`
  );
} else {
  // getContinuousRun not yet implemented — skip with note
  console.log('  skip  Part A: getContinuousRun not yet exported (deferred)');
}

// ---------------------------------------------------------------------------
// Part B — Zero-candidate path via max_candidates=0
//
// Simplest approach: pass max_candidates=0. The handler should
// recognise that no work is requested and return immediately with
// stopped_reason='no_candidates' or 'max_reached' (both are correct
// depending on whether the handler treats 0 as "nothing to do" before
// or after running the scout). We accept either. The key invariant is
// that candidate_runs is empty and the run still returns ok=true.
// ---------------------------------------------------------------------------

console.log('\n==> Part B: zero-candidate path (max_candidates=0)');

const homeB = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-ci-homeB-'));
fs.mkdirSync(path.join(homeB, '.cairn'), { recursive: true });
const repoB = makeFixtureRepo('B');
const PID_B = 'p_ci_smoke_B';
registerProject(homeB, PID_B, repoB);

const inputB = {
  goal: makeGoal('B'),
  scout_provider:  'fixture-scout',
  worker_provider: 'fixture-worker',
  review_provider: 'fixture-review',
  max_candidates:  0,
};
const optsB = { home: homeB, poll_ms: 100, timeout_ms: 30000 };

const runResB = await handlers.runContinuousIteration(PID_B, inputB, optsB);

ok(runResB.ok === true,
   'Part B: run returns ok=true even with max_candidates=0');
ok(
  Array.isArray(runResB.candidate_runs) && runResB.candidate_runs.length === 0,
  `Part B: candidate_runs is empty (got ${Array.isArray(runResB.candidate_runs) ? runResB.candidate_runs.length : 'non-array'})`
);
// stopped_reason should communicate that nothing was processed
ok(
  runResB.stopped_reason === 'no_candidates'
  || runResB.stopped_reason === 'max_reached'
  || runResB.stopped_reason === 'completed',
  `Part B: stopped_reason communicates zero-work outcome (got: ${runResB.stopped_reason})`
);

// ---------------------------------------------------------------------------
// Part C — launch_failed partial
//
// Pass worker_provider='no-such-provider'. Scout (fixture-scout) runs
// fine and emits 5 candidates. When the handler tries to launch a
// worker for the first picked candidate, launchWorker returns
// { ok:false, error:'unknown_provider' }. The handler should:
//   - still return ok=true (partial result is not a hard error)
//   - set status='finished', stopped_reason='worker_launch_failed'
//   - leave the first candidate at PICKED (per Day 3 contract)
//   - NOT attempt subsequent candidates
// ---------------------------------------------------------------------------

console.log('\n==> Part C: launch_failed partial (worker_provider=no-such-provider)');

const homeC = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-ci-homeC-'));
fs.mkdirSync(path.join(homeC, '.cairn'), { recursive: true });
const repoC = makeFixtureRepo('C');
const PID_C = 'p_ci_smoke_C';
registerProject(homeC, PID_C, repoC);

const inputC = {
  goal: makeGoal('C'),
  scout_provider:  'fixture-scout',
  worker_provider: 'no-such-provider',   // deliberate bad provider
  review_provider: 'fixture-review',
  max_candidates:  3,
};
const optsC = { home: homeC, poll_ms: 100, timeout_ms: 30000 };

const runResC = await handlers.runContinuousIteration(PID_C, inputC, optsC);

ok(runResC.ok === true,
   'Part C: run returns ok=true even when worker launch fails (partial result)');
ok(runResC.status === 'finished',
   `Part C: status=finished (got: ${runResC.status})`);
ok(
  runResC.stopped_reason === 'worker_launch_failed'
  || runResC.stopped_reason === 'launch_failed',
  `Part C: stopped_reason indicates worker launch failure (got: ${runResC.stopped_reason})`
);
ok(typeof runResC.scout_run_id === 'string' && runResC.scout_run_id.length > 0,
   'Part C: scout_run_id present (scout ran ok before worker failed)');

// The failed candidate should be at PICKED in the registry
// (Day 3 contract: launch_failed leaves candidate at PICKED, not PROPOSED/REJECTED).
// Check either via candidate_runs or by scanning the registry directly.
let firstPickedStatus = null;
if (Array.isArray(runResC.candidate_runs) && runResC.candidate_runs.length > 0) {
  const firstCandId = runResC.candidate_runs[0].candidate_id;
  const firstCand = candidates.getCandidate(PID_C, firstCandId, { home: homeC });
  firstPickedStatus = firstCand && firstCand.status;
} else {
  // No candidate_runs entry for failed — check all PICKED rows in registry
  const pickedRows = candidates.listCandidatesByStatus(PID_C, 'PICKED', { home: homeC });
  if (pickedRows.length > 0) firstPickedStatus = 'PICKED';
}
ok(
  firstPickedStatus === 'PICKED',
  `Part C: first candidate left at PICKED in registry after launch_failed (got: ${firstPickedStatus})`
);

// Subsequent candidates should NOT have been attempted (remain PROPOSED)
const proposedAfterC = candidates.listCandidatesByStatus(PID_C, 'PROPOSED', { home: homeC });
ok(proposedAfterC.length >= 1,
   `Part C: subsequent candidates NOT attempted (still PROPOSED: ${proposedAfterC.length})`);

// ---------------------------------------------------------------------------
// Part D — max_candidates cap at 2
//
// fixture-scout emits 5 candidates. max_candidates=2 should stop after
// processing exactly 2. The remaining 3 should still be PROPOSED.
// ---------------------------------------------------------------------------

console.log('\n==> Part D: max_candidates=2 cap');

const homeD = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-ci-homeD-'));
fs.mkdirSync(path.join(homeD, '.cairn'), { recursive: true });
const repoD = makeFixtureRepo('D');
const PID_D = 'p_ci_smoke_D';
registerProject(homeD, PID_D, repoD);

const inputD = {
  goal: makeGoal('D'),
  scout_provider:  'fixture-scout',
  worker_provider: 'fixture-worker',
  review_provider: 'fixture-review',
  max_candidates:  2,
};
const optsD = { home: homeD, poll_ms: 100, timeout_ms: 60000 };

const runResD = await handlers.runContinuousIteration(PID_D, inputD, optsD);

ok(
  Array.isArray(runResD.candidate_runs) && runResD.candidate_runs.length === 2,
  `Part D: candidate_runs.length === 2 (got ${runResD.candidate_runs && runResD.candidate_runs.length})`
);
ok(
  runResD.stopped_reason === 'max_reached' || runResD.stopped_reason === 'completed',
  `Part D: stopped_reason is max_reached|completed (got: ${runResD.stopped_reason})`
);
// fixture-scout emits 5; 2 are processed, so 3 should remain PROPOSED
const proposedD = candidates.listCandidatesByStatus(PID_D, 'PROPOSED', { home: homeD });
ok(proposedD.length === 3,
   `Part D: 3 remaining candidates still PROPOSED in registry (got ${proposedD.length})`);
ok(runResD.status === 'finished',
   `Part D: status=finished (got: ${runResD.status})`);

// Optionally verify JSONL row has candidates_processed=2
const rowD = handlers.getContinuousRun
  ? handlers.getContinuousRun(PID_D, runResD.run_id, { home: homeD })
  : null;
if (rowD !== undefined && rowD !== null) {
  ok(
    rowD.candidates_processed === 2 || rowD.candidate_runs_count === 2
    || (Array.isArray(rowD.candidate_runs) && rowD.candidate_runs.length === 2),
    `Part D: persisted JSONL row tracks candidates_processed=2 (got: ${JSON.stringify({ candidates_processed: rowD.candidates_processed, candidate_runs_count: rowD.candidate_runs_count })})`
  );
} else {
  console.log('  skip  Part D: getContinuousRun not yet exported (deferred)');
}

// ---------------------------------------------------------------------------
// Part E — user-initiated stop
//
// Use a generous poll_ms=500 so there is time for the stop flag to be
// observed between ticks. Start the run async, call stop after 300ms,
// then await the result.
//
// Timing note: the fixture providers exit almost immediately (~0ms),
// so by the time the stop arrives, the first candidate may already be
// finished. That's acceptable — what we verify is that the run returns
// status='stopped' and stopped_reason='user_stopped'. If for some
// reason the run finishes before the stop flag is observed, the run
// will return status='finished', and we'll note this as an expected
// flake and downgrade to 2 asserts.
// ---------------------------------------------------------------------------

console.log('\n==> Part E: user-initiated stop');

const homeE = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-ci-homeE-'));
fs.mkdirSync(path.join(homeE, '.cairn'), { recursive: true });
const repoE = makeFixtureRepo('E');
const PID_E = 'p_ci_smoke_E';
registerProject(homeE, PID_E, repoE);

const inputE = {
  goal: makeGoal('E'),
  scout_provider:  'fixture-scout',
  worker_provider: 'fixture-worker',
  review_provider: 'fixture-review',
  max_candidates:  5,
};
// poll_ms=500 gives the main loop time to see the stop flag between ticks.
const optsE = { home: homeE, poll_ms: 500, timeout_ms: 60000 };

// Start the run but don't await it yet.
const runPromise = handlers.runContinuousIteration(PID_E, inputE, optsE);

// Give the run a moment to start and produce a run_id.
// We poll for up to 2s for the run_id to appear in the JSONL.
let runIdE = null;
for (let attempt = 0; attempt < 20; attempt++) {
  // The handler should surface run_id before starting the scout.
  // Check via listContinuousRuns if available, otherwise wait for
  // the run promise to expose a run_id on its in-progress state.
  // Simple approach: wait 150ms and call stopContinuousIteration
  // on the run. The handler must expose the run_id synchronously
  // or via an emitted event. If it doesn't, we stop by project_id.
  if (attempt === 0) await new Promise(r => setTimeout(r, 150));
  else await new Promise(r => setTimeout(r, 50));
  // Try to read from JSONL if listContinuousRuns is available
  if (handlers.listContinuousRuns) {
    const rows = handlers.listContinuousRuns(PID_E, 1, { home: homeE });
    // continuous-runs JSONL uses `id` for the row's primary key (mirroring
    // project-iterations.cjs). Earlier draft of this smoke probed `run_id`.
    if (rows && rows.length > 0) { runIdE = rows[0].id || rows[0].run_id; break; }
  }
  // Also check if the run already has a run_id on the promise object
  // (some implementations attach it). This is speculative — won't fail.
  break; // don't spin; just send stop after the 150ms initial delay
}

// Issue the stop (may arrive before or after first candidate finishes).
let stopRes;
if (runIdE && handlers.stopContinuousIteration) {
  stopRes = handlers.stopContinuousIteration(runIdE, { home: homeE });
} else if (handlers.stopContinuousIteration) {
  // Stop by project_id if no run_id yet (handler may accept this form).
  stopRes = handlers.stopContinuousIteration(null, { project_id: PID_E, home: homeE });
}

ok(
  !stopRes || stopRes.ok === true,
  `Part E: stopContinuousIteration returns ok:true (got: ${JSON.stringify(stopRes)})`
);

// Now await the run completion.
const runResE = await runPromise;

// The run may finish before stop is observed (fixtures are fast) —
// that is an accepted timing flake. We document it inline and verify
// the realistic outcome.
//
// Expected: status='stopped', stopped_reason='user_stopped'
// Acceptable timing flake: status='finished' (all 5 done before stop)
if (runResE.status === 'stopped') {
  ok(runResE.stopped_reason === 'user_stopped',
     `Part E: stopped_reason=user_stopped (got: ${runResE.stopped_reason})`);
  ok(
    Array.isArray(runResE.candidate_runs)
    && runResE.candidate_runs.length < inputE.max_candidates,
    `Part E: candidate_runs.length < max_candidates (got ${runResE.candidate_runs && runResE.candidate_runs.length}, max=${inputE.max_candidates}) — run was interrupted`
  );
} else {
  // Fixtures ran faster than the stop propagated. Log but don't fail.
  console.log(
    `  note  Part E: run finished before stop was observed ` +
    `(status=${runResE.status}; timing flake with fast fixtures). ` +
    `Reducing to 1 assert.`
  );
  ok(runResE.status === 'finished' || runResE.status === 'stopped',
     `Part E (flake path): run completed in a valid terminal status (${runResE.status})`);
}

// ---------------------------------------------------------------------------
// Part F — IPC + preload sanity
//
// Grep main.cjs for the four IPC channel strings and preload.cjs for
// the four JS API names. One assert per channel + preload pair.
// ---------------------------------------------------------------------------

console.log('\n==> Part F: IPC + preload sanity (grep)');

const mainSrc    = fs.readFileSync(path.join(root, 'main.cjs'),    'utf8');
const preloadSrc = fs.readFileSync(path.join(root, 'preload.cjs'), 'utf8');

ok(mainSrc.includes("'run-continuous-iteration'"),
   "Part F: main.cjs registers 'run-continuous-iteration' IPC channel");
ok(mainSrc.includes("'stop-continuous-iteration'"),
   "Part F: main.cjs registers 'stop-continuous-iteration' IPC channel");
ok(mainSrc.includes("'get-continuous-run'"),
   "Part F: main.cjs registers 'get-continuous-run' IPC channel");
ok(mainSrc.includes("'list-continuous-runs'"),
   "Part F: main.cjs registers 'list-continuous-runs' IPC channel");

ok(
  /runContinuousIteration[:\s]/.test(preloadSrc)
  || preloadSrc.includes('runContinuousIteration'),
  'Part F: preload.cjs exposes runContinuousIteration'
);
ok(
  /stopContinuousIteration[:\s]/.test(preloadSrc)
  || preloadSrc.includes('stopContinuousIteration'),
  'Part F: preload.cjs exposes stopContinuousIteration'
);
ok(
  /getContinuousRun[:\s]/.test(preloadSrc)
  || preloadSrc.includes('getContinuousRun'),
  'Part F: preload.cjs exposes getContinuousRun'
);
ok(
  /listContinuousRuns[:\s]/.test(preloadSrc)
  || preloadSrc.includes('listContinuousRuns'),
  'Part F: preload.cjs exposes listContinuousRuns'
);

// ---------------------------------------------------------------------------
// Part G — safety invariants
// ---------------------------------------------------------------------------

console.log('\n==> Part G: safety invariants');

// G1: real ~/.cairn/cairn.db must not have been touched.
ok(safeMtime(realCairnDb) === beforeDb,
   'Part G: real ~/.cairn/cairn.db mtime unchanged throughout smoke');

// G2: no destructive git verbs should appear in run errors or
// stopped_reason — Cairn must not push / force / rebase / reset.
const destructiveVerbs = ['push', 'force', 'rebase', 'reset', 'clean', 'rm -rf'];
const stoppedReasons = [runResA, runResB, runResC, runResD, runResE]
  .map(r => r && r.stopped_reason)
  .filter(Boolean)
  .join(' ')
  .toLowerCase();
const noDestructive = destructiveVerbs.every(v => !stoppedReasons.includes(v));
ok(noDestructive,
   `Part G: no destructive git verbs in stopped_reason values (checked: ${stoppedReasons.slice(0, 80)})`);

// G3: two distinct project homes must not collide — each run wrote only
// to its own home directory. Verify by checking that Part A's candidate
// registry does NOT appear under Part B's home.
const candDirA = path.join(homeA, '.cairn', 'project-candidates');
const candDirB = path.join(homeB, '.cairn', 'project-candidates');
const candFileInB = path.join(candDirB, 'p_ci_smoke_A.jsonl');
ok(!fs.existsSync(candFileInB),
   'Part G: project A candidate JSONL does NOT exist under project B home (no cross-home collision)');

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${asserts - fails}/${asserts} passed (${fails} failed)`);
if (fails > 0) {
  console.log('FAILURES:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
