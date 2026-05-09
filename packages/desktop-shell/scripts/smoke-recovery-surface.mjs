#!/usr/bin/env node
/**
 * Smoke for the Recovery Surface (UI hardening — checkpoint visibility).
 *
 * Exercises:
 *   - deriveProjectRecovery: confidence good/limited/none across the
 *     three branches; counts per status; safe_anchors list; latest_task_checkpoint
 *   - recoveryPromptForProject: prompt structure, no auto-execute
 *     wording, advisory rules present
 *   - recoveryPromptForTask: scoped prompt; mentions task id + state
 *   - Privacy: prompts NEVER contain api keys / agent_id / cwd /
 *     transcript / stdout
 *
 * Read-only invariants: source-level grep on recovery-summary.cjs.
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

const recovery = require(path.join(root, 'recovery-summary.cjs'));

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
const DAY = 24 * 60 * 60 * 1000;

function ckpt(id, status, ago, opts) {
  const o = opts || {};
  return {
    id,
    label: o.label || null,
    snapshot_status: status,
    git_head: o.git_head || ('abc' + id.slice(0, 4)),
    size_bytes: o.size_bytes != null ? o.size_bytes : 1024,
    created_at: NOW - ago - 60_000,
    ready_at: status === 'READY' ? NOW - ago : null,
    task_id: o.task_id || 't_' + id,
    task_intent: o.task_intent || 'task ' + id,
    task_state: o.task_state || 'RUNNING',
  };
}

// ---------------------------------------------------------------------------
// Part A — confidence: NONE
// ---------------------------------------------------------------------------

console.log('==> Part A: confidence=none');

const r0 = recovery.deriveProjectRecovery([], { now: NOW });
eq(r0.confidence, 'none', 'no checkpoints → confidence=none');
eq(r0.counts.total, 0, 'no checkpoints → counts.total=0');
ok(r0.last_ready === null, 'no checkpoints → last_ready=null');
eq(r0.safe_anchors.length, 0, 'no checkpoints → safe_anchors empty');
ok(r0.latest_task_checkpoint === null, 'no checkpoints → no latest_task_checkpoint');
ok(r0.confidence_reason.indexOf('No checkpoints recorded') >= 0,
   'reason: explicit "no checkpoints"');

// All-corrupted → also none.
const corrupted = [
  ckpt('corr1', 'CORRUPTED', 60_000),
  ckpt('corr2', 'CORRUPTED', 120_000),
];
const r0b = recovery.deriveProjectRecovery(corrupted, { now: NOW });
eq(r0b.confidence, 'none', 'all corrupted → confidence=none');
eq(r0b.counts.corrupted, 2, 'corrupted count');
eq(r0b.counts.ready, 0, 'no ready');

// ---------------------------------------------------------------------------
// Part B — confidence: GOOD
// ---------------------------------------------------------------------------

console.log('\n==> Part B: confidence=good');

const fresh = [
  ckpt('a', 'READY', 5 * 60_000, { label: 'before-rename' }),
  ckpt('b', 'READY', 60 * 60_000, { label: 'mid-day' }),
  ckpt('c', 'PENDING', 2 * 60_000),
];
const rGood = recovery.deriveProjectRecovery(fresh, { now: NOW });
eq(rGood.confidence, 'good', 'fresh READY → confidence=good');
ok(rGood.last_ready && rGood.last_ready.id === 'a',
   'last_ready = the freshest READY (5m old)');
eq(rGood.counts.ready, 2, 'counts.ready=2');
eq(rGood.counts.pending, 1, 'counts.pending=1');
eq(rGood.counts.total, 3, 'counts.total=3');
ok(rGood.safe_anchors.length >= 2, 'safe_anchors includes ≥2 ready');
ok(rGood.safe_anchors.some(a => a.id === 'c'),
   'safe_anchors includes top PENDING after the READY rows');
// id_short is short, label preserved.
ok(rGood.last_ready.id_short.length <= 12, 'last_ready id_short ≤12 chars');
eq(rGood.last_ready.label, 'before-rename', 'last_ready label preserved');
ok(rGood.latest_task_checkpoint && rGood.latest_task_checkpoint.task_id === 't_a',
   'latest_task_checkpoint references freshest task');

// ---------------------------------------------------------------------------
// Part C — confidence: LIMITED
// ---------------------------------------------------------------------------

console.log('\n==> Part C: confidence=limited');

// Old READY only (>24h).
const old = [
  ckpt('old1', 'READY', 2 * DAY, { label: 'last week-ish' }),
];
const rLimitedOld = recovery.deriveProjectRecovery(old, { now: NOW });
eq(rLimitedOld.confidence, 'limited', 'only old READY → confidence=limited');
ok(rLimitedOld.last_ready, 'limited: last_ready still set (just old)');
ok(rLimitedOld.confidence_reason.indexOf('older') >= 0,
   'limited: reason mentions older');

// Pending only.
const pending = [
  ckpt('p1', 'PENDING', 5 * 60_000),
];
const rLimitedPending = recovery.deriveProjectRecovery(pending, { now: NOW });
eq(rLimitedPending.confidence, 'limited', 'only PENDING → confidence=limited');
ok(rLimitedPending.last_ready === null, 'pending only: last_ready=null');
ok(rLimitedPending.confidence_reason.indexOf('PENDING') >= 0,
   'limited: reason mentions PENDING');

// ---------------------------------------------------------------------------
// Part D — recoveryPromptForProject text contract
// ---------------------------------------------------------------------------

console.log('\n==> Part D: recoveryPromptForProject');

const promptGood = recovery.recoveryPromptForProject({
  project_label: 'cairn',
  summary: rGood,
});
ok(/cairn/.test(promptGood), 'prompt: project label embedded');
ok(/Cairn does NOT execute rewind|cairn is a project control surface/i.test(promptGood),
   'prompt: explicit "Cairn does NOT execute rewind"');
ok(/inspect/i.test(promptGood), 'prompt: tells agent to inspect');
ok(/confirm.*boundary|preview/i.test(promptGood),
   'prompt: requires confirmation step');
ok(/Do not push.* unless.* user.*authorize/i.test(promptGood) ||
   /Do not push.* unless.* explicit/i.test(promptGood),
   'prompt: "Do not push unless authorized"');
ok(/READY/.test(promptGood), 'prompt: mentions READY anchor count');

// Imperative ban: positive "go execute" language. We exclude the
// prompt's own NEGATIVE clauses ("Do NOT execute rewind without …",
// "Never run …") which are the intended bans.
function hasPositiveImperative(text) {
  // Strip lines that are explicit bans.
  const cleaned = text.split(/\r?\n/).filter(line =>
    !/(do not|don'?t|never|refuse|without first)\b/i.test(line)
  ).join('\n');
  return /\b(run|execute|perform|do)\s+(the\s+)?rewind\s+(now|immediately|first|right away)\b/i.test(cleaned);
}
ok(!hasPositiveImperative(promptGood),
   'prompt: no positive auto-execute imperative (negative bans are fine)');
ok(!/git stash|force.?push|git reset --hard/i.test(promptGood) ||
   /Never .*(git stash|force.?push|git reset --hard|stash|force-push)/i.test(promptGood),
   'prompt: only mentions git stash / force-push as banned alternatives');

// No-summary branch.
const promptNoSummary = recovery.recoveryPromptForProject({ project_label: 'p', summary: null });
ok(/Refuse to rewind without one|No recovery summary available/i.test(promptNoSummary),
   'prompt with no summary: refuse-to-rewind language');

// ---------------------------------------------------------------------------
// Part E — recoveryPromptForTask
// ---------------------------------------------------------------------------

console.log('\n==> Part E: recoveryPromptForTask');

const taskPrompt = recovery.recoveryPromptForTask({
  project_label: 'cairn',
  task_id:       'T-001',
  task_intent:   'Refactor auth flow',
  task_state:    'RUNNING',
  checkpoint:    rGood.last_ready,
});
ok(/T-001/.test(taskPrompt),                  'task prompt: task id embedded');
ok(/Refactor auth flow/.test(taskPrompt),     'task prompt: task intent embedded');
ok(/RUNNING/.test(taskPrompt),                'task prompt: task state embedded');
ok(/inspect/i.test(taskPrompt),               'task prompt: instruction to inspect');
ok(/Do not push.*authorize/i.test(taskPrompt), 'task prompt: do-not-push contract');
ok(/cairn\.rewind\.preview|cairn\.rewind\.to/i.test(taskPrompt),
   'task prompt: references cairn primitives explicitly');

// No-checkpoint branch.
const taskPromptNoCkpt = recovery.recoveryPromptForTask({
  project_label: 'cairn', task_id: 'T-002', task_intent: 'X', task_state: 'BLOCKED',
  checkpoint: null,
});
ok(/Refuse to rewind without one|No checkpoint provided/i.test(taskPromptNoCkpt),
   'task prompt with no checkpoint: refuse-without-anchor language');

// ---------------------------------------------------------------------------
// Part F — privacy sweep
// ---------------------------------------------------------------------------

console.log('\n==> Part F: privacy sweep');

const POISON = '__SMOKE_POISON__';
const POISON_KEY = 'sk-FAKE-RECOVERY-KEY-AAAA';
const dirtyCkpts = [
  ckpt('a', 'READY', 5 * 60_000, {
    label: 'safe',
    // Sensitive sibling fields the source row could carry; the
    // anchor view and prompt builders should drop them.
    transcript: POISON, api_key: POISON_KEY,
    cwd: 'D:\\secret', agent_id: 'cairn-' + POISON,
  }),
];
const rDirty = recovery.deriveProjectRecovery(dirtyCkpts, { now: NOW });
const rDirtyStr = JSON.stringify(rDirty);
ok(rDirtyStr.indexOf(POISON) === -1, 'recovery summary: no POISON');
ok(rDirtyStr.indexOf(POISON_KEY) === -1, 'recovery summary: no api key');
ok(rDirtyStr.indexOf('secret') === -1, 'recovery summary: no raw cwd');
ok(rDirtyStr.indexOf('transcript') === -1, 'recovery summary: no transcript field');
ok(rDirtyStr.indexOf('agent_id') === -1, 'recovery summary: no agent_id field');

const promptDirty = recovery.recoveryPromptForProject({
  project_label: 'cairn', summary: rDirty,
});
ok(promptDirty.indexOf(POISON) === -1, 'prompt: no POISON');
ok(promptDirty.indexOf(POISON_KEY) === -1, 'prompt: no api key');
ok(promptDirty.indexOf('secret') === -1, 'prompt: no raw cwd');

// ---------------------------------------------------------------------------
// Part G — read-only invariants
// ---------------------------------------------------------------------------

console.log('\n==> Part G: read-only invariants');

const afterCairn = safeMtime(realCairnDb);
if (beforeCairn != null) eq(afterCairn, beforeCairn, 'cairn.db mtime unchanged');

const src = fs.readFileSync(path.join(root, 'recovery-summary.cjs'), 'utf8');
ok(!/\.run\s*\(/.test(src),     'recovery-summary.cjs: no .run(');
ok(!/\.exec\s*\(/.test(src),    'recovery-summary.cjs: no .exec(');
ok(!/\.prepare\s*\(/.test(src), 'recovery-summary.cjs: no .prepare(');
ok(!/writeFileSync|writeFile\b|appendFile/.test(src),
   'recovery-summary.cjs: no file writes');
ok(!/require\(['"]child_process['"]\)/.test(src),
   'recovery-summary.cjs: no child_process');
ok(!/['"]\.claude['"]/.test(src), 'recovery-summary.cjs: no ".claude" literal');
ok(!/['"]\.codex['"]/.test(src),  'recovery-summary.cjs: no ".codex" literal');

console.log(`\n==> ${asserts - fails}/${asserts} assertions passed`);
if (fails > 0) {
  console.error(`FAIL: ${fails} assertion(s) failed`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('PASS');
