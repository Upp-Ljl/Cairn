#!/usr/bin/env node
/**
 * Smoke for Three-Stage Loop Day 3 — Worker Bind.
 *
 * Part A — generateWorkerPrompt unit tests (pure)
 * Part B — pickCandidateAndLaunchWorker state-machine paths
 * Part C — fixture-worker end-to-end (real spawn + real file write)
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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-worker-bind-smoke-'));
os.homedir = () => tmpDir;
fs.mkdirSync(path.join(tmpDir, '.cairn'), { recursive: true });

const handlers     = require(path.join(root, 'managed-loop-handlers.cjs'));
const launcher     = require(path.join(root, 'worker-launcher.cjs'));
const candidates   = require(path.join(root, 'project-candidates.cjs'));
const workerPrompt = require(path.join(root, 'worker-prompt.cjs'));

console.log('==> Part A: generateWorkerPrompt unit tests');

function buildPromptFor(kind, opts) {
  return workerPrompt.generateWorkerPrompt({
    goal: { id: 'g', title: 'Smoke worker', desired_outcome: '' },
    project_rules: { non_goals: [] },
    recent_reports: [],
  }, Object.assign({
    candidate: {
      id: 'c_aaa111',
      description: 'Add a header comment to src/index.ts',
      candidate_kind: kind,
      source_run_id: 'wr_scout_REDACTED',  // must NOT leak into prompt
    },
    managed_record: null,
    forceDeterministic: true,
  }, opts || {}));
}

const p_bug   = buildPromptFor('bug_fix');
const p_test  = buildPromptFor('missing_test');
const p_ref   = buildPromptFor('refactor');
const p_doc   = buildPromptFor('doc');
const p_other = buildPromptFor('other');

ok(p_bug.is_worker === true && p_bug.mode === 'worker', 'is_worker + mode set');
ok(p_bug.candidate_id === 'c_aaa111', 'candidate_id surfaced on output');

// Each kind injects its own tone keyword.
ok(/conservative|MINIMUM\s+diff/i.test(p_bug.prompt),     'bug_fix tone: conservative/minimum diff');
ok(/tests only|do NOT modify implementation/i.test(p_test.prompt), 'missing_test tone: tests only');
ok(/behavior MUST NOT change|behavior-preserving/i.test(p_ref.prompt), 'refactor tone: behavior preserved');
ok(/documentation only|do NOT touch code files/i.test(p_doc.prompt),   'doc tone: documentation only');
ok(/proceed conservatively/i.test(p_other.prompt),         'other tone: conservative fallback');

// Candidate id and description are spliced in.
ok(p_bug.prompt.includes('c_aaa111'), 'candidate id appears in prompt');
ok(p_bug.prompt.includes('Add a header comment to src/index.ts'), 'candidate description appears in prompt');

// Required headers + echo prefix.
ok(p_bug.prompt.includes(workerPrompt.WORKER_REPORT_HEADER), 'WORKER_REPORT_HEADER in prompt');
ok(workerPrompt.WORKER_REPORT_HEADER === '## Worker Report', 'WORKER_REPORT_HEADER constant value');
ok(workerPrompt.CANDIDATE_ECHO_PREFIX === 'cairn-candidate-id:', 'CANDIDATE_ECHO_PREFIX constant value');
ok(p_bug.prompt.includes(workerPrompt.CANDIDATE_ECHO_PREFIX + ' c_aaa111'),
   'echo line "cairn-candidate-id: <id>" required by prompt');

// source_run_id from the candidate must NOT leak into the worker prompt.
ok(!p_bug.prompt.includes('wr_scout_REDACTED'), 'source_run_id NOT leaked into worker prompt');

// Guard: missing candidate or fields throws.
let threw = false;
try { workerPrompt.generateWorkerPrompt({}, {}); } catch (_e) { threw = true; }
ok(threw, 'generateWorkerPrompt without candidate throws');
threw = false;
try { workerPrompt.generateWorkerPrompt({}, { candidate: { id: 'x' } }); } catch (_e) { threw = true; }
ok(threw, 'generateWorkerPrompt without description throws');

// Unknown kind defaults to "other" tone.
const p_unk = buildPromptFor('made_up_kind');
ok(/proceed conservatively/i.test(p_unk.prompt), 'unknown kind falls back to other tone');

console.log('\n==> Part B: pickCandidateAndLaunchWorker state-machine');

// Build a fixture managed project + a candidate to pick.
function makeFixtureRepo() {
  const fix = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-wb-fixture-'));
  function git(args) { return spawnSync('git', args, { cwd: fix, encoding: 'utf8' }); }
  git(['init']);
  git(['config', 'user.email', 'smoke@example.com']);
  git(['config', 'user.name', 'Smoke']);
  git(['checkout', '-b', 'main']);
  fs.writeFileSync(path.join(fix, 'package.json'), JSON.stringify({ name: 'fix' }));
  fs.writeFileSync(path.join(fix, 'package-lock.json'), '{}');
  fs.writeFileSync(path.join(fix, 'README.md'), '# fix\n');
  git(['add', '.']);
  git(['commit', '-m', 'initial']);
  return fix;
}

const fix1 = makeFixtureRepo();
const PID = 'p_wb_smoke';
const reg = {
  projects: [{
    id: PID, label: 'wb-fix',
    project_root: fix1, db_path: '/dev/null', agent_id_hints: [],
  }],
};
handlers.registerManagedProject(reg, PID, {});

// Seed a candidate.
const c1 = candidates.proposeCandidate(PID, {
  description: 'Add a comment to README explaining smoke purpose.',
  candidate_kind: 'doc',
  source_iteration_id: 'i_scout_x',
  source_run_id: 'wr_scout_x',
});
ok(c1.ok, 'seed candidate proposed');

// B.1 — error: candidate_not_found
const e1 = handlers.pickCandidateAndLaunchWorker(PID, {
  candidate_id: 'c_does_not_exist', provider: 'fixture-worker',
});
ok(!e1.ok && e1.error === 'candidate_not_found', 'candidate_not_found returns stable error');

// B.2 — error: missing inputs
const e2 = handlers.pickCandidateAndLaunchWorker(PID, { provider: 'fixture-worker' });
ok(!e2.ok && e2.error === 'candidate_id_required', 'missing candidate_id rejected');
const e3 = handlers.pickCandidateAndLaunchWorker(PID, { candidate_id: c1.candidate.id });
ok(!e3.ok && e3.error === 'provider_required', 'missing provider rejected');

// B.3 — error: launch_failed (unknown provider) — candidate stays PICKED
const e4 = handlers.pickCandidateAndLaunchWorker(PID, {
  candidate_id: c1.candidate.id, provider: 'no-such-provider',
});
ok(!e4.ok && e4.error === 'launch_failed', 'unknown provider → launch_failed');
ok(e4.candidate_status === 'PICKED', 'launch_failed: candidate status reported as PICKED');
const c1AfterFail = candidates.getCandidate(PID, c1.candidate.id);
ok(c1AfterFail.status === 'PICKED', 'candidate is persisted at PICKED after launch_failed (no auto-rollback)');
ok(c1AfterFail.worker_iteration_id == null, 'candidate.worker_iteration_id remains null after launch_failed');

// B.4 — error: candidate_not_proposed (already PICKED from B.3)
const e5 = handlers.pickCandidateAndLaunchWorker(PID, {
  candidate_id: c1.candidate.id, provider: 'fixture-worker',
});
ok(!e5.ok && e5.error === 'candidate_not_proposed', 'second pick rejected: candidate_not_proposed');
ok(e5.current_status === 'PICKED', 'error detail includes current_status=PICKED');

// B.5a — looking up an unknown id from a different project comes back
// candidate_not_found (each project has its own JSONL file).
const c2 = candidates.proposeCandidate(PID, { description: 'mismatch test', candidate_kind: 'doc' });
const e6a = handlers.pickCandidateAndLaunchWorker('p_other_no_file', {
  candidate_id: c2.candidate.id, provider: 'fixture-worker',
});
ok(!e6a.ok && e6a.error === 'candidate_not_found',
   'cross-project lookup with no destination file → candidate_not_found');

// B.5b — defensive project_id_mismatch path: hand-craft a JSONL line
// whose stored project_id disagrees with its filename. This triggers
// the handler's step-ii check (step iii of the contract).
const mismatchPid = 'p_mismatch_dst';
const mismatchFile = candidates.candFile
  ? candidates.candFile(mismatchPid)
  : path.join(tmpDir, '.cairn', 'project-candidates', mismatchPid + '.jsonl');
fs.mkdirSync(path.dirname(mismatchFile), { recursive: true });
const forgedRow = {
  id: 'c_forged_aaa',
  project_id: 'p_someone_else',  // ← disagrees with the filename
  source_iteration_id: null,
  source_run_id: null,
  description: 'forged for mismatch test',
  candidate_kind: 'doc',
  status: 'PROPOSED',
  worker_iteration_id: null,
  review_iteration_id: null,
  created_at: Date.now(),
  updated_at: Date.now(),
};
fs.writeFileSync(mismatchFile, JSON.stringify(forgedRow) + '\n');
const e6b = handlers.pickCandidateAndLaunchWorker(mismatchPid, {
  candidate_id: 'c_forged_aaa', provider: 'fixture-worker',
});
ok(!e6b.ok && e6b.error === 'project_id_mismatch',
   'forged row whose project_id disagrees with file → project_id_mismatch');

// B.6 — error: managed_project_not_found
const regOrphan = {
  projects: [{ id: 'p_orphan', label: 'orphan', project_root: '/nope', db_path: '/dev/null', agent_id_hints: [] }],
};
const cOrphan = candidates.proposeCandidate('p_orphan', { description: 'orphan', candidate_kind: 'doc' });
const e7 = handlers.pickCandidateAndLaunchWorker('p_orphan', {
  candidate_id: cOrphan.candidate.id, provider: 'fixture-worker',
});
ok(!e7.ok && e7.error === 'managed_project_not_found', 'managed_project_not_found rejected');

console.log('\n==> Part C: fixture-worker end-to-end');

// Provider catalog includes fixture-worker.
const provs = launcher.detectWorkerProviders();
ok(provs.find(p => p.id === 'fixture-worker' && p.available), 'fixture-worker available');

// Fresh repo + fresh candidate (the previous one is locked at PICKED).
const fix2 = makeFixtureRepo();
const PID2 = 'p_wb_e2e';
const reg2 = {
  projects: [{
    id: PID2, label: 'wb-fix-2',
    project_root: fix2, db_path: '/dev/null', agent_id_hints: [],
  }],
};
handlers.registerManagedProject(reg2, PID2, {});
const c3 = candidates.proposeCandidate(PID2, {
  description: 'Touch a marker file demonstrating worker bind',
  candidate_kind: 'other',
  source_iteration_id: 'i_scout_z',
  source_run_id: 'wr_scout_z',
});
ok(c3.ok && c3.candidate.status === 'PROPOSED', 'fresh candidate is PROPOSED');

const launchRes = handlers.pickCandidateAndLaunchWorker(PID2, {
  candidate_id: c3.candidate.id, provider: 'fixture-worker',
});
ok(launchRes.ok, `pick + launch ok (${launchRes.error || ''})`);
ok(launchRes.candidate_status === 'WORKING', 'returned candidate_status === WORKING');
ok(launchRes.run_id && /^wr_/.test(launchRes.run_id), 'run_id looks valid');
ok(launchRes.worker_iteration_id && /^i_/.test(launchRes.worker_iteration_id), 'worker_iteration_id looks valid');

// Wait for fixture-worker to exit + verify state.
await new Promise(r => setTimeout(r, 1000));
const finalRun = handlers.getWorkerRun(launchRes.run_id);
ok(finalRun && finalRun.status === 'exited', `fixture-worker exited (status=${finalRun && finalRun.status})`);

const c3After = candidates.getCandidate(PID2, c3.candidate.id);
ok(c3After.status === 'WORKING', 'candidate now WORKING');
ok(c3After.worker_iteration_id === launchRes.worker_iteration_id, 'candidate.worker_iteration_id stamped');

// fixture-worker writes a marker file in cwd. Verify it landed in fix2.
const marker = path.join(fix2, 'cairn-worker-fixture-touched.txt');
ok(fs.existsSync(marker), 'fixture-worker wrote marker file in cwd');
const markerContent = fs.readFileSync(marker, 'utf8');
ok(markerContent.includes('cairn-candidate-id: ' + c3.candidate.id),
   'marker file content includes candidate id');

// Tail log + Worker Report extraction.
const tailRes = handlers.tailWorkerRun(launchRes.run_id, 16384);
ok(tailRes.ok && tailRes.text.includes('## Worker Report'), 'tail contains Worker Report header');
const ext = handlers.extractManagedWorkerReport(PID2, { run_id: launchRes.run_id });
ok(ext.ok, 'extractManagedWorkerReport ok on fixture-worker output');
ok(ext.report.completed.some(b => b.includes('cairn-candidate-id: ' + c3.candidate.id)),
   'Worker Report Completed[0] echoes candidate id');

console.log('\n==> Part D: IPC + preload exposure');

const preload = fs.readFileSync(path.join(root, 'preload.cjs'), 'utf8');
ok(/pickCandidateAndLaunchWorker:\s/.test(preload), 'preload exposes pickCandidateAndLaunchWorker');
const main = fs.readFileSync(path.join(root, 'main.cjs'), 'utf8');
ok(main.includes("'pick-candidate-and-launch-worker'"), 'main.cjs registers pick-candidate-and-launch-worker IPC');

console.log('\n==> Part E: safety invariants');

ok(safeMtime(realCairnDb) === beforeDb, 'real ~/.cairn/cairn.db mtime unchanged');

const wpSrc = fs.readFileSync(path.join(root, 'worker-prompt.cjs'), 'utf8');
const wpCode = wpSrc.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
ok(!/require\(['"]better-sqlite3/.test(wpCode), 'worker-prompt does not import better-sqlite3');
ok(!/require\(['"]electron/.test(wpCode), 'worker-prompt does not import electron');
ok(!/require\(['"]child_process/.test(wpCode), 'worker-prompt does not import child_process');

console.log(`\n${asserts - fails}/${asserts} passed (${fails} failed)`);
if (fails) { console.log('FAILURES:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }
