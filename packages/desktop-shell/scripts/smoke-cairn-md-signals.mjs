#!/usr/bin/env node
/**
 * smoke-cairn-md-signals.mjs — deterministic gate for the optional
 * `## Signals` section parser in CAIRN.md (commit B of the
 * signal-category refactor, 2026-05-15).
 *
 * Covers:
 *   - parses `## Signals` with all 6 known categories → correct override map
 *   - accepts both `~~prefix` and bare forms
 *   - empty section body → {}
 *   - missing section entirely → profile.signal_overrides === {}
 *   - unknown category → ignored (not in result)
 *   - case-insensitive on/off + alternate values (true/false/yes/no)
 *   - integration: scanCairnMd populates profile.signal_overrides
 *   - integration: emptyProfile() defaults signal_overrides to {}
 *   - integration: mode-a-loop.buildPlan copies signal_overrides onto the plan
 *
 * HOME sandbox: this smoke is pure parser + buildPlan (no registry,
 * no SQLite, no real ~/.cairn writes), but we still set HOME to a tmp
 * sandbox per the registry-pollution lesson (feedback_smoke_real_registry_pollution).
 *
 * No new npm dep.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dsRoot = path.resolve(__dirname, '..');

// HOME sandbox — no registry side-effects from this smoke, but keep the
// guard per project convention.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-signals-smoke-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const profileMod = require(path.join(dsRoot, 'mentor-project-profile.cjs'));
const modeALoop  = require(path.join(dsRoot, 'mode-a-loop.cjs'));

let asserts = 0, fails = 0;
const failures = [];
function ok(c, l) {
  asserts++;
  if (c) process.stdout.write(`  ok    ${l}\n`);
  else   { fails++; failures.push(l); process.stdout.write(`  FAIL  ${l}\n`); }
}
function header(t) { process.stdout.write(`\n${'='.repeat(56)}\n${t}\n${'='.repeat(56)}\n`); }
function section(t) { process.stdout.write(`\n[${t}]\n`); }

// Suppress the console.warn from unknown-category path so smoke output stays
// clean. Restore after we've covered the unknown-category assertion.
const _origWarn = console.warn;
let _warnCount = 0;
console.warn = (...args) => { _warnCount++; /* swallow */ };

header('Section A — parseSignalOverrides (pure)');

section('A.1 all 6 known categories, ~~ prefix, on/off');
{
  const body = [
    '- ~~project-narrative: on',
    '- ~~vcs-signal: off',
    '- ~~candidate-pipeline: on',
    '- ~~iteration-history: off',
    '- ~~worker-reports: on',
    '- ~~kernel-state: off',
  ].join('\n');
  const r = profileMod.parseSignalOverrides(body);
  ok(r.docs === true,        'A.1.1 ~~project-narrative → docs:true');
  ok(r.git === false,        'A.1.2 ~~vcs-signal → git:false');
  ok(r.candidates === true,  'A.1.3 ~~candidate-pipeline → candidates:true');
  ok(r.iterations === false, 'A.1.4 ~~iteration-history → iterations:false');
  ok(r.reports === true,     'A.1.5 ~~worker-reports → reports:true');
  ok(r.kernel === false,     'A.1.6 ~~kernel-state → kernel:false');
  ok(Object.keys(r).length === 6, 'A.1.7 exactly 6 keys');
}

section('A.2 bare form (no ~~) is accepted');
{
  const body = '- vcs-signal: off\n- candidate-pipeline: on';
  const r = profileMod.parseSignalOverrides(body);
  ok(r.git === false,       'A.2.1 bare vcs-signal → git:false');
  ok(r.candidates === true, 'A.2.2 bare candidate-pipeline → candidates:true');
}

section('A.3 mixed ~~ and bare forms in same section');
{
  const body = '- ~~vcs-signal: off\n- candidate-pipeline: off';
  const r = profileMod.parseSignalOverrides(body);
  ok(r.git === false && r.candidates === false, 'A.3.1 mixed forms parsed together');
}

section('A.4 empty body → empty map');
{
  ok(JSON.stringify(profileMod.parseSignalOverrides('')) === '{}', 'A.4.1 empty string → {}');
  ok(JSON.stringify(profileMod.parseSignalOverrides(null)) === '{}', 'A.4.2 null → {}');
  ok(JSON.stringify(profileMod.parseSignalOverrides(undefined)) === '{}', 'A.4.3 undefined → {}');
}

section('A.5 unknown category → ignored');
{
  const body = '- ~~issue-tracker: off\n- ~~vcs-signal: on';
  const warnBefore = _warnCount;
  const r = profileMod.parseSignalOverrides(body);
  ok(r.git === true, 'A.5.1 known category still parsed');
  ok(!('issue-tracker' in r) && !('issue_tracker' in r), 'A.5.2 unknown category not in result');
  ok(Object.keys(r).length === 1, 'A.5.3 result has exactly 1 entry');
  ok(_warnCount > warnBefore, 'A.5.4 unknown category triggered a console.warn');
}

section('A.6 case-insensitive values + alternate booleans');
{
  const body = [
    '- ~~vcs-signal: OFF',
    '- ~~candidate-pipeline: TRUE',
    '- ~~iteration-history: No',
    '- ~~worker-reports: Yes',
  ].join('\n');
  const r = profileMod.parseSignalOverrides(body);
  ok(r.git === false,        'A.6.1 OFF (upper) → false');
  ok(r.candidates === true,  'A.6.2 TRUE → true');
  ok(r.iterations === false, 'A.6.3 No → false');
  ok(r.reports === true,     'A.6.4 Yes → true');
}

