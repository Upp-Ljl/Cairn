#!/usr/bin/env node
/**
 * smoke-panel-ipc-field-names.mjs — catches the 2026-05-14 class of bug
 * 鸭总 reported: "Failed: title_required" because panel.js sent {text}
 * but registry.setProjectGoal required {title}.
 *
 * This whole class is "field-name drift between panel.js callsite and
 * the handler that validates it". Pure unit tests of registry pass; pure
 * IPC mock tests of panel pass. But the WIRE between them goes unchecked.
 *
 * Strategy: enumerate panel.js callsites that pass object payloads to
 * window.cairn.*; for each one, find the matching ipcMain.handle in
 * main.cjs and the validation in the consumer module; assert the keys
 * panel sends are the SAME keys the validation reads.
 *
 * Today this smoke ships the setProjectGoal pair explicitly; future
 * IPC additions get a TODO entry below and someone can extend.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PANEL_JS  = path.resolve(__dirname, '..', 'panel.js');
const REGISTRY  = path.resolve(__dirname, '..', 'registry.cjs');

let asserts = 0, fails = 0;
const failures = [];
function ok(c, l) {
  asserts++;
  if (c) process.stdout.write(`  ok    ${l}\n`);
  else { fails++; failures.push(l); process.stdout.write(`  FAIL  ${l}\n`); }
}
function header(t) { process.stdout.write(`\n${'='.repeat(64)}\n${t}\n${'='.repeat(64)}\n`); }
function section(t) { process.stdout.write(`\n[${t}]\n`); }

header('smoke-panel-ipc-field-names — wire contract sanity');

const panelSrc = fs.readFileSync(PANEL_JS, 'utf8');
const regSrc = fs.readFileSync(REGISTRY, 'utf8');

// ---------------------------------------------------------------------------
// Test 1: setProjectGoal — panel.js callsites must pass `title` (the validator)
// ---------------------------------------------------------------------------
section('1 setProjectGoal: panel.js sends `title`, never bare `text`');
{
  // Find all setProjectGoal calls in panel.js — extract the payload literal
  const pattern = /window\.cairn\.setProjectGoal\s*\([^,]+,\s*\{([^{}]*?)\}/g;
  const matches = [...panelSrc.matchAll(pattern)];
  ok(matches.length >= 2, `found ≥2 setProjectGoal callsites (got ${matches.length})`);
  for (let i = 0; i < matches.length; i++) {
    const payload = matches[i][1];
    const hasTitle = /\btitle\b\s*:/.test(payload) || /^\s*title\s*[,}]/m.test(payload);
    const hasBareText = /^\s*text\s*[,}]/m.test(payload) && !hasTitle;
    ok(hasTitle, `callsite ${i+1}: payload contains 'title' field — payload="${payload.replace(/\s+/g,' ').trim().slice(0,80)}"`);
    ok(!hasBareText, `callsite ${i+1}: payload does NOT use bare {text} (the 2026-05-14 bug)`);
  }
}

// ---------------------------------------------------------------------------
// Test 2: registry.setProjectGoal validates `title` from input
// ---------------------------------------------------------------------------
section('2 registry.setProjectGoal reads input.title');
{
  const fn = /function\s+setProjectGoal\s*\([\s\S]+?\)\s*\{([\s\S]+?)\n\}/.exec(regSrc);
  ok(fn !== null, 'setProjectGoal function found in registry.cjs');
  if (fn) {
    const body = fn[1];
    ok(/input\s*\.\s*title|input\s*&&\s*input\.title/.test(body), 'body reads input.title');
    ok(/title_required/.test(body), 'returns title_required error code');
  }
}

// ---------------------------------------------------------------------------
// Test 3: end-to-end runtime check — calling with {title} succeeds, {text} fails
// ---------------------------------------------------------------------------
section('3 runtime: setProjectGoal({title}) succeeds, setProjectGoal({text}) fails');
{
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const registry = require(REGISTRY);
  const reg = { version: 2, projects: [{ id: 'p_smoke', label: 's', project_root: '/x', db_path: '/x.db' }] };
  const goodResult = registry.setProjectGoal(reg, 'p_smoke', { title: 'real goal' });
  ok(!goodResult.error && goodResult.goal && goodResult.goal.title === 'real goal',
     `{title:"real goal"} → ok, goal stored (error: ${goodResult.error || 'none'})`);
  const badResult = registry.setProjectGoal(reg, 'p_smoke', { text: 'wrong field' });
  ok(badResult.error === 'title_required',
     `{text:"wrong field"} → error='title_required' (got '${badResult.error}')`);
  // Defense: also confirm {} produces title_required
  const emptyResult = registry.setProjectGoal(reg, 'p_smoke', {});
  ok(emptyResult.error === 'title_required', `empty input → error='title_required'`);
}

// ---------------------------------------------------------------------------
// Test 4: no other panel.js callsite sneaks {text} where {title} is needed
// ---------------------------------------------------------------------------
section('4 panel-wide guard: no setProjectGoal({text}) anywhere');
{
  // Bare-{text} pattern — anything immediately after setProjectGoal args containing { text
  const badPattern = /setProjectGoal\s*\([^)]*?,\s*\{\s*text\s*[:},]/;
  ok(!badPattern.test(panelSrc), 'no setProjectGoal({text...}) anywhere in panel.js');
}

// ---------------------------------------------------------------------------
// Generalized contract assertions — every panel.js mutation IPC must send
// the exact fields its handler/consumer reads. Subagent审查 2026-05-14
// flagged: setProjectGoal smoke was too narrow; extending to all major
// mutation pairs catches the whole class of "field-name drift" bugs.
// ---------------------------------------------------------------------------

const MAIN_CJS = path.resolve(__dirname, '..', 'main.cjs');
const STEER = path.resolve(__dirname, '..', 'cockpit-steer.cjs');
const DISPATCH = path.resolve(__dirname, '..', 'cockpit-dispatch.cjs');
const LANE = path.resolve(__dirname, '..', 'cockpit-lane.cjs');

function callsiteFields(callRe, source) {
  // Find `window.cairn.<name>(...{ field1, field2: ..., field3 })` and
  // return the set of field names that appear as keys.
  const m = callRe.exec(source);
  if (!m) return null;
  const payload = m[1] || '';
  // Match either `key:` or `key,` or `key}` style (shorthand or full).
  const keys = new Set();
  for (const tok of payload.split(/[,\n]/)) {
    const t = tok.trim();
    if (!t) continue;
    const m2 = /^([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?::|$|,|\})/.exec(t);
    if (m2) keys.add(m2[1]);
  }
  return keys;
}

// ---------------------------------------------------------------------------
section('5 cockpitSteer({project_id, agent_id, message}) matches handler');
{
  const keys = callsiteFields(/window\.cairn\.cockpitSteer\s*\(\s*\{([\s\S]*?)\}\s*\)/, panelSrc);
  ok(keys !== null, 'cockpitSteer callsite found');
  if (keys) {
    ok(keys.has('project_id') && keys.has('agent_id') && keys.has('message'),
       `panel sends {project_id, agent_id, message} (got ${[...keys].join(', ')})`);
  }
}

// ---------------------------------------------------------------------------
section('6 cockpitTodoAdd({project_id, label}) matches handler');
{
  const keys = callsiteFields(/window\.cairn\.cockpitTodoAdd\s*\(\s*\{([\s\S]*?)\}\s*\)/, panelSrc);
  ok(keys !== null, 'cockpitTodoAdd callsite found');
  if (keys) {
    ok(keys.has('project_id') && keys.has('label'),
       `panel sends {project_id, label} (got ${[...keys].join(', ')})`);
  }
}

// ---------------------------------------------------------------------------
section('7 cockpitTodoDispatch({project_id, todo_id, source, target_agent_id, label, why}) matches');
{
  const keys = callsiteFields(/window\.cairn\.cockpitTodoDispatch\s*\(\s*\{([\s\S]*?)\}\s*\)/, panelSrc);
  ok(keys !== null, 'cockpitTodoDispatch callsite found');
  if (keys) {
    const required = ['project_id', 'todo_id', 'source', 'target_agent_id', 'label'];
    const missing = required.filter(k => !keys.has(k));
    ok(missing.length === 0, `all 5 required fields present (missing: ${missing.join(', ') || 'none'})`);
  }
}

// ---------------------------------------------------------------------------
section('8 cockpitLaneCreate({project_id, candidates, authorized_by}) matches');
{
  const allCalls = [...panelSrc.matchAll(/window\.cairn\.cockpitLaneCreate\s*\(\s*\{([\s\S]*?)\}\s*\)/g)];
  ok(allCalls.length >= 2, `≥2 cockpitLaneCreate callsites (got ${allCalls.length})`);
  for (let i = 0; i < allCalls.length; i++) {
    const keys = new Set();
    for (const tok of allCalls[i][1].split(/[,\n]/)) {
      const t = tok.trim();
      const m2 = /^([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?::|$|,|\})/.exec(t);
      if (m2) keys.add(m2[1]);
    }
    ok(keys.has('project_id') && keys.has('candidates'),
       `callsite ${i+1}: has project_id + candidates (got ${[...keys].join(', ')})`);
  }
  // Confirm cockpit-lane.cjs destructures these names
  const laneSrc = fs.readFileSync(LANE, 'utf8');
  ok(/createLane\s*\(\s*db\s*,\s*projectId\s*,\s*candidates\s*,\s*authorizedBy/.test(laneSrc),
     'createLane signature takes (db, projectId, candidates, authorizedBy)');
}

// ---------------------------------------------------------------------------
section('9 cockpitRewindPreview/To({project_id, checkpoint_id}) matches');
{
  const keysPreview = callsiteFields(/window\.cairn\.cockpitRewindPreview\s*\(\s*\{([\s\S]*?)\}\s*\)/, panelSrc);
  const keysTo = callsiteFields(/window\.cairn\.cockpitRewindTo\s*\(\s*\{([\s\S]*?)\}\s*\)/, panelSrc);
  ok(keysPreview !== null && keysPreview.has('project_id') && keysPreview.has('checkpoint_id'),
     'cockpitRewindPreview has project_id + checkpoint_id');
  ok(keysTo !== null && keysTo.has('project_id') && keysTo.has('checkpoint_id'),
     'cockpitRewindTo has project_id + checkpoint_id');
  // Rewind handler in main.cjs reads snake_case input.{project_id,checkpoint_id}
  // and passes camelCase positional args to cockpit-rewind.cjs::previewRewind/
  // performRewind. Both layers must agree.
  const mainSrc = fs.readFileSync(MAIN_CJS, 'utf8');
  ok(/input\.project_id/.test(mainSrc) && /input\.checkpoint_id/.test(mainSrc),
     'main.cjs rewind handler reads input.project_id + input.checkpoint_id');
}

// ---------------------------------------------------------------------------
section('10 cockpit-steer.cjs reads matching field names');
{
  const steerSrc = fs.readFileSync(STEER, 'utf8');
  ok(/input\.project_id|projectId|p\.project_id/.test(steerSrc), 'steer reads project_id');
  ok(/input\.agent_id|agentId/.test(steerSrc), 'steer reads agent_id');
  ok(/input\.message|message/.test(steerSrc), 'steer reads message');
}

// ---------------------------------------------------------------------------
section('11 cockpit-dispatch.cjs reads matching field names');
{
  const dispatchSrc = fs.readFileSync(DISPATCH, 'utf8');
  ok(/project_id/.test(dispatchSrc), 'dispatch reads project_id');
  ok(/todo_id/.test(dispatchSrc), 'dispatch reads todo_id');
  ok(/target_agent_id/.test(dispatchSrc), 'dispatch reads target_agent_id');
  ok(/\blabel\b/.test(dispatchSrc), 'dispatch reads label');
  ok(/\bsource\b/.test(dispatchSrc), 'dispatch reads source');
}

// ---------------------------------------------------------------------------
header(`${asserts - fails}/${asserts} assertions passed (${fails} failed)`);
if (fails) {
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
  process.exit(1);
}
process.exit(0);
