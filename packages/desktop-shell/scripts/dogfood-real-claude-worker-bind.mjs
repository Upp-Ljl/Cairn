#!/usr/bin/env node
/**
 * Real-Claude Worker-Bind Dogfood — Three-Stage Loop / Day 3.
 *
 * Three-Stage Loop's first MUTATION round runs against a fresh
 * temp git repo, NOT against agent-game-platform. Reasons:
 *   - Day 3 is the first time Cairn launches a worker that is
 *     authorized to write files. The blast radius of an LLM
 *     deviation is real; we keep it bounded.
 *   - agent-game-platform is the user's long-lived dogfood target
 *     for repeated rounds; we don't want to season it with
 *     half-implemented test changes from a smoke run.
 *   - A throwaway repo proves the same handler + IPC + bind path
 *     while staying disposable: cleanup is `fs.rmSync(tmp, ...)`.
 *
 * Pre-flight: mktemp + git init + minimal package.json + README +
 * src/index.ts + initial commit. Cleanup at the end. We do NOT push,
 * NOT add a remote, NOT clone — there is intentionally no remote on
 * the temp repo, so even an accidental `git push` from the worker
 * (forbidden by prompt rules anyway) would fail loudly.
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
  const cairnTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-dogfood-wb-'));
  os.homedir = () => cairnTmp;
  fs.mkdirSync(path.join(cairnTmp, '.cairn'), { recursive: true });
  console.log(`(sandboxed Cairn writes: ${cairnTmp}; child inherits real HOME)`);
}

const handlers     = require(path.join(root, 'managed-loop-handlers.cjs'));
const launcher     = require(path.join(root, 'worker-launcher.cjs'));
const candidates   = require(path.join(root, 'project-candidates.cjs'));

console.log('\n========================================');
console.log('  Cairn Real-Claude Worker-Bind Dogfood (Day 3)');
console.log('========================================');

// -------- Build a throwaway target repo --------

const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-day3-target-'));
console.log(`Temp repo: ${tempRepo}`);

function git(args) { return spawnSync('git', args, { cwd: tempRepo, encoding: 'utf8' }); }
git(['init']);
git(['config', 'user.email', 'dogfood@example.local']);
git(['config', 'user.name', 'Cairn Day3 Dogfood']);
git(['checkout', '-b', 'main']);
fs.mkdirSync(path.join(tempRepo, 'src'));
fs.writeFileSync(path.join(tempRepo, 'package.json'), JSON.stringify({
  name: 'cairn-day3-target',
  version: '0.1.0',
  scripts: { build: 'echo build', test: 'echo test' },
}, null, 2));
fs.writeFileSync(path.join(tempRepo, 'package-lock.json'), '{}');
fs.writeFileSync(path.join(tempRepo, 'README.md'),
  '# cairn-day3-target\n\nThrowaway target for the Three-Stage Loop Day 3 dogfood. Created and deleted by the dogfood script.\n');
fs.writeFileSync(path.join(tempRepo, 'src', 'index.ts'),
  'export function hello() {\n  return "hello";\n}\n');
git(['add', '.']);
git(['commit', '-m', 'initial']);

const preHead   = git(['rev-parse', 'HEAD']).stdout.trim();
const preBranch = git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
const preStatus = git(['status', '--short']).stdout;
console.log('\n[pre-flight]');
console.log(`  HEAD:    ${preHead}`);
console.log(`  branch:  ${preBranch}`);
console.log(`  status:  ${preStatus.trim() || '(clean)'}`);

// Detect real claude
const provs = launcher.detectWorkerProviders();
const claude = provs.find(p => p.id === 'claude-code');
ok(claude && claude.available, 'claude-code available on this machine');
if (!claude || !claude.available) {
  console.log('FAIL: claude-code not on PATH; aborting (cleaning up temp repo).');
  fs.rmSync(tempRepo, { recursive: true, force: true });
  process.exit(1);
}

// Register the temp repo as a managed project.
const PID = 'p_dogfood_day3';
const reg = {
  projects: [{
    id: PID, label: 'cairn-day3-target',
    project_root: tempRepo, db_path: '/dev/null', agent_id_hints: [],
  }],
};
const r = handlers.registerManagedProject(reg, PID, {});
ok(r.ok, 'register temp repo as managed project ok');

// Hand-seed a candidate (skipping Scout — Day 3 only validates Worker bind).
const c = candidates.proposeCandidate(PID, {
  description: 'Add a one-line comment header to src/index.ts explaining the file purpose. Do NOT change any function body.',
  candidate_kind: 'doc',
  source_iteration_id: 'i_manual_seed',
  source_run_id: 'wr_manual_seed',
});
ok(c.ok, 'seed candidate proposed');
console.log(`  candidate: ${c.candidate.id}`);

// Pick + launch real claude-code.
console.log('\n[launch] pickCandidateAndLaunchWorker(provider=claude-code)');
const t0 = Date.now();
const launchRes = handlers.pickCandidateAndLaunchWorker(PID, {
  candidate_id: c.candidate.id,
  provider: 'claude-code',
});
ok(launchRes.ok, `launch ok (${launchRes.error || ''})`);
if (!launchRes.ok) {
  console.log('FAIL: launch did not succeed; cleaning up.');
  fs.rmSync(tempRepo, { recursive: true, force: true });
  process.exit(1);
}
const RUN_ID = launchRes.run_id;
const ITER_ID = launchRes.worker_iteration_id;
console.log(`  run_id:                  ${RUN_ID}`);
console.log(`  worker_iteration_id:     ${ITER_ID}`);
console.log(`  returned candidate_status: ${launchRes.candidate_status}`);
ok(launchRes.candidate_status === 'WORKING', 'launch returned candidate_status=WORKING');

// Poll until exit.
console.log('\n[poll] up to 4 min');
let final = null, stopped = false;
while ((Date.now() - t0) < MAX_WAIT_MS) {
  await new Promise(r => setTimeout(r, POLL_MS));
  final = handlers.getWorkerRun(RUN_ID);
  if (!final) break;
  if (final.status !== 'running' && final.status !== 'queued') break;
  process.stdout.write(`  · ${Math.floor((Date.now() - t0) / 1000)}s elapsed, status=${final.status}\r`);
}
if (!final) final = handlers.getWorkerRun(RUN_ID);
console.log('');
const elapsed = Math.floor((Date.now() - t0) / 1000);
if (final && (final.status === 'running' || final.status === 'queued')) {
  console.log(`  worker still running after ${elapsed}s — stopping`);
  handlers.stopWorkerRun(RUN_ID);
  await new Promise(r => setTimeout(r, 1000));
  final = handlers.getWorkerRun(RUN_ID);
  stopped = true;
}
console.log(`  elapsed: ${elapsed}s · status: ${final && final.status} · exit: ${final && final.exit_code}`);
ok(final && (final.status === 'exited' || final.status === 'failed' || final.status === 'stopped'),
   'final status is terminal');

// Tail + secret-leak grep.
const tailRes = handlers.tailWorkerRun(RUN_ID, 16384);
ok(tailRes.ok && tailRes.text.length > 0, 'tail non-empty');
const tail = tailRes.text;
const leaks = [
  ['ANTHROPIC_API_KEY', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['OpenAI sk-',         /\bsk-[A-Za-z0-9]{40,}\b/],
  ['GitHub PAT',         /\bghp_[A-Za-z0-9]{20,}\b/],
  ['Bearer header',      /Bearer\s+[A-Za-z0-9_\-\.]{30,}/],
];
for (const [name, rx] of leaks) ok(!rx.test(tail), `tail does NOT contain ${name}`);

// Worker Report extraction.
const ext = handlers.extractManagedWorkerReport(PID, { run_id: RUN_ID });
if (!ext.ok) {
  console.log(`  extract failed: ${ext.error}`);
  console.log('  --- last 12 lines of tail ---');
  console.log(tail.split(/\r?\n/).slice(-12).map(l => '  | ' + l).join('\n'));
  ok(false, `extractManagedWorkerReport failed: ${ext.error}`);
} else {
  ok(true, 'extractManagedWorkerReport ok');
  const echoLine = (ext.report.completed || []).find(b => b.includes('cairn-candidate-id:'));
  ok(!!echoLine, 'Worker Report Completed includes cairn-candidate-id echo');
  ok(echoLine && echoLine.includes(c.candidate.id),
     'echoed candidate id matches the one we picked');
}

// Candidate state checks.
const cAfter = candidates.getCandidate(PID, c.candidate.id);
ok(cAfter.status === 'WORKING', 'candidate is WORKING after launch');
ok(cAfter.worker_iteration_id === ITER_ID, 'candidate.worker_iteration_id stamped');

// Post-flight: temp repo should have changed files (worker did write)
// AND no new commits AND changes confined to src/ or *.md files.
const postHead   = git(['rev-parse', 'HEAD']).stdout.trim();
const postStatus = git(['status', '--short']).stdout;
console.log('\n[post-flight]');
console.log(`  HEAD:    ${postHead}`);
console.log(`  status:`);
postStatus.split('\n').filter(Boolean).forEach(l => console.log(`    ${l}`));
ok(preHead === postHead, 'no new commits (worker did not git commit)');
ok(postStatus.trim() !== '', 'temp repo has working-tree changes (worker actually modified files)');

const changed = postStatus.split('\n').filter(Boolean).map(l => l.replace(/^.{2}\s+/, '').trim());
const allInScope = changed.every(p =>
  p.startsWith('src/') || p.endsWith('.md') || p === 'src/index.ts' || p.startsWith('docs/'));
ok(allInScope, `all changed files within candidate scope (changed: ${changed.join(', ')})`);

// Cleanup.
console.log('\n[cleanup] removing temp repo');
let cleanupOk = true;
try { fs.rmSync(tempRepo, { recursive: true, force: true }); }
catch (e) { cleanupOk = false; console.log(`  cleanup error: ${e.message}`); }
ok(cleanupOk && !fs.existsSync(tempRepo), 'temp repo cleaned up');

console.log('\n========================================');
console.log(`  ${asserts - fails}/${asserts} assertions passed (${fails} failed)`);
if (stopped) console.log('  NOTE: worker was stopped (timeout)');
console.log('========================================\n');

if (fails) { console.log('FAILURES:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }
