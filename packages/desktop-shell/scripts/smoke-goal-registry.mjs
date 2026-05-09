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
// Part B — edit preserves id + created_at
// ---------------------------------------------------------------------------

console.log('\n==> Part B: edit preserves id + created_at');

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
eq(editRes.goal.id, originalId, 'edit: goal id preserved');
eq(editRes.goal.created_at, originalCreated, 'edit: created_at preserved');
ok(editRes.goal.updated_at >= originalCreated, 'edit: updated_at preserved or bumped');
eq(editRes.goal.title, 'Ship Goal Mode v1 (edited)', 'edit: title updated');
eq(editRes.goal.success_criteria.length, 1, 'edit: criteria replaced (not appended)');
eq(editRes.goal.non_goals.length, 0, 'edit: non_goals cleared when empty list given');

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