section('A.7 unparseable value dropped silently');
{
  const body = '- ~~vcs-signal: maybe\n- ~~candidate-pipeline: on';
  const r = profileMod.parseSignalOverrides(body);
  ok(!('git' in r),         'A.7.1 "maybe" value dropped (key absent)');
  ok(r.candidates === true, 'A.7.2 sibling parsed normally');
}

section('A.8 inline comment after value is stripped');
{
  const body = '- ~~vcs-signal: off  # disabling for offline work';
  const r = profileMod.parseSignalOverrides(body);
  ok(r.git === false, 'A.8.1 trailing # comment stripped before parse');
}

header('Section B — scanCairnMd integration');

section('B.1 CAIRN.md with ## Signals section → profile.signal_overrides populated');
{
  const tmp = path.join(tmpHome, 'CAIRN-with-signals.md');
  fs.writeFileSync(tmp, [
    '# Test Project',
    '',
    '## Whole',
    '> A test project for the signals parser.',
    '',
    '## Signals',
    '- ~~vcs-signal: off',
    '- ~~candidate-pipeline: on',
    '',
  ].join('\n'));
  const p = profileMod.scanCairnMd(tmp);
  ok(p.exists === true, 'B.1.1 profile.exists');
  ok(p.signal_overrides && typeof p.signal_overrides === 'object', 'B.1.2 signal_overrides is object');
  ok(p.signal_overrides.git === false, 'B.1.3 git override = false');
  ok(p.signal_overrides.candidates === true, 'B.1.4 candidates override = true');
}

section('B.2 CAIRN.md without ## Signals → signal_overrides === {}');
{
  const tmp = path.join(tmpHome, 'CAIRN-no-signals.md');
  fs.writeFileSync(tmp, '# Project\n\n## Whole\n> One sentence.\n');
  const p = profileMod.scanCairnMd(tmp);
  ok(p.exists === true, 'B.2.1 profile.exists');
  ok(p.signal_overrides && typeof p.signal_overrides === 'object', 'B.2.2 signal_overrides present');
  ok(Object.keys(p.signal_overrides).length === 0, 'B.2.3 signal_overrides is empty {}');
}

section('B.3 emptyProfile() defaults signal_overrides to {}');
{
  const empty = profileMod.emptyProfile('/tmp/nope.md');
  ok('signal_overrides' in empty, 'B.3.1 field present on empty profile');
  ok(typeof empty.signal_overrides === 'object' && Object.keys(empty.signal_overrides).length === 0,
     'B.3.2 default is empty object');
}

section('B.4 missing file → emptyProfile shape preserved (signal_overrides:{})');
{
  const p = profileMod.scanCairnMd('/no/such/file/CAIRN.md');
  ok(p.exists === false, 'B.4.1 missing file → exists=false');
  ok(p.signal_overrides && Object.keys(p.signal_overrides).length === 0,
     'B.4.2 signal_overrides still {} on missing file');
}

section('B.5 Chinese alias 信号源 also recognized');
{
  const tmp = path.join(tmpHome, 'CAIRN-zh.md');
  fs.writeFileSync(tmp, '# 项目\n\n## 信号源\n- ~~vcs-signal: off\n');
  const p = profileMod.scanCairnMd(tmp);
  ok(p.signal_overrides.git === false, 'B.5.1 信号源 section parsed');
}

header('Section C — mode-a-loop.buildPlan integration');

section('C.1 buildPlan copies profile.signal_overrides onto plan');
{
  const goal = { id: 'g1', title: 'Test goal', success_criteria: ['x'] };
  const profile = { signal_overrides: { git: false, candidates: true } };
  const plan = modeALoop.buildPlan(goal, profile, 1000);
  ok(plan.signal_overrides && plan.signal_overrides.git === false, 'C.1.1 git override on plan');
  ok(plan.signal_overrides.candidates === true, 'C.1.2 candidates override on plan');
  // Mutate the plan's overrides; profile must be unchanged (shallow clone).
  plan.signal_overrides.git = true;
  ok(profile.signal_overrides.git === false, 'C.1.3 plan.signal_overrides is a copy, not alias');
}

section('C.2 buildPlan with no profile → plan.signal_overrides === {}');
{
  const plan = modeALoop.buildPlan('plain string goal', null, 2000);
  ok(plan.signal_overrides && typeof plan.signal_overrides === 'object', 'C.2.1 field present');
  ok(Object.keys(plan.signal_overrides).length === 0, 'C.2.2 empty when profile missing');
}

section('C.3 buildPlan does not break existing shape');
{
  const goal = { id: 'g2', title: 'Goal 2', success_criteria: ['a', 'b'] };
  const profile = { whole_sentence: 'North star.', signal_overrides: {} };
  const plan = modeALoop.buildPlan(goal, profile, 3000);
  ok(typeof plan.plan_id === 'string' && plan.plan_id.length > 0, 'C.3.1 plan_id still set');
  ok(plan.goal_id === 'g2', 'C.3.2 goal_id preserved');
  ok(plan.whole_sentence === 'North star.', 'C.3.3 whole_sentence preserved');
  ok(plan.status === 'ACTIVE', 'C.3.4 status preserved');
  ok(Array.isArray(plan.steps), 'C.3.5 steps array present');
}

// Restore console.warn
console.warn = _origWarn;

header(`Result: ${asserts - fails}/${asserts} passed${fails ? `, ${fails} FAILED` : ''}`);
if (fails) {
  process.stdout.write('\nFailures:\n');
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
  process.exit(1);
}
process.stdout.write('\nALL GREEN.\n');
process.exit(0);
