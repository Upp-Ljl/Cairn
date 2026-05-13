#!/usr/bin/env node
/**
 * smoke-mentor-rule-c.mjs — Phase 8 of Cairn (§8 Rule C off-goal drift).
 *
 * Validates the async evaluateRuleC_offGoal evaluator against a stub LLM
 * judge. No real network calls — that's dogfood-llm-rule-c.mjs.
 *
 * Covered:
 *   1. helper returns on_path=true → 'on_path' decision, no nudge
 *   2. helper returns on_path=false (single) → 'strike' (strikes=1), no nudge
 *   3. second consecutive on_path=false → 'nudge', strikes reset, nudge row written
 *   4. on_path=true after one strike → strikes reset to 0
 *   5. no profile.whole_sentence → returns null (rule skipped)
 *   6. recentActivity empty → returns null
 *   7. helper not injected → returns null
 *   8. throttle: second call within offGoalThrottleMs → returns null
 *   9. helper.ok=false → returns helper_skipped, no strike increment
 *  10. throws inside helper → returns helper_threw with error string
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dsRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(dsRoot, '..', '..');

const Database = require(path.join(repoRoot, 'packages', 'daemon', 'node_modules', 'better-sqlite3'));
const policy = require(path.join(dsRoot, 'mentor-policy.cjs'));

let asserts = 0, fails = 0;
const failures = [];
function ok(c, l) {
  asserts++;
  if (c) process.stdout.write(`  ok    ${l}\n`);
  else   { fails++; failures.push(l); process.stdout.write(`  FAIL  ${l}\n`); }
}
function header(t) { process.stdout.write(`\n${'='.repeat(56)}\n${t}\n${'='.repeat(56)}\n`); }
function section(t) { process.stdout.write(`\n[${t}]\n`); }

function freshDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE scratchpad (
      key TEXT PRIMARY KEY, value_json TEXT, value_path TEXT, task_id TEXT,
      expires_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
  `);
  return db;
}

const PROJ = { id: 'p_rulec' };
const TASK = (overrides) => Object.assign({
  task_id: 't_rulec_001',
  intent: 'add tests for feature X',
  state: 'RUNNING',
  created_at: Date.now() - 60000,
  updated_at: Date.now() - 5000,
  created_by_agent_id: 'cairn-session-aaaa11111111',
  metadata_json: null,
}, overrides || {});

function profileWithWhole() {
  return {
    exists: true,
    whole_sentence: 'Cairn is a host-level multi-agent coordination kernel + control-surface side panel.',
    goal: { text: 'Ship Rule C off-goal drift judge', exists: true },
    authority: { auto_decide: [], decide_and_announce: [], escalate: [] },
    known_answers: [],
  };
}

function profileWithoutWhole() {
  return {
    exists: true,
    whole_sentence: null,
    goal: null,
    authority: { auto_decide: [], decide_and_announce: [], escalate: [] },
    known_answers: [],
  };
}

const ACTIVITY = {
  transitions: [{ task_id: 't_rulec_001', intent: 'add tests', state: 'RUNNING', updated_at: Date.now() }],
  commits: [{ hash: 'abc', subject: 'wip: tests', ts: Date.now() }],
};

function emitFactory(db) {
  return {
    nudge: (payload) => policy.emitNudge(db, PROJ.id, payload),
    escalation: (payload) => policy.emitEscalation(db, PROJ.id, payload),
  };
}

function fakeJudge(result) { return async () => result; }

const FAST_CONFIG = Object.assign({}, policy.DEFAULTS, { offGoalThrottleMs: 0 });

header('smoke-mentor-rule-c — Phase 8');

// ---------------------------------------------------------------------------
section('1 on_path=true → on_path decision');
{
  const db = freshDb();
  const r = await policy.evaluateRuleC_offGoal({
    db, project: PROJ, task: TASK(), profile: profileWithWhole(),
    recentActivity: ACTIVITY, config: FAST_CONFIG, emit: emitFactory(db),
    llmJudgeOffGoal: fakeJudge({ ok: true, on_path: true, redirect: '', confidence: 'high' }),
  });
  ok(r && r.action === 'on_path', `action=on_path (got ${r && r.action})`);
  ok(r && r.confidence === 'high', 'confidence threaded through');
  const state = policy.readMentorState(db, 't_rulec_001');
  ok(state.offgoal_strikes === 0, 'strikes stay 0');
  ok(state.nudge_count === 0, 'no nudge emitted');
  db.close();
}

// ---------------------------------------------------------------------------
section('2 single on_path=false → strike (no nudge yet)');
{
  const db = freshDb();
  const r = await policy.evaluateRuleC_offGoal({
    db, project: PROJ, task: TASK(), profile: profileWithWhole(),
    recentActivity: ACTIVITY, config: FAST_CONFIG, emit: emitFactory(db),
    llmJudgeOffGoal: fakeJudge({ ok: true, on_path: false, redirect: 'refocus on Whole', confidence: 'low' }),
  });
  ok(r && r.action === 'strike', `action=strike (got ${r && r.action})`);
  ok(r && r.strikes === 1, 'strikes=1');
  const state = policy.readMentorState(db, 't_rulec_001');
  ok(state.offgoal_strikes === 1, 'state offgoal_strikes=1');
  ok(state.nudge_count === 0, 'no nudge yet');
  db.close();
}

// ---------------------------------------------------------------------------
section('3 second consecutive on_path=false → nudge + strikes reset');
{
  const db = freshDb();
  const ctx = {
    db, project: PROJ, task: TASK(), profile: profileWithWhole(),
    recentActivity: ACTIVITY, config: FAST_CONFIG, emit: emitFactory(db),
    llmJudgeOffGoal: fakeJudge({ ok: true, on_path: false, redirect: 'focus back on kernel', confidence: 'high' }),
  };
  await policy.evaluateRuleC_offGoal(ctx); // strike 1
  const r2 = await policy.evaluateRuleC_offGoal(ctx); // strike 2 → nudge
  ok(r2 && r2.action === 'nudge', `action=nudge (got ${r2 && r2.action})`);
  ok(r2 && r2.redirect && r2.redirect.includes('kernel'), 'redirect text present');
  const state = policy.readMentorState(db, 't_rulec_001');
  ok(state.offgoal_strikes === 0, 'strikes reset to 0 after nudge');
  ok(state.nudge_count === 1, 'nudge_count incremented');
  // Inspect the actual nudge row in scratchpad
  const nudges = db.prepare("SELECT key, value_json FROM scratchpad WHERE key LIKE 'mentor/%/nudge/%'").all();
  ok(nudges.length === 1, '1 nudge row written');
  const body = JSON.parse(nudges[0].value_json);
  ok(body.rule === 'C' && body.layer === 'L3', 'nudge tagged rule=C layer=L3');
  ok(body.redirect && body.redirect.includes('kernel'), 'redirect survived to scratchpad payload');
  ok(body.message && body.message.includes('off-goal drift'), 'nudge body mentions off-goal drift');
  db.close();
}

// ---------------------------------------------------------------------------
section('4 on_path=true after a strike → strikes reset');
{
  const db = freshDb();
  await policy.evaluateRuleC_offGoal({
    db, project: PROJ, task: TASK(), profile: profileWithWhole(),
    recentActivity: ACTIVITY, config: FAST_CONFIG, emit: emitFactory(db),
    llmJudgeOffGoal: fakeJudge({ ok: true, on_path: false, redirect: 'r', confidence: 'low' }),
  });
  const r = await policy.evaluateRuleC_offGoal({
    db, project: PROJ, task: TASK(), profile: profileWithWhole(),
    recentActivity: ACTIVITY, config: FAST_CONFIG, emit: emitFactory(db),
    llmJudgeOffGoal: fakeJudge({ ok: true, on_path: true, redirect: '', confidence: 'low' }),
  });
  ok(r && r.action === 'on_path', 'second call → on_path');
  const state = policy.readMentorState(db, 't_rulec_001');
  ok(state.offgoal_strikes === 0, 'strikes reset by on_path');
  ok(state.nudge_count === 0, 'no nudge emitted');
  db.close();
}

// ---------------------------------------------------------------------------
section('5 no profile.whole_sentence → null (rule skipped)');
{
  const db = freshDb();
  const r = await policy.evaluateRuleC_offGoal({
    db, project: PROJ, task: TASK(), profile: profileWithoutWhole(),
    recentActivity: ACTIVITY, config: FAST_CONFIG, emit: emitFactory(db),
    llmJudgeOffGoal: fakeJudge({ ok: true, on_path: false, redirect: '', confidence: 'high' }),
  });
  ok(r === null, 'returns null when no whole_sentence');
  db.close();
}

// ---------------------------------------------------------------------------
section('6 empty recentActivity → null');
{
  const db = freshDb();
  const r = await policy.evaluateRuleC_offGoal({
    db, project: PROJ, task: TASK(), profile: profileWithWhole(),
    recentActivity: { transitions: [], commits: [] },
    config: FAST_CONFIG, emit: emitFactory(db),
    llmJudgeOffGoal: fakeJudge({ ok: true, on_path: false, redirect: '', confidence: 'high' }),
  });
  ok(r === null, 'returns null on empty activity');
  db.close();
}

// ---------------------------------------------------------------------------
section('7 missing llmJudgeOffGoal helper → null');
{
  const db = freshDb();
  const r = await policy.evaluateRuleC_offGoal({
    db, project: PROJ, task: TASK(), profile: profileWithWhole(),
    recentActivity: ACTIVITY, config: FAST_CONFIG, emit: emitFactory(db),
    // llmJudgeOffGoal omitted
  });
  ok(r === null, 'returns null when helper not injected');
  db.close();
}

// ---------------------------------------------------------------------------
section('8 throttle: second call within window → null');
{
  const db = freshDb();
  const throttleCfg = Object.assign({}, policy.DEFAULTS, { offGoalThrottleMs: 60 * 1000 });
  await policy.evaluateRuleC_offGoal({
    db, project: PROJ, task: TASK(), profile: profileWithWhole(),
    recentActivity: ACTIVITY, config: throttleCfg, emit: emitFactory(db),
    llmJudgeOffGoal: fakeJudge({ ok: true, on_path: true, redirect: '', confidence: 'low' }),
  });
  const r = await policy.evaluateRuleC_offGoal({
    db, project: PROJ, task: TASK(), profile: profileWithWhole(),
    recentActivity: ACTIVITY, config: throttleCfg, emit: emitFactory(db),
    llmJudgeOffGoal: fakeJudge({ ok: true, on_path: true, redirect: '', confidence: 'low' }),
  });
  ok(r === null, 'second call within throttle window returns null');
  db.close();
}

// ---------------------------------------------------------------------------
section('9 helper.ok=false → helper_skipped (no strike)');
{
  const db = freshDb();
  const r = await policy.evaluateRuleC_offGoal({
    db, project: PROJ, task: TASK(), profile: profileWithWhole(),
    recentActivity: ACTIVITY, config: FAST_CONFIG, emit: emitFactory(db),
    llmJudgeOffGoal: fakeJudge({ ok: false, reason: 'no_provider' }),
  });
  ok(r && r.action === 'helper_skipped', `action=helper_skipped (got ${r && r.action})`);
  ok(r && r.reason === 'no_provider', 'reason passed through');
  const state = policy.readMentorState(db, 't_rulec_001');
  ok(state.offgoal_strikes === 0, 'no strike on helper failure');
  ok(state.last_offgoal_check_at > 0, 'last_offgoal_check_at stamped (for throttle)');
  db.close();
}

// ---------------------------------------------------------------------------
section('10 helper throws → helper_threw with error message');
{
  const db = freshDb();
  const r = await policy.evaluateRuleC_offGoal({
    db, project: PROJ, task: TASK(), profile: profileWithWhole(),
    recentActivity: ACTIVITY, config: FAST_CONFIG, emit: emitFactory(db),
    llmJudgeOffGoal: async () => { throw new Error('boom'); },
  });
  ok(r && r.action === 'helper_threw', `action=helper_threw (got ${r && r.action})`);
  ok(r && r.error === 'boom', 'error message captured');
  db.close();
}

// ---------------------------------------------------------------------------
section('11 BLOCKED task → null (rule only fires on RUNNING)');
{
  const db = freshDb();
  const r = await policy.evaluateRuleC_offGoal({
    db, project: PROJ, task: TASK({ state: 'BLOCKED' }), profile: profileWithWhole(),
    recentActivity: ACTIVITY, config: FAST_CONFIG, emit: emitFactory(db),
    llmJudgeOffGoal: fakeJudge({ ok: true, on_path: false, redirect: 'x', confidence: 'high' }),
  });
  ok(r === null, 'returns null when task state != RUNNING');
  db.close();
}

// ---------------------------------------------------------------------------
header(`${asserts - fails}/${asserts} assertions passed (${fails} failed)`);
if (fails) {
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
  process.exit(1);
}
process.exit(0);
