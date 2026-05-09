#!/usr/bin/env node
/**
 * Smoke for the Coordination panel integration (IPC payload shape).
 *
 * Cairn's panel renders client-side, so we don't drive the DOM here;
 * instead we verify that the shapes the panel consumes are stable
 * and self-consistent. Specifically:
 *
 *   - get-coordination-signals payload contract: matches
 *     deriveCoordinationSignals shape; signals carry prompt_action
 *     for every action kind the panel wires up
 *   - get-handoff-prompt / get-conflict-prompt / get-review-prompt
 *     compose advisory text with the locked safety contracts
 *   - panel.html includes the new Coordination strip + tab + sections
 *   - panel.js wires the strip events (renderCoordinationStrip is no
 *     longer a stub)
 *   - default panel renders no resolveConflict mutation button
 *
 * No live DB; we exercise the pure-derivation path and the panel
 * structure with file-level grep + a tiny in-memory deriveSignals
 * call.
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

const coord = require(path.join(root, 'coordination-signals.cjs'));

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

const NOW = 1_800_000_000_000;

// ---------------------------------------------------------------------------
// Part A — payload shape contract
// ---------------------------------------------------------------------------

console.log('==> Part A: coordination payload shape');

const r = coord.deriveCoordinationSignals({
  blockers: [{ id: 'b1', task_id: 't1', status: 'OPEN', raised_at: NOW - 60000, question: 'q' }],
  outcomes: [{ task_id: 't2', status: 'FAIL' }],
  conflicts: [{ id: 'cf1', status: 'OPEN', conflict_type: 'FILE_OVERLAP',
                agent_a: 'a', paths_json: '["x.js"]' }],
  tasks:    [{ task_id: 't3', state: 'WAITING_REVIEW', created_by_agent_id: 'a' }],
}, { now: NOW });

ok(r && typeof r === 'object', 'returns object');
ok('coordination_level' in r, 'has coordination_level');
ok(Array.isArray(r.signals), 'signals is array');
ok(Array.isArray(r.handoff_candidates), 'handoff_candidates is array');
ok(Array.isArray(r.conflict_candidates), 'conflict_candidates is array');
ok(Array.isArray(r.recovery_candidates), 'recovery_candidates is array');
ok(typeof r.ts === 'number', 'ts is number');

// Every signal that has a prompt_action must use one of the panel's
// wired-up actions (otherwise the click does nothing).
const WIRED_ACTIONS = new Set([
  'copy_handoff_prompt',
  'copy_recovery_prompt',
  'copy_review_prompt',
  'copy_conflict_prompt',
]);
for (const s of r.signals) {
  if (!s.prompt_action) continue;
  ok(WIRED_ACTIONS.has(s.prompt_action),
     `signal ${s.kind}: prompt_action="${s.prompt_action}" is wired by the panel`);
}

// summarize() shape stable.
const sum = coord.summarizeCoordination(r);
ok('level' in sum && 'counts' in sum && 'by_kind' in sum && 'top_titles' in sum,
   'summarizeCoordination shape stable');

// ---------------------------------------------------------------------------
// Part B — panel.html structural contract
// ---------------------------------------------------------------------------

console.log('\n==> Part B: panel.html structural contract');

const panelHtml = fs.readFileSync(path.join(root, 'panel.html'), 'utf8');

// Coordination tab + body sections present.
ok(/data-tab="coord"/.test(panelHtml), 'panel.html: data-tab="coord" tab button');
ok(/id="view-coord"/.test(panelHtml),  'panel.html: #view-coord tab body');
ok(/id="coord-signals-list"/.test(panelHtml),     'panel.html: signals list');
ok(/id="coord-scratchpad-list"/.test(panelHtml),  'panel.html: scratchpad list');
ok(/id="coord-conflicts-list"/.test(panelHtml),   'panel.html: conflicts list');

// Coordination strip on L2 hero.
ok(/id="coord-strip"/.test(panelHtml),            'panel.html: #coord-strip hero strip');
ok(/id="coord-strip-show-all"/.test(panelHtml),   'panel.html: show-all link');

// Default panel must NOT render a resolveConflict UI button.
ok(!/resolveConflict|Resolve Conflict|resolve-conflict/i.test(panelHtml),
   'panel.html: NO resolveConflict UI button (read-only default)');

// ---------------------------------------------------------------------------
// Part C — panel.js wires the strip + tab
// ---------------------------------------------------------------------------

console.log('\n==> Part C: panel.js wiring');

const panelJs = fs.readFileSync(path.join(root, 'panel.js'), 'utf8');

ok(/function renderCoordinationStrip\(/.test(panelJs),
   'panel.js: renderCoordinationStrip defined');
ok(/function renderCoordSignalsList\(/.test(panelJs),
   'panel.js: renderCoordSignalsList defined');
ok(/function renderScratchpadList\(/.test(panelJs),
   'panel.js: renderScratchpadList defined');
ok(/function renderConflictsList\(/.test(panelJs),
   'panel.js: renderConflictsList defined');

// Strip is no longer a stub: must reference signals + level.
ok(/coord\.coordination_level|coordination_level/.test(panelJs),
   'panel.js: renderCoordinationStrip references coordination_level');

// Action handler dispatches every wired prompt kind.
for (const a of ['copy_handoff_prompt', 'copy_recovery_prompt', 'copy_review_prompt', 'copy_conflict_prompt']) {
  ok(panelJs.indexOf(`'${a}'`) >= 0 || panelJs.indexOf(`"${a}"`) >= 0,
     `panel.js: action ${a} handled`);
}

// Tab list includes 'coord'.
ok(/coord:\s*document\.getElementById\('view-coord'\)/.test(panelJs),
   'panel.js: setupTabs includes coord tab view');

// Phase 2/3 IPC bridges are referenced.
for (const fn of ['getCoordinationSignals', 'getProjectScratchpad', 'getProjectConflicts',
                  'getHandoffPrompt', 'getConflictPrompt', 'getReviewPrompt']) {
  ok(panelJs.indexOf(fn) >= 0, `panel.js: window.cairn.${fn} referenced`);
}

// ---------------------------------------------------------------------------
// Part D — main.cjs IPC handlers exist
// ---------------------------------------------------------------------------

console.log('\n==> Part D: main.cjs IPC handlers');

const mainSrc = fs.readFileSync(path.join(root, 'main.cjs'), 'utf8');
for (const ch of [
  "ipcMain.handle('get-project-scratchpad'",
  "ipcMain.handle('get-project-conflicts'",
  "ipcMain.handle('get-coordination-signals'",
  "ipcMain.handle('get-handoff-prompt'",
  "ipcMain.handle('get-conflict-prompt'",
  "ipcMain.handle('get-review-prompt'",
]) {
  ok(mainSrc.indexOf(ch) >= 0, `main.cjs: handler registered → ${ch.slice(15)}`);
}

// composeHandoffPrompt / composeConflictPrompt / composeReviewPrompt
// must NOT contain any positive auto-execute imperative outside their
// own ban clauses.
const promptText = mainSrc;
function hasBadImperative(line) {
  return /\b(run|execute|perform|do)\s+(the\s+)?(rewind|merge|push|resolve)\s+(now|immediately|first|right away)\b/i.test(line);
}
const cleanedLines = promptText.split(/\r?\n/).filter(line =>
  !/(do not|don'?t|never|refuse|without first|surface)\b/i.test(line)
);
const bad = cleanedLines.find(hasBadImperative);
ok(!bad, `main.cjs: no positive auto-execute imperative in prompt builders${bad ? ' — found "' + bad.trim() + '"' : ''}`);

// ---------------------------------------------------------------------------
// Part E — read-only invariants
// ---------------------------------------------------------------------------

console.log('\n==> Part E: read-only invariants');

const afterCairn = safeMtime(realCairnDb);
if (beforeCairn != null) eq(afterCairn, beforeCairn, 'cairn.db mtime unchanged');

// Mutation grep over panel.js (renderer) — must have NO .run / .exec.
ok(!/\.run\s*\(/.test(panelJs),  'panel.js: no .run( (UI is read-only)');
ok(!/\.exec\s*\(/.test(panelJs), 'panel.js: no .exec(');

// preload.cjs surface check.
const preload = fs.readFileSync(path.join(root, 'preload.cjs'), 'utf8');
for (const fn of ['getCoordinationSignals', 'getProjectScratchpad', 'getProjectConflicts',
                  'getHandoffPrompt', 'getConflictPrompt', 'getReviewPrompt']) {
  ok(preload.indexOf(fn) >= 0, `preload.cjs: bridges ${fn}`);
}

console.log(`\n==> ${asserts - fails}/${asserts} assertions passed`);
if (fails > 0) {
  console.error(`FAIL: ${fails} assertion(s) failed`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('PASS');
