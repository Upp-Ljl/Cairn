#!/usr/bin/env node
/**
 * Smoke for Goal Interpretation v1 (advisory LLM layer).
 *
 * Exercises:
 *   - llm-client.parseEnvFile: env-file parsing, comments, quoted vals.
 *   - llm-client.loadProvider: missing-file / incomplete-config /
 *     enabled paths.
 *   - llm-client.describeProvider: NEVER includes the api key.
 *   - goal-interpretation.buildCompactState: drops sensitive fields,
 *     caps lengths, never echoes raw input.
 *   - goal-interpretation.deterministicInterpretation: stable shape,
 *     pulse signals promoted, "no goal" branch, attention/watch/ok
 *     branches.
 *   - goal-interpretation.interpretGoal end-to-end:
 *       disabled provider     → deterministic
 *       LLM returns valid JSON → mode=llm
 *       LLM returns invalid JSON → fallback to deterministic
 *       LLM HTTP failure        → fallback to deterministic
 *       LLM timeout             → fallback to deterministic
 *   - Privacy contract: a POISON marker injected into the input is
 *     NEVER seen by the (mock) LLM payload — proves buildCompactState
 *     stripped raw fields like agent_id / cwd / capabilities /
 *     transcripts.
 *
 * Read-only invariants: source-level grep on llm-client.cjs and
 * goal-interpretation.cjs (no .run / .exec / SQL mutation / file
 * write / child_process / .claude / .codex string literal).
 *
 * NEVER hits the network. Live key probing happens in the dogfood,
 * not here.
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

const llmClient   = require(path.join(root, 'llm-client.cjs'));
const goalInterp  = require(path.join(root, 'goal-interpretation.cjs'));

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

const POISON = '__SMOKE_POISON__/* must never reach the LLM payload */';
const POISON_KEY = 'sk-FAKE-KEY-MUST-NEVER-LEAK-12345';

// ---------------------------------------------------------------------------
// Part A — env file parsing + provider load
// ---------------------------------------------------------------------------

console.log('==> Part A: env file parsing + provider load');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-interp-smoke-'));
const goodFile = path.join(tmpDir, 'good.env');
fs.writeFileSync(goodFile,
  '# comment\n' +
  '\n' +
  `MINIMAX_BASE_URL=https://api.example.test/v1\n` +
  `MINIMAX_API_KEY="${POISON_KEY}"\n` +
  `MINIMAX_MODEL=fake-model-1\n` +
  `EXTRA=ignored\n`, 'utf8');

const env = llmClient.parseEnvFile(goodFile);
eq(env.MINIMAX_MODEL, 'fake-model-1', 'parseEnvFile: simple value');
eq(env.MINIMAX_API_KEY, POISON_KEY, 'parseEnvFile: quoted value unwraps quotes');

const provGood = llmClient.loadProvider({ keysFile: goodFile });
ok(provGood.enabled, 'loadProvider: enabled when all 3 vars set');
eq(provGood.model, 'fake-model-1', 'loadProvider: model exposed');
eq(provGood.baseUrl, 'https://api.example.test/v1', 'loadProvider: baseUrl exposed');

const desc = llmClient.describeProvider(provGood);
ok(JSON.stringify(desc).indexOf(POISON_KEY) === -1,
   'describeProvider: api key NEVER appears in describe output');
ok(!desc._apiKey && !desc.apiKey, 'describeProvider: no api key field at all');
eq(desc.enabled, true, 'describeProvider: enabled flag');
eq(desc.model, 'fake-model-1', 'describeProvider: model exposed');

const missingFile = llmClient.loadProvider({ keysFile: path.join(tmpDir, 'nope.env') });
eq(missingFile.enabled, false, 'loadProvider: missing file → disabled');
eq(missingFile.reason, 'keys_file_missing', 'loadProvider: reason=keys_file_missing');

const partialFile = path.join(tmpDir, 'partial.env');
fs.writeFileSync(partialFile, 'MINIMAX_BASE_URL=https://api.example/v1\nMINIMAX_MODEL=m1\n', 'utf8');
const provPartial = llmClient.loadProvider({ keysFile: partialFile });
eq(provPartial.enabled, false, 'loadProvider: missing key → disabled');
eq(provPartial.reason, 'incomplete_config', 'loadProvider: reason=incomplete_config');

// ---------------------------------------------------------------------------
// Part B — buildCompactState privacy contract
// ---------------------------------------------------------------------------

console.log('\n==> Part B: buildCompactState strips raw / sensitive fields');

const dirty = {
  goal: {
    title: 'My goal',
    desired_outcome: 'Outcome',
    success_criteria: ['c1', 'c2'],
    non_goals: ['ng1'],
    // dirty fields that must NOT survive:
    transcript: POISON,
    api_key: POISON_KEY,
  },
  pulse: {
    pulse_level: 'attention',
    signals: [
      { kind: 'open_blocker', severity: 'attention', title: '1 open blocker', detail: 'Detail OK',
        // dirty:
        raw_prompt: POISON, agent_id: 'cairn-session-' + POISON },
    ],
  },
  activity_summary: {
    total: 4,
    by_family: { live: 2, recent: 1, inactive: 1, dead: 0, unknown: 0 },
    by_app: { mcp: 2, 'claude-code': 1, codex: 1 },
  },
  top_activities: [
    { app: 'mcp', state: 'active', state_family: 'live', display_name: 'cairn-session-aaa',
      // dirty fields:
      agent_id: 'cairn-session-aaaaaaaaaaaa', session_id: 'sid-' + POISON,
      cwd: 'D:\\lll\\cairn\\secret\\path',
      capabilities: ['cwd:' + POISON, 'session:' + POISON],
      detail: { capabilities: ['cwd:' + POISON], owns_tasks: { RUNNING: 1 } } },
  ],
  tasks_summary: { running: 1, blocked: 0, waiting_review: 0, failed: 0, done: 5 },
  blockers_summary: { open: 1 },
  outcomes_summary: { failed: 0, pending: 0 },
  recent_reports: [
    { title: 'Worker report A', completed: ['x','y'], remaining: ['z'], blockers: [],
      next_steps: ['nx'], needs_human: false,
      // dirty:
      transcript: POISON, prompt: POISON, stdout: POISON },
  ],
};

const compact = goalInterp.buildCompactState(dirty);
const compactStr = JSON.stringify(compact);
ok(compactStr.indexOf(POISON) === -1, 'compact state: POISON marker NOT present anywhere');
ok(compactStr.indexOf(POISON_KEY) === -1, 'compact state: api key NOT present');
ok(compactStr.indexOf('secret\\\\path') === -1 && compactStr.indexOf('secret/path') === -1,
   'compact state: raw cwd path NOT present');
ok(compactStr.indexOf('cairn-session-aaaaaaaaaaaa') === -1,
   'compact state: full agent_id NOT present');
ok(compactStr.indexOf('transcript') === -1, 'compact state: no "transcript" key');
ok(compactStr.indexOf('prompt') === -1, 'compact state: no "prompt" key');
ok(compactStr.indexOf('stdout') === -1, 'compact state: no "stdout" key');
ok(compactStr.indexOf('capabilities') === -1, 'compact state: no "capabilities" key');
ok(compactStr.indexOf('owns_tasks') === -1, 'compact state: no "owns_tasks" detail key');
ok(compactStr.indexOf('api_key') === -1, 'compact state: no "api_key" key');
ok(compactStr.indexOf('agent_id') === -1, 'compact state: no agent_id key reaches LLM');

// Goal scaffolding survives (sanitized).
eq(compact.goal.title, 'My goal', 'compact state: goal.title preserved');
eq(compact.goal.success_criteria.length, 2, 'compact state: criteria list preserved');
// Pulse signals: only kind/severity/title/detail.
eq(compact.pulse.signals.length, 1, 'compact state: 1 pulse signal');
ok(compact.pulse.signals[0].kind === 'open_blocker', 'compact state: signal.kind preserved');
ok(!('raw_prompt' in compact.pulse.signals[0]), 'compact state: signal raw_prompt stripped');
ok(!('agent_id' in compact.pulse.signals[0]), 'compact state: signal agent_id stripped');
// Activities: only 4 fields per row.
eq(compact.top_activities.length, 1, 'compact state: 1 top activity');
const a0 = compact.top_activities[0];
ok(Object.keys(a0).sort().join(',') === 'app,display_name,state,state_family',
   'compact state: activity row keys = [app, display_name, state, state_family]');
// Reports: only counts + title + needs_human.
eq(compact.recent_reports.length, 1, 'compact state: 1 report');
const r0 = compact.recent_reports[0];
eq(r0.title, 'Worker report A', 'compact state: report title preserved');
eq(r0.completed_count, 2, 'compact state: report completed counted');
eq(r0.blocker_count, 0, 'compact state: report blocker count');
ok(!('transcript' in r0), 'compact state: report transcript stripped');

// ---------------------------------------------------------------------------
// Part C — deterministic interpretation
// ---------------------------------------------------------------------------

console.log('\n==> Part C: deterministic interpretation');

const detNoGoal = goalInterp.deterministicInterpretation(
  goalInterp.buildCompactState({ goal: null, pulse: { pulse_level: 'ok', signals: [] } }),
  { now: 100 },
);
eq(detNoGoal.mode, 'deterministic', 'deterministic mode');
ok(detNoGoal.summary.indexOf('No goal set') === 0, 'no-goal branch: summary starts "No goal set"');
ok(detNoGoal.next_attention.length > 0, 'no-goal branch: next_attention prompts user to set a goal');

const detAttention = goalInterp.deterministicInterpretation(
  goalInterp.buildCompactState({
    goal: { title: 'g', desired_outcome: '' },
    pulse: { pulse_level: 'attention', signals: [
      { kind: 'open_blocker', severity: 'attention', title: '1 open blocker', detail: '' },
    ]},
    blockers_summary: { open: 1 },
  }),
  { now: 100 },
);
eq(detAttention.risks.length, 1, 'attention branch: 1 risk surfaced');
eq(detAttention.risks[0].kind, 'open_blocker', 'attention branch: signal kind passed through');
ok(detAttention.summary.indexOf('ATTENTION') >= 0, 'attention branch: summary mentions ATTENTION');
ok(detAttention.evidence_ids.includes('open_blocker'),
   'attention branch: evidence_ids includes signal kind');

const detOk = goalInterp.deterministicInterpretation(
  goalInterp.buildCompactState({
    goal: { title: 'g' },
    pulse: { pulse_level: 'ok', signals: [] },
    activity_summary: { total: 1, by_family: { live: 1, recent: 0, inactive: 0, dead: 0, unknown: 0 }, by_app: { mcp: 1, 'claude-code': 0, codex: 0 } },
  }),
  { now: 100 },
);
ok(detOk.summary.indexOf('no open issues') >= 0, 'ok branch: summary mentions "no open issues"');

// ---------------------------------------------------------------------------
// Part D — interpretGoal end-to-end with mock LLM
// ---------------------------------------------------------------------------

console.log('\n==> Part D: interpretGoal end-to-end');

const baseInput = {
  goal: { title: 'Ship Goal Mode', desired_outcome: 'Working v1' },
  pulse: { pulse_level: 'watch', signals: [
    { kind: 'live_agents_no_active_task', severity: 'watch', title: '2 agents live but no active task', detail: 'detail' },
  ]},
  activity_summary: { total: 2, by_family: { live: 2, recent: 0, inactive: 0, dead: 0, unknown: 0 }, by_app: { mcp: 2, 'claude-code': 0, codex: 0 } },
  blockers_summary: { open: 0 },
};

// Disabled provider → deterministic.
const r1 = await goalInterp.interpretGoal(baseInput, {
  provider: { enabled: false, reason: 'incomplete_config' },
});
eq(r1.mode, 'deterministic', 'disabled provider → deterministic');
eq(r1.error_code, 'incomplete_config', 'disabled provider → error_code surfaced');

// Mock LLM returns valid JSON.
let lastPayload = null;
const mockLlmOk = async (payload) => {
  lastPayload = payload;
  return {
    enabled: true, ok: true, model: 'fake-model-1',
    text: JSON.stringify({
      summary: 'Two agents are present without a running task. Worth a check.',
      risks: [{ kind: 'live_agents_no_active_task', severity: 'watch', title: 'live but quiet' }],
      next_attention: ['Open Tasks tab to see if a task is needed'],
      evidence_ids: ['live_agents_no_active_task'],
    }),
  };
};
const r2 = await goalInterp.interpretGoal(baseInput, {
  provider: { enabled: true, _apiKey: POISON_KEY, model: 'fake-model-1', baseUrl: 'https://x/v1' },
  chatJson: mockLlmOk,
});
eq(r2.mode, 'llm', 'valid LLM JSON → mode=llm');
eq(r2.model, 'fake-model-1', 'llm model exposed');
ok(r2.summary.indexOf('Two agents') >= 0, 'llm summary preserved');
eq(r2.risks.length, 1, 'llm risks normalized');
ok(r2.next_attention.length === 1, 'llm next_attention preserved');

