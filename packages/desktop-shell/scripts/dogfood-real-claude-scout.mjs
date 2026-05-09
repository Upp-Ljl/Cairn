#!/usr/bin/env node
/**
 * Real-Claude Scout Dogfood — Three-Stage Loop / Day 2.
 *
 * Drives a real Claude Code scout round against the cloned
 * agent-game-platform. End-to-end validates: scout-prompt -> launch
 * -> tail -> extractScoutCandidates -> candidates registry has
 * PROPOSED rows bound to the run.
 *
 * Sandboxed: JS-level os.homedir() is overridden to a tmpdir for
 * Cairn writes; process.env.HOME / USERPROFILE are NOT touched, so
 * the spawned claude.cmd inherits real HOME and finds its
 * ~/.claude/.credentials.json. Pass --use-real-home to write to
 * the actual ~/.cairn instead.
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
const MAX_WAIT_MS = 240000;

let asserts = 0, fails = 0;
const failures = [];
function ok(c, l) { asserts++; if (c) console.log(`  ok    ${l}`); else { fails++; failures.push(l); console.log(`  FAIL  ${l}`); } }

if (!useRealHome) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-dogfood-scout-'));
  os.homedir = () => tmpDir;
  fs.mkdirSync(path.join(tmpDir, '.cairn'), { recursive: true });
  console.log(`(sandboxed Cairn writes: ${tmpDir}; child inherits real HOME for credentials)`);
}

const handlers     = require(path.join(root, 'managed-loop-handlers.cjs'));
const launcher     = require(path.join(root, 'worker-launcher.cjs'));
const candidates   = require(path.join(root, 'project-candidates.cjs'));
const scoutPrompt  = require(path.join(root, 'scout-prompt.cjs'));

console.log('\n========================================');
console.log('  Cairn Real-Claude Scout Dogfood (Day 2)');
console.log('========================================');
console.log(`Target repo:   ${repoUrl}`);
console.log(`Local path:    ${localPath}`);

// Pre-flight git probe
function gitProbe(args) { return spawnSync('git', args, { cwd: localPath, encoding: 'utf8' }); }
const preHead   = gitProbe(['rev-parse', 'HEAD']).stdout.trim();
const preStatus = gitProbe(['status', '--short']).stdout;
const preBranch = gitProbe(['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
console.log('\n[pre-flight]');
console.log(`  HEAD:    ${preHead}`);
console.log(`  branch:  ${preBranch}`);
console.log(`  status:  ${preStatus.trim() || '(clean)'}`);

// Detect real claude
const provs = launcher.detectWorkerProviders();
const claude = provs.find(p => p.id === 'claude-code');
ok(claude && claude.available, 'claude-code available on this machine');
if (!claude || !claude.available) { console.log('FAIL: claude-code not on PATH; aborting.'); process.exit(1); }

// Register the project + start iteration
const PROJECT_ID = 'p_real_scout_agp';
const reg = {
  projects: [{
    id: PROJECT_ID, label: 'agent-game-platform (scout dogfood)',
    project_root: localPath, db_path: '/dev/null', agent_id_hints: [],
  }],
};
const r = handlers.registerManagedProject(reg, PROJECT_ID, {});
ok(r.ok, 'register ok');
ok(r.record.profile && r.record.profile.package_manager === 'bun', 'profile detected bun');

const startRes = handlers.startManagedIteration(PROJECT_ID, { goal_id: 'g_scout_001' });
ok(startRes.ok, 'iteration started');
const ITER_ID = startRes.iteration.id;
console.log(`  iteration: ${ITER_ID}`);

// Compose scout prompt — same shape as Cairn-built managed prompt
// + Scout hard-rules block in front.
const goal = {
  id: 'g_scout_001',
  title: 'Scout pass — agent-game-platform candidate improvements',
  desired_outcome: 'Up to 5 small, isolated, testable candidate improvements that future rounds could pick up.',
  success_criteria: [
    'Output a `## Scout Candidates` block with 1-5 items.',
    'Use the closed kind set (missing_test / refactor / doc / bug_fix / other).',
    'Order safest candidate first.',
  ],
  non_goals: [],
};
const rules = {
  version: 1,
  coding_standards: ['Read-only round; no file edits.'],
  testing_policy: ['Do NOT run any test command.'],
  reporting_policy: ['Output ends with `## Scout Candidates` block.'],
  pre_pr_checklist: ['No file changes; no commits; no pushes.'],
  non_goals: [
    'Do not write or edit any file in agent-game-platform.',
    'Do not git commit / git push.',
    'Do not run installers.',
    'Do not modify Cairn itself.',
  ],
  updated_at: Date.now(),
};
const scoutPack = scoutPrompt.generateScoutPrompt({
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
}, {
  managed_record: handlers.getManagedProjectProfile(PROJECT_ID),
  iteration_id: ITER_ID,
  forceDeterministic: true,
});
ok(scoutPack.is_scout && scoutPack.mode === 'scout', 'scout pack tagged is_scout/mode');
ok(scoutPack.prompt.includes(scoutPrompt.SCOUT_CANDIDATES_HEADER),
   'scout pack embeds canonical header');
console.log(`\n[2] scout prompt: ${scoutPack.prompt.length} chars (rules ${scoutPrompt.SCOUT_HARD_RULES.length})`);

// Launch real Claude Code
console.log('\n[3] launch real claude-code (scout round)');
const t0 = Date.now();
const launchRes = handlers.launchManagedWorker(PROJECT_ID, {
  provider: 'claude-code',
  prompt: scoutPack.prompt,
});
ok(launchRes.ok, `launch ok (${launchRes.error || ''})`);
if (!launchRes.ok) process.exit(1);
const RUN_ID = launchRes.run_id;
console.log(`  run_id: ${RUN_ID}`);
console.log(`  iteration_id: ${launchRes.iteration_id}`);

// Poll until exit (or timeout)
console.log('\n[4] polling… (up to 4 min)');
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

// Tail + secret-leak grep
console.log('\n[5] tail + secret check');
const tailRes = handlers.tailWorkerRun(RUN_ID, 16384);
ok(tailRes.ok && tailRes.text.length > 0, 'tail non-empty');
const tail = tailRes.text;
console.log('  --- last 12 lines ---');
console.log(tail.split(/\r?\n/).slice(-12).map(l => '  | ' + l).join('\n'));
const leaks = [
  ['ANTHROPIC_API_KEY', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['OpenAI sk-',         /\bsk-[A-Za-z0-9]{40,}\b/],
  ['GitHub PAT',         /\bghp_[A-Za-z0-9]{20,}\b/],
  ['Bearer header',      /Bearer\s+[A-Za-z0-9_\-\.]{30,}/],
];
for (const [name, rx] of leaks) ok(!rx.test(tail), `tail does NOT contain ${name}`);

// Extract scout candidates
console.log('\n[6] extract scout candidates');
const ext = handlers.extractScoutCandidates(PROJECT_ID, { run_id: RUN_ID });
if (!ext.ok) {
  console.log(`  FAIL extract: ${ext.error}`);
  console.log('  --- full tail ---');
  console.log(tail.split(/\r?\n/).map(l => '  | ' + l).join('\n'));
  ok(false, `extract failed: ${ext.error}`);
} else {
  ok(true, 'extract ok');
  console.log(`  candidates returned: ${ext.candidates.length}`);
  for (const c of ext.candidates) {
    console.log(`    [${c.kind}] ${c.description.slice(0, 100)}`);
  }
  ok(ext.candidates.length >= 1, 'at least 1 candidate proposed');
  ok(ext.candidates.every(c => c.description && c.description.length > 0 && c.description.length <= 240),
     'every candidate description non-empty and ≤240');
  ok(ext.candidates.every(c => ['missing_test', 'refactor', 'doc', 'bug_fix', 'other'].includes(c.kind)),
     'every candidate.kind in closed set');
}

// Registry-side checks
const all = candidates.listCandidates(PROJECT_ID, 50);
ok(all.length >= 1, 'registry has at least 1 PROPOSED candidate');
ok(all.every(c => c.status === 'PROPOSED'), 'all candidates are PROPOSED');
ok(all.every(c => c.source_run_id === RUN_ID), 'every candidate.source_run_id === RUN_ID');
ok(all.every(c => c.source_iteration_id === ITER_ID), 'every candidate.source_iteration_id === ITER_ID');

// Post-flight: managed repo MUST be byte-for-byte unchanged.
const postHead   = gitProbe(['rev-parse', 'HEAD']).stdout.trim();
const postStatus = gitProbe(['status', '--short']).stdout;
console.log('\n[post-flight]');
console.log(`  HEAD:    ${postHead}`);
console.log(`  status:  ${postStatus.trim() || '(clean)'}`);
ok(preHead === postHead, 'agent-game-platform HEAD unchanged');
ok(preStatus === postStatus, 'agent-game-platform working tree unchanged (byte-for-byte)');

console.log('\n========================================');
console.log(`  ${asserts - fails}/${asserts} assertions passed (${fails} failed)`);
if (stopped) console.log('  NOTE: worker was stopped (timeout)');
console.log('========================================\n');

if (fails) { console.log('FAILURES:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }
