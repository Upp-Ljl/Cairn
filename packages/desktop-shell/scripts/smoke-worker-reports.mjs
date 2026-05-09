#!/usr/bin/env node
/**
 * Smoke for the Worker Report Protocol v1.
 *
 * Exercises:
 *   - normalizeReport: required-fields default, length caps, list caps
 *   - parseReportText: every section variant + freeform fallback +
 *     metadata key recognition + bullet syntax variants
 *   - addWorkerReport / listWorkerReports / clearWorkerReports
 *     end-to-end against a HOME-shimmed tmpdir
 *   - JSONL robustness: a malformed line in the middle of the file
 *     does not break reading; surrounding reports still come back
 *   - Privacy: report summary form (counts only, never bodies) flows
 *     through buildCompactState — re-asserts the Phase 2 boundary
 *
 * Read-only invariants:
 *   - Real ~/.cairn/cairn.db mtime unchanged
 *   - Source-level grep on worker-reports.cjs (no SQL / no
 *     child_process / no .claude / .codex string literal)
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
function safeMtime(p) { try { return fs.statSync(p).mtimeMs; } catch (_e) { return null; } }
const beforeCairn = safeMtime(realCairnDb);

// HOME shim before requiring worker-reports.cjs (it computes
// ~/.cairn/project-reports/ at call time, but we shim early to keep
// every operation in the smoke isolated).
const realHome = os.homedir();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-reports-smoke-'));
process.env.HOME = tmpDir;
process.env.USERPROFILE = tmpDir;
os.homedir = () => tmpDir;
fs.mkdirSync(path.join(tmpDir, '.cairn'), { recursive: true });

const wr = require(path.join(root, 'worker-reports.cjs'));
const goalInterp = require(path.join(root, 'goal-interpretation.cjs'));

// ---------------------------------------------------------------------------
// Part A — parseReportText
// ---------------------------------------------------------------------------

console.log('==> Part A: parseReportText');

const md = `# Refactor auth flow

source: claude-code
session: 7f5b-uuid-a
agent: cairn-session-aaaa
needs_human: yes
related_task: T-001

## Completed
- moved validateSession into auth/middleware
- added unit tests for token refresh

## Remaining
- update README
- migrate the snapshot tests

## Blockers
- waiting for product to confirm token TTL change

## Next steps
- run full integration suite
1. open PR draft

## Notes (ignored)
- this is filler that should not crash the parser
`;

const parsed = wr.parseReportText(md);
eq(parsed.title, 'Refactor auth flow', 'parsed title from H1');
eq(parsed.source_app, 'claude-code', 'parsed source_app from inline metadata');
eq(parsed.session_id, '7f5b-uuid-a', 'parsed session_id');
eq(parsed.agent_id, 'cairn-session-aaaa', 'parsed agent_id');
eq(parsed.needs_human, true, 'parsed needs_human=yes → true');
ok(parsed.related_task_ids.includes('T-001'), 'parsed related_task → list');
eq(parsed.completed.length, 2, 'completed: 2 bullets');
eq(parsed.remaining.length, 2, 'remaining: 2 bullets');
eq(parsed.blockers.length, 1, 'blockers: 1 bullet');
eq(parsed.next_steps.length, 2, 'next_steps: bullet + numbered list');

// Freeform fallback — first non-empty line becomes title.
const free = wr.parseReportText('Just a quick note from the agent.\nNo sections, no bullets.');
eq(free.title, 'Just a quick note from the agent.', 'freeform: title = first line');
eq(free.completed.length, 0, 'freeform: completed empty');
eq(free.blockers.length, 0, 'freeform: blockers empty');

// Empty / malformed input.
const empty = wr.parseReportText('');
eq(empty.title, '', 'empty input: empty title');
const ws = wr.parseReportText('   \n\n  \n');
eq(ws.title, '', 'whitespace-only input: empty title');

// Section header variants.
ok(wr.matchSectionHeader('## Done') === 'completed', 'matchSectionHeader: Done → completed');
ok(wr.matchSectionHeader('### Blocked') === 'blockers', 'Blocked → blockers');
ok(wr.matchSectionHeader('## In Progress') === 'remaining', 'In Progress → remaining');
ok(wr.matchSectionHeader('## next-step') === 'next_steps', 'next-step → next_steps');
ok(wr.matchSectionHeader('## Random Section') === null, 'unknown header → null');
ok(wr.matchSectionHeader('not a header') === null, 'non-header → null');

// ---------------------------------------------------------------------------
// Part B — normalizeReport
// ---------------------------------------------------------------------------

console.log('\n==> Part B: normalizeReport');

const norm = wr.normalizeReport('p_aaaa', {
  title: 'x'.repeat(wr.STR_TITLE_MAX + 50),
  completed: Array(wr.LIST_MAX + 5).fill('done'),
  remaining: ['  ', null, 'real'],
});
eq(norm.title.length, wr.STR_TITLE_MAX, 'normalize: title capped to STR_TITLE_MAX');
eq(norm.completed.length, wr.LIST_MAX, 'normalize: completed capped to LIST_MAX');
eq(norm.remaining.length, 1, 'normalize: empty / null entries dropped from list');
eq(norm.remaining[0], 'real', 'normalize: surviving entry preserved');
ok(norm.id && norm.id.startsWith('r_'), 'normalize: id assigned');
ok(norm.created_at > 0, 'normalize: created_at set');
eq(norm.project_id, 'p_aaaa', 'normalize: project_id passed through');
eq(norm.needs_human, false, 'normalize: needs_human defaults false');

// ---------------------------------------------------------------------------
// Part C — add / list / clear end-to-end
// ---------------------------------------------------------------------------

console.log('\n==> Part C: add / list / clear');

const projectId = 'p_smoke_aaaa';

// Empty list initially.
eq(wr.listWorkerReports(projectId).length, 0, 'list: 0 reports for fresh project');

const a1 = wr.addWorkerReport(projectId, { title: 'first', completed: ['x'] });
ok(a1.ok, 'add #1 ok');
const a2 = wr.addWorkerReport(projectId, { title: 'second', blockers: ['waiting'] });
ok(a2.ok, 'add #2 ok');
const a3 = wr.addWorkerReport(projectId, { title: 'third', needs_human: true });
ok(a3.ok, 'add #3 ok');

const listed = wr.listWorkerReports(projectId, 10);
eq(listed.length, 3, 'list: 3 reports after 3 adds');
eq(listed[0].title, 'third',  'list: newest-first ordering [0]');
eq(listed[1].title, 'second', 'list: newest-first ordering [1]');
eq(listed[2].title, 'first',  'list: newest-first ordering [2]');

// limit param.
const top1 = wr.listWorkerReports(projectId, 1);
eq(top1.length, 1, 'list: limit=1 returns 1');
eq(top1[0].title, 'third', 'list: limit=1 returns the newest');

// Project isolation: a different project_id has no reports.
eq(wr.listWorkerReports('p_other').length, 0,
   'list: different project_id sees no reports (file scope)');

// Add invalid input.
const noProj = wr.addWorkerReport('', { title: 'x' });
eq(noProj.error, 'projectId_required', 'add: empty projectId rejected');

// ---------------------------------------------------------------------------
// Part D — JSONL robustness (malformed line)
// ---------------------------------------------------------------------------

console.log('\n==> Part D: JSONL robustness');

// Inject a malformed line directly between valid ones.
const file = wr.reportsFile(projectId);
fs.appendFileSync(file, '{ this is not json\n', 'utf8');
wr.addWorkerReport(projectId, { title: 'fourth', completed: ['after-malformed'] });

const robust = wr.listWorkerReports(projectId);
eq(robust.length, 4, 'list: malformed line skipped, 4 valid reports remain');
eq(robust[0].title, 'fourth', 'list: newest after malformed is "fourth"');
ok(robust.some(r => r.title === 'first'), 'list: oldest still readable');

// ---------------------------------------------------------------------------
// Part E — clear
// ---------------------------------------------------------------------------

console.log('\n==> Part E: clear');

const c1 = wr.clearWorkerReports(projectId);
ok(c1.cleared, 'clear: cleared=true on first call');
eq(wr.listWorkerReports(projectId).length, 0, 'clear: list returns 0 after');

const c2 = wr.clearWorkerReports(projectId);
ok(!c2.cleared, 'clear: idempotent (no-op when file gone)');

// ---------------------------------------------------------------------------
// Part F — interpretation payload privacy (cross-check Phase 2 boundary)
// ---------------------------------------------------------------------------

console.log('\n==> Part F: interpretation payload privacy');

const POISON = '__SMOKE_POISON__';
wr.addWorkerReport(projectId, {
  title: 'with secrets',
  completed: ['this should be in summary count, not body'],
  // Add a fake "transcript" extra field to ensure normalizeReport drops
  // unknown fields entirely. Even if a future caller tries this, it
  // shouldn't bleed into interpretation payloads.
  transcript: POISON,
  prompt: POISON,
});
const reports = wr.listWorkerReports(projectId, 5);
const compact = goalInterp.buildCompactState({
  recent_reports: reports,
});
const compactStr = JSON.stringify(compact);
ok(compactStr.indexOf(POISON) === -1,
   'interpretation payload: POISON marker NOT present');
ok(compactStr.indexOf('this should be in summary count') === -1,
   'interpretation payload: report body bullets NOT present (only counts)');
ok(/completed_count/.test(compactStr),
   'interpretation payload: completed_count IS present (count is the contract)');

// Cleanup before invariants.
wr.clearWorkerReports(projectId);

// ---------------------------------------------------------------------------
// Part G — read-only invariants
// ---------------------------------------------------------------------------

console.log('\n==> Part G: read-only invariants');

const afterCairn = safeMtime(realCairnDb);
if (beforeCairn != null) eq(afterCairn, beforeCairn, 'real ~/.cairn/cairn.db mtime unchanged');

const src = fs.readFileSync(path.join(root, 'worker-reports.cjs'), 'utf8');
ok(!/\.run\s*\(/.test(src),     'worker-reports.cjs: no .run(');
ok(!/\.exec\s*\(/.test(src),    'worker-reports.cjs: no .exec(');
ok(!/\.prepare\s*\(/.test(src), 'worker-reports.cjs: no .prepare(');
ok(!/\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i.test(src),
   'worker-reports.cjs: no SQL mutation keywords');
ok(!/require\(['"]child_process['"]\)/.test(src),
   'worker-reports.cjs: no child_process');
ok(!/['"]\.claude['"]/.test(src), 'worker-reports.cjs: no ".claude" string literal');
ok(!/['"]\.codex['"]/.test(src),  'worker-reports.cjs: no ".codex" string literal');

// Cleanup tmpdir.
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) {}
os.homedir = () => realHome;

console.log(`\n==> ${asserts - fails}/${asserts} assertions passed`);
if (fails > 0) {
  console.error(`FAIL: ${fails} assertion(s) failed`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('PASS');
