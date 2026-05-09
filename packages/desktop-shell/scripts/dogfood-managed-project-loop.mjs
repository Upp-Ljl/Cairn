#!/usr/bin/env node
/**
 * Live dogfood — Cairn managing agent-game-platform.
 *
 * Runs the full managed-project loop against the real cloned repo
 * at D:/lll/managed-projects/agent-game-platform (cloned beforehand
 * by the user / setup script). Steps:
 *
 *   1. Register managed project (no clone — repo already on disk)
 *   2. Detect profile
 *   3. Set goal + rules (defaults if not provided)
 *   4. Start iteration
 *   5. Generate worker prompt
 *   6. Attach a FIXTURE worker report (clearly tagged in the report
 *      title), since this dogfood does not run an actual coding agent
 *   7. Collect read-only git evidence
 *   8. Run managed loop review
 *   9. Print a one-page outcome report
 *
 * Read/write boundary: this script DOES write under ~/.cairn (the
 * registry, managed-projects, project-iterations, project-reports
 * are the ones we manage). It does NOT touch cairn.db, ~/.claude,
 * ~/.codex, or the agent-game-platform working tree.
 *
 * Sandbox: writes go to a tmp HOME, not the user's real ~/.cairn,
 * so the dogfood can't pollute real Cairn state. Pass --use-real-home
 * to run against the real ~/.cairn (the user must opt in).
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-dogfood-managed-'));
  process.env.HOME = tmpDir;
  process.env.USERPROFILE = tmpDir;
  os.homedir = () => tmpDir;
  fs.mkdirSync(path.join(tmpDir, '.cairn'), { recursive: true });
  console.log(`(sandboxed home: ${tmpDir})`);
}

const mp       = require(path.join(root, 'managed-project.cjs'));
const iters    = require(path.join(root, 'project-iterations.cjs'));
const evidence = require(path.join(root, 'project-evidence.cjs'));
const review   = require(path.join(root, 'managed-loop-review.cjs'));
const wr       = require(path.join(root, 'worker-reports.cjs'));
const adapter  = require(path.join(root, 'managed-loop-prompt.cjs'));

const PROJECT_ID = 'p_dogfood_agp';
const repoExists = fs.existsSync(localPath);

console.log('\n========================================');
console.log('  Cairn Managed Project Loop — Dogfood');
console.log('========================================');
console.log(`Target repo:        ${repoUrl}`);
console.log(`Local path:         ${localPath}`);
console.log(`Repo on disk:       ${repoExists ? 'yes' : 'NO (will continue with profile_error)'}`);

// -----------------------------------------------------------------------
// 1. Register managed project
// -----------------------------------------------------------------------
console.log('\n[1] registerManagedProject');
const reg = mp.registerManagedProject({
  project_id: PROJECT_ID,
  repo_url: repoUrl,
  local_path: localPath,
  clone: false,  // we expect setup to have cloned it; never auto-clone in dogfood
});
ok(reg.ok, 'registerManagedProject ok');
if (repoExists) {
  ok(reg.profile_error == null, 'no profile_error when repo exists');
  ok(reg.record.profile && reg.record.profile.package_manager, 'profile has package_manager');
} else {
  ok(reg.profile_error === 'local_path_not_found', 'graceful profile_error when repo missing');
}
const profile = reg.record.profile;
console.log(`  package manager:  ${profile && profile.package_manager}`);
console.log(`  languages:        ${(profile && profile.languages || []).join(', ')}`);
console.log(`  test commands:    ${(profile && profile.test_commands || []).join(' | ')}`);
console.log(`  build commands:   ${(profile && profile.build_commands || []).join(' | ')}`);
console.log(`  lint commands:    ${(profile && profile.lint_commands || []).join(' | ')}`);
console.log(`  scripts (count):  ${(profile && profile.scripts_detected || []).length}`);
console.log(`  docs:             ${(profile && profile.docs || []).join(', ')}`);

// -----------------------------------------------------------------------
// 2. Compose goal + rules (in-memory; we don't write to ~/.cairn/projects.json
//    here because the existing registry has its own writer. The review
//    layer accepts these shapes directly.)
// -----------------------------------------------------------------------
console.log('\n[2] goal + rules');
const goal = {
  id: 'g_dogfood_001',
  title: 'Improve agent-game-platform safely under Cairn-managed loops',
  desired_outcome: 'A concrete, small improvement is landed each round; no scope creep; tests still pass.',
  success_criteria: [
    'Each round produces a worker report with completed/remaining/blockers.',
    'Tests detected by the profile (bun run test) are not regressed.',
    'No unauthorized push.',
  ],
  non_goals: [],
};
const rules = {
  version: 1,
  coding_standards: [
    'Follow existing patterns in this Next.js + bun project.',
    'No new dependencies unless explicitly necessary; explain in the report when added.',
  ],
  testing_policy: profile && profile.test_commands && profile.test_commands.length
    ? [`Before claiming done, run: ${profile.test_commands[0]}`]
    : ['Run the project\'s detected tests before claiming done.'],
  reporting_policy: [
    'Report completed / remaining / blockers / next steps.',
    'Note explicitly when a test command was NOT run, and why.',
  ],
  pre_pr_checklist: [
    'No new SQLite schema / API surface change without authorization.',
    'No secret / API key in source, logs, or commit.',
    'No unrelated dirty files in the diff.',
  ],
  non_goals: [
    'Do not refactor unrelated modules.',
    'Do not push or merge to main without explicit user authorization.',
    'Do not modify Cairn itself; only the managed project.',
  ],
  updated_at: Date.now(),
};
ok(goal.title.length > 0, 'goal title set');
ok(rules.testing_policy.length > 0, 'testing_policy populated');

// -----------------------------------------------------------------------
// 3. Start iteration
// -----------------------------------------------------------------------
console.log('\n[3] startIteration');
const startRes = iters.startIteration(PROJECT_ID, { goal_id: goal.id });
ok(startRes.ok, 'startIteration ok');
const iteration = startRes.iteration;
console.log(`  iteration id:     ${iteration.id}`);
console.log(`  status:           ${iteration.status}`);

// -----------------------------------------------------------------------
// 4. Generate worker prompt
// -----------------------------------------------------------------------
console.log('\n[4] generate worker prompt');
const promptInput = {
  goal,
  project_rules: rules,
  project_rules_is_default: false,
  pulse: { pulse_level: 'ok', signals: [] },
  activity_summary: { by_family: { live: 0, recent: 0, inactive: 0 }, total: 0 },
  tasks_summary: { running: 0, blocked: 0, waiting_review: 0, failed: 0 },
  blockers_summary: { open: 0 },
  outcomes_summary: { failed: 0, pending: 0 },
  recent_reports: [],
  pre_pr_gate: { status: 'unknown', checklist: [], rule_log: [] },
};
const prompt = adapter.generateManagedPrompt(promptInput, {
  managed_record: reg.record,
  iteration_id: iteration.id,
  forceDeterministic: true,
});
ok(prompt.is_managed, 'prompt is_managed=true');
ok(prompt.prompt.includes('# Managed project'), 'prompt has managed section');
if (profile) ok(prompt.prompt.includes(profile.package_manager), 'prompt names package manager');
console.log(`  prompt length:    ${prompt.prompt.length} chars`);
console.log(`  evidence_ids:     ${prompt.evidence_ids.slice(0, 5).join(', ')}`);

const attachP = iters.attachWorkerPrompt(PROJECT_ID, iteration.id, { id: 'p_' + Date.now(), title: prompt.title });
ok(attachP.ok, 'attachWorkerPrompt ok');

// -----------------------------------------------------------------------
// 5. Attach FIXTURE worker report
// -----------------------------------------------------------------------
console.log('\n[5] attach FIXTURE worker report');
const fixtureReport = wr.normalizeReport(PROJECT_ID, {
  source_app: 'fixture',
  agent_id: null,
  title: '[FIXTURE] Round 1 — wired Sentry sample rate config',
  completed: ['Adjusted Sentry traces sample rate to 0.05 in production env.'],
  remaining: ['Confirm CHANGELOG entry; add e2e test for the config switch.'],
  blockers: [],
  next_steps: ['Add a unit test asserting the sample-rate is read from env.'],
  needs_human: false,
});
const append = wr.addWorkerReport(PROJECT_ID, fixtureReport);
ok(append.ok, 'fixture report appended');
const attachR = iters.attachWorkerReport(PROJECT_ID, iteration.id, fixtureReport.id);
ok(attachR.ok, 'attachWorkerReport ok');

// -----------------------------------------------------------------------
// 6. Collect evidence
// -----------------------------------------------------------------------
console.log('\n[6] collect evidence');
const ev = evidence.collectGitEvidence(localPath, { profile, allow_run_tests: false });
const evSum = evidence.summarizeEvidence(ev);
console.log(`  branch:           ${ev.branch}`);
console.log(`  git_short:        ${ev.git_short}`);
console.log(`  dirty:            ${ev.dirty}`);
console.log(`  changed_files:    ${ev.changed_files.length}`);
console.log(`  last_commit:      ${ev.last_commit ? ev.last_commit.subject : '(none)'}`);
console.log(`  errors:           ${ev.errors.join(' | ') || '(none)'}`);
ok(repoExists ? ev.git_head !== null : ev.errors.includes('local_path_missing'),
   repoExists ? 'git evidence collected' : 'graceful when local_path missing');
const attachE = iters.attachEvidence(PROJECT_ID, iteration.id, evSum);
ok(attachE.ok, 'attachEvidence ok');

// -----------------------------------------------------------------------
// 7. Review iteration
// -----------------------------------------------------------------------
console.log('\n[7] managed loop review');
const verdict = review.deterministicReview({
  iteration,
  worker_report: fixtureReport,
  evidence: evSum,
  pre_pr_gate: { status: 'ready_with_risks', checklist: [], rule_log: [] },
  goal,
});
console.log(`  status:           ${verdict.status}`);
console.log(`  summary:          ${verdict.summary}`);
console.log(`  risks:            ${verdict.risks.length}`);
console.log(`  next_attention:   ${verdict.next_attention.length} item(s)`);
for (const a of verdict.next_attention) console.log(`     - ${a}`);
if (verdict.next_prompt_seed) console.log(`  next_prompt_seed: ${verdict.next_prompt_seed}`);
ok(['continue', 'ready_for_review', 'blocked', 'needs_evidence', 'unknown'].includes(verdict.status),
   'verdict.status is in the closed set');

const completeRes = iters.completeIterationReview(
  PROJECT_ID, iteration.id,
  { status: 'ready_with_risks' },
  verdict.status, verdict.summary, verdict.next_attention,
);
ok(completeRes.ok && completeRes.iteration.status === 'reviewed', 'iteration marked reviewed');

// -----------------------------------------------------------------------
// 8. Final shape verification
// -----------------------------------------------------------------------
console.log('\n[8] final fold');
const final = iters.latestIteration(PROJECT_ID);
ok(final && final.id === iteration.id, 'latest iteration matches');
ok(final.status === 'reviewed', 'final status is reviewed');
ok(final.review_status === verdict.status, 'final review_status matches verdict');
ok(final.evidence_summary != null, 'final has evidence_summary');
ok(final.worker_report_id === fixtureReport.id, 'final has worker_report_id');

console.log('\n========================================');
console.log(`  ${asserts - fails}/${asserts} assertions passed (${fails} failed)`);
console.log('========================================\n');

if (fails) {
  console.log('FAILURES:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
