#!/usr/bin/env node
/**
 * smoke-cockpit-llm-helpers.mjs — Phase 6 of panel-cockpit-redesign.
 *
 * Covers:
 *   - cockpit settings shape + defaults
 *   - setCockpitSettings deep-merge + leader validation
 *   - 4 LLM helpers (gated by enabled flag + provider availability)
 *   - prompt shape helpers exist + take expected inputs
 *
 * Uses a fake fetch + fake provider so we don't actually hit a network.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dsRoot = path.resolve(__dirname, '..');

const registry = require(path.join(dsRoot, 'registry.cjs'));
const helpers = require(path.join(dsRoot, 'cockpit-llm-helpers.cjs'));

let asserts = 0, fails = 0;
const failures = [];
function ok(c, l) {
  asserts++;
  if (c) process.stdout.write(`  ok    ${l}\n`);
  else   { fails++; failures.push(l); process.stdout.write(`  FAIL  ${l}\n`); }
}
function header(t) { process.stdout.write(`\n${'='.repeat(56)}\n${t}\n${'='.repeat(56)}\n`); }
function section(t) { process.stdout.write(`\n[${t}]\n`); }

header('smoke-cockpit-llm-helpers — Phase 6');

// ---------------------------------------------------------------------------
// 1 — settings defaults + getter
// ---------------------------------------------------------------------------
section('1 settings defaults');
const reg0 = { projects: [{ id: 'p_a', label: 'a', project_root: '/a', db_path: '/db', agent_id_hints: [] }] };
const s0 = registry.getCockpitSettings(reg0, 'p_a');
ok(s0.leader === 'claude-code', 'default leader = claude-code');
ok(s0.llm_helpers.tail_summary_enabled === true, 'tail_summary default ON');
ok(s0.llm_helpers.conflict_explainer_enabled === true, 'conflict_explainer default ON');
ok(s0.llm_helpers.inbox_smart_sort_enabled === false, 'inbox_smart_sort default OFF');
ok(s0.llm_helpers.goal_input_assist_enabled === false, 'goal_input_assist default OFF');
ok(s0.escalation_thresholds.error_nudge_cap === 2, 'default error_nudge_cap = 2');

// ---------------------------------------------------------------------------
// 2 — setCockpitSettings deep-merge + leader validation
// ---------------------------------------------------------------------------
section('2 setCockpitSettings');
const set1 = registry.setCockpitSettings(reg0, 'p_a', {
  leader: 'cursor',
  llm_helpers: { goal_input_assist_enabled: true },
});
ok(set1.reg, 'set returns reg');
ok(set1.settings.leader === 'cursor', 'leader updated');
ok(set1.settings.llm_helpers.goal_input_assist_enabled === true, 'flag updated');
// Other defaults preserved
ok(set1.settings.llm_helpers.tail_summary_enabled === true, 'other flags preserved (tail_summary)');
ok(set1.settings.escalation_thresholds.error_nudge_cap === 2, 'thresholds preserved');

const setBadLeader = registry.setCockpitSettings(reg0, 'p_a', { leader: 'fake-leader' });
ok(setBadLeader.error === 'unknown_leader: fake-leader', 'unknown leader rejected');

const setNoProj = registry.setCockpitSettings(reg0, 'p_does_not_exist', { leader: 'cursor' });
ok(setNoProj.error === 'project_not_found', 'missing project flagged');

// ---------------------------------------------------------------------------
// 3 — helper gating: disabled + no_input
// ---------------------------------------------------------------------------
section('3 helper gating');
const r_dis = await helpers.summarizeTail({ enabled: false, tail: 'log content' });
ok(r_dis.ok === false && r_dis.reason === 'disabled', 'disabled flag short-circuits');

const r_empty = await helpers.summarizeTail({ enabled: true, tail: '' });
ok(r_empty.ok === false && r_empty.reason === 'no_input', 'empty tail flagged');

const r_conflict_empty = await helpers.explainConflict({ enabled: true });
ok(r_conflict_empty.ok === false && r_conflict_empty.reason === 'no_input', 'empty conflict input flagged');

// ---------------------------------------------------------------------------
// 4 — helper prompts have expected shape (no network call)
// ---------------------------------------------------------------------------
section('4 prompt shapes');
const ts = helpers.tailSummaryPrompt('wr_123', 'agent did X\nthen Y\nfailed at Z\n');
ok(ts.system && ts.system.includes('3 lines'), 'tail summary system specifies 3 lines');
ok(ts.user && ts.user.includes('wr_123'), 'tail summary user includes run_id');

const cp = helpers.conflictExplanationPrompt({ paths: ['a.ts', 'b.ts'], diff_a: 'A1', diff_b: 'B1' });
ok(cp.system && /one sentence/i.test(cp.system), 'conflict prompt mentions one sentence');
ok(cp.user && cp.user.includes('a.ts, b.ts'), 'conflict prompt includes paths');

const sp = helpers.inboxSortPrompt({ items: [{ kind: 'conflict', body: 'x' }, { kind: 'task', body: 'y' }], goal: 'G' });
ok(sp.system && sp.system.includes('JSON'), 'inbox sort prompt asks for JSON');
ok(sp.user && sp.user.includes('Project goal: G'), 'inbox sort prompt includes goal');

const gp = helpers.goalAssistPrompt({ rough_idea: 'something poker', files: ['a.ts', 'b.ts'] });
ok(gp.system && gp.system.includes('sharpened_goal'), 'goal assist asks for sharpened_goal');
ok(gp.user && gp.user.includes('something poker'), 'goal assist includes rough idea');

// ---------------------------------------------------------------------------
// 5 — runHelper with stub provider + fetch (verifies invocation shape)
// ---------------------------------------------------------------------------
section('5 stub provider invocation');
const fakeProvider = {
  enabled: true,
  model: 'fake-haiku',
  baseUrl: 'https://example.invalid/v1',
  _apiKey: 'stub-key',
};
let capturedBody = null;
const fakeFetch = async (_url, opts) => {
  capturedBody = JSON.parse(opts.body);
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: 'did:   wrote tests\nstuck: no blockers\nnext:  add equity.ts' } }],
      model: 'fake-haiku',
    }),
  };
};
const r_inv = await helpers.runHelper(
  { system: 'sys', user: 'user' },
  { provider: fakeProvider, fetchImpl: fakeFetch },
);
ok(r_inv.ok === true, `runHelper completed with stub fetch (reason=${r_inv.reason || 'ok'})`);
ok(capturedBody && Array.isArray(capturedBody.messages), 'payload has messages array');
if (capturedBody) {
  ok(capturedBody.messages.length === 2, '2 messages (system + user)');
  ok(capturedBody.messages[0].role === 'system', 'first message is system');
  ok(capturedBody.messages[1].role === 'user', 'second message is user');
}
ok(r_inv.content && r_inv.content.includes('wrote tests'), `runHelper returns text content`);

header(`${asserts - fails}/${asserts} assertions passed (${fails} failed)`);
if (fails) {
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
  process.exit(1);
}
process.exit(0);