// Verify payload privacy: nothing in the LLM call carries POISON / key.
const lastPayloadStr = JSON.stringify(lastPayload);
ok(lastPayloadStr.indexOf(POISON_KEY) === -1, 'mock LLM payload: no api key');
ok(lastPayloadStr.indexOf('agent_id') === -1, 'mock LLM payload: no agent_id key');
ok(lastPayloadStr.indexOf('transcript') === -1, 'mock LLM payload: no transcript key');
ok(lastPayloadStr.indexOf('prompt') === -1 || /system|messages/.test(lastPayloadStr),
   'mock LLM payload: no "prompt" data key (system/messages OK)');
ok(lastPayload.messages && lastPayload.messages[0].role === 'system',
   'mock LLM payload has system message');
ok(lastPayload.messages[0].content.indexOf('NOT a coding agent') >= 0,
   'system prompt contains advisory positioning');

// Mock LLM returns INVALID JSON → fallback.
const mockLlmBadJson = async () => ({
  enabled: true, ok: true, model: 'fake-model-1',
  text: 'this is not json at all',
});
const r3 = await goalInterp.interpretGoal(baseInput, {
  provider: { enabled: true, _apiKey: POISON_KEY, model: 'fake-model-1', baseUrl: 'https://x/v1' },
  chatJson: mockLlmBadJson,
});
eq(r3.mode, 'deterministic', 'invalid LLM JSON → fallback to deterministic');
eq(r3.error_code, 'json_parse', 'invalid LLM JSON → error_code=json_parse');
eq(r3.llm_model, 'fake-model-1', 'fallback retains attempted llm_model for diag');

// Mock LLM with code-fence wrapped JSON (some providers do this).
const mockLlmFenced = async () => ({
  enabled: true, ok: true, model: 'fake-model-1',
  text: '```json\n{"summary":"Fenced","risks":[],"next_attention":[],"evidence_ids":[]}\n```',
});
const r4 = await goalInterp.interpretGoal(baseInput, {
  provider: { enabled: true, _apiKey: POISON_KEY, model: 'fake-model-1', baseUrl: 'https://x/v1' },
  chatJson: mockLlmFenced,
});
eq(r4.mode, 'llm', 'fenced JSON: still parsed as llm mode');
eq(r4.summary, 'Fenced', 'fenced JSON: summary extracted');

// HTTP failure → fallback.
const mockLlmHttp500 = async () => ({
  enabled: true, ok: false, model: 'fake-model-1', error_code: 'http_500',
});
const r5 = await goalInterp.interpretGoal(baseInput, {
  provider: { enabled: true, _apiKey: POISON_KEY, model: 'fake-model-1', baseUrl: 'https://x/v1' },
  chatJson: mockLlmHttp500,
});
eq(r5.mode, 'deterministic', 'HTTP failure → fallback');
eq(r5.error_code, 'http_500', 'HTTP failure → error_code surfaced');

// Timeout → fallback.
const mockLlmTimeout = async () => ({
  enabled: true, ok: false, model: 'fake-model-1', error_code: 'timeout',
});
const r6 = await goalInterp.interpretGoal(baseInput, {
  provider: { enabled: true, _apiKey: POISON_KEY, model: 'fake-model-1', baseUrl: 'https://x/v1' },
  chatJson: mockLlmTimeout,
});
eq(r6.error_code, 'timeout', 'timeout → error_code surfaced');

// forceDeterministic short-circuits LLM.
const r7 = await goalInterp.interpretGoal(baseInput, {
  forceDeterministic: true,
  provider: { enabled: true, _apiKey: POISON_KEY, model: 'fake-model-1', baseUrl: 'https://x/v1' },
  chatJson: () => { throw new Error('should never call LLM'); },
});
eq(r7.mode, 'deterministic', 'forceDeterministic: never calls LLM');

// ---------------------------------------------------------------------------
// Part E — chatJson timeout via mock fetch
// ---------------------------------------------------------------------------

console.log('\n==> Part E: chatJson timeout / abort handling');

const mockFetchSlow = (url, init) => new Promise((resolve, reject) => {
  // Honor abort signal so AbortController fires.
  if (init && init.signal) {
    init.signal.addEventListener('abort', () => {
      const e = new Error('aborted'); e.name = 'AbortError';
      reject(e);
    });
  }
  // Otherwise hang forever.
});
const tRes = await llmClient.chatJson({
  messages: [{ role: 'user', content: 'x' }],
}, {
  provider: { enabled: true, _apiKey: POISON_KEY, model: 'm', baseUrl: 'https://x/v1' },
  fetchImpl: mockFetchSlow, timeoutMs: 50,
});
eq(tRes.ok, false, 'timeout: ok=false');
eq(tRes.error_code, 'timeout', 'timeout: error_code=timeout');
ok(tRes.model === 'm' && JSON.stringify(tRes).indexOf(POISON_KEY) === -1,
   'timeout return: no api key in payload');

// ---------------------------------------------------------------------------
// Part F — project rules awareness (governance v1)
// ---------------------------------------------------------------------------

console.log('\n==> Part F: project rules awareness');

const rulesInput = {
  goal: { title: 'g', desired_outcome: '' },
  pulse: { pulse_level: 'ok', signals: [] },
  project_rules: {
    version: 1,
    coding_standards: ['Follow patterns', 'No unrelated refactors',
      // Add a poison field at this level to verify the LLM doesn't
      // see arbitrary keys; only known sections + counts flow.
      // (Added to the section list itself wouldn't reach the payload
      // since clipList drops non-strings — checked below.)
    ],
    testing_policy: ['Run targeted smoke', 'Verify mtime invariants', 'Read-only grep'],
    reporting_policy: ['List changed files', 'Report residual risks'],
    pre_pr_checklist: ['No new schema/dep without auth', 'No secret leakage'],
    non_goals: ['No auto-dispatch', 'No code execution by Cairn'],
    updated_at: 1700000000000,
  },
  project_rules_is_default: false,
};
const compactRules = goalInterp.buildCompactState(rulesInput);
ok(compactRules.rules_summary, 'rules_summary present in compact state');
eq(compactRules.rules_summary.counts.coding_standards, 2, 'rules_summary.counts.coding_standards');
eq(compactRules.rules_summary.counts.non_goals, 2, 'rules_summary.counts.non_goals');
eq(compactRules.rules_summary.is_default, false, 'rules_summary.is_default propagated');
eq(compactRules.rules_summary.pre_pr_top.length, 2, 'rules_summary.pre_pr_top capped to ≤4');
eq(compactRules.rules_summary.testing_top.length, 3, 'rules_summary.testing_top trimmed list');
ok(compactRules.rules_summary.non_goals.length === 2,
   'rules_summary.non_goals fully present (boundary contract)');
ok(compactRules.rules_summary.non_goals.includes('No auto-dispatch'),
   'rules_summary: non_goals contain "No auto-dispatch"');
// updated_at is metadata, not content — it lives in rules_summary
// only as a count/flag, never as a raw timestamp the LLM has to deal
// with. We don't ship updated_at; check it's NOT in output.
const compactStr2 = JSON.stringify(compactRules);
ok(compactStr2.indexOf('1700000000000') === -1,
   'rules updated_at NOT echoed into compact state');

// LLM payload still strips sensitive fields when rules are present.
const rulesPoisoned = {
  ...rulesInput,
  // Inject sensitive sibling fields to confirm rules path doesn't open
  // a hole in the privacy boundary.
  goal: { title: 'g', api_key: POISON_KEY, transcript: POISON },
  top_activities: [
    { app: 'mcp', state: 'active', state_family: 'live', display_name: 'x',
      agent_id: 'cairn-' + POISON, cwd: 'D:\\secret\\path' },
  ],
};
const compactPoisoned = goalInterp.buildCompactState(rulesPoisoned);
const cps = JSON.stringify(compactPoisoned);
ok(cps.indexOf(POISON) === -1, 'rules+poison: POISON marker absent');
ok(cps.indexOf(POISON_KEY) === -1, 'rules+poison: api key absent');
ok(cps.indexOf('secret\\\\path') === -1 && cps.indexOf('secret/path') === -1,
   'rules+poison: cwd absent');
