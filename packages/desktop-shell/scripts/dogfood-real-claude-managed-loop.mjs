#!/usr/bin/env node
/**
 * Real-Claude-Code Managed Loop Dogfood.
 *
 * Drives the same IPC handlers the panel buttons hit, but with the
 * REAL claude-code provider and a tightly constrained read-only
 * prompt. The point is to verify the launch / tail / extract /
 * review pipeline against an actual LLM round, not to improve
 * agent-game-platform.
 *
 * Constraints baked into the prompt:
 *   - read-only round (no file mutations)
 *   - no git commit / push
 *   - no installs
 *   - must emit a `## Worker Report` block at the end
 *
 * We sandbox HOME (so this dogfood doesn't pollute the user's real
 * ~/.cairn) but launch against the real cloned repo so we exercise
 * real spawn + cwd. Pass --use-real-home to write to the real
 * ~/.cairn (this lets the desktop panel see the new iteration).
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
const localPath = process.env.CAIRN_DOGFOOD_REPO_PATH || 'D:/lll/managed-projects/agent-game-platform';
const repoUrl = 'https://github.com/anzy-renlab-ai/agent-game-platform.git';
const POLL_MS = 1000;
const MAX_WAIT_MS = 240000; // 4 minutes

let asserts = 0, fails = 0;
const failures = [];
function ok(c, l) { asserts++; if (c) console.log(`  ok    ${l}`); else { fails++; failures.push(l); console.log(`  FAIL  ${l}`); } }

if (!useRealHome) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-real-claude-'));
  // Override the JS os.homedir() so Cairn's path writes go to tmpDir.
  // Deliberately DO NOT touch process.env.HOME / process.env.USERPROFILE:
  // the spawned worker inherits process.env, and claude.cmd needs to
  // find its real ~/.claude/.credentials.json via the real HOME or it
  // will exit with "Not logged in".
  os.homedir = () => tmpDir;
  fs.mkdirSync(path.join(tmpDir, '.cairn'), { recursive: true });
  console.log(`(sandboxed Cairn writes: ${tmpDir}; child inherits real HOME for credentials)`);
}

const handlers = require(path.join(root, 'managed-loop-handlers.cjs'));

console.log('\n========================================');
console.log('  Cairn Real-Claude Managed Loop Dogfood');
console.log('========================================');
console.log(`Target repo:   ${repoUrl}`);
console.log(`Local path:    ${localPath}`);

// ---- Pre-flight: capture git state of the managed repo BEFORE the run ----

function gitProbe(args) {
  return spawnSync('git', args, { cwd: localPath, encoding: 'utf8' });
}
const preHead   = gitProbe(['rev-parse', 'HEAD']).stdout.trim();
const preStatus = gitProbe(['status', '--short']).stdout;
const preBranch = gitProbe(['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
console.log('\n[pre-flight] managed repo state');
console.log(`  HEAD:    ${preHead}`);
console.log(`  branch:  ${preBranch}`);
console.log(`  status:  ${preStatus.trim() || '(clean)'}`);

// ---- 1. Detect providers ----
console.log('\n[1] detect-worker-providers');
const provs = handlers.detectWorkerProviders();
for (const p of provs) {
  console.log(`  - ${p.id.padEnd(14)} ${p.available ? 'available' : 'unavailable'} ${p.resolved_path || ''}`);
}
const claude = provs.find(p => p.id === 'claude-code');
ok(claude && claude.available, 'claude-code available on this machine');
if (!claude || !claude.available) {
  console.log('FAIL: claude-code not on PATH; aborting real-Claude dogfood.');
  process.exit(1);
}

// ---- 2. Register the project ----
const PROJECT_ID = 'p_real_claude_agp';
const reg = {
  projects: [{
    id: PROJECT_ID,
    label: 'agent-game-platform (real-claude dogfood)',
    project_root: localPath,
    db_path: '/dev/null',
    agent_id_hints: [],
  }],
};
console.log('\n[2] register');
const r = handlers.registerManagedProject(reg, PROJECT_ID, {});
ok(r.ok, 'register ok');
ok(r.record.profile && r.record.profile.package_manager === 'bun', 'profile has bun pm');

// ---- 3. Start iteration ----
const startRes = handlers.startManagedIteration(PROJECT_ID, { goal_id: 'g_real_dogfood' });
ok(startRes.ok, 'iteration started');
const ITER_ID = startRes.iteration.id;
console.log(`  iteration: ${ITER_ID}`);

// ---- 4. Build a tightly constrained prompt ----
//
// We use generateManagedWorkerPrompt to get the standard scaffolding,
// then PREPEND a hard-rules block. This way the agent sees the
// Cairn-built non_goals + acceptance plus our explicit "read-only"
// scoping at the very top.

const goal = {
  id: 'g_real_dogfood',
  title: 'Read-only investigation of agent-game-platform tests directory (Cairn dogfood)',
  desired_outcome: 'Identify what tests exist and propose ONE small follow-up improvement, in a Worker Report block at the end of your run. No file modifications this round.',
  success_criteria: [
    'List the test files under the project (max 10).',
    'Identify ONE small follow-up that a future round could pick up.',
    'Emit a `## Worker Report` block exactly as instructed.',
  ],
  non_goals: ['Do not modify any file in this round; this is a read-only investigation.'],
};
const rules = {
  version: 1,
  coding_standards: ['Read-only round; no file edits.'],
  testing_policy: ['Do NOT run any test command this round.'],
  reporting_policy: ['Emit a `## Worker Report` block with the four standard sections; nothing else after it.'],
  pre_pr_checklist: ['No file changes; no commits; no pushes.'],
  non_goals: [
    'Do not write or edit any file in agent-game-platform.',
    'Do not git commit, git add, or git push anything.',
    'Do not run npm/bun/pnpm/yarn install.',
    'Do not modify Cairn itself.',
  ],
  updated_at: Date.now(),
};

const promptRes = handlers.generateManagedWorkerPrompt(PROJECT_ID, { goal, project_rules: rules });
ok(promptRes.ok, 'prompt generated');

const HARD_RULES = [
  '# CAIRN DOGFOOD — READ-ONLY ROUND',
  '',
  'You are being launched by Cairn for a single read-only investigation round.',
  'STRICT RULES — violating any of these means stop immediately and emit a Worker Report explaining why:',
  '',
  '1. DO NOT modify, create, or delete any file in this repository.',
  '2. DO NOT run `git commit`, `git add`, `git push`, `git rebase`, or `git reset`.',
  '3. DO NOT run `npm/bun/pnpm/yarn install` or any installer.',
  '4. DO NOT run tests, builds, or dev servers (you may LIST them).',
  '5. ONLY use Read / Glob / Grep / LS / Bash for read-only inspection.',
  '6. Keep the response under ~30 lines of substance.',
  '7. End your response with EXACTLY this block (and nothing after it):',
  '',
  '## Worker Report',
  '### Completed',
  '- <one or two bullets>',
  '### Remaining',
  '- <what a future round could do>',
  '### Blockers',
  '- <any, or leave empty>',
  '### Next',
  '- <one bullet for the next round>',
  '',
  '# YOUR TASK',
  '',
  'Look at the `tests/` directory of this Next.js + bun project. List up to 10 test files (just paths, do not open more than 2). Identify ONE small follow-up improvement that a future round could pick up (e.g. "add coverage for X.test.ts" or "tests/foo.test.ts has no assertions"). Output the Worker Report block as the final thing in your response.',
  '',
  '# CAIRN-BUILT CONTEXT (advisory)',
  '',
].join('\n');

const finalPrompt = HARD_RULES + promptRes.result.prompt;
console.log(`\n[3] prompt prepared: ${finalPrompt.length} chars (${HARD_RULES.length} rules + ${promptRes.result.prompt.length} pack)`);

// ---- 5. Launch real claude-code ----
console.log('\n[4] launch real claude-code');
const t0 = Date.now();
const launchRes = handlers.launchManagedWorker(PROJECT_ID, {
  provider: 'claude-code',
  prompt: finalPrompt,
});
ok(launchRes.ok, `launch ok (${launchRes.error || ''})`);
if (!launchRes.ok) {
  console.log('FAIL: launch did not succeed');
  process.exit(1);
}
const RUN_ID = launchRes.run_id;
console.log(`  run_id:        ${RUN_ID}`);
console.log(`  iteration_id:  ${launchRes.iteration_id}`);
console.log(`  status:        ${launchRes.run.status}`);
console.log(`  resolved_exe:  ${launchRes.run.resolved_exe}`);

// ---- 6. Poll until exit (or timeout) ----
console.log('\n[5] polling run status (up to 4 min)…');
let final = null;
let stopped = false;
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
  console.log(`  worker still running after ${elapsed}s — calling stopWorkerRun`);
  const sres = handlers.stopWorkerRun(RUN_ID);
  console.log(`  stop result: ${JSON.stringify(sres)}`);
  await new Promise(r => setTimeout(r, 1000));
  final = handlers.getWorkerRun(RUN_ID);
  stopped = true;
}

console.log(`\n  elapsed:   ${elapsed}s`);
console.log(`  status:    ${final && final.status}`);
console.log(`  exit_code: ${final && final.exit_code}`);
console.log(`  pid:       ${final && final.pid}`);
console.log(`  ended_at:  ${final && final.ended_at}`);

ok(final && (final.status === 'exited' || final.status === 'failed' || final.status === 'stopped'),
   'final status is terminal (exited / failed / stopped)');

// ---- 7. Tail log ----
console.log('\n[6] tail log');
const tailRes = handlers.tailWorkerRun(RUN_ID, 16384);
ok(tailRes.ok, 'tail ok');
const tail = (tailRes.text || '');
console.log(`  log bytes (last):   ${tail.length}`);
ok(tail.length > 0, 'tail is non-empty');

// Print tail head + tail
const tailLines = tail.split(/\r?\n/);
console.log('  --- first 8 lines ---');
console.log(tailLines.slice(0, 8).map(l => '  | ' + l).join('\n'));
console.log('  --- last 16 lines ---');
console.log(tailLines.slice(-16).map(l => '  | ' + l).join('\n'));

// ---- 8. Secret-leak check on tail ----
const leaks = [
  ['ANTHROPIC_API_KEY', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['OpenAI sk-',         /\bsk-[A-Za-z0-9]{40,}\b/],
  ['GitHub PAT',         /\bghp_[A-Za-z0-9]{20,}\b/],
  ['Bearer header',      /Bearer\s+[A-Za-z0-9_\-\.]{30,}/],
];
for (const [name, rx] of leaks) {
  ok(!rx.test(tail), `tail does NOT contain ${name}`);
}

// ---- 9. Extract Worker Report ----
console.log('\n[7] extract Worker Report from tail.log');
const extract = handlers.extractManagedWorkerReport(PROJECT_ID, { run_id: RUN_ID });
let extractOk = !!(extract && extract.ok);
let manualReportId = null;
if (extractOk) {
  ok(true, 'extract ok');
  console.log(`  report_id:        ${extract.report.id}`);
  console.log(`  completed:        ${extract.report.completed.length}`);
  console.log(`  remaining:        ${extract.report.remaining.length}`);
  console.log(`  blockers:         ${extract.report.blockers.length}`);
  console.log(`  next_steps:       ${extract.report.next_steps.length}`);
  for (const c of extract.report.completed.slice(0, 3)) console.log(`    completed: ${c}`);
} else {
  ok(false, `extract failed: ${extract && extract.error}`);
  // Fallback: build a minimal manual report from the tail so the
  // review still has something to chew on. We mark the title to
  // make it obvious this was not auto-extracted.
  console.log(`  extract_failure_reason: ${extract && extract.error}`);
  const wr = require(path.join(root, 'worker-reports.cjs'));
  const lastLines = tailLines.slice(-30).filter(Boolean);
  const manual = wr.normalizeReport(PROJECT_ID, {
    title: '[manual-fallback] Real Claude run — extract failed',
    completed: ['Real claude-code run completed; tail log captured.'],
    remaining: ['Extract failed; see tail.log for raw output.'],
    blockers: [`extract returned: ${extract && extract.error}`],
    next_steps: lastLines.slice(-5),
    source_app: 'cairn-dogfood-fallback',
  });
  const append = wr.addWorkerReport(PROJECT_ID, manual);
  if (append.ok) {
    manualReportId = append.report.id;
    const iters = require(path.join(root, 'project-iterations.cjs'));
    iters.attachWorkerReport(PROJECT_ID, ITER_ID, manualReportId);
    console.log(`  manual fallback report attached: ${manualReportId}`);
  }
}

// ---- 10. Collect evidence + review ----
console.log('\n[8] continue managed iteration review (evidence + verdict)');
const cont = await handlers.continueManagedIterationReview(PROJECT_ID, {
  goal, rules,
  pre_pr_gate: { status: 'ready_with_risks', rule_log: [] },
}, { forceDeterministic: true });
ok(cont.ok, 'continue ok');
const ev = cont.evidence || {};
console.log(`  branch:           ${ev.branch}`);
console.log(`  HEAD:             ${ev.git_short}`);
console.log(`  dirty:            ${ev.dirty}`);
console.log(`  changed_files:    ${(ev.changed_files || []).length}`);
if ((ev.changed_files || []).length > 0) {
  for (const f of ev.changed_files.slice(0, 10)) console.log(`    ${f}`);
}
console.log(`  diff_stat (head): ${(ev.diff_stat || '').split('\n').slice(0, 6).join(' / ')}`);
console.log(`  verdict.status:   ${cont.verdict.status}`);
console.log(`  verdict.summary:  ${cont.verdict.summary}`);
if (cont.verdict.next_attention && cont.verdict.next_attention.length) {
  console.log(`  next_attention:`);
  for (const a of cont.verdict.next_attention.slice(0, 3)) console.log(`    - ${a}`);
}
if (cont.verdict.next_prompt_seed) {
  console.log(`  next_prompt_seed: ${cont.verdict.next_prompt_seed}`);
}

ok(['continue', 'ready_for_review', 'blocked', 'needs_evidence', 'unknown'].includes(cont.verdict.status),
   'verdict.status is in closed set');

// ---- 11. Final iteration row ----
const iters = require(path.join(root, 'project-iterations.cjs'));
const finalIter = iters.getIteration(PROJECT_ID, ITER_ID);
console.log('\n[9] final iteration row');
console.log(`  status:           ${finalIter.status}`);
console.log(`  worker_run_id:    ${finalIter.worker_run_id}`);
console.log(`  worker_provider:  ${finalIter.worker_provider}`);
console.log(`  worker_status:    ${finalIter.worker_status}`);
console.log(`  worker_run_dir:   ${finalIter.worker_run_dir}`);
console.log(`  worker_report_id: ${finalIter.worker_report_id}`);
console.log(`  review_status:    ${finalIter.review_status}`);
ok(finalIter.worker_run_id === RUN_ID, 'iteration carries worker_run_id');
ok(finalIter.worker_report_id, 'iteration carries a report id (auto or manual fallback)');
ok(finalIter.status === 'reviewed', 'iteration ended as reviewed');

// ---- 12. Post-flight: did the worker change anything in the managed repo? ----

const postHead   = gitProbe(['rev-parse', 'HEAD']).stdout.trim();
const postStatus = gitProbe(['status', '--short']).stdout;
console.log('\n[post-flight] managed repo state');
console.log(`  HEAD:    ${postHead}`);
console.log(`  changed since HEAD-or-pre: ${postStatus.trim() || '(none)'}`);
ok(preHead === postHead, 'no new commits in managed repo (HEAD unchanged)');
ok(preStatus === postStatus, 'no working-tree changes in managed repo');

// ---- 13. Read-only invariants (Cairn side) ----

const realDb = path.join(useRealHome ? os.homedir() : os.tmpdir(), '.cairn', 'cairn.db');
// We're sandboxed; the actual real-DB invariant is verified by the
// other smokes. Here just sanity-check we never created cairn.db in
// our sandboxed home.
if (!useRealHome) {
  ok(!fs.existsSync(path.join(os.homedir(), '.cairn', 'cairn.db')), 'no cairn.db created in sandboxed home');
}

console.log('\n========================================');
console.log(`  ${asserts - fails}/${asserts} assertions passed (${fails} failed)`);
if (stopped) console.log('  NOTE: worker was stopped (timeout)');
if (!extractOk) console.log('  NOTE: extract fell back to manual; see fallback report');
console.log('========================================\n');

if (fails) {
  console.log('FAILURES:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
