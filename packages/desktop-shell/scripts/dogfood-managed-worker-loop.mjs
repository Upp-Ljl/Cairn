#!/usr/bin/env node
/**
 * Live dogfood — full Managed Worker Loop against the cloned
 * agent-game-platform repo.
 *
 * Provider strategy:
 *   - We probe REAL providers via detectWorkerProviders so the report
 *     accurately reflects what's installed (claude/codex on PATH).
 *   - We DO NOT auto-launch claude/codex against a real repo: that
 *     would modify the user's working tree and consume API credits
 *     without the user clicking the panel button. The dogfood
 *     therefore exercises the entire pipeline using fixture-echo,
 *     which spawns Node-on-Node, emits a Worker Report, and exits.
 *     This validates the launch path, run.json persistence, tail-log
 *     capture, extraction, iteration binding, evidence collection,
 *     and review — all the same code paths a real provider hits.
 *
 * Sandboxed HOME by default; pass --use-real-home to write to the
 * real ~/.cairn (still does NOT auto-launch claude or codex).
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

const args = new Set(process.argv.slice(2));
const useRealHome = args.has('--use-real-home');
const localPath = process.env.CAIRN_DOGFOOD_REPO_PATH || 'D:/lll/managed-projects/agent-game-platform';
const repoUrl = 'https://github.com/anzy-renlab-ai/agent-game-platform.git';

let asserts = 0, fails = 0;
const failures = [];
function ok(c, l) { asserts++; if (c) console.log(`  ok    ${l}`); else { fails++; failures.push(l); console.log(`  FAIL  ${l}`); } }

if (!useRealHome) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-dogfood-worker-'));
  process.env.HOME = tmpDir;
  process.env.USERPROFILE = tmpDir;
  os.homedir = () => tmpDir;
  fs.mkdirSync(path.join(tmpDir, '.cairn'), { recursive: true });
  console.log(`(sandboxed home: ${tmpDir})`);
}

const handlers = require(path.join(root, 'managed-loop-handlers.cjs'));
const launcher = require(path.join(root, 'worker-launcher.cjs'));

console.log('\n========================================');
console.log('  Cairn Managed Worker Loop — Dogfood');
console.log('========================================');
console.log(`Target repo:   ${repoUrl}`);
console.log(`Local path:    ${localPath}`);
console.log(`Repo on disk:  ${fs.existsSync(localPath) ? 'yes' : 'NO'}`);

// ---- 1. detect providers (REAL) ----
console.log('\n[1] detect-worker-providers (real)');
const provs = handlers.detectWorkerProviders();
for (const p of provs) {
  console.log(`  - ${p.id.padEnd(14)} ${p.available ? 'available' : 'unavailable'} ${p.resolved_path || ''}`);
}
ok(provs.find(p => p.id === 'fixture-echo' && p.available), 'fixture-echo available (always)');
ok(provs.find(p => p.id === 'claude-code'), 'claude-code provider entry present');
ok(provs.find(p => p.id === 'codex'), 'codex provider entry present');
const claudeAvail = provs.find(p => p.id === 'claude-code').available;
const codexAvail  = provs.find(p => p.id === 'codex').available;

// ---- 2. register the project ----
const PROJECT_ID = 'p_dogfood_worker_agp';
const reg = {
  projects: [{
    id: PROJECT_ID, label: 'agent-game-platform',
    project_root: localPath, db_path: '/dev/null', agent_id_hints: [],
  }],
};
console.log('\n[2] register');
const r = handlers.registerManagedProject(reg, PROJECT_ID, {});
ok(r.ok, 'register ok');
ok(r.record.profile && r.record.profile.package_manager === 'bun', 'detected bun');

// ---- 3. start iteration ----
console.log('\n[3] start iteration');
const startRes = handlers.startManagedIteration(PROJECT_ID, { goal_id: 'g_real_001' });
ok(startRes.ok, 'iteration started');
const ITER_ID = startRes.iteration.id;

// ---- 4. generate prompt ----
console.log('\n[4] generate prompt');
const goal = {
  id: 'g_real_001',
  title: 'Improve agent-game-platform — worker-launch dogfood',
  desired_outcome: 'A small verified improvement each round; tests do not regress.',
  success_criteria: [
    'Bun tests do not regress.',
    'Each round produces a Worker Report block.',
  ],
  non_goals: [],
};
const rules = {
  version: 1,
  coding_standards: ['Follow existing Next.js conventions; no new deps without approval.'],
  testing_policy: ['Before claiming done, run: bun run test'],
  reporting_policy: ['Emit a `## Worker Report` block at the end with Completed/Remaining/Blockers/Next.'],
  pre_pr_checklist: ['No secrets in source; no unrelated dirty files.'],
  non_goals: ['No unauthorized push; no scope creep; do not modify Cairn itself.'],
  updated_at: Date.now(),
};
const pr = handlers.generateManagedWorkerPrompt(PROJECT_ID, { goal, project_rules: rules });
ok(pr.ok, 'prompt generated');
ok(pr.iteration_id === ITER_ID, 'bound to iteration');
console.log(`  prompt length: ${pr.result.prompt.length} chars`);

// ---- 5. LAUNCH (fixture-echo, never claude/codex auto) ----
console.log('\n[5] launch worker (fixture-echo)');
const launchRes = handlers.launchManagedWorker(PROJECT_ID, {
  provider: 'fixture-echo',
  prompt: pr.result.prompt,
});
ok(launchRes.ok, 'launch ok');
const RUN_ID = launchRes.run_id;
console.log(`  run_id:        ${RUN_ID}`);
console.log(`  iteration_id:  ${launchRes.iteration_id}`);
console.log(`  status:        ${launchRes.run.status}`);

// ---- 6. wait for exit ----
console.log('\n[6] wait for exit');
let waited = 0;
let runStatus = 'running';
while (waited < 5000 && (runStatus === 'running' || runStatus === 'queued')) {
  await new Promise(r => setTimeout(r, 200));
  waited += 200;
  const cur = handlers.getWorkerRun(RUN_ID);
  if (cur) runStatus = cur.status;
}
const finalRun = handlers.getWorkerRun(RUN_ID);
ok(finalRun && finalRun.status === 'exited', `worker exited (got ${finalRun && finalRun.status})`);
console.log(`  ended_at:      ${finalRun.ended_at}`);
console.log(`  exit_code:     ${finalRun.exit_code}`);
console.log(`  prompt_hash:   ${finalRun.prompt_hash}`);

// ---- 7. tail log + extract report ----
console.log('\n[7] tail + extract report');
const tail = handlers.tailWorkerRun(RUN_ID, 16384);
ok(tail.ok && tail.text.length > 0, 'tail returns log');
console.log('  --- tail (head) ---');
console.log(tail.text.split('\n').slice(0, 8).map(l => '  ' + l).join('\n'));
console.log('  ...');
const extract = handlers.extractManagedWorkerReport(PROJECT_ID, { run_id: RUN_ID });
ok(extract.ok, 'extract ok');
ok(extract.iteration_id === ITER_ID, 'extracted report bound to iteration');
console.log(`  extracted: ${extract.report.completed.length} completed · ${extract.report.remaining.length} remaining · ${extract.report.blockers.length} blockers · ${extract.report.next_steps.length} next`);

// ---- 8. collect evidence + review (continue handler) ----
console.log('\n[8] continue managed iteration review');
const cont = await handlers.continueManagedIterationReview(PROJECT_ID, {
  goal, rules,
  pre_pr_gate: { status: 'ready_with_risks', rule_log: [] },
}, { forceDeterministic: true });
ok(cont.ok, 'continue ok');
console.log(`  branch:           ${cont.evidence && cont.evidence.branch}`);
console.log(`  HEAD:             ${cont.evidence && cont.evidence.git_short}`);
console.log(`  dirty:            ${cont.evidence && cont.evidence.dirty}`);
console.log(`  changed_files:    ${(cont.evidence && cont.evidence.changed_files || []).length}`);
console.log(`  verdict.status:   ${cont.verdict.status}`);
console.log(`  verdict.summary:  ${cont.verdict.summary}`);
ok(['continue', 'ready_for_review', 'blocked', 'needs_evidence', 'unknown'].includes(cont.verdict.status),
   'verdict status in closed set');

// ---- 9. iteration row reflects every step ----
const iters = require(path.join(root, 'project-iterations.cjs'));
const finalIter = iters.getIteration(PROJECT_ID, ITER_ID);
console.log('\n[9] final iteration row');
console.log(`  status:           ${finalIter.status}`);
console.log(`  worker_run_id:    ${finalIter.worker_run_id}`);
console.log(`  worker_provider:  ${finalIter.worker_provider}`);
console.log(`  worker_status:    ${finalIter.worker_status}`);
console.log(`  worker_report_id: ${finalIter.worker_report_id}`);
console.log(`  review_status:    ${finalIter.review_status}`);
ok(finalIter.status === 'reviewed', 'iteration ended as reviewed');
ok(finalIter.worker_run_id === RUN_ID, 'iteration carries worker_run_id');
ok(finalIter.worker_report_id === extract.report.id, 'iteration carries extracted report');

// ---- 10. real provider gap report ----
console.log('\n[10] real provider gap report');
console.log(`  claude-code real:  ${claudeAvail ? 'available — would launch real Claude Code on click' : 'unavailable'}`);
console.log(`  codex real:        ${codexAvail ? 'available' : 'unavailable (Codex CLI not found in PATH)'}`);
console.log('  Real launch is NOT auto-fired — user must click the panel button.');

console.log('\n========================================');
console.log(`  ${asserts - fails}/${asserts} assertions passed (${fails} failed)`);
console.log('========================================\n');

if (fails) {
  console.log('FAILURES:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
