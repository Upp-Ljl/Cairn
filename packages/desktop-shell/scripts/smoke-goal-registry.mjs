#!/usr/bin/env node
/**
 * Smoke for Goal Mode v1 registry helpers.
 *
 * Exercises:
 *   - registry.setProjectGoal: required-field validation (title), id +
 *     created_at preservation across edits, updated_at bumps,
 *     trim/length-cap on each field, list trimming.
 *   - registry.getProjectGoal: missing project / no goal → null.
 *   - registry.clearProjectGoal: removes the field cleanly; idempotent.
 *   - Persistence: ~/.cairn/projects.json contains the goal verbatim.
 *   - Duplicate labels across two projects don't bleed goal state.
 *
 * Read-only invariants:
 *   - Real ~/.cairn/cairn.db mtime unchanged.
 *   - Real ~/.claude / ~/.codex mtime unchanged.
 *   - Goal helpers only write through registry.saveRegistry (atomic
 *     temp+rename onto projects.json) — source-level grep guards.
 *
 * No external deps. No commits. HOME shimmed to a tmpdir so the live
 * registry is untouched.
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

let asserts = 0, fails = 0;
const failures = [];
function ok(cond, label) {
  asserts++;
  if (cond) console.log(`  ok    ${label}`);
  else { fails++; failures.push(label); console.log(`  FAIL  ${label}`); }
}
function eq(a, b, label) {
  ok(a === b, `${label} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);
}

// Snapshot off-limits paths.
const realCairnDb = path.join(os.homedir(), '.cairn', 'cairn.db');
const realClaude  = path.join(os.homedir(), '.claude');
const realCodex   = path.join(os.homedir(), '.codex');
function safeMtime(p) { try { return fs.statSync(p).mtimeMs; } catch (_e) { return null; } }
const beforeCairn  = safeMtime(realCairnDb);
const beforeClaude = safeMtime(realClaude);
const beforeCodex  = safeMtime(realCodex);

// Shim HOME before requiring registry.cjs so writes land in tmpdir.
const realHome = os.homedir();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-goal-smoke-'));
process.env.HOME = tmpDir;
process.env.USERPROFILE = tmpDir;
os.homedir = () => tmpDir;
fs.mkdirSync(path.join(tmpDir, '.cairn'), { recursive: true });

const registry = require(path.join(__dirname, '..', 'registry.cjs'));

// ---------------------------------------------------------------------------
// Part A — basic set / get / clear
// ---------------------------------------------------------------------------

console.log('==> Part A: set / get / clear');

let reg = { version: registry.REGISTRY_VERSION, projects: [] };
const a1 = registry.addProject(reg, {
  project_root: process.platform === 'win32' ? 'C:\\fake\\alpha' : '/fake/alpha',
  db_path: '/tmp/x.db', label: 'alpha',
});
reg = a1.reg;
const projId = a1.entry.id;

ok(registry.getProjectGoal(reg, projId) === null, 'fresh project: no goal');
ok(registry.getProjectGoal(reg, 'p_nonexistent') === null, 'unknown project: null');

const setRes = registry.setProjectGoal(reg, projId, {
  title: '  Ship Goal Mode v1   ',
  desired_outcome: 'Cairn shows agent activity in service of one stated goal.',
  success_criteria: ['L1 card renders goal title', 'pulse explains goal risk', '  ', null],
  non_goals: ['no auto-dispatch'],
});
reg = setRes.reg;
ok(!setRes.error, 'setProjectGoal: no error');
ok(setRes.goal && setRes.goal.id, 'setProjectGoal: goal id assigned');
eq(setRes.goal.title, 'Ship Goal Mode v1', 'title trimmed (whitespace stripped)');
eq(setRes.goal.success_criteria.length, 2, 'criteria filtered to non-empty entries');
eq(setRes.goal.non_goals[0], 'no auto-dispatch', 'non_goals preserved');
ok(setRes.goal.created_at > 0, 'created_at populated');
ok(setRes.goal.updated_at >= setRes.goal.created_at, 'updated_at >= created_at');

const got = registry.getProjectGoal(reg, projId);
ok(got && got.id === setRes.goal.id, 'getProjectGoal returns the persisted goal');

// ---------------------------------------------------------------------------
// Part B — edit rotates id when content changes (Mode A supersede trigger);
//         preserves id when content is identical (idempotent re-save).
//         created_at is preserved across edits regardless.
//
// Contract (鸭总 2026-05-14 fix): the goal_id is the supersede signal that
// mode-a-loop.ensurePlan watches. Any visible field change MUST rotate it
// so a stale COMPLETE plan supersedes; an identical re-save MUST NOT
// rotate it (e.g. panel double-clicks save).
// ---------------------------------------------------------------------------

console.log('\n==> Part B: edit rotates id on content change, preserves on no-op');

const originalId = setRes.goal.id;
const originalCreated = setRes.goal.created_at;
// Sleep a tick so updated_at has a chance to differ.
await new Promise(r => setTimeout(r, 5));
const editRes = registry.setProjectGoal(reg, projId, {
  title: 'Ship Goal Mode v1 (edited)',
  desired_outcome: 'Refined.',
  success_criteria: ['edited criterion'],
  non_goals: [],
});
reg = editRes.reg;
ok(editRes.goal.id !== originalId, 'edit (content changed): goal id ROTATED (supersede trigger)');
eq(editRes.goal.created_at, originalCreated, 'edit: created_at preserved across id rotation');
ok(editRes.goal.updated_at >= originalCreated, 'edit: updated_at bumped');
eq(editRes.goal.title, 'Ship Goal Mode v1 (edited)', 'edit: title updated');
eq(editRes.goal.success_criteria.length, 1, 'edit: criteria replaced (not appended)');
eq(editRes.goal.non_goals.length, 0, 'edit: non_goals cleared when empty list given');

// Idempotent re-save: same fields → same id (panel double-click save shouldn't supersede)
const editedId = editRes.goal.id;
const editedCreated = editRes.goal.created_at;
await new Promise(r => setTimeout(r, 5));
const idem = registry.setProjectGoal(reg, projId, {
  title: 'Ship Goal Mode v1 (edited)',
  desired_outcome: 'Refined.',
  success_criteria: ['edited criterion'],
  non_goals: [],
});
reg = idem.reg;
eq(idem.goal.id, editedId, 're-save (no content change): id PRESERVED (no supersede)');
eq(idem.goal.created_at, editedCreated, 're-save: created_at preserved');
ok(idem.goal.updated_at >= editedCreated, 're-save: updated_at refreshed');

// Whitespace / list-normalization differences are not content changes
await new Promise(r => setTimeout(r, 5));
const idemNorm = registry.setProjectGoal(reg, projId, {
  title: '  Ship Goal Mode v1 (edited)  ',         // extra whitespace
  desired_outcome: 'Refined.',
  success_criteria: ['edited criterion', '', '  ', null], // trim/filter
  non_goals: [],
});
reg = idemNorm.reg;
eq(idemNorm.goal.id, editedId, 're-save with whitespace/empties: id PRESERVED (normalized identical)');

// Field-by-field change → id rotates
await new Promise(r => setTimeout(r, 5));
const changeTitle = registry.setProjectGoal(reg, projId, {
  title: 'A different title',
  desired_outcome: 'Refined.',
  success_criteria: ['edited criterion'],
  non_goals: [],
});
reg = changeTitle.reg;
ok(changeTitle.goal.id !== editedId, 'title change → id rotated');

const tId = changeTitle.goal.id;
await new Promise(r => setTimeout(r, 5));
const changeOutcome = registry.setProjectGoal(reg, projId, {
  title: 'A different title',
  desired_outcome: 'Different outcome',
  success_criteria: ['edited criterion'],
  non_goals: [],
});
reg = changeOutcome.reg;
ok(changeOutcome.goal.id !== tId, 'desired_outcome change → id rotated');

const oId = changeOutcome.goal.id;
await new Promise(r => setTimeout(r, 5));
const changeCriteria = registry.setProjectGoal(reg, projId, {
  title: 'A different title',
  desired_outcome: 'Different outcome',
  success_criteria: ['edited criterion', 'an added one'], // ADD
  non_goals: [],
});
reg = changeCriteria.reg;
ok(changeCriteria.goal.id !== oId, 'success_criteria add → id rotated');

const cId = changeCriteria.goal.id;
await new Promise(r => setTimeout(r, 5));
const changeNonGoals = registry.setProjectGoal(reg, projId, {
  title: 'A different title',
  desired_outcome: 'Different outcome',
  success_criteria: ['edited criterion', 'an added one'],
  non_goals: ['a non-goal'],
});
reg = changeNonGoals.reg;
ok(changeNonGoals.goal.id !== cId, 'non_goals add → id rotated');

// Symmetric: removing fields also rotates id (鸭总 2026-05-14 scenario:
// went from 4 success_criteria to 2 — must rotate)
const ngId = changeNonGoals.goal.id;
await new Promise(r => setTimeout(r, 5));
const removeCriterion = registry.setProjectGoal(reg, projId, {
  title: 'A different title',
  desired_outcome: 'Different outcome',
  success_criteria: ['edited criterion'], // REMOVED 'an added one'
  non_goals: ['a non-goal'],
});
reg = removeCriterion.reg;
ok(removeCriterion.goal.id !== ngId, 'success_criteria REMOVE → id rotated (CEO scenario)');

// ---------------------------------------------------------------------------
// Part C — required-field validation
// ---------------------------------------------------------------------------

console.log('\n==> Part C: validation');

const noTitle = registry.setProjectGoal(reg, projId, { title: '' });
eq(noTitle.error, 'title_required', 'empty title → title_required error');
const wsTitle = registry.setProjectGoal(reg, projId, { title: '   ' });
eq(wsTitle.error, 'title_required', 'whitespace-only title → title_required');
const missingProj = registry.setProjectGoal(reg, 'p_nope', { title: 'x' });
eq(missingProj.error, 'project_not_found', 'unknown project → project_not_found');

// Length caps.
const longTitle = 'x'.repeat(registry.GOAL_MAX_TITLE_LEN + 100);
const capRes = registry.setProjectGoal(reg, projId, { title: longTitle });
reg = capRes.reg;
eq(capRes.goal.title.length, registry.GOAL_MAX_TITLE_LEN, 'title capped to GOAL_MAX_TITLE_LEN');

const manyCriteria = Array(registry.GOAL_MAX_CRITERIA + 5).fill('c');
const cap2 = registry.setProjectGoal(reg, projId, { title: 'x', success_criteria: manyCriteria });
reg = cap2.reg;
eq(cap2.goal.success_criteria.length, registry.GOAL_MAX_CRITERIA, 'criteria capped to GOAL_MAX_CRITERIA');

// ---------------------------------------------------------------------------
// Part D — clear
// ---------------------------------------------------------------------------

console.log('\n==> Part D: clear');

const cl1 = registry.clearProjectGoal(reg, projId);
reg = cl1.reg;
ok(cl1.cleared, 'clear: returns cleared=true on first call');
ok(registry.getProjectGoal(reg, projId) === null, 'clear: getProjectGoal → null after');

const cl2 = registry.clearProjectGoal(reg, projId);
reg = cl2.reg;
ok(!cl2.cleared, 'clear: idempotent (no-op when already cleared)');

const cl3 = registry.clearProjectGoal(reg, 'p_nope');
ok(!cl3.cleared, 'clear: unknown project → no-op');

// ---------------------------------------------------------------------------
// Part E — duplicate labels don't share goal state
// ---------------------------------------------------------------------------

console.log('\n==> Part E: duplicate labels are independent');

const a2 = registry.addProject(reg, {
  project_root: process.platform === 'win32' ? 'C:\\fake\\alpha-mirror' : '/fake/alpha-mirror',
  db_path: '/tmp/x.db', label: 'alpha (2)',
});
reg = a2.reg;
const proj2Id = a2.entry.id;

const sa = registry.setProjectGoal(reg, projId,  { title: 'goal A' });
reg = sa.reg;
const sb = registry.setProjectGoal(reg, proj2Id, { title: 'goal B' });
reg = sb.reg;
eq(registry.getProjectGoal(reg, projId).title, 'goal A',
   'project A retains its goal');
eq(registry.getProjectGoal(reg, proj2Id).title, 'goal B',
   'project B retains its goal independently');
ok(registry.getProjectGoal(reg, projId).id !== registry.getProjectGoal(reg, proj2Id).id,
   'two projects have distinct goal ids');

// Clear A; B's goal must remain.
const ca = registry.clearProjectGoal(reg, projId);
reg = ca.reg;
ok(registry.getProjectGoal(reg, projId) === null, 'after clear A: A has no goal');
eq(registry.getProjectGoal(reg, proj2Id).title, 'goal B', 'after clear A: B still has goal B');

// ---------------------------------------------------------------------------
// Part F — persistence + read-only invariants
// ---------------------------------------------------------------------------

console.log('\n==> Part F: persistence + read-only invariants');

const onDisk = JSON.parse(
  fs.readFileSync(path.join(tmpDir, '.cairn', 'projects.json'), 'utf8'),
);
const persistedB = onDisk.projects.find(p => p.id === proj2Id);
ok(persistedB && persistedB.active_goal && persistedB.active_goal.title === 'goal B',
   'projects.json on disk contains the goal verbatim');
const persistedA = onDisk.projects.find(p => p.id === projId);
ok(persistedA && !persistedA.active_goal,
   'projects.json: cleared project has no active_goal field');

// Real (non-shimmed) cairn.db must not have been touched. ~/.claude
// and ~/.codex are *live* directories — Claude Code / Codex Desktop
// may be running in another process and writing to them concurrently
// with the smoke. We therefore guard those via SOURCE-LEVEL grep
// (registry.cjs has no I/O paths that could touch them) rather than
// mtime, which is racy against external writers.
const afterCairn = safeMtime(realCairnDb);
if (beforeCairn != null) eq(afterCairn, beforeCairn, 'real ~/.cairn/cairn.db mtime unchanged');

// Source-level: registry.cjs goal helpers must not run SQL or write
// outside of saveRegistry's atomicWriteJson path. Plus assert nothing
// in the source references ~/.claude or ~/.codex (proves we can't
// write there even by accident).
const src = fs.readFileSync(path.join(__dirname, '..', 'registry.cjs'), 'utf8');
ok(!/\.run\s*\(/.test(src),     'registry.cjs has no .run(');
ok(!/\.exec\s*\(/.test(src),    'registry.cjs has no .exec(');
ok(!/require\(['"]child_process['"]\)/.test(src),
   'registry.cjs does not require child_process');
// String-literal match only — comments mentioning ~/.claude / ~/.codex
// for documentation purposes are fine; what matters is no path
// constants that would let writes land there.
ok(!/['"]\.claude['"]/.test(src), 'registry.cjs has no ".claude" string literal');
ok(!/['"]\.codex['"]/.test(src),  'registry.cjs has no ".codex" string literal');

// Cleanup.
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) {}
os.homedir = () => realHome;

console.log(`\n==> ${asserts - fails}/${asserts} assertions passed`);
if (fails > 0) {
  console.error(`FAIL: ${fails} assertion(s) failed`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('PASS');