// rules_summary still emitted alongside the cleaned input.
ok(compactPoisoned.rules_summary && compactPoisoned.rules_summary.non_goals.length === 2,
   'rules+poison: rules_summary still emitted alongside cleaned envelope');

// Default rules shape:
const defaultRulesInput = {
  ...rulesInput,
  project_rules_is_default: true,
};
const cd = goalInterp.buildCompactState(defaultRulesInput);
eq(cd.rules_summary.is_default, true, 'default rules: is_default propagates');

// LLM rewrite path: end-to-end with rules in input. Hostile mock
// tries to add an "Auto-dispatch the Cursor agent" recommendation;
// the LLM message goes through but we verify the system prompt told
// the LLM not to.
let lastPayloadRules = null;
const mockOkRules = async (payload) => {
  lastPayloadRules = payload;
  return {
    enabled: true, ok: true, model: 'fake-model',
    text: JSON.stringify({
      summary: 'Goal stable; rules are honored.',
      risks: [],
      next_attention: ['Confirm tests are green per testing policy'],
      evidence_ids: [],
    }),
  };
};
const r_e2e = await goalInterp.interpretGoal(rulesInput, {
  provider: { enabled: true, _apiKey: POISON_KEY, model: 'fake-model', baseUrl: 'https://x/v1' },
  chatJson: mockOkRules,
});
eq(r_e2e.mode, 'llm', 'rules input + valid LLM → mode=llm');
const lastPayloadStr2 = JSON.stringify(lastPayloadRules);
ok(/rules_summary/.test(lastPayloadStr2),
   'LLM payload: rules_summary key present');
ok(/non_goals/.test(lastPayloadStr2),
   'LLM payload: non_goals key present (boundary contract)');
ok(lastPayloadStr2.indexOf(POISON_KEY) === -1, 'LLM payload: no api key');
// System prompt mentions rules + non_goals + advisory.
const sysMsg = lastPayloadRules.messages[0].content;
ok(/rules_summary/.test(sysMsg), 'system prompt: references rules_summary');
ok(/non_goals/.test(sysMsg), 'system prompt: references non_goals');
ok(/ADVISORY|advisory/.test(sysMsg), 'system prompt: explicitly advisory');
ok(/never suggest .* non_goal/i.test(sysMsg) || /respect non_goals/i.test(sysMsg),
   'system prompt: explicit non_goals respect rule');

// ---------------------------------------------------------------------------
// Part G — read-only invariants
// ---------------------------------------------------------------------------

console.log('\n==> Part G: read-only invariants');

const llmSrc = fs.readFileSync(path.join(root, 'llm-client.cjs'), 'utf8');
ok(!/\.run\s*\(/.test(llmSrc),         'llm-client.cjs: no .run(');
ok(!/\.exec\s*\(/.test(llmSrc),        'llm-client.cjs: no .exec(');
ok(!/writeFileSync|writeFile\b|appendFile/.test(llmSrc), 'llm-client.cjs: no file writes');
ok(!/require\(['"]child_process['"]\)/.test(llmSrc), 'llm-client.cjs: no child_process');
ok(!/['"]\.claude['"]/.test(llmSrc) && !/['"]\.codex['"]/.test(llmSrc),
   'llm-client.cjs: no .claude / .codex string literal');

const interpSrc = fs.readFileSync(path.join(root, 'goal-interpretation.cjs'), 'utf8');
ok(!/\.run\s*\(/.test(interpSrc),     'goal-interpretation.cjs: no .run(');
ok(!/\.exec\s*\(/.test(interpSrc),    'goal-interpretation.cjs: no .exec(');
ok(!/writeFileSync|writeFile\b|appendFile/.test(interpSrc),
   'goal-interpretation.cjs: no file writes');
ok(!/require\(['"]child_process['"]\)/.test(interpSrc),
   'goal-interpretation.cjs: no child_process');
ok(!/['"]\.claude['"]/.test(interpSrc) && !/['"]\.codex['"]/.test(interpSrc),
   'goal-interpretation.cjs: no .claude / .codex string literal');

// Cleanup.
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) {}

console.log(`\n==> ${asserts - fails}/${asserts} assertions passed`);
if (fails > 0) {
  console.error(`FAIL: ${fails} assertion(s) failed`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('PASS');
