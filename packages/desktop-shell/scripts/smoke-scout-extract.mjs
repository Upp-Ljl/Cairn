#!/usr/bin/env node
/**
 * Smoke for Three-Stage Loop Day 2 — Scout extraction.
 *
 * Part A — parser unit tests (no spawn, pure text).
 * Part B — fixture-scout end-to-end: launch -> tail -> extract -> registry.
 * Part C — IPC + preload exposure.
 * Part D — safety invariants.
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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-scout-smoke-'));
os.homedir = () => tmpDir;
fs.mkdirSync(path.join(tmpDir, '.cairn'), { recursive: true });

const launcher = require(path.join(root, 'worker-launcher.cjs'));
const handlers = require(path.join(root, 'managed-loop-handlers.cjs'));
const candidates = require(path.join(root, 'project-candidates.cjs'));
const scoutPrompt = require(path.join(root, 'scout-prompt.cjs'));
const iters = require(path.join(root, 'project-iterations.cjs'));

console.log('==> Part A: parser unit tests');

// 1. Five legal candidates parse cleanly.
const t1 = launcher.extractScoutCandidatesFromText([
  '## Scout Candidates',
  '- [missing_test] foo.ts has no test',
  '- [doc] README missing quickstart',
  '- [bug_fix] mailbox timeout edge',
  '- [refactor] consolidate validators',
  '- [other] add changelog template',
].join('\n'));
ok(t1.ok, 'parse: 5 legal candidates ok');
ok(t1.candidates.length === 5, '5 candidates returned');
ok(t1.candidates.every(c => c.description.length > 0), 'all descriptions non-empty');
ok(t1.candidates[0].kind === 'missing_test' && t1.candidates[1].kind === 'doc', 'kinds preserved in order');

// 2. Six candidates → only first 5 (truncation).
const t2 = launcher.extractScoutCandidatesFromText([
  '## Scout Candidates',
  '- [missing_test] one',
  '- [doc] two',
  '- [bug_fix] three',
  '- [refactor] four',
  '- [other] five',
  '- [missing_test] six (should be dropped)',
].join('\n'));
ok(t2.ok && t2.candidates.length === 5, 'truncation: only first 5 retained');
ok(t2.candidates[4].description === 'five', 'fifth candidate is "five", not "six"');

// 3. Closed kind set + unknown kind coercion.
const t3 = launcher.extractScoutCandidatesFromText([
  '## Scout Candidates',
  '- [missing_test] valid kind',
  '- [made_up_kind] description body here',
].join('\n'));
ok(t3.ok && t3.candidates.length === 2, 'two candidates parsed');
ok(t3.candidates[0].kind === 'missing_test', 'valid kind preserved');
ok(t3.candidates[1].kind === 'other', 'unknown kind coerced to "other"');
ok(t3.candidates[1].description.includes('made_up_kind') || t3.candidates[1].description.includes('description body here'),
   'unknown-kind description preserves original info');

// 4. No-kind line → 'other'.
const t4 = launcher.extractScoutCandidatesFromText([
  '## Scout Candidates',
  '- a candidate with no kind tag',
].join('\n'));
ok(t4.ok && t4.candidates.length === 1, 'no-kind line parsed as one candidate');
ok(t4.candidates[0].kind === 'other', 'kindless line defaults to "other"');
ok(t4.candidates[0].description === 'a candidate with no kind tag', 'kindless description preserved verbatim');

// 5. Empty bullet → skipped (no phantom).
const t5 = launcher.extractScoutCandidatesFromText([
  '## Scout Candidates',
  '- [missing_test] real one',
  '-',
  '- [doc] real two',
].join('\n'));
ok(t5.ok && t5.candidates.length === 2, 'empty bullet skipped (no phantom candidate)');

// 6. None-sentinel lines are skipped.
const t6 = launcher.extractScoutCandidatesFromText([
  '## Scout Candidates',
  '- [doc] real one',
  '- (none)',
  '- N/A',
  '- nothing',
  '- [bug_fix] real two',
].join('\n'));
ok(t6.ok && t6.candidates.length === 2, 'sentinels skipped (no phantom candidates)');
ok(t6.candidates.map(c => c.description).every(d => !/^\(?none\)?$|n\/a|nothing/i.test(d)),
   'no sentinel description survived');

// 7. No header → no_scout_block.
const t7 = launcher.extractScoutCandidatesFromText('hello world\nno header here\n');
ok(!t7.ok && t7.error === 'no_scout_block', 'missing header → no_scout_block');

// 8. Multiple headers → last wins.
const t8 = launcher.extractScoutCandidatesFromText([
  '## Scout Candidates',
  '- [missing_test] early one (should be dropped)',
  '## Scout Candidates',
  '- [doc] late one',
].join('\n'));
ok(t8.ok && t8.candidates.length === 1 && t8.candidates[0].description === 'late one',
   'multiple headers: last block wins');

// 9. extractScoutCandidates(runId) on a non-existent run → no_log.
const t9 = launcher.extractScoutCandidates('wr_no_such_run');
ok(!t9.ok && t9.error === 'no_log', 'unknown run → no_log');

// 10. SCOUT_CANDIDATES_HEADER source-of-truth.
ok(scoutPrompt.SCOUT_CANDIDATES_HEADER === '## Scout Candidates',
   'SCOUT_CANDIDATES_HEADER is the canonical "## Scout Candidates"');
ok(scoutPrompt.SCOUT_HARD_RULES.includes(scoutPrompt.SCOUT_CANDIDATES_HEADER),
   'SCOUT_HARD_RULES references SCOUT_CANDIDATES_HEADER');

// 11. generateScoutPrompt is_scout flag.
const promptInput = {
  goal: { id: 'g', title: 'Smoke', desired_outcome: '' },
  project_rules: { non_goals: [] },
  recent_reports: [],
};
const sp = scoutPrompt.generateScoutPrompt(promptInput, { managed_record: null, forceDeterministic: true });
ok(sp.is_scout === true && sp.mode === 'scout', 'generateScoutPrompt sets is_scout + mode');
ok(sp.prompt.startsWith('# CAIRN SCOUT — READ-ONLY ROUND'), 'scout prompt starts with hard-rules header');
ok(sp.prompt.includes('## Scout Candidates'), 'scout prompt embeds the canonical header');

// ---------------------------------------------------------------------------
console.log('\n==> Part B: fixture-scout end-to-end');

// fixture-scout is in the catalog and detected as available.
const provs = launcher.detectWorkerProviders();
ok(provs.find(p => p.id === 'fixture-scout' && p.available), 'fixture-scout detected available');

// Build a fixture managed project (a barebones git repo).
const fix = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-scout-fixture-'));
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

const PROJECT_ID = 'p_scout_smoke';
const reg = {
  projects: [{
    id: PROJECT_ID, label: 'scout-fix',
    project_root: fix, db_path: '/dev/null', agent_id_hints: [],
  }],
};
const reg1 = handlers.registerManagedProject(reg, PROJECT_ID, {});
ok(reg1.ok, 'register managed project ok');
const startRes = handlers.startManagedIteration(PROJECT_ID, { goal_id: 'g_x' });
ok(startRes.ok, 'iteration started');
const ITER_ID = startRes.iteration.id;

// Generate scout prompt and launch fixture-scout.
const goal = { id: 'g_x', title: 'Scout fixture round', desired_outcome: 'list candidates' };
const promptCtx = {
  goal, project_rules: { non_goals: [] }, recent_reports: [],
};
// Build the prompt directly via scout-prompt + the same context shape
// generateManagedWorkerPrompt builds.
const baseProm = handlers.generateManagedWorkerPrompt(PROJECT_ID, { goal, project_rules: { non_goals: [] } });
ok(baseProm.ok, 'base managed prompt generated');
const scoutPack = scoutPrompt.generateScoutPrompt({
  goal, project_rules: { non_goals: [] }, recent_reports: [],
}, { managed_record: handlers.getManagedProjectProfile(PROJECT_ID), iteration_id: ITER_ID, forceDeterministic: true });
ok(scoutPack.is_scout && scoutPack.prompt.length > 0, 'scout pack composed');

const launchRes = handlers.launchManagedWorker(PROJECT_ID, {
  provider: 'fixture-scout',
  prompt: scoutPack.prompt,
});
ok(launchRes.ok, 'launch fixture-scout ok');
const RUN_ID = launchRes.run_id;

// Wait for fixture-scout to exit (it just writes lines and exits 0).
await new Promise(r => setTimeout(r, 800));
const finalRun = handlers.getWorkerRun(RUN_ID);
ok(finalRun && finalRun.status === 'exited', `fixture-scout exited (status=${finalRun && finalRun.status})`);

// Tail must contain the canonical header.
const tailRes = handlers.tailWorkerRun(RUN_ID, 16384);
ok(tailRes.ok && tailRes.text.includes('## Scout Candidates'), 'tail contains "## Scout Candidates"');

// Extract via the handler — verifies project_id_mismatch path,
// proposeCandidate persistence, and source_iteration_id binding.
const ext = handlers.extractScoutCandidates(PROJECT_ID, { run_id: RUN_ID });
ok(ext.ok, 'extractScoutCandidates ok');
ok(Array.isArray(ext.candidate_ids) && ext.candidate_ids.length === 5, '5 candidate_ids returned');
ok(ext.candidates.every(c => c.description && c.description.length > 0), 'every candidate has description');
ok(ext.candidates.some(c => c.kind === 'missing_test') && ext.candidates.some(c => c.kind === 'doc'),
   'kinds round-trip from fixture');

// Registry side: each candidate is PROPOSED, source_iteration_id matches.
const all = candidates.listCandidates(PROJECT_ID, 50);
ok(all.length === 5, 'registry holds 5 candidates');
ok(all.every(c => c.status === 'PROPOSED'), 'all candidates are PROPOSED');
ok(all.every(c => c.source_run_id === RUN_ID), 'every candidate.source_run_id === RUN_ID');
ok(all.every(c => c.source_iteration_id === ITER_ID), 'every candidate.source_iteration_id === ITER_ID');
ok(candidates.listCandidatesByStatus(PROJECT_ID, 'PROPOSED').length === 5,
   'listCandidatesByStatus(PROPOSED) returns all 5');

// project_id_mismatch path: try extracting with a different projectId.
const mismatch = handlers.extractScoutCandidates('p_other_project', { run_id: RUN_ID });
ok(!mismatch.ok && mismatch.error === 'project_id_mismatch',
   'extract with mismatched projectId rejected');

// ---------------------------------------------------------------------------
console.log('\n==> Part C: IPC + preload exposure');

const preload = fs.readFileSync(path.join(root, 'preload.cjs'), 'utf8');
ok(/extractScoutCandidates:\s/.test(preload), 'preload exposes extractScoutCandidates');

const main = fs.readFileSync(path.join(root, 'main.cjs'), 'utf8');
ok(main.includes("'extract-scout-candidates'"), 'main.cjs registers extract-scout-candidates IPC');

// ---------------------------------------------------------------------------
console.log('\n==> Part D: safety invariants');

ok(safeMtime(realCairnDb) === beforeDb, 'real ~/.cairn/cairn.db mtime unchanged');

const launcherSrc = fs.readFileSync(path.join(root, 'worker-launcher.cjs'), 'utf8');
const launcherCode = launcherSrc.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
const scoutSrc = fs.readFileSync(path.join(root, 'scout-prompt.cjs'), 'utf8');
const scoutCode = scoutSrc.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
ok(!/require\(['"]better-sqlite3/.test(launcherCode), 'worker-launcher does not import better-sqlite3');
ok(!/require\(['"]better-sqlite3/.test(scoutCode), 'scout-prompt does not import better-sqlite3');
ok(!/require\(['"]electron/.test(launcherCode), 'worker-launcher does not import electron');
ok(!/require\(['"]electron/.test(scoutCode), 'scout-prompt does not import electron');

console.log(`\n${asserts - fails}/${asserts} passed (${fails} failed)`);
if (fails) { console.log('FAILURES:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }
