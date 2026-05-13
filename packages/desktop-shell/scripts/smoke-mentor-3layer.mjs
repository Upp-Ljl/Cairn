#!/usr/bin/env node
/**
 * smoke-mentor-3layer.mjs — deterministic gate for the L1+L2 3-layer
 * decision architecture (CAIRN.md profile + agent_brief).
 *
 * Covers:
 *   - scanner shape (sections, IS/IS NOT, authority ✅⚠️🛑, known_answers,
 *     current phase)
 *   - missing-file graceful fallback (no exception, profile.exists=false)
 *   - profile cache write+read+mtime-gated reuse via loadProfile
 *   - agent_brief read / staleness flag / briefSnippet
 *   - mentor-policy Rule D with each profile route:
 *       L1.0 known_answers   → nudge_from_profile
 *       L1.1 authority.🛑    → escalate (profile-sourced)
 *       L1.2 authority.✅    → nudge_from_profile + brief lean when present
 *       L1.3 authority.⚠️    → nudge_from_profile with announce flag
 *       L1 unmatched         → conservative escalate
 *       config.knownAnswers  → nudge_with_known_answer (back-compat)
 *   - mentor-policy Rule E with profile escalate / unmatched
 *   - mentor-policy Rule G with profile auto_decide / unmatched
 *
 * No LLM calls (those live in dogfood-llm-3layer.mjs).
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dsRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(dsRoot, '..', '..');

const Database = require(path.join(repoRoot, 'packages', 'daemon', 'node_modules', 'better-sqlite3'));
const profileMod = require(path.join(dsRoot, 'mentor-project-profile.cjs'));
const briefMod = require(path.join(dsRoot, 'mentor-agent-brief.cjs'));
const policy = require(path.join(dsRoot, 'mentor-policy.cjs'));

let asserts = 0, fails = 0;
const failures = [];
function ok(c, l) {
  asserts++;
  if (c) process.stdout.write(`  ok    ${l}\n`);
  else   { fails++; failures.push(l); process.stdout.write(`  FAIL  ${l}\n`); }
}
function header(t) { process.stdout.write(`\n${'='.repeat(56)}\n${t}\n${'='.repeat(56)}\n`); }
function section(t) { process.stdout.write(`\n[${t}]\n`); }

function freshDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE scratchpad (
      key TEXT PRIMARY KEY, value_json TEXT, value_path TEXT, task_id TEXT,
      expires_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
  `);
  return db;
}

const PROJ = { id: 'p_smoke', project_root: null }; // populated per-test when needed
const TASK = (overrides) => Object.assign({
  task_id: 't_smk',
  intent: 'add tests',
  state: 'RUNNING',
  created_at: Date.now() - 60000,
  updated_at: Date.now() - 5000,
  created_by_agent_id: 'cairn-session-aaaa00000001',
  metadata_json: null,
}, overrides || {});

const SAMPLE_CAIRN_MD = `# Smoke Test Project

## Whole

A test fixture project that validates the schema-v2 3-layer Mentor architecture end to end.

## Goal

Get smoke + dogfood passing.

## What this project IS / IS NOT

- IS: a kernel for multi-agent coordination
- IS: shared state primitives
- IS NOT: an agent
- IS NOT: a task daemon

## Mentor authority (decision delegation)

- ✅ retry transient test failures up to 2x
- ✅ pick TypeScript over JavaScript when blocker asks "which language"
- ⚠️ reduce a task's time budget when 80% elapsed and progress visible
- ⚠️ extend a task's time budget by 30%
- 🛑 npm publish
- 🛑 force-push to main
- 🛑 LICENSE edit
- 🛑 outcomes evaluation failed

## Project constraints

- no new npm deps
- tests hit real DB, not mocks

## Known answers

- which test framework => vitest with real DB, not mocks
- prefer ts or js => prefer TypeScript
`;

header('smoke-mentor-3layer');

// ---------------------------------------------------------------------------
// Scanner shape
// ---------------------------------------------------------------------------
section('1 Scanner — CAIRN.md shape');
let scanProfile;
{
  const tmp = path.join(os.tmpdir(), `cairn-3layer-smoke-${Date.now()}.md`);
  fs.writeFileSync(tmp, SAMPLE_CAIRN_MD, 'utf8');
  scanProfile = profileMod.scanCairnMd(tmp);
  ok(scanProfile.exists === true, 'profile.exists === true');
  ok(scanProfile.project_name === 'Smoke Test Project', 'project_name parsed');
  ok(typeof scanProfile.source_sha1 === 'string' && scanProfile.source_sha1.length === 16, 'sha1 truncated 16-hex');
  ok(scanProfile.goal && scanProfile.goal.length > 0, 'goal parsed (non-empty)');
  ok(scanProfile.is_list.includes('a kernel for multi-agent coordination'), 'is_list captures kernel line');
  ok(scanProfile.is_list.includes('shared state primitives'), 'is_list captures primitives line');
  ok(scanProfile.is_not_list.includes('an agent'), 'is_not_list captures agent');
  ok(scanProfile.is_not_list.includes('a task daemon'), 'is_not_list captures task daemon');
  ok(scanProfile.authority.auto_decide.length === 2, '✅ bullets: 2');
  ok(scanProfile.authority.decide_and_announce.length === 2, '⚠️ bullets: 2');
  ok(scanProfile.authority.escalate.length === 4, '🛑 bullets: 4');
  ok(scanProfile.constraints.includes('no new npm deps'), 'constraints captured');
  ok(scanProfile.known_answers.some(k => k.pattern === 'which test framework' && k.answer.includes('vitest')), 'known_answers: vitest entry');
  ok(scanProfile.known_answers.some(k => k.pattern === 'prefer ts or js' && k.answer.includes('TypeScript')), 'known_answers: ts entry');
  // schema v2 (2026-05-14): whole_sentence extracted, goal kept, current_phase gone
  ok(scanProfile.version === 2, 'profile.version === 2 (schema v2)');
  ok(typeof scanProfile.whole_sentence === 'string' && scanProfile.whole_sentence.includes('schema-v2 3-layer'),
     'whole_sentence parsed from ## Whole');
  ok(scanProfile.goal === 'Get smoke + dogfood passing.', 'goal parsed from ## Goal');
  ok(!('current_phase' in scanProfile), 'current_phase removed from profile (v2)');
  fs.unlinkSync(tmp);
}

// ---------------------------------------------------------------------------
// Missing-file fallback
// ---------------------------------------------------------------------------
section('2 Scanner — missing file fallback');
{
  const p = profileMod.scanCairnMd('/no/such/dir/CAIRN.md');
  ok(p.exists === false, 'missing CAIRN.md → exists=false');
  ok(p.authority.escalate.length === 0, 'missing file → empty escalate');
  ok(p.authority.auto_decide.length === 0, 'missing file → empty auto_decide');
  ok(p.known_answers.length === 0, 'missing file → empty known_answers');
  ok(p.version === profileMod.PROFILE_VERSION, 'version stamped');
}

// ---------------------------------------------------------------------------
// Cache layer
// ---------------------------------------------------------------------------
section('3 Cache — write + read + loadProfile reuse');
{
  const db = freshDb();
  const written = profileMod.writeCachedProfile(db, 'p_cache', scanProfile);
  ok(written === true, 'writeCachedProfile returns true');
  const back = profileMod.readCachedProfile(db, 'p_cache');
  ok(back !== null, 'readCachedProfile finds row');
  ok(back.project_name === scanProfile.project_name, 'round-trip project_name');
  ok(back.authority.escalate.length === scanProfile.authority.escalate.length, 'round-trip authority lengths');

  // loadProfile via temp file
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-3layer-load-'));
  fs.writeFileSync(path.join(tmpDir, 'CAIRN.md'), SAMPLE_CAIRN_MD);
  const proj = { id: 'p_load', project_root: tmpDir };
  const first = profileMod.loadProfile(db, proj);
  ok(first.exists === true, 'loadProfile reads file');
  ok(first.project_name === 'Smoke Test Project', 'loadProfile got project_name');
  // Same file unchanged → cache reuse (we can detect: scanned_at frozen).
  const cachedFirst = profileMod.readCachedProfile(db, proj.id);
  const second = profileMod.loadProfile(db, proj);
  ok(second.scanned_at === cachedFirst.scanned_at, 'loadProfile reuses cache when mtime unchanged');
  // Touch the file (advance mtime) → re-scan.
  const future = Date.now() + 10_000;
  fs.utimesSync(path.join(tmpDir, 'CAIRN.md'), future / 1000, future / 1000);
  const third = profileMod.loadProfile(db, proj);
  ok(third.scanned_at >= second.scanned_at, 'loadProfile re-scans when mtime advanced');
  fs.rmSync(tmpDir, { recursive: true, force: true });
  db.close();
}

// ---------------------------------------------------------------------------
// agent_brief
// ---------------------------------------------------------------------------
section('4 agent_brief — read / stale flag / snippet');
{
  const db = freshDb();
  const wrote = briefMod.writeAgentBriefForTest(db, 'cairn-session-bbbb22222222', {
    agent_id: 'cairn-session-bbbb22222222',
    task_id: 't_smk',
    summary: 'porting the migration runner to a new schema version',
    stuck_on: 'unsure whether to keep checksum guard',
    options_considered: ['keep guard', 'drop guard'],
    lean: 'keep guard — historical migrations are immutable per CLAUDE.md',
    written_at: Date.now(),
  });
  ok(wrote === true, 'writeAgentBriefForTest returns true');
  const r = briefMod.readAgentBrief(db, 'cairn-session-bbbb22222222');
  ok(r !== null && r.brief.lean.includes('keep guard'), 'readAgentBrief returns brief');
  ok(r.is_stale === false, 'fresh brief is not stale');
  const stale = briefMod.readAgentBrief(db, 'cairn-session-bbbb22222222', { staleAfterMs: 1, nowMs: Date.now() + 60_000 });
  ok(stale.is_stale === true, 'stale brief flagged when nowMs advances');
  const snip = briefMod.briefSnippet(r.brief);
  ok(typeof snip === 'string' && snip.includes('keep guard'), 'briefSnippet returns one-liner');
  db.close();
}

// ---------------------------------------------------------------------------
// Rule D — each 3-layer route
// ---------------------------------------------------------------------------
section('5 Rule D — L1.0 known_answers → nudge_from_profile');
{
  const db = freshDb();
  const r = policy.evaluatePolicy({
    db, project: { id: 'p_d_known' },
    task: TASK({ state: 'BLOCKED' }),
    openBlockers: [{ blocker_id: 'b1', question: 'Should I use which test framework here?', raised_at: Date.now() }],
    profile: scanProfile,
  });
  const dec = r.decisions.find(d => d.rule === 'D');
  ok(dec && dec.action === 'nudge_from_profile', 'action = nudge_from_profile');
  ok(dec.source === 'profile.known_answers', 'source = profile.known_answers');
  ok(dec.match_pattern === 'which test framework', 'match_pattern surfaced');
  db.close();
}

section('6 Rule D — L1.1 authority.🛑 → escalate');
{
  const db = freshDb();
  const r = policy.evaluatePolicy({
    db, project: { id: 'p_d_esc' },
    task: TASK({ state: 'BLOCKED' }),
    openBlockers: [{ blocker_id: 'b1', question: 'Should I do an npm publish for this fix?', raised_at: Date.now() }],
    profile: scanProfile,
  });
  const dec = r.decisions.find(d => d.rule === 'D');
  ok(dec && dec.action === 'escalate', 'action = escalate');
  ok(dec.source === 'profile.authority.escalate', 'source = profile.authority.escalate');
  ok(dec.matched_bullet === 'npm publish', 'matched_bullet captured');
  db.close();
}

section('7 Rule D — L1.2 authority.✅ → nudge_from_profile + brief lean');
{
  const db = freshDb();
  briefMod.writeAgentBriefForTest(db, 'cairn-session-cccc33333333', {
    agent_id: 'cairn-session-cccc33333333',
    task_id: 't_smk',
    summary: 'integrating with the new test framework',
    stuck_on: 'whether to retry the flaky test once more',
    options_considered: ['retry once', 'mark as flaky'],
    lean: 'retry once — the failure looks transient',
    written_at: Date.now(),
  });
  const briefs = briefMod.readAgentBriefs(db, ['cairn-session-cccc33333333']);
  const r = policy.evaluatePolicy({
    db, project: { id: 'p_d_auto' },
    task: TASK({ state: 'BLOCKED', created_by_agent_id: 'cairn-session-cccc33333333' }),
    openBlockers: [{ blocker_id: 'b1', question: 'Should we retry transient test failures here?', raised_at: Date.now() }],
    profile: scanProfile,
    briefs,
  });
  const dec = r.decisions.find(d => d.rule === 'D');
  ok(dec && dec.action === 'nudge_from_profile', 'action = nudge_from_profile');
  ok(dec.route === 'auto', 'route = auto');
  ok(dec.source === 'profile.authority.auto_decide', 'source = profile.authority.auto_decide');
  ok(dec.brief_used === true, 'brief_used flag = true');
  // Inspect the actual nudge body — should mention the lean.
  const nudgeRow = db.prepare('SELECT value_json FROM scratchpad WHERE key = ?').get(dec.nudge_key);
  const nudgeBody = JSON.parse(nudgeRow.value_json);
  ok(typeof nudgeBody.message === 'string' && nudgeBody.message.includes('retry once'),
     'nudge body includes brief lean');
  db.close();
}

section('8 Rule D — L1.3 authority.⚠️ → nudge_from_profile with announce flag');
{
  const db = freshDb();
  const r = policy.evaluatePolicy({
    db, project: { id: 'p_d_ann' },
    task: TASK({ state: 'BLOCKED' }),
    openBlockers: [{ blocker_id: 'b1', question: 'Should I reduce the task time budget for this?', raised_at: Date.now() }],
    profile: scanProfile,
  });
  const dec = r.decisions.find(d => d.rule === 'D');
  ok(dec && dec.action === 'nudge_from_profile', 'action = nudge_from_profile');
  ok(dec.route === 'announce', 'route = announce');
  ok(dec.source === 'profile.authority.decide_and_announce', 'source = announce');
  const nudgeRow = db.prepare('SELECT value_json FROM scratchpad WHERE key = ?').get(dec.nudge_key);
  const body = JSON.parse(nudgeRow.value_json);
  ok(body.announce === true, 'announce flag set in nudge payload');
  db.close();
}

section('9 Rule D — L1 unmatched → conservative escalate');
{
  const db = freshDb();
  const r = policy.evaluatePolicy({
    db, project: { id: 'p_d_unm' },
    task: TASK({ state: 'BLOCKED' }),
    openBlockers: [{ blocker_id: 'b1', question: 'unrelated question about purple monkeys', raised_at: Date.now() }],
    profile: scanProfile,
  });
  const dec = r.decisions.find(d => d.rule === 'D');
  ok(dec && dec.action === 'escalate', 'unmatched profile → escalate');
  ok(dec.source === 'profile.unmatched', 'source = profile.unmatched');
  db.close();
}

section('10 Rule D — config.knownAnswers legacy back-compat');
{
  const db = freshDb();
  const r = policy.evaluatePolicy({
    db, project: { id: 'p_d_legacy' },
    task: TASK({ state: 'BLOCKED' }),
    openBlockers: [{ blocker_id: 'b1', question: 'use vitest or bun:test?', raised_at: Date.now() }],
    // no profile — exercises L2-legacy path
    config: { knownAnswers: { 'vitest or bun:test': 'use bun:test (project standard)' } },
  });
  const dec = r.decisions.find(d => d.rule === 'D');
  ok(dec && dec.action === 'nudge_with_known_answer', 'legacy action name preserved');
  db.close();
}

// ---------------------------------------------------------------------------
// Rule E — profile routing
// ---------------------------------------------------------------------------
section('11 Rule E — profile escalates "time budget" → escalate');
{
  const db = freshDb();
  // Build a profile where 🛑 contains "time budget"
  const customProfile = JSON.parse(JSON.stringify(scanProfile));
  customProfile.authority.escalate.push('time budget overrun');
  const r = policy.evaluatePolicy({
    db, project: { id: 'p_e_esc' },
    task: TASK({ created_at: Date.now() - 60000, metadata_json: JSON.stringify({ budget_ms: 60000 }) }),
    profile: customProfile,
  });
  const dec = r.decisions.find(d => d.rule === 'E');
  ok(dec && dec.action === 'escalate', 'escalate per profile.🛑');
  ok(dec.source === 'profile.authority.escalate', 'source captured');
  db.close();
}

section('12 Rule E — profile unmatched → escalate (back-compat)');
{
  const db = freshDb();
  // scanProfile has "reduce a task's time budget" in ⚠️ — that DOES match
  // "time budget". So the rule should fire as announce, not escalate.
  // Use a profile with no time-budget bullet to test unmatched.
  const customProfile = JSON.parse(JSON.stringify(scanProfile));
  customProfile.authority.auto_decide = [];
  customProfile.authority.decide_and_announce = [];
  customProfile.authority.escalate = customProfile.authority.escalate.filter(s => !s.toLowerCase().includes('time'));
  const r = policy.evaluatePolicy({
    db, project: { id: 'p_e_unm' },
    task: TASK({ created_at: Date.now() - 60000, metadata_json: JSON.stringify({ budget_ms: 60000 }) }),
    profile: customProfile,
  });
  const dec = r.decisions.find(d => d.rule === 'E');
  ok(dec && dec.action === 'escalate', 'unmatched → escalate (back-compat)');
  db.close();
}

// ---------------------------------------------------------------------------
// Rule G — profile routing
// ---------------------------------------------------------------------------
section('13 Rule G — profile 🛑 on outcomes failed → escalate');
{
  const db = freshDb();
  const r = policy.evaluatePolicy({
    db, project: { id: 'p_g_esc' },
    task: TASK(),
    outcome: { task_id: 't_smk', status: 'FAILED' },
    profile: scanProfile, // contains "🛑 outcomes evaluation failed"
  });
  const dec = r.decisions.find(d => d.rule === 'G');
  ok(dec && dec.action === 'escalate', 'profile.🛑 fires → escalate');
  ok(dec.source === 'profile.authority.escalate', 'source captured');
  db.close();
}

section('14 Rule G — profile ✅ on outcomes failed → nudge_from_profile');
{
  const db = freshDb();
  const customProfile = JSON.parse(JSON.stringify(scanProfile));
  customProfile.authority.escalate = customProfile.authority.escalate.filter(s => !s.toLowerCase().includes('outcomes'));
  customProfile.authority.auto_decide.push('outcomes evaluation failed');
  const r = policy.evaluatePolicy({
    db, project: { id: 'p_g_auto' },
    task: TASK(),
    outcome: { task_id: 't_smk', status: 'FAILED' },
    profile: customProfile,
  });
  const dec = r.decisions.find(d => d.rule === 'G');
  ok(dec && dec.action === 'nudge_from_profile', 'profile.✅ fires → nudge_from_profile');
  ok(dec.source === 'profile.authority.auto_decide', 'source captured');
  db.close();
}

section('15 Rule G — no profile → legacy nudge (first failure)');
{
  const db = freshDb();
  const r = policy.evaluatePolicy({
    db, project: { id: 'p_g_legacy' },
    task: TASK(),
    outcome: { task_id: 't_smk', status: 'FAILED' },
    // no profile
  });
  const dec = r.decisions.find(d => d.rule === 'G');
  ok(dec && dec.action === 'nudge', 'legacy path preserved → nudge');
  db.close();
}

// ---------------------------------------------------------------------------
// routeBySignal helper smoke
// ---------------------------------------------------------------------------
section('16 routeBySignal helper');
{
  const routedEsc = policy.routeBySignal(scanProfile, 'we are about to npm publish');
  ok(routedEsc.route === 'escalate' && routedEsc.matched_bullet === 'npm publish', 'routes npm publish to escalate');
  const routedAuto = policy.routeBySignal(scanProfile, 'retry transient test failures cleanly');
  ok(routedAuto.route === 'auto', 'routes retry phrasing to auto');
  const routedNone = policy.routeBySignal(scanProfile, 'I want to paint the wall purple');
  ok(routedNone.route === 'unmatched', 'unrelated signal → unmatched');
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
header(`${asserts - fails}/${asserts} assertions passed (${fails} failed)`);
if (fails) {
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
  process.exit(1);
}
process.exit(0);
