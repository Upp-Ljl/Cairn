#!/usr/bin/env node
/**
 * Smoke for the managed-worker loop at the handler layer.
 *
 * Exercises the panel-equivalent IPC entry points that wrap
 * worker-launcher: detect / launch / status poll / extract / review,
 * binding the run to the iteration JSONL via attachWorkerRunToIteration.
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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-mwl-smoke-'));
process.env.HOME = tmpDir;
process.env.USERPROFILE = tmpDir;
os.homedir = () => tmpDir;
fs.mkdirSync(path.join(tmpDir, '.cairn'), { recursive: true });

const handlers = require(path.join(root, 'managed-loop-handlers.cjs'));
const iters    = require(path.join(root, 'project-iterations.cjs'));

// Fixture managed project
const fix = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-mwl-fixture-'));
function git(args) { return spawnSync('git', args, { cwd: fix, encoding: 'utf8' }); }
git(['init']);
git(['config', 'user.email', 'smoke@example.com']);
git(['config', 'user.name', 'Smoke']);
git(['checkout', '-b', 'main']);
fs.writeFileSync(path.join(fix, 'package.json'), JSON.stringify({
  name: 'fix', scripts: { test: 'node -e ""' },
}));
fs.writeFileSync(path.join(fix, 'package-lock.json'), '{}');
fs.writeFileSync(path.join(fix, 'README.md'), '# fix\n');
git(['add', '.']);
git(['commit', '-m', 'initial']);

const PROJECT_ID = 'p_mwl_001';
const reg = {
  projects: [{
    id: PROJECT_ID, label: 'mwl-fix',
    project_root: fix, db_path: '/dev/null', agent_id_hints: [],
  }],
};

// -------- 1. detect-worker-providers
const provs = handlers.detectWorkerProviders();
ok(provs.find(p => p.id === 'fixture-echo' && p.available), 'detect: fixture-echo available');
ok(provs.find(p => p.id === 'claude-code'), 'detect: claude-code listed');

// -------- 2. register + start iteration + generate prompt
const reg1 = handlers.registerManagedProject(reg, PROJECT_ID, {});
ok(reg1.ok, 'register ok');
const start = handlers.startManagedIteration(PROJECT_ID, { goal_id: 'g_x' });
ok(start.ok, 'start iteration');
const ITER_ID = start.iteration.id;

const goal = { id: 'g_x', title: 'Wire up Sentry sample-rate config', desired_outcome: 'pass tests' };
const promptRes = handlers.generateManagedWorkerPrompt(PROJECT_ID, { goal });
ok(promptRes.ok, 'generate prompt ok');
const PROMPT = promptRes.result.prompt;

// -------- 3. launch worker (fixture-echo)
const launch = handlers.launchManagedWorker(PROJECT_ID, {
  provider: 'fixture-echo',
  prompt: PROMPT,
});
ok(launch.ok, 'launch ok');
ok(launch.iteration_id === ITER_ID, 'launch bound to current iteration');
const RUN_ID = launch.run_id;
console.log(`  run_id: ${RUN_ID}`);

// Iteration row should now carry worker_run_id, worker_provider, worker_status, worker_run_dir
const iterAfterLaunch = iters.getIteration(PROJECT_ID, ITER_ID);
ok(iterAfterLaunch.worker_run_id === RUN_ID, 'iteration.worker_run_id stamped');
ok(iterAfterLaunch.worker_provider === 'fixture-echo', 'iteration.worker_provider stamped');
ok(typeof iterAfterLaunch.worker_run_dir === 'string' && iterAfterLaunch.worker_run_dir.includes(RUN_ID),
   'iteration.worker_run_dir stamped');

// -------- 4. wait for fixture-echo exit; getWorkerRun reflects exited
await new Promise(r => setTimeout(r, 800));

// Read iteration BEFORE calling any handler that triggers sync — we
// want to verify the iteration was stale at this point (worker_status
// still 'running' from launch time) so we can prove the sync flips it.
const iterBeforeSync = iters.getIteration(PROJECT_ID, ITER_ID);
ok(iterBeforeSync.worker_status === 'running', 'iteration starts at worker_status=running (pre-sync)');

const runFinal = handlers.getWorkerRun(RUN_ID);
ok(runFinal && runFinal.status === 'exited', `run exited (got ${runFinal && runFinal.status})`);

// Sync invariant: getWorkerRun must converge the iteration row to
// match run.json once the run has reached a terminal status.
const iterAfterSync = iters.getIteration(PROJECT_ID, ITER_ID);
ok(iterAfterSync.worker_status === 'exited', 'iteration.worker_status synced to exited via getWorkerRun');
ok(iterAfterSync.worker_ended_at && iterAfterSync.worker_ended_at >= iterBeforeSync.started_at,
   'iteration.worker_ended_at populated after sync');

// Idempotency: a second getWorkerRun must NOT churn the iteration.
const updatedAtBefore = iterAfterSync.updated_at;
await new Promise(r => setTimeout(r, 50));
handlers.getWorkerRun(RUN_ID);
const iterAfterSecondSync = iters.getIteration(PROJECT_ID, ITER_ID);
ok(iterAfterSecondSync.updated_at === updatedAtBefore, 'sync is idempotent — no extra patch when already synced');

// -------- 5. listWorkerRuns scoped by project
const list = handlers.listWorkerRuns(PROJECT_ID);
ok(list.length === 1 && list[0].run_id === RUN_ID, 'list returns one run for the project');

const listOther = handlers.listWorkerRuns('p_unknown');
ok(listOther.length === 0, 'list returns none for unknown project');

// -------- 6. tailWorkerRun
const tailRes = handlers.tailWorkerRun(RUN_ID, 16384);
ok(tailRes.ok && tailRes.text.includes('Worker Report'), 'tail returns log with Worker Report header');

// -------- 7. extractManagedWorkerReport — automatic from log
const extract = handlers.extractManagedWorkerReport(PROJECT_ID, { run_id: RUN_ID });
ok(extract.ok, 'extract ok');
ok(extract.report.title.includes('auto-extracted'), 'extracted title is tagged');
ok(extract.iteration_id === ITER_ID, 'extracted report bound to iteration');

// Iteration row should now have worker_report_id from the extract path
const iterAfterExtract = iters.getIteration(PROJECT_ID, ITER_ID);
ok(iterAfterExtract.worker_report_id === extract.report.id, 'iteration carries extracted report id');

// -------- 8. continue-managed-iteration-review (collect evidence + review in one)
const cont = await handlers.continueManagedIterationReview(PROJECT_ID, {
  goal,
  pre_pr_gate: { status: 'ready_with_risks', rule_log: [] },
}, { forceDeterministic: true });
ok(cont.ok, 'continue ok');
ok(['continue', 'ready_for_review', 'blocked', 'needs_evidence', 'unknown'].includes(cont.verdict.status),
   'continue: verdict status in closed set');

// -------- 9. stopWorkerRun on already-exited run is safe
const stop = handlers.stopWorkerRun(RUN_ID);
ok(stop.ok && stop.already, 'stop on already-exited run safe');

// -------- 10. error paths
const e1 = handlers.launchManagedWorker('p_no_such', { provider: 'fixture-echo', prompt: 'x' });
ok(!e1.ok && e1.error === 'managed_project_not_found', 'launch: unknown project');
const e2 = handlers.launchManagedWorker(PROJECT_ID, {});
ok(!e2.ok && e2.error === 'provider_required', 'launch: missing provider');

// Launch with no open iteration: complete the existing one first, then try
iters.completeIterationReview(PROJECT_ID, ITER_ID, null, 'continue', 'done', []);
const e3 = handlers.launchManagedWorker(PROJECT_ID, { provider: 'fixture-echo', prompt: PROMPT });
ok(!e3.ok && e3.error === 'no_open_iteration', 'launch: no open iteration → error');

// -------- 11. read-only invariants
ok(safeMtime(realCairnDb) === beforeDb, 'real ~/.cairn/cairn.db mtime unchanged');

// -------- 12. handler module: no SQLite, no Electron
const src = fs.readFileSync(path.join(root, 'managed-loop-handlers.cjs'), 'utf8');
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
ok(!/require\(['"]better-sqlite3/.test(code), 'handlers does not load better-sqlite3');
ok(!/require\(['"]electron/.test(code), 'handlers does not load electron');

// -------- 13. preload + main expose all 8 worker channels
const preload = fs.readFileSync(path.join(root, 'preload.cjs'), 'utf8');
const main    = fs.readFileSync(path.join(root, 'main.cjs'), 'utf8');
for (const name of ['detectWorkerProviders', 'launchManagedWorker', 'getWorkerRun', 'listWorkerRuns',
                    'stopWorkerRun', 'tailWorkerRun', 'extractWorkerReport',
                    'continueManagedIterationReview']) {
  ok(preload.includes(name + ':'), `preload exposes ${name}`);
}
for (const ch of ['detect-worker-providers', 'launch-managed-worker', 'get-worker-run',
                  'list-worker-runs', 'stop-worker-run', 'tail-worker-run',
                  'extract-worker-report', 'continue-managed-iteration-review']) {
  ok(main.includes(`'${ch}'`), `main registers ipc '${ch}'`);
}

console.log(`\n${asserts - fails}/${asserts} passed (${fails} failed)`);
if (fails) { console.log('FAILURES:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }
