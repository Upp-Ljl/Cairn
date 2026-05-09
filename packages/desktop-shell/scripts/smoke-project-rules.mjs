#!/usr/bin/env node
/**
 * Smoke for Project Rules Registry (governance v1).
 *
 * Exercises:
 *   - registry.setProjectRules: per-section length cap, per-item len cap,
 *     all-empty rejection (rules_empty), updated_at bumps on every set
 *   - registry.getProjectRules: missing project / no rules → null
 *   - registry.getEffectiveProjectRules: falls back to RULES_DEFAULT
 *     when no rules; is_default flag flips correctly
 *   - registry.clearProjectRules: idempotent; field removed cleanly
 *   - Persistence: ~/.cairn/projects.json contains project_rules verbatim
 *
 * Read-only invariants (live cairn.db mtime; source-level grep on
 * registry.cjs for SQL / file writes / .claude / .codex literals).
 *
 * No external deps. No commits. HOME shimmed to a tmpdir.
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

const realCairnDb = path.join(os.homedir(), '.cairn', 'cairn.db');
function safeMtime(p) { try { return fs.statSync(p).mtimeMs; } catch (_e) { return null; } }
const beforeCairn = safeMtime(realCairnDb);

const realHome = os.homedir();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-rules-smoke-'));
process.env.HOME = tmpDir;
process.env.USERPROFILE = tmpDir;
os.homedir = () => tmpDir;
fs.mkdirSync(path.join(tmpDir, '.cairn'), { recursive: true });

const registry = require(path.join(__dirname, '..', 'registry.cjs'));

// ---------------------------------------------------------------------------
// Part A — getEffectiveProjectRules default fallback
// ---------------------------------------------------------------------------

console.log('==> Part A: default fallback');

let reg = { version: registry.REGISTRY_VERSION, projects: [] };
const a1 = registry.addProject(reg, {
  project_root: process.platform === 'win32' ? 'C:\\fake\\alpha' : '/fake/alpha',
  db_path: '/tmp/x.db', label: 'alpha',
});
reg = a1.reg;
const projId = a1.entry.id;

ok(registry.getProjectRules(reg, projId) === null, 'no rules: getProjectRules → null');
const eff1 = registry.getEffectiveProjectRules(reg, projId);
eq(eff1.is_default, true, 'no rules: is_default=true');
ok(eff1.rules.coding_standards.length > 0, 'default ruleset has coding_standards');
ok(eff1.rules.testing_policy.length > 0,   'default ruleset has testing_policy');
ok(eff1.rules.reporting_policy.length > 0, 'default ruleset has reporting_policy');
ok(eff1.rules.pre_pr_checklist.length > 0, 'default ruleset has pre_pr_checklist');
ok(eff1.rules.non_goals.length > 0,        'default ruleset has non_goals');
eq(eff1.rules.version, registry.RULES_VERSION, 'default ruleset has version field');
// Default ruleset must explicitly mention non-dispatch language so the
// downstream Pre-PR Gate / Prompt Pack inherits a positioning-safe
// floor even when the user never sets rules.
ok(eff1.rules.non_goals.some(g => /dispatch|auto/i.test(g)),
   'default non_goals mentions auto-dispatch boundary');

// ---------------------------------------------------------------------------
// Part B — set / get
// ---------------------------------------------------------------------------

console.log('\n==> Part B: set / get');

const setRes = registry.setProjectRules(reg, projId, {
  coding_standards: ['use existing patterns', '  ', null],
  testing_policy: ['run targeted smoke'],
  reporting_policy: ['list changed files'],
  pre_pr_checklist: ['no schema change unless authorized'],
  non_goals: ['no auto-dispatch'],
});
reg = setRes.reg;
ok(!setRes.error, 'setProjectRules: no error');
eq(setRes.rules.coding_standards.length, 1, 'set: empty/null entries dropped from list');
eq(setRes.rules.coding_standards[0], 'use existing patterns', 'set: real entry preserved');
eq(setRes.rules.version, registry.RULES_VERSION, 'set: version stamped');
ok(setRes.rules.updated_at > 0, 'set: updated_at populated');

const got = registry.getProjectRules(reg, projId);
eq(got.coding_standards[0], 'use existing patterns', 'get: persisted rules read back');

const eff2 = registry.getEffectiveProjectRules(reg, projId);
eq(eff2.is_default, false, 'after set: is_default=false');
eq(eff2.rules.testing_policy[0], 'run targeted smoke', 'effective: returns user rules');

// ---------------------------------------------------------------------------
// Part C — validation + length caps
// ---------------------------------------------------------------------------

console.log('\n==> Part C: validation + caps');

const allEmpty = registry.setProjectRules(reg, projId, {});
eq(allEmpty.error, 'rules_empty', 'all-empty rules → rules_empty');

const allBlank = registry.setProjectRules(reg, projId, {
  coding_standards: ['', '  ', null], testing_policy: [],
});
eq(allBlank.error, 'rules_empty', 'all-blank-after-trim → rules_empty');

const missingProj = registry.setProjectRules(reg, 'p_nope', { coding_standards: ['x'] });
eq(missingProj.error, 'project_not_found', 'unknown project → project_not_found');

// Per-section cap
const manyItems = Array(registry.RULES_MAX_TOTAL_ITEMS + 5).fill('rule');
const cap1 = registry.setProjectRules(reg, projId, {
  coding_standards: manyItems,
});
reg = cap1.reg;
eq(cap1.rules.coding_standards.length, registry.RULES_MAX_TOTAL_ITEMS,
   'per-section list capped to RULES_MAX_TOTAL_ITEMS');

// Per-item length cap
const long = 'x'.repeat(registry.RULES_MAX_ITEM_LEN + 100);
const cap2 = registry.setProjectRules(reg, projId, { coding_standards: [long] });
reg = cap2.reg;
eq(cap2.rules.coding_standards[0].length, registry.RULES_MAX_ITEM_LEN,
   'per-item length capped to RULES_MAX_ITEM_LEN');

// ---------------------------------------------------------------------------
// Part D — clear (revert to default)
// ---------------------------------------------------------------------------

console.log('\n==> Part D: clear');

const cl1 = registry.clearProjectRules(reg, projId);
reg = cl1.reg;
ok(cl1.cleared, 'clear: cleared=true on first call');
ok(registry.getProjectRules(reg, projId) === null, 'after clear: getProjectRules → null');
const eff3 = registry.getEffectiveProjectRules(reg, projId);
eq(eff3.is_default, true, 'after clear: getEffective → default again');

const cl2 = registry.clearProjectRules(reg, projId);
ok(!cl2.cleared, 'clear: idempotent');

const clMissing = registry.clearProjectRules(reg, 'p_nope');
ok(!clMissing.cleared, 'clear: unknown project → no-op');

// ---------------------------------------------------------------------------
// Part E — persistence on disk
// ---------------------------------------------------------------------------

console.log('\n==> Part E: persistence');

const setForDisk = registry.setProjectRules(reg, projId, {
  coding_standards: ['rule A'],
  pre_pr_checklist: ['no secret leakage'],
});
reg = setForDisk.reg;

const onDisk = JSON.parse(
  fs.readFileSync(path.join(tmpDir, '.cairn', 'projects.json'), 'utf8'),
);
const persisted = onDisk.projects.find(p => p.id === projId);
ok(persisted && persisted.project_rules,
   'projects.json: project_rules persisted to disk');
eq(persisted.project_rules.coding_standards[0], 'rule A',
   'projects.json: rules content matches');
eq(persisted.project_rules.pre_pr_checklist[0], 'no secret leakage',
   'projects.json: pre_pr_checklist matches');

// And after clear: field is gone from disk.
const clearForDisk = registry.clearProjectRules(reg, projId);
reg = clearForDisk.reg;
const onDisk2 = JSON.parse(
  fs.readFileSync(path.join(tmpDir, '.cairn', 'projects.json'), 'utf8'),
);
const persisted2 = onDisk2.projects.find(p => p.id === projId);
ok(persisted2 && !persisted2.project_rules,
   'projects.json: cleared project has no project_rules field');

// ---------------------------------------------------------------------------
// Part F — read-only invariants
// ---------------------------------------------------------------------------

console.log('\n==> Part F: read-only invariants');

const afterCairn = safeMtime(realCairnDb);
if (beforeCairn != null) eq(afterCairn, beforeCairn, 'real ~/.cairn/cairn.db mtime unchanged');

const src = fs.readFileSync(path.join(__dirname, '..', 'registry.cjs'), 'utf8');
ok(!/['"]\.claude['"]/.test(src), 'registry.cjs: no ".claude" string literal');
ok(!/['"]\.codex['"]/.test(src),  'registry.cjs: no ".codex" string literal');
ok(!/\.run\s*\(/.test(src),       'registry.cjs: no .run(');
ok(!/\.exec\s*\(/.test(src),      'registry.cjs: no .exec(');

try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) {}
os.homedir = () => realHome;

console.log(`\n==> ${asserts - fails}/${asserts} assertions passed`);
if (fails > 0) {
  console.error(`FAIL: ${fails} assertion(s) failed`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('PASS');
