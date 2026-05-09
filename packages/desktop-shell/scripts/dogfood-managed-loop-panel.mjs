#!/usr/bin/env node
/**
 * Live dogfood — exercise the panel-level managed-loop handlers
 * (the same ones main.cjs IPC forwards to) against the cloned
 * agent-game-platform repo.
 *
 * The previous round (`dogfood-managed-project-loop.mjs`) tested the
 * raw modules directly. This dogfood tests the IPC-wrapper layer the
 * panel will call: same operations, just routed through
 * managed-loop-handlers.cjs with a synthetic registry shape.
 *
 * Sandboxed HOME by default so the user's real ~/.cairn isn't
 * touched. Pass --use-real-home to write to ~/.cairn instead.
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-dogfood-panel-'));
  process.env.HOME = tmpDir;
  process.env.USERPROFILE = tmpDir;
  os.homedir = () => tmpDir;
  fs.mkdirSync(path.join(tmpDir, '.cairn'), { recursive: true });
  console.log(`(sandboxed home: ${tmpDir})`);
}

const handlers = require(path.join(root, 'managed-loop-handlers.cjs'));

const PROJECT_ID = 'p_dogfood_panel_agp';
const reg = {
  projects: [{
    id: PROJECT_ID,
    label: 'agent-game-platform',
    project_root: localPath,
    db_path: '/dev/null',
    agent_id_hints: [],
  }],
};

console.log('\n========================================');
console.log('  Cairn Managed Loop — Panel Dogfood');
console.log('========================================');
console.log(`Target repo:   ${repoUrl}`);
console.log(`Local path:    ${localPath}`);
console.log(`Repo on disk:  ${fs.existsSync(localPath) ? 'yes' : 'NO'}`);

// 1. list (empty)
const list0 = handlers.listManagedProjects(reg);
ok(list0.length === 0, '[list 0] no managed projects yet');

// 2. register (default local_path = project_root from registry)
console.log('\n[2] register-managed-project');
const reg1 = handlers.registerManagedProject(reg, PROJECT_ID, {});
ok(reg1.ok, 'register ok');
ok(reg1.record.profile && reg1.record.profile.package_manager === 'bun', 'detected bun');
console.log(`  package_manager: ${reg1.record.profile.package_manager}`);
console.log(`  test_commands:   ${reg1.record.profile.test_commands.join(' | ')}`);
console.log(`  build_commands:  ${reg1.record.profile.build_commands.join(' | ')}`);
console.log(`  default_branch:  ${reg1.record.default_branch}`);

// 3. profile read
console.log('\n[3] get-managed-project-profile');
const rec = handlers.getManagedProjectProfile(PROJECT_ID);
ok(rec && rec.local_path === localPath, 'profile round-trips');

// 4. list (1)
const list1 = handlers.listManagedProjects(reg);
ok(list1.length === 1 && list1[0].label === 'agent-game-platform', 'list contains 1 project labeled');

// 5. start iteration
console.log('\n[5] start-managed-iteration');
const sr = handlers.startManagedIteration(PROJECT_ID, { goal_id: 'g_panel_001' });
ok(sr.ok && sr.iteration.status === 'planned', 'started');
const ITER = sr.iteration.id;

// 6. generate worker prompt (panel-equivalent ctx)
console.log('\n[6] generate-managed-worker-prompt');
const goal = {
  id: 'g_panel_001',
  title: 'Improve agent-game-platform — panel-driven loop',
  desired_outcome: 'A small, verifiable improvement each round.',
  success_criteria: ['Bun tests do not regress.', 'Each round produces a worker report.'],
  non_goals: [],
};
const rules = {
  version: 1,
  coding_standards: ['Follow Next.js conventions; no new deps without approval.'],
  testing_policy: ['Before claiming done, run: bun run test'],
  reporting_policy: ['Report completed/remaining/blockers; note when tests not run.'],
  pre_pr_checklist: ['No secret in source; no unrelated dirty files.'],
  non_goals: ['No unauthorized push; no scope creep.'],
  updated_at: Date.now(),
};
const pr = handlers.generateManagedWorkerPrompt(PROJECT_ID, {
  goal,
  project_rules: rules,
  project_rules_is_default: false,
});
ok(pr.ok, 'prompt generated');
ok(pr.iteration_id === ITER, 'auto-bound to current iteration');
ok(pr.result.prompt.includes('# Managed project'), 'prompt has managed section');
ok(pr.result.prompt.includes('bun run test'), 'prompt contains detected bun test command');
console.log(`  prompt length: ${pr.result.prompt.length} chars`);
console.log(`  bound to:      ${pr.iteration_id}`);

// 7. attach worker report (free-form text — what a user would paste)
console.log('\n[7] attach-managed-worker-report');
const reportText = [
  '# [FIXTURE] Round 1 — wired Sentry sample rate config',
  'source: claude-code',
  'agent: panel-dogfood',
  '## Completed',
  '- Adjusted Sentry traces sample rate to 0.05 in production env.',
  '## Remaining',
  '- Confirm CHANGELOG entry; add e2e test for the config switch.',
  '## Blockers',
  '## Next',
  '- Add a unit test asserting the sample-rate is read from env.',
].join('\n');
const ar = handlers.attachManagedWorkerReport(PROJECT_ID, { text: reportText });
ok(ar.ok, 'report attached');
ok(ar.iteration_id === ITER, 'report bound to iteration');
console.log(`  report id: ${ar.report.id}`);
console.log(`  parsed:    completed=${ar.report.completed.length}, remaining=${ar.report.remaining.length}, blockers=${ar.report.blockers.length}`);

// 8. collect evidence (read-only)
console.log('\n[8] collect-managed-evidence');
const ev = handlers.collectManagedEvidence(PROJECT_ID, {});
ok(ev.ok, 'evidence collected');
console.log(`  branch:        ${ev.evidence.branch}`);
console.log(`  HEAD:          ${ev.evidence.git_short}`);
console.log(`  dirty:         ${ev.evidence.dirty}`);
console.log(`  changed:       ${(ev.evidence.changed_files || []).length}`);
console.log(`  last commit:   ${ev.evidence.last_commit && ev.evidence.last_commit.subject}`);

// 9. review iteration
console.log('\n[9] review-managed-iteration');
const review = await handlers.reviewManagedIteration(PROJECT_ID, {
  goal,
  rules,
  pre_pr_gate: { status: 'ready_with_risks', rule_log: [] },
}, { forceDeterministic: true });
ok(review.ok, 'review ok');
console.log(`  status:           ${review.verdict.status}`);
console.log(`  summary:          ${review.verdict.summary}`);
console.log(`  next_attention:   ${review.verdict.next_attention.length}`);
for (const a of review.verdict.next_attention) console.log(`     - ${a}`);
if (review.verdict.next_prompt_seed) console.log(`  next_prompt_seed: ${review.verdict.next_prompt_seed}`);
ok(['continue', 'ready_for_review', 'blocked', 'needs_evidence', 'unknown'].includes(review.verdict.status),
   'verdict status in closed set');

// 10. list iterations after full round
const itersAfter = handlers.listManagedIterations(PROJECT_ID, 5);
ok(itersAfter.length === 1, 'one iteration recorded');
ok(itersAfter[0].status === 'reviewed', 'iteration ended as reviewed');
ok(itersAfter[0].review_status === review.verdict.status, 'review_status persisted');

console.log('\n========================================');
console.log(`  ${asserts - fails}/${asserts} assertions passed (${fails} failed)`);
console.log('========================================\n');

if (fails) {
  console.log('FAILURES:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
