#!/usr/bin/env node
/**
 * Real-Claude single-cycle Continuous Iteration dogfood.
 *
 * Drives the Mode B handler (runContinuousIteration) with real
 * claude-code in all three stages, capped at max_candidates=1 so
 * the whole chain is one Scout → one Worker → one Review.
 *
 * Verifies the Day 1-6 contracts the Mode B handler is supposed to
 * preserve:
 *   - Day 3: Worker does not git commit (pre HEAD === post HEAD)
 *   - Day 4: verdict is advisory, candidate stops at REVIEWED
 *   - Day 5: NOT auto-Accepted by Mode B
 *   - Day 6: boundary_violations array populated (may be empty)
 *   - A4:    Multi-Cairn outbox untouched (CAIRN_SHARED_DIR unset
 *            ⇒ multi_cairn_not_enabled; no shared file created)
 *
 * Sandboxes Cairn writes via JS-level os.homedir() override only —
 * process.env.HOME / USERPROFILE are intentionally NOT touched so
 * the spawned claude.cmd inherits the real HOME and finds its
 * ~/.claude/.credentials.json.
 *
 * Expected runtime: 5-8 min. Expected cost: ~$2-3 in Anthropic credits.
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

let asserts = 0, fails = 0;
const failures = [];
function ok(c, l) { asserts++; if (c) console.log(`  ok    ${l}`); else { fails++; failures.push(l); console.log(`  FAIL  ${l}`); } }

if (!useRealHome) {
  const cairnTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-dogfood-cont-'));
  os.homedir = () => cairnTmp;
  fs.mkdirSync(path.join(cairnTmp, '.cairn'), { recursive: true });
  console.log(`(sandboxed Cairn writes: ${cairnTmp}; child inherits real HOME)`);
}

const handlers   = require(path.join(root, 'managed-loop-handlers.cjs'));
const launcher   = require(path.join(root, 'worker-launcher.cjs'));
const candidates = require(path.join(root, 'project-candidates.cjs'));
const multiCairn = require(path.join(root, 'multi-cairn.cjs'));

console.log('\n========================================');
console.log('  Mode B Continuous Iteration — real-Claude single-cycle');
console.log('========================================');

// ---------------------------------------------------------------------------
// Pre-flight
// ---------------------------------------------------------------------------

// Multi-Cairn must be off for this run (we don't want the outbox to record
// anything during a real-Claude dogfood — the snapshot privacy invariant
// is covered by smoke-multi-cairn).
ok(!process.env.CAIRN_SHARED_DIR || !fs.existsSync(process.env.CAIRN_SHARED_DIR),
   'Multi-Cairn disabled for this dogfood (CAIRN_SHARED_DIR unset or missing)');
ok(multiCairn.isMultiCairnEnabled() === false || !!process.env.CAIRN_SHARED_DIR,
   'Multi-Cairn isMultiCairnEnabled reflects env');

// Build temp repo.
const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-cont-target-'));
console.log(`Temp repo: ${tempRepo}`);
function git(args) { return spawnSync('git', args, { cwd: tempRepo, encoding: 'utf8' }); }
git(['init']);
git(['config', 'user.email', 'cont@example.local']);
git(['config', 'user.name', 'Cairn Continuous Dogfood']);
git(['checkout', '-b', 'main']);
fs.mkdirSync(path.join(tempRepo, 'src'));
fs.writeFileSync(path.join(tempRepo, 'package.json'), JSON.stringify({
  name: 'cairn-cont-target', version: '0.1.0',
}, null, 2));
fs.writeFileSync(path.join(tempRepo, 'package-lock.json'), '{}');
fs.writeFileSync(path.join(tempRepo, 'README.md'),
  '# cairn-cont-target\n\nThrowaway target for the Mode B real-Claude dogfood.\n');
fs.writeFileSync(path.join(tempRepo, 'src', 'index.ts'),
  'export function greet(name) {\n  return "hello, " + name;\n}\n');
git(['add', '.']);
git(['commit', '-m', 'initial']);

const preHead   = git(['rev-parse', 'HEAD']).stdout.trim();
const preStatus = git(['status', '--short']).stdout;
console.log(`Pre-flight HEAD: ${preHead}`);
console.log(`Pre-flight status: ${preStatus.trim() || '(clean)'}`);

// Snapshot pre-flight file fingerprints for byte-equal cleanup check.
function snapshotRepo(dir) {
  const out = {};
  function walk(rel) {
    const abs = path.join(dir, rel || '');
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch (_e) { return; }
    for (const e of entries) {
      if (e.name === '.git') continue;
      const r = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) walk(r);
      else if (e.isFile()) {
        try { out[r.replace(/\\/g, '/')] = fs.readFileSync(path.join(dir, r), 'utf8'); }
        catch (_e) {}
      }
    }
  }
  walk('');
  return out;
}
const preFingerprint = snapshotRepo(tempRepo);
ok(Object.keys(preFingerprint).length >= 3, 'pre-flight: temp repo has expected seed files');

// claude available?
const provs = launcher.detectWorkerProviders();
const claude = provs.find(p => p.id === 'claude-code');
ok(claude && claude.available, 'claude-code available');
if (!claude || !claude.available) {
  console.log('FAIL: claude-code not on PATH; aborting (cleaning up).');
  fs.rmSync(tempRepo, { recursive: true, force: true });
  process.exit(1);
}

// Register the managed project.
const PID = 'p_dogfood_continuous';
const reg = { projects: [{ id: PID, label: 'cont-target', project_root: tempRepo, db_path: '/dev/null', agent_id_hints: [] }] };
ok(handlers.registerManagedProject(reg, PID, {}).ok, 'register temp repo as managed project');

// ---------------------------------------------------------------------------
// Run the chain
// ---------------------------------------------------------------------------

const goal = {
  id: 'g_cont_001',
  title: 'Add a one-line file header comment',
  desired_outcome: 'A single-line comment at the top of src/index.ts explaining what the file does, nothing else.',
  success_criteria: [
    'src/index.ts gains a one-line // comment at the very top.',
    'No other file is modified.',
    'No new dependency or test is added.',
  ],
  non_goals: [
    'Do not add tests.',
    'Do not modify package.json.',
    'Do not commit or push.',
  ],
};
const rules = {
  version: 1,
  coding_standards: ['Single-line header comment only; do not touch function bodies.'],
  testing_policy: ['Do NOT run tests this round.'],
  reporting_policy: ['Emit standard `## Worker Report` block.'],
  pre_pr_checklist: ['No secrets; no commits.'],
  non_goals: ['No git commit/push; no installer; no Cairn modifications.'],
  updated_at: Date.now(),
};

console.log('\n[run] runContinuousIteration(max_candidates=1)');
const t0 = Date.now();
const result = await handlers.runContinuousIteration(PID, {
  goal,
  rules,
  scout_provider:  'claude-code',
  worker_provider: 'claude-code',
  review_provider: 'claude-code',
  max_candidates:  1,
}, {
  // Looser poll than fixture smoke — real Claude rounds are 30-180s each.
  poll_ms: 2000,
  // Per-stage timeout slightly under the handler's default of 4min, plenty
  // of headroom for a tiny file-header change.
  stage_timeout_ms: 5 * 60 * 1000,
  total_timeout_ms: 12 * 60 * 1000,
});
const elapsedSec = Math.floor((Date.now() - t0) / 1000);
console.log(`\n[done] elapsed ${elapsedSec}s · status=${result.status} · stopped_reason=${result.stopped_reason}`);

// ---------------------------------------------------------------------------
// Verify chain shape
// ---------------------------------------------------------------------------

ok(result.ok === true, 'runContinuousIteration returned ok=true');
ok(result.status === 'finished', `final status === 'finished' (got ${result.status})`);
ok(result.scout_run_id && /^wr_/.test(result.scout_run_id), 'scout_run_id populated and well-formed');
ok(Array.isArray(result.candidate_runs) && result.candidate_runs.length === 1,
   `exactly 1 candidate_run (got ${result.candidate_runs && result.candidate_runs.length})`);

const cr = result.candidate_runs[0];
console.log('\n[candidate_run]');
console.log(`  candidate_id:       ${cr.candidate_id}`);
console.log(`  worker_run_id:      ${cr.worker_run_id}`);
console.log(`  review_run_id:      ${cr.review_run_id}`);
console.log(`  verdict:            ${cr.verdict}`);
console.log(`  reason:             ${cr.reason}`);
console.log(`  boundary_violations: ${JSON.stringify(cr.boundary_violations)}`);
console.log(`  status:             ${cr.status}`);

ok(cr.worker_run_id && /^wr_/.test(cr.worker_run_id), 'candidate has worker_run_id');
ok(cr.review_run_id && /^wr_/.test(cr.review_run_id), 'candidate has review_run_id');
ok(['pass', 'fail', 'needs_human'].includes(cr.verdict),
   `verdict ∈ closed set (got ${cr.verdict})`);
ok(Array.isArray(cr.boundary_violations), 'boundary_violations is an array (may be empty)');
ok(cr.status === 'REVIEWED', `candidate_runs[0].status === 'REVIEWED' (got ${cr.status})`);

// Candidate state in the registry — the Day 4/5 contract: Mode B never
// auto-Accepts. The registry MUST show REVIEWED, never ACCEPTED.
const candRow = candidates.getCandidate(PID, cr.candidate_id);
ok(candRow && candRow.status === 'REVIEWED',
   `registry: candidate.status === 'REVIEWED' (got ${candRow && candRow.status}) — NOT auto-promoted to ACCEPTED`);
ok(candRow.status !== 'ACCEPTED' && candRow.status !== 'REJECTED' && candRow.status !== 'ROLLED_BACK',
   'registry: candidate is NOT in any terminal state');
ok(candRow.review_iteration_id && /^i_/.test(candRow.review_iteration_id),
   'registry: review_iteration_id stamped');

// ---------------------------------------------------------------------------
// Temp repo integrity: Day 3 contract — worker did not commit.
// ---------------------------------------------------------------------------

const postHead   = git(['rev-parse', 'HEAD']).stdout.trim();
const postStatus = git(['status', '--short']).stdout;
console.log('\n[post-run repo state]');
console.log(`  HEAD:    ${postHead}`);
console.log(`  status:`);
postStatus.split('\n').filter(Boolean).forEach(l => console.log(`    ${l}`));
ok(preHead === postHead, `Day 3 contract: HEAD unchanged (pre=${preHead.slice(0,8)} post=${postHead.slice(0,8)})`);

// Scope check: changed files should be confined to src/index.ts (the
// candidate description scopes to src/index.ts). If Claude touched
// other paths, this catches it.
const changed = postStatus.split('\n').filter(Boolean).map(l => l.replace(/^.{2}\s+/, '').trim());
const inScope = changed.every(f => f === 'src/index.ts' || f.startsWith('src/'));
ok(inScope, `changed files within candidate scope (changed: ${changed.join(', ') || '(none)'})`);

// ---------------------------------------------------------------------------
// Secret-leak grep across all three run tails.
// ---------------------------------------------------------------------------

const tailScout  = handlers.tailWorkerRun(result.scout_run_id, 32768).text || '';
const tailWorker = handlers.tailWorkerRun(cr.worker_run_id, 32768).text || '';
const tailReview = handlers.tailWorkerRun(cr.review_run_id, 32768).text || '';
for (const [name, tail] of [['scout', tailScout], ['worker', tailWorker], ['review', tailReview]]) {
  ok(!/sk-ant-[A-Za-z0-9_-]{20,}/.test(tail), `${name}: no sk-ant- token in tail.log`);
  ok(!/\bsk-[A-Za-z0-9]{40,}\b/.test(tail),   `${name}: no sk-* token in tail.log`);
  ok(!/\bghp_[A-Za-z0-9]{20,}\b/.test(tail),  `${name}: no ghp_ token in tail.log`);
  ok(!/Bearer\s+[A-Za-z0-9_\-\.]{30,}/.test(tail), `${name}: no Bearer header in tail.log`);
}

// ---------------------------------------------------------------------------
// Multi-Cairn shouldn't have been touched.
// ---------------------------------------------------------------------------

const teamRows = handlers.listTeamCandidates(PID);
ok(Array.isArray(teamRows) && teamRows.length === 0,
   'A4 boundary: Multi-Cairn outbox untouched (listTeamCandidates returns [])');

// ---------------------------------------------------------------------------
// Cleanup: restore working tree + delete temp repo, then verify byte-equal.
// ---------------------------------------------------------------------------

console.log('\n[cleanup]');
// First print the worker's diff for the record.
const finalDiff = git(['diff', '--no-color']).stdout;
if (finalDiff) {
  console.log('  worker diff (preserved for inspection before cleanup):');
  finalDiff.split('\n').slice(0, 20).forEach(l => console.log('  | ' + l));
}
// Restore working tree.
git(['checkout', '--', '.']);
git(['clean', '-fd']);
const cleanedStatus = git(['status', '--short']).stdout;
ok(cleanedStatus === '', `working tree clean after git checkout + clean (got: ${JSON.stringify(cleanedStatus)})`);
const postCleanFingerprint = snapshotRepo(tempRepo);
const fpKeys = Object.keys(preFingerprint).sort();
const cleanKeys = Object.keys(postCleanFingerprint).sort();
ok(JSON.stringify(fpKeys) === JSON.stringify(cleanKeys),
   'post-cleanup file set === pre-flight file set');
// Semantic cleanup check: `git diff HEAD` must be empty after
// checkout+clean. We don't compare raw bytes against the pre-flight
// snapshot because git on Windows applies core.autocrlf (LF→CRLF on
// checkout) and we wrote the seed files with plain \n — that
// difference is git-induced, not worker-induced.
const cleanDiff = git(['diff', 'HEAD']).stdout;
ok(cleanDiff === '', `post-cleanup: git diff HEAD is empty (${cleanDiff.length} byte(s))`);

// Delete temp repo.
let rmOk = true;
try { fs.rmSync(tempRepo, { recursive: true, force: true }); }
catch (e) { rmOk = false; console.log(`  rm error: ${e.message}`); }
ok(rmOk && !fs.existsSync(tempRepo), 'temp repo dir removed');

console.log('\n========================================');
console.log(`  ${asserts - fails}/${asserts} assertions passed (${fails} failed)`);
console.log('========================================\n');

if (fails) { console.log('FAILURES:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }
