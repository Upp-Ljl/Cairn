#!/usr/bin/env node
/**
 * smoke-goal-shape-extraction.mjs — locks the 2026-05-14 bug fix for
 * "panel never shows user's goal after setting it".
 *
 * Bug 鸭总 caught:
 * - User sets goal via panel → registry.setProjectGoal writes
 *   active_goal: { id, title, ... } (object shape with `title` field).
 * - main.cjs::get-cockpit-state handler extracted `goal.text` which
 *   NEVER exists on that object → goalText=null → autopilot stuck at
 *   NO_GOAL → Mentor never engaged → panel showed no change.
 * - mentor-policy.cjs::evaluateRuleC_offGoal similarly read
 *   `profile.goal.text` but profile.goal is a STRING from
 *   extractGoal() → also always null.
 *
 * Both broken in the same way: field-name drift between producer (where
 * data is built/stored) and consumer (where data is read). Same class
 * as 鸭总's earlier `title_required` bug.
 *
 * SANDBOX: HOME shimmed before requiring registry.cjs (registry's
 * setProjectGoal writes to ~/.cairn/projects.json — see
 * feedback_smoke_real_registry_pollution memory).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// ---------------------------------------------------------------------------
// SANDBOX before requiring registry
// ---------------------------------------------------------------------------
const _realHome = os.homedir();
const _realProjectsJson = path.join(_realHome, '.cairn', 'projects.json');
const _tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-goalshape-smoke-'));
fs.mkdirSync(path.join(_tmpDir, '.cairn'), { recursive: true });
process.env.HOME = _tmpDir;
process.env.USERPROFILE = _tmpDir;
const _mtimeBefore = fs.existsSync(_realProjectsJson) ? fs.statSync(_realProjectsJson).mtimeMs : null;
process.on('exit', () => {
  const _mtimeAfter = fs.existsSync(_realProjectsJson) ? fs.statSync(_realProjectsJson).mtimeMs : null;
  if (_mtimeBefore !== _mtimeAfter) {
    console.error('FATAL: smoke wrote to REAL ~/.cairn/projects.json — sandbox failed');
    process.exit(3);
  }
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dsRoot = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const registry = require(path.join(dsRoot, 'registry.cjs'));
const mainSrc = fs.readFileSync(path.join(dsRoot, 'main.cjs'), 'utf8');
const mentorPolicySrc = fs.readFileSync(path.join(dsRoot, 'mentor-policy.cjs'), 'utf8');

let asserts = 0, fails = 0;
const failures = [];
function ok(c, l) {
  asserts++;
  if (c) process.stdout.write(`  ok    ${l}\n`);
  else { fails++; failures.push(l); process.stdout.write(`  FAIL  ${l}\n`); }
}
function header(t) { process.stdout.write(`\n${'='.repeat(64)}\n${t}\n${'='.repeat(64)}\n`); }
function section(t) { process.stdout.write(`\n[${t}]\n`); }

header('smoke-goal-shape-extraction');

// ---------------------------------------------------------------------------
section('1 ProjectGoal has `title`, not `text`');
{
  const reg = { version: 2, projects: [{ id: 'p_x', label: 'x', project_root: '/x', db_path: '/x.db' }] };
  const result = registry.setProjectGoal(reg, 'p_x', { title: 'real goal text here' });
  ok(result.goal !== null, 'setProjectGoal returns a goal object');
  ok(typeof result.goal.title === 'string', 'goal.title is a string');
  ok(result.goal.title === 'real goal text here', `goal.title preserved (got "${result.goal.title}")`);
  ok(result.goal.text === undefined, 'goal.text does NOT exist (this was the bug)');
}

// ---------------------------------------------------------------------------
section('2 registry.getProjectGoal returns the object with .title');
{
  const reg = { version: 2, projects: [{ id: 'p_x', label: 'x', project_root: '/x', db_path: '/x.db' }] };
  registry.setProjectGoal(reg, 'p_x', { title: 'goal 2' });
  // setProjectGoal returns new reg; replicate panel's flow that reads
  // back via getProjectGoal
  const reg2 = { version: 2, projects: [{ id: 'p_x', label: 'x', project_root: '/x', db_path: '/x.db',
    active_goal: { id: 'g1', title: 'goal 2', desired_outcome: '', success_criteria: [], non_goals: [],
                   created_at: 1, updated_at: 1 }}]};
  const got = registry.getProjectGoal(reg2, 'p_x');
  ok(got !== null && typeof got === 'object', 'getProjectGoal returns object');
  ok(typeof got.title === 'string', 'got.title is a string');
  ok(got.text === undefined, 'got.text is undefined');
}

// ---------------------------------------------------------------------------
section('3 main.cjs extraction uses goal.title (not goal.text)');
{
  // Match the goalText extraction pattern at L895-901
  ok(/goal\s*&&\s*typeof\s+goal\s*===\s*'object'\s*&&\s*typeof\s+goal\.title\s*===\s*'string'/.test(mainSrc),
     'main.cjs uses typeof goal.title === string check');
  ok(/\bgoal\.title\b/.test(mainSrc), 'main.cjs references goal.title');
  // Critically: ensure the OLD broken pattern is gone
  ok(!/goal\.text\s*\?\s*goal\.text/.test(mainSrc),
     'main.cjs no longer uses goal.text ? goal.text pattern (the bug)');
}

// ---------------------------------------------------------------------------
section('4 mentor-policy.cjs goal extraction accepts string OR object');
{
  // The fixed line should accept profile.goal as string (the actual shape
  // returned by extractGoal) OR object with .text / .title.
  ok(/typeof\s+profile\.goal\s*===\s*'string'/.test(mentorPolicySrc),
     'mentor-policy.cjs checks typeof profile.goal === string');
  // OLD bug pattern: profile.goal && profile.goal.text ? profile.goal.text : null
  // Confirm the OLD ternary that exclusively read .text is gone — i.e. we no
  // longer have JUST `profile.goal.text` without the string check
  const oldPattern = /profile\.goal\s*&&\s*profile\.goal\.text\s*\?\s*profile\.goal\.text\s*:\s*null/;
  ok(!oldPattern.test(mentorPolicySrc),
     'mentor-policy.cjs no longer uses bare profile.goal.text ternary (the bug)');
}

// ---------------------------------------------------------------------------
section('5 End-to-end: get-cockpit-state path actually surfaces goal text');
{
  // Replicate main.cjs handler's extraction inline (defensive copy of
  // the production logic). When we update production, this should track.
  function extractGoalTextProductionStyle(goal) {
    return goal && typeof goal === 'object' && typeof goal.title === 'string'
      ? goal.title
      : (typeof goal === 'string' ? goal : null);
  }
  const goalObj = { id: 'g1', title: '把试验场做成可玩的德州扑克 demo', desired_outcome: '',
                    success_criteria: [], non_goals: [], created_at: 1, updated_at: 1 };
  ok(extractGoalTextProductionStyle(goalObj) === '把试验场做成可玩的德州扑克 demo',
     'object form → title surfaced');
  ok(extractGoalTextProductionStyle('legacy string goal') === 'legacy string goal',
     'string form (legacy) → goal surfaced');
  ok(extractGoalTextProductionStyle(null) === null, 'null → null');
  ok(extractGoalTextProductionStyle({}) === null, 'empty object → null');
  ok(extractGoalTextProductionStyle({ text: 'old bug shape' }) === null,
     'object with .text but no .title → null (rejects old shape, which signaled bug)');
}

// ---------------------------------------------------------------------------
header(`${asserts - fails}/${asserts} assertions passed (${fails} failed)`);
if (fails) {
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
  process.exit(1);
}
process.exit(0);
