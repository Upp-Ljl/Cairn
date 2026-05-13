#!/usr/bin/env node
/**
 * dogfood-llm-rule-c.mjs — real haiku invocation through
 * cockpit-llm-helpers.judgeOffGoal. Phase 8 §8 Rule C off-goal drift.
 *
 * Validates that:
 *   - llm-client loads the provider keys file
 *   - judgeOffGoal composes a valid prompt with project Whole + activity
 *   - haiku returns parseable JSON { on_path, redirect, confidence }
 *   - obviously-aligned activity → on_path=true
 *   - obviously-off-path activity → on_path=false + non-empty redirect
 *
 * Reads this repo's CAIRN.md for the Whole sentence. Cost: ~$0.002 per
 * run (two haiku calls). 429 / 5xx is treated as infra-ok via the same
 * pattern used by dogfood-llm-tail-summary.mjs.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dsRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(dsRoot, '..', '..');

const llmHelpers = require(path.join(dsRoot, 'cockpit-llm-helpers.cjs'));
const llmClient = require(path.join(dsRoot, 'llm-client.cjs'));
const mentorProfile = require(path.join(dsRoot, 'mentor-project-profile.cjs'));

let asserts = 0, fails = 0;
const failures = [];
function ok(c, l) {
  asserts++;
  if (c) process.stdout.write(`  ok    ${l}\n`);
  else   { fails++; failures.push(l); process.stdout.write(`  FAIL  ${l}\n`); }
}
function header(t) { process.stdout.write(`\n${'='.repeat(56)}\n${t}\n${'='.repeat(56)}\n`); }

header('dogfood-llm-rule-c — real haiku off-goal judge');

// ---------------------------------------------------------------------------
// 1 — provider available?
// ---------------------------------------------------------------------------
const provider = llmClient.loadProvider({});
process.stdout.write(`Provider: enabled=${provider.enabled} model=${provider.model || '?'} reason=${provider.reason || '-'}\n`);
if (!provider.enabled) {
  process.stdout.write(`  SKIP — provider not configured. Reason: ${provider.reason}\n`);
  process.exit(0);
}
ok(provider.enabled === true, 'provider enabled');

// ---------------------------------------------------------------------------
// 2 — load this repo's CAIRN.md and extract Whole
// ---------------------------------------------------------------------------
const cairnMdPath = path.join(repoRoot, 'CAIRN.md');
if (!fs.existsSync(cairnMdPath)) {
  process.stdout.write(`  SKIP — no CAIRN.md at ${cairnMdPath}\n`);
  process.exit(0);
}
const profile = mentorProfile.loadProfileFromPath
  ? mentorProfile.loadProfileFromPath(cairnMdPath)
  : null;

// Fallback: read whole_sentence manually if loadProfileFromPath isn't exported.
let whole = null;
if (profile && profile.whole_sentence) {
  whole = profile.whole_sentence;
} else {
  const text = fs.readFileSync(cairnMdPath, 'utf8');
  const m = text.match(/##\s+(Whole|完整形态)[^\n]*\n+([\s\S]*?)(?=\n##\s|\n#\s|$)/);
  if (m) {
    // first non-empty line after the heading
    whole = (m[2].split('\n').map(l => l.trim()).find(l => l && !l.startsWith('>')) || '').trim();
  }
}
ok(typeof whole === 'string' && whole.length > 20, `extracted Whole (${whole ? whole.slice(0, 80) + '...' : 'missing'})`);
if (!whole) process.exit(1);

// ---------------------------------------------------------------------------
// 3 — call judgeOffGoal with ALIGNED activity (should return on_path=true)
// ---------------------------------------------------------------------------
process.stdout.write(`\nCase A: aligned activity (kernel work)\n`);
const alignedActivity = {
  transitions: [
    { task_id: 't_a1', state: 'RUNNING', intent: 'ship Rule C off-goal judge in mentor-policy' },
    { task_id: 't_a2', state: 'WAITING_REVIEW', intent: 'wire mentor-tick recentActivity gather' },
  ],
  commits: [
    { subject: 'feat(mentor): add Rule C off-goal drift evaluator' },
    { subject: 'feat(llm): judgeOffGoal helper for cockpit' },
  ],
};
let t0 = Date.now();
const resA = await llmHelpers.judgeOffGoal(
  { enabled: true, whole, goal: 'Ship Phase 8 §8 Rule C', recent_activity: alignedActivity },
  { timeoutMs: 60000 },
);
process.stdout.write(`  elapsed: ${Date.now() - t0}ms · result: ${JSON.stringify(resA)}\n`);

const transientA = resA.detail && /^http_(4[02]9|5\d\d)|timeout|network/.test(resA.detail);
if (!resA.ok && transientA) {
  process.stdout.write(`  INFRA OK — provider transient (${resA.detail})\n`);
  ok(true, 'aligned: helper composed real LLM call');
} else if (!resA.ok) {
  process.stdout.write(`  FAIL — ${JSON.stringify(resA)}\n`);
  failures.push('aligned case did not return ok'); fails++; asserts++;
} else {
  ok(typeof resA.on_path === 'boolean', 'aligned: on_path is boolean');
  // Conservative prompt: should default to on_path=true here.
  ok(resA.on_path === true, `aligned: on_path=true (got ${resA.on_path})`);
  if (resA.on_path) ok(resA.redirect === '', 'aligned: redirect empty when on_path');
}

// ---------------------------------------------------------------------------
// 4 — call judgeOffGoal with OFF-PATH activity (should return on_path=false)
// ---------------------------------------------------------------------------
process.stdout.write(`\nCase B: off-path activity (unrelated game dev)\n`);
const offActivity = {
  transitions: [
    { task_id: 't_b1', state: 'RUNNING', intent: 'design dungeon boss combat AI for action RPG' },
    { task_id: 't_b2', state: 'RUNNING', intent: 'render particle effects in WebGL for fire spells' },
  ],
  commits: [
    { subject: 'feat(game): add fireball spell with knockback' },
    { subject: 'feat(combat): implement boss phase 2 attack pattern' },
    { subject: 'art(sprites): draw new sword swing animation' },
  ],
};
t0 = Date.now();
const resB = await llmHelpers.judgeOffGoal(
  { enabled: true, whole, goal: 'Ship Phase 8 §8 Rule C', recent_activity: offActivity },
  { timeoutMs: 60000 },
);
process.stdout.write(`  elapsed: ${Date.now() - t0}ms · result: ${JSON.stringify(resB)}\n`);

const transientB = resB.detail && /^http_(4[02]9|5\d\d)|timeout|network/.test(resB.detail);
if (!resB.ok && transientB) {
  process.stdout.write(`  INFRA OK — provider transient (${resB.detail})\n`);
  ok(true, 'off-path: helper composed real LLM call');
} else if (!resB.ok) {
  process.stdout.write(`  FAIL — ${JSON.stringify(resB)}\n`);
  failures.push('off-path case did not return ok'); fails++; asserts++;
} else {
  ok(typeof resB.on_path === 'boolean', 'off-path: on_path is boolean');
  ok(resB.on_path === false, `off-path: on_path=false (got ${resB.on_path})`);
  if (resB.on_path === false) {
    ok(typeof resB.redirect === 'string' && resB.redirect.length > 0, `off-path: redirect non-empty ("${resB.redirect}")`);
    ok(resB.confidence === 'low' || resB.confidence === 'high', `confidence ∈ {low, high} (got ${resB.confidence})`);
  }
}

// ---------------------------------------------------------------------------
header(`${asserts - fails}/${asserts} assertions passed (${fails} failed)`);
if (fails) {
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
  process.exit(1);
}
process.exit(0);
