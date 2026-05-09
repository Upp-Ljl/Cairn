#!/usr/bin/env node
/**
 * Smoke for the Pre-PR Gate (Phase 4, advisory only).
 *
 * Exercises:
 *   - deterministicGate every documented rule:
 *       open_blocker → not_ready
 *       failed_outcome → not_ready
 *       failed_task → not_ready
 *       open_conflict → not_ready
 *       no_goal → unknown (when no other watch signal)
 *       no_recent_report → ready_with_risks (when goal set)
 *       waiting_review → ready_with_risks
 *       report_needs_human → ready_with_risks
 *       in-flight + no recent activity → ready_with_risks (carried
 *         from pulse.signals)
 *       positive evidence path
 *   - status priority: not_ready > ready_with_risks > unknown,
 *     LLM cannot override status
 *   - LLM rewrite: valid JSON / fenced JSON / invalid JSON / HTTP fail
 *     → fallback to deterministic (status preserved)
 *   - Privacy: payload to LLM contains only deterministic outputs
 *     (no goal text, no agent_id, no transcripts)
 *
 * Read-only invariants: source-level grep on pre-pr-gate.cjs.
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

const gate = require(path.join(root, 'pre-pr-gate.cjs'));

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

const NOW = 1_800_000_000_000;

function baseInput(extra) {
  return Object.assign({
    goal: { title: 'Ship feature X', desired_outcome: '' },
    pulse: { pulse_level: 'ok', signals: [] },
    summary: {
      tasks_running: 0, tasks_blocked: 0, tasks_waiting_review: 0, tasks_failed: 0,
      blockers_open: 0, outcomes_failed: 0,
      conflicts_open: 0,
    },
    activity_summary: { total: 1, by_family: { live: 1, recent: 0, inactive: 0, dead: 0, unknown: 0 } },
    recent_reports: [{ title: 'progress', completed: ['x'], remaining: [], blockers: [], next_steps: [], needs_human: false }],
  }, extra || {});
}

// ---------------------------------------------------------------------------
// Part A — blocking rules
// ---------------------------------------------------------------------------

console.log('==> Part A: blocking rules (status=not_ready)');

const r_blocker = gate.deterministicGate(baseInput({
  summary: { blockers_open: 1, tasks_running: 0, tasks_blocked: 0, tasks_waiting_review: 0, tasks_failed: 0, outcomes_failed: 0, conflicts_open: 0 },
}), { now: NOW });
eq(r_blocker.status, 'not_ready', 'open_blocker → not_ready');
ok(r_blocker.rule_log.includes('open_blocker'), 'rule_log: open_blocker');
ok(r_blocker.checklist.length >= 1, 'checklist: at least one item for blocker');
ok(r_blocker.risks.some(r => r.severity === 'attention'), 'risk severity attention');

const r_outcome = gate.deterministicGate(baseInput({
  summary: { outcomes_failed: 2, tasks_running: 0, tasks_blocked: 0, tasks_waiting_review: 0, tasks_failed: 0, blockers_open: 0, conflicts_open: 0 },
}), { now: NOW });
eq(r_outcome.status, 'not_ready', 'failed_outcome → not_ready');
ok(r_outcome.rule_log.includes('failed_outcome'), 'rule_log: failed_outcome');

const r_taskfail = gate.deterministicGate(baseInput({
  summary: { tasks_failed: 1, tasks_running: 0, tasks_blocked: 0, tasks_waiting_review: 0, blockers_open: 0, outcomes_failed: 0, conflicts_open: 0 },
}), { now: NOW });
eq(r_taskfail.status, 'not_ready', 'failed_task → not_ready');
ok(r_taskfail.rule_log.includes('failed_task'), 'rule_log: failed_task');

const r_conflict = gate.deterministicGate(baseInput({
  summary: { conflicts_open: 1, tasks_running: 0, tasks_blocked: 0, tasks_waiting_review: 0, tasks_failed: 0, blockers_open: 0, outcomes_failed: 0 },
}), { now: NOW });
eq(r_conflict.status, 'not_ready', 'open_conflict → not_ready');
ok(r_conflict.rule_log.includes('open_conflict'), 'rule_log: open_conflict');

// Stacked blocking signals.
const r_all = gate.deterministicGate(baseInput({
  summary: { blockers_open: 1, outcomes_failed: 1, tasks_failed: 1, conflicts_open: 1, tasks_running: 0, tasks_blocked: 0, tasks_waiting_review: 0 },
}), { now: NOW });
eq(r_all.status, 'not_ready', '4 blockers → not_ready');
ok(r_all.rule_log.length >= 4, 'rule_log: all 4 logged');

// ---------------------------------------------------------------------------
// Part B — anchor rules (status=unknown)
// ---------------------------------------------------------------------------

console.log('\n==> Part B: anchor rules (status=unknown / ready_with_risks)');

const r_no_goal = gate.deterministicGate(baseInput({
  goal: null,
  recent_reports: [],
  summary: { tasks_running: 0, tasks_blocked: 0, tasks_waiting_review: 0, tasks_failed: 0, blockers_open: 0, outcomes_failed: 0, conflicts_open: 0 },
}), { now: NOW });
eq(r_no_goal.status, 'unknown', 'no goal → status=unknown');
ok(r_no_goal.rule_log.includes('no_goal'), 'rule_log: no_goal');

// no goal but we have an explicit blocker is still not_ready (blocker wins)
const r_no_goal_block = gate.deterministicGate(baseInput({
  goal: null,
  summary: { blockers_open: 1, tasks_running: 0, tasks_blocked: 0, tasks_waiting_review: 0, tasks_failed: 0, outcomes_failed: 0, conflicts_open: 0 },
}), { now: NOW });
eq(r_no_goal_block.status, 'not_ready', 'no goal + blocker still → not_ready (blocker wins)');

// ---------------------------------------------------------------------------
// Part C — observational watch rules (status=ready_with_risks)
// ---------------------------------------------------------------------------

console.log('\n==> Part C: watch rules (status=ready_with_risks)');

const r_no_report = gate.deterministicGate(baseInput({
  recent_reports: [],
}), { now: NOW });
eq(r_no_report.status, 'ready_with_risks', 'goal but no recent report → ready_with_risks');
ok(r_no_report.rule_log.includes('no_recent_report'), 'rule_log: no_recent_report');

const r_needs_human = gate.deterministicGate(baseInput({
  recent_reports: [{ title: 'r1', completed: [], remaining: [], blockers: [], next_steps: [], needs_human: true }],
}), { now: NOW });
ok(r_needs_human.rule_log.includes('report_needs_human'), 'rule_log: report_needs_human');
eq(r_needs_human.status, 'ready_with_risks', 'needs_human → ready_with_risks');

const r_waiting_review = gate.deterministicGate(baseInput({
  summary: { tasks_waiting_review: 2, tasks_running: 0, tasks_blocked: 0, tasks_failed: 0, blockers_open: 0, outcomes_failed: 0, conflicts_open: 0 },
}), { now: NOW });
ok(r_waiting_review.rule_log.includes('waiting_review'), 'rule_log: waiting_review');
eq(r_waiting_review.status, 'ready_with_risks', 'waiting_review → ready_with_risks');

const r_inflight_stale = gate.deterministicGate(baseInput({
  pulse: { pulse_level: 'watch', signals: [
    { kind: 'inflight_no_recent_activity', severity: 'watch', title: 'task in flight · no activity in 60m', detail: '' },
  ]},
  summary: { tasks_running: 1, tasks_blocked: 0, tasks_waiting_review: 0, tasks_failed: 0, blockers_open: 0, outcomes_failed: 0, conflicts_open: 0 },
}), { now: NOW });
ok(r_inflight_stale.rule_log.includes('inflight_no_recent_activity'),
   'rule_log: inflight_no_recent_activity carried from pulse');

// ---------------------------------------------------------------------------
// Part D — positive evidence path
// ---------------------------------------------------------------------------

console.log('\n==> Part D: positive evidence');

const r_positive = gate.deterministicGate(baseInput({
  summary: { tasks_running: 0, tasks_blocked: 0, tasks_waiting_review: 0, tasks_failed: 0, blockers_open: 0, outcomes_failed: 0, conflicts_open: 0 },
  recent_reports: [{ title: 'progress', completed: ['done X'], remaining: [], blockers: [], next_steps: [], needs_human: false }],
}), { now: NOW });
ok(r_positive.evidence.some(e => e.indexOf('No tasks in flight') >= 0),
   'positive: evidence mentions zero in-flight tasks');
eq(r_positive.status, 'ready_with_risks', 'positive evidence path → ready_with_risks (advisory ready)');

// ---------------------------------------------------------------------------
// Part E — LLM rewrite
// ---------------------------------------------------------------------------

console.log('\n==> Part E: evaluatePrePrGate with mock LLM');

// Disabled provider → deterministic.
const e1 = await gate.evaluatePrePrGate(baseInput(), {
  provider: { enabled: false, reason: 'incomplete_config' },
});
eq(e1.mode, 'deterministic', 'disabled provider → deterministic');

// Mock LLM returns valid rewrite. Status MUST come from deterministic
// even if the LLM tries to claim otherwise.
let lastPayload = null;
const mockOk = async (payload) => {
  lastPayload = payload;
  return {
    enabled: true, ok: true, model: 'fake-model',
    text: JSON.stringify({
      checklist: ['Review the open blocker', 'Re-check failing outcome'],
      risks: [{ kind: 'open_blocker', severity: 'attention', title: 'Blocker is open', detail: 'Resolve before merge' }],
      summary: 'Two issues should clear before merging.',
      // Hostile attempt: try to flip status. We must ignore it.
      status: 'ready_with_risks',
    }),
  };
};
const e2 = await gate.evaluatePrePrGate(baseInput({
  summary: { blockers_open: 1, outcomes_failed: 1, tasks_running: 0, tasks_blocked: 0, tasks_waiting_review: 0, tasks_failed: 0, conflicts_open: 0 },
}), {
  provider: { enabled: true, _apiKey: 'sk-FAKE', model: 'fake-model', baseUrl: 'https://x/v1' },
  chatJson: mockOk,
});
eq(e2.mode, 'llm', 'valid LLM rewrite → mode=llm');
eq(e2.status, 'not_ready', 'LLM CANNOT change status (still not_ready)');
ok(e2.summary.indexOf('Two issues') >= 0, 'LLM summary preserved');
eq(e2.checklist.length, 2, 'LLM checklist count preserved');

// Privacy: payload sent to LLM contains ONLY deterministic outputs
// (status, rule_log, checklist, risks, evidence) — never raw input
// fields. The goal title is intentionally part of evidence (the gate
// rewrite needs the anchor) — same user-authored field the user
// already passed to the Phase 2 Interpretation. We DO NOT pass:
// agent_id, session_id, cwd, transcripts, capabilities, raw report
// bodies, full activity rows.
const lastPayloadStr = JSON.stringify(lastPayload);
ok(lastPayloadStr.indexOf('agent_id') === -1, 'LLM payload: no agent_id key');
ok(lastPayloadStr.indexOf('session_id') === -1, 'LLM payload: no session_id key');
ok(lastPayloadStr.indexOf('transcript') === -1, 'LLM payload: no transcript key');
ok(lastPayloadStr.indexOf('capabilities') === -1, 'LLM payload: no capabilities key');
ok(lastPayloadStr.indexOf('cwd') === -1, 'LLM payload: no cwd key');
ok(/system|messages/.test(lastPayloadStr) && /rule_log/.test(lastPayloadStr),
   'LLM payload: contains rule_log + system message');
// Confirm the LLM is given the deterministic shape, not the raw inputs.
const userMsg = lastPayload && lastPayload.messages && lastPayload.messages[1];
ok(userMsg && userMsg.role === 'user', 'LLM payload: 2nd message is user role');
const userBody = JSON.parse(userMsg.content);
const allowedKeys = new Set(['status', 'rule_log', 'checklist', 'risks', 'evidence']);
const userKeys = Object.keys(userBody);
ok(userKeys.every(k => allowedKeys.has(k)),
   `LLM user message: only allowed keys (got ${userKeys.join(',')})`);

// Mock LLM returns invalid JSON → fallback.
const mockBad = async () => ({
  enabled: true, ok: true, model: 'fake-model',
  text: 'this is not json',
});
const e3 = await gate.evaluatePrePrGate(baseInput({
  summary: { blockers_open: 1, tasks_running: 0, tasks_blocked: 0, tasks_waiting_review: 0, tasks_failed: 0, outcomes_failed: 0, conflicts_open: 0 },
}), {
  provider: { enabled: true, _apiKey: 'sk-FAKE', model: 'fake-model', baseUrl: 'https://x/v1' },
  chatJson: mockBad,
});
eq(e3.mode, 'deterministic', 'invalid LLM JSON → fallback mode=deterministic');
eq(e3.status, 'not_ready', 'invalid LLM JSON → status preserved');
eq(e3.error_code, 'json_parse', 'invalid LLM JSON → error_code surfaced');

// HTTP failure → fallback.
const mockHttp = async () => ({
  enabled: true, ok: false, model: 'fake-model', error_code: 'http_500',
});
const e4 = await gate.evaluatePrePrGate(baseInput(), {
  provider: { enabled: true, _apiKey: 'sk-FAKE', model: 'fake-model', baseUrl: 'https://x/v1' },
  chatJson: mockHttp,
});
eq(e4.mode, 'deterministic', 'HTTP failure → fallback');
eq(e4.error_code, 'http_500', 'HTTP failure → error_code surfaced');

// forceDeterministic short-circuit.
const e5 = await gate.evaluatePrePrGate(baseInput(), {
  forceDeterministic: true,
  provider: { enabled: true, _apiKey: 'sk-FAKE', model: 'fake-model', baseUrl: 'https://x/v1' },
  chatJson: () => { throw new Error('should never call LLM'); },
});
eq(e5.mode, 'deterministic', 'forceDeterministic skips LLM');

// ---------------------------------------------------------------------------
// Part F — project rules awareness (governance v1)
// ---------------------------------------------------------------------------

console.log('\n==> Part F: project rules awareness');

const userRules = {
  version: 1,
  coding_standards: ['Follow existing patterns', 'No unrelated refactors'],
  testing_policy: ['Run targeted smoke', 'Verify mtime invariants'],
  reporting_policy: ['List changed files in final report'],
  pre_pr_checklist: ['No new schema/dep without authorization', 'No secret leakage'],
  non_goals: ['No auto-dispatch', 'No code execution by Cairn'],
  updated_at: NOW,
};

// Status still locked: blocker > rules.
const r_rules_blocker = gate.deterministicGate(baseInput({
  summary: { blockers_open: 1, tasks_running: 0, tasks_blocked: 0, tasks_waiting_review: 0, tasks_failed: 0, outcomes_failed: 0, conflicts_open: 0 },
  project_rules: userRules,
}), { now: NOW });
eq(r_rules_blocker.status, 'not_ready', 'rules + blocker → status still not_ready');
ok(r_rules_blocker.rule_log.includes('rules_applied'),
   'rule_log: rules_applied tag (user rules)');

// Rules feed checklist sections.
const r_rules_clean = gate.deterministicGate(baseInput({
  summary: { tasks_running: 0, tasks_blocked: 0, tasks_waiting_review: 0, tasks_failed: 0, blockers_open: 0, outcomes_failed: 0, conflicts_open: 0 },
  project_rules: userRules,
}), { now: NOW });
ok(r_rules_clean.checklist.some(c => c.startsWith('Pre-PR:')),
   'checklist: Pre-PR items present');
ok(r_rules_clean.checklist.some(c => c.startsWith('Testing:')),
   'checklist: Testing items present');
ok(r_rules_clean.checklist.some(c => c.startsWith('Reporting:')),
   'checklist: Reporting items present');
ok(r_rules_clean.checklist.some(c => c.startsWith('Coding:')),
   'checklist: Coding (top 2) items present');
// non_goals → evidence (not checklist) so users see boundary.
ok(r_rules_clean.evidence.some(e => /Non-goals/i.test(e)),
   'evidence: non_goals section surfaced');

// Default rules: items tagged [default] so the user sees the floor.
const r_default = gate.deterministicGate(baseInput({
  summary: { tasks_running: 0, tasks_blocked: 0, tasks_waiting_review: 0, tasks_failed: 0, blockers_open: 0, outcomes_failed: 0, conflicts_open: 0 },
  project_rules: userRules,
  project_rules_is_default: true,
}), { now: NOW });
ok(r_default.checklist.every(c => !/\[default\]/.test(c) || c.endsWith(' [default]')),
   'default-tag suffix consistent');
ok(r_default.checklist.some(c => c.endsWith(' [default]')),
   'default rules: items tagged [default]');
ok(r_default.rule_log.includes('rules_default_applied'),
   'rule_log: rules_default_applied tag');

// reporting_policy sharpens no-recent-report wording.
const r_no_report_with_policy = gate.deterministicGate(baseInput({
  recent_reports: [],
  project_rules: userRules,
}), { now: NOW });
ok(r_no_report_with_policy.rule_log.includes('no_recent_report'),
   'no_recent_report still fires when policy set');
ok(r_no_report_with_policy.risks.some(r =>
   r.kind === 'no_recent_report' && /reporting policy/i.test(r.title)),
   'no_recent_report wording sharpened by reporting policy');

// LLM rewrite: rules in input still produce locked status, and a
// hostile LLM trying to remove non_goals or change status is ignored.
const mockHostileRules = async (payload) => {
  return {
    enabled: true, ok: true, model: 'fake-model',
    text: JSON.stringify({
      checklist: ['Run the deploy', 'Push to main now'], // hostile additions
      risks: [],
      summary: 'Looks ready to ship.',
      status: 'ready_with_risks', // hostile attempt to flip from not_ready
    }),
  };
};
const r_hostile = await gate.evaluatePrePrGate(baseInput({
  summary: { blockers_open: 1, tasks_running: 0, tasks_blocked: 0, tasks_waiting_review: 0, tasks_failed: 0, outcomes_failed: 0, conflicts_open: 0 },
  project_rules: userRules,
}), {
  provider: { enabled: true, _apiKey: 'sk-FAKE', model: 'fake-model', baseUrl: 'https://x/v1' },
  chatJson: mockHostileRules,
});
eq(r_hostile.status, 'not_ready', 'hostile LLM cannot flip not_ready → ready_with_risks');
// Even though LLM tried hostile additions, the deterministic rule_log
// is preserved (LLM cannot rewrite it).
ok(r_hostile.rule_log.includes('open_blocker'), 'hostile LLM: rule_log preserves open_blocker');
ok(r_hostile.rule_log.includes('rules_applied'), 'hostile LLM: rule_log preserves rules_applied');

// ---------------------------------------------------------------------------
// Part G — read-only invariants
// ---------------------------------------------------------------------------

console.log('\n==> Part G: read-only invariants');

const src = fs.readFileSync(path.join(root, 'pre-pr-gate.cjs'), 'utf8');
ok(!/\.run\s*\(/.test(src),     'pre-pr-gate.cjs: no .run(');
ok(!/\.exec\s*\(/.test(src),    'pre-pr-gate.cjs: no .exec(');
ok(!/\.prepare\s*\(/.test(src), 'pre-pr-gate.cjs: no .prepare(');
ok(!/writeFileSync|writeFile\b|appendFile/.test(src),
   'pre-pr-gate.cjs: no file writes');
ok(!/require\(['"]child_process['"]\)/.test(src),
   'pre-pr-gate.cjs: no child_process');
ok(!/['"]\.claude['"]/.test(src), 'pre-pr-gate.cjs: no ".claude" string literal');
ok(!/['"]\.codex['"]/.test(src),  'pre-pr-gate.cjs: no ".codex" string literal');

console.log(`\n==> ${asserts - fails}/${asserts} assertions passed`);
if (fails > 0) {
  console.error(`FAIL: ${fails} assertion(s) failed`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('PASS');
