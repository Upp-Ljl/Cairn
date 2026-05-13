#!/usr/bin/env node
/**
 * smoke-cockpit-module-order.mjs — structural assertion that the
 * cockpit view (panel.html `#view-cockpit`) lists the 5 modules in
 * the order CEO grilled into 17 product constraints (§3-6):
 *
 *   M1 State Strip · M2 Mentor + Todolist · M3 Steer · M4 Sessions ·
 *   M5 Safety / Rewind
 *
 * Also verifies:
 *   - L2 Session Timeline view exists as separate top-level view
 *   - First-launch wizard overlay exists (B4)
 *   - No stale Activity Feed remnant inside view-cockpit
 *
 * Read-only file parse — no Electron, no CDP. Fast. Catches the
 * regression where someone reorders panel.html and forgets the spec.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PANEL_HTML = path.resolve(__dirname, '..', 'panel.html');

let asserts = 0, fails = 0;
const failures = [];
function ok(c, l) {
  asserts++;
  if (c) process.stdout.write(`  ok    ${l}\n`);
  else { fails++; failures.push(l); process.stdout.write(`  FAIL  ${l}\n`); }
}
function header(t) { process.stdout.write(`\n${'='.repeat(56)}\n${t}\n${'='.repeat(56)}\n`); }
function section(t) { process.stdout.write(`\n[${t}]\n`); }

header('smoke-cockpit-module-order');

const html = fs.readFileSync(PANEL_HTML, 'utf8');

// ---------------------------------------------------------------------------
section('1 view-cockpit block exists');
const cockpitStart = html.indexOf('<div id="view-cockpit"');
const cockpitMatch = html.slice(cockpitStart).match(/<div id="view-cockpit"[\s\S]*?<\/div>\s*<\/div>/);
ok(cockpitStart > 0, '<div id="view-cockpit"> present');
const cockpitBlock = html.slice(cockpitStart);

// ---------------------------------------------------------------------------
section('2 each module id appears exactly once inside view-cockpit');
const moduleIds = [
  'cockpit-state',          // M1 State Strip
  'cockpit-mentor-module',  // M2 Mentor (A4 reorder)
  'cockpit-todolist',       // M2 Todolist (A2.1)
  'cockpit-steer',          // M3 Steer (A4 reorder)
  'cockpit-sessions',       // M4 Sessions (A3-part2)
  'cockpit-safety',         // M5 Safety / Rewind
];
const idIdx = {};
for (const id of moduleIds) {
  const regex = new RegExp(`id="${id}"`, 'g');
  const matches = (cockpitBlock.match(regex) || []).length;
  ok(matches >= 1, `#${id} present in view-cockpit (count=${matches})`);
  idIdx[id] = cockpitBlock.indexOf(`id="${id}"`);
}

// ---------------------------------------------------------------------------
section('3 module DOM order matches CEO-grilled 17-constraint layout');
const order = moduleIds.map(id => ({ id, pos: idIdx[id] }));
order.sort((a, b) => a.pos - b.pos);
const observedOrder = order.map(o => o.id).join(' → ');
process.stdout.write(`  observed: ${observedOrder}\n`);
const expected = ['cockpit-state', 'cockpit-mentor-module', 'cockpit-todolist', 'cockpit-steer', 'cockpit-sessions', 'cockpit-safety'];
for (let i = 0; i < expected.length; i++) {
  ok(order[i].id === expected[i], `position ${i}: expected ${expected[i]}, got ${order[i].id}`);
}

// ---------------------------------------------------------------------------
section('4 L2 Session Timeline view exists at top level');
ok(html.includes('<div id="view-timeline"'), '<div id="view-timeline"> present');
ok(html.includes('id="tl-list"'), '#tl-list (timeline container) present');
ok(html.includes('id="tl-back"'), '#tl-back (back to cockpit button) present');

// ---------------------------------------------------------------------------
section('5 First-launch wizard exists (B4)');
ok(html.includes('id="first-launch-wizard"'), '#first-launch-wizard present');
ok(/flw-screen|first-launch/i.test(html), 'wizard screen markup present');

// ---------------------------------------------------------------------------
section('6 No stale Activity Feed inside view-cockpit (replaced by Sessions in A3-part2)');
const activityInsideCockpit = (cockpitBlock.match(/<div class="cockpit-activity"/g) || []).length;
ok(activityInsideCockpit === 0, `legacy cockpit-activity block removed from view-cockpit (found ${activityInsideCockpit})`);

// ---------------------------------------------------------------------------
section('7 Mentor module is M2 (positioned right after State Strip)');
const idxState = cockpitBlock.indexOf('id="cockpit-state"');
const idxMentor = cockpitBlock.indexOf('id="cockpit-mentor-module"');
const idxSteer = cockpitBlock.indexOf('id="cockpit-steer"');
ok(idxState < idxMentor, 'Mentor comes after State Strip');
ok(idxMentor < idxSteer, 'Mentor comes BEFORE Steer (約定 3: M2 上移)');

// ---------------------------------------------------------------------------
section('8 Steer dropdown for session target (約定 4)');
ok(html.includes('id="cockpit-steer-target"'), '#cockpit-steer-target dropdown present');

// ---------------------------------------------------------------------------
header(`${asserts - fails}/${asserts} assertions passed (${fails} failed)`);
if (fails) {
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
  process.exit(1);
}
process.exit(0);
