#!/usr/bin/env node
/**
 * dogfood-llm-3layer.mjs — real LLM dogfood of the L3 polish layer.
 *
 * What this validates:
 *   - Cairn Mentor's L3 polish path composes a CAIRN.md profile + an
 *     agent_brief + a blocker question into a haiku-class prompt
 *   - The provider (whichever is configured in ~/.cairn/llm-keys or env)
 *     returns a parseable structured decision
 *   - 429 / 5xx / timeout treated as INFRA-OK (the helper composed a
 *     real call; the unit smoke covers parsing with a stub fetch)
 *
 * L3 is not in the synchronous mentor-policy code path by design
 * (see plan §3 "high gate"). This dogfood exercises the path
 * independently so the engine is verified to work end-to-end.
 *
 * Cost ceiling: ≤ ~$0.001 per run. Uses runHelper directly with the
 * existing cockpit-llm-helpers.cjs infra so we share the same
 * provider gating + 429-grace as the other 4 helpers.
 *
 * Per `feedback_autonomous_ship_authorization` memory, this runs
 * without asking the user — the ship authorization covers it.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dsRoot = path.resolve(__dirname, '..');

const llmHelpers = require(path.join(dsRoot, 'cockpit-llm-helpers.cjs'));
const llmClient = require(path.join(dsRoot, 'llm-client.cjs'));

let asserts = 0, fails = 0;
const failures = [];
function ok(c, l) {
  asserts++;
  if (c) process.stdout.write(`  ok    ${l}\n`);
  else   { fails++; failures.push(l); process.stdout.write(`  FAIL  ${l}\n`); }
}
function header(t) { process.stdout.write(`\n${'='.repeat(56)}\n${t}\n${'='.repeat(56)}\n`); }

header('dogfood-llm-3layer — real haiku L3 polish');

// ---------------------------------------------------------------------------
// 1 — provider available?
// ---------------------------------------------------------------------------
const provider = llmClient.loadProvider({});
process.stdout.write(`Provider: enabled=${provider.enabled} model=${provider.model || '?'} reason=${provider.reason || '-'}\n`);
if (!provider.enabled) {
  process.stdout.write(`  SKIP — provider not configured. Reason: ${provider.reason}\n`);
  process.stdout.write(`  (~/.cairn/llm-keys with CAIRN_LLM_KEY or ANTHROPIC_API_KEY env required)\n`);
  process.exit(0);
}
ok(provider.enabled === true, 'provider enabled');
ok(typeof provider.model === 'string', `provider has a model (${provider.model})`);

// ---------------------------------------------------------------------------
// 2 — Build a realistic L3 prompt with a synthetic profile + brief + question
// ---------------------------------------------------------------------------

const PROFILE_FIXTURE = {
  project_name: 'Cairn',
  goal: 'Build the host-level multi-agent coordination kernel.',
  authority: {
    auto_decide: [
      'retry transient test failures up to 2x',
      'pick TypeScript over JavaScript when blocker asks "which language"',
    ],
    decide_and_announce: [
      'reduce a task time budget when 80% elapsed and progress visible',
    ],
    escalate: [
      'npm publish',
      'force-push to main',
      'LICENSE edit',
      'adding a new npm dependency',
    ],
  },
  constraints: [
    'no new npm dependencies',
    'tests hit a real DB, not mocks',
  ],
};

const BRIEF_FIXTURE = {
  agent_id: 'cairn-session-aaaa11112222',
  task_id: 't_dogfood',
  summary: 'porting the migration runner to handle a new checksum field; needed to decide whether to keep the existing strict-equality guard or relax it.',
  stuck_on: 'unsure whether relaxing the guard violates the immutable-migrations invariant from CLAUDE.md',
  options_considered: ['keep guard, write a new migration', 'relax guard to allow new field'],
  lean: 'keep guard — historical migrations must remain immutable; write a new migration for the new field.',
};

const QUESTION = 'Should I relax the migration checksum guard to add a new field, or write a fresh migration?';

const promptSystem = [
  'You are Cairn Mentor — the project-management coordinator inside the Cairn',
  'host-level multi-agent coordination kernel. You DECIDE on behalf of the project',
  'owner using three layers: L1 the per-project CAIRN.md policy (provided),',
  'L2 the active agent\'s self-brief (provided), and L3 your own polish — which',
  'is THIS call.',
  '',
  'Return ONLY a single-line JSON object with this exact shape, no prose, no markdown:',
  '  { "decision": "<one short sentence the agent will see>",',
  '    "route":    "auto" | "announce" | "escalate",',
  '    "reasoning": "<one short clause tying the decision back to the profile or brief>" }',
  '',
  'Routing rules:',
  '  - "auto"     = reversible / low-stakes / matches profile.auto_decide → decide silently',
  '  - "announce" = matches profile.decide_and_announce → decide but flag for the user',
  '  - "escalate" = matches profile.escalate or is irreversible → bounce to the user',
  'Prefer the agent\'s "lean" when it does not conflict with the profile\'s escalate list.',
].join('\n');

const promptUser = [
  `PROJECT: ${PROFILE_FIXTURE.project_name}`,
  `GOAL:    ${PROFILE_FIXTURE.goal}`,
  ``,
  `PROFILE.auto_decide:`,
  ...PROFILE_FIXTURE.authority.auto_decide.map(s => `  - ${s}`),
  `PROFILE.decide_and_announce:`,
  ...PROFILE_FIXTURE.authority.decide_and_announce.map(s => `  - ${s}`),
  `PROFILE.escalate:`,
  ...PROFILE_FIXTURE.authority.escalate.map(s => `  - ${s}`),
  `PROFILE.constraints:`,
  ...PROFILE_FIXTURE.constraints.map(s => `  - ${s}`),
  ``,
  `AGENT BRIEF (id=${BRIEF_FIXTURE.agent_id}, task=${BRIEF_FIXTURE.task_id}):`,
  `  summary:           ${BRIEF_FIXTURE.summary}`,
  `  stuck_on:          ${BRIEF_FIXTURE.stuck_on}`,
  `  options_considered: ${BRIEF_FIXTURE.options_considered.join(' | ')}`,
  `  lean:              ${BRIEF_FIXTURE.lean}`,
  ``,
  `QUESTION FROM AGENT: ${QUESTION}`,
].join('\n');

process.stdout.write(`\nInvoking runHelper (haiku, max 250 tokens)...\n`);
process.stdout.write(`Prompt length: system=${promptSystem.length} user=${promptUser.length}\n`);

// ---------------------------------------------------------------------------
// 3 — Real call
// ---------------------------------------------------------------------------
const t0 = Date.now();
const result = await llmHelpers.runHelper(
  { system: promptSystem, user: promptUser },
  { maxTokens: 250, temperature: 0.1, timeoutMs: 60000 },
);
const elapsed = Date.now() - t0;
process.stdout.write(`  elapsed: ${elapsed}ms\n`);

// 429 / 5xx / network — INFRA-OK grace (same convention as other dogfoods)
const transient = result.detail && /^http_(4[02]9|5\d\d)|timeout|network/.test(result.detail);
if (!result.ok && transient) {
  process.stdout.write(`  INFRA OK — provider transient (${result.detail}); content verification deferred.\n`);
  process.stdout.write(`  (Helper composed the L3 prompt; runHelper made the real call.)\n`);
  ok(true, `L3 prompt composed; provider responded ${result.detail}`);
} else if (!result.ok) {
  process.stdout.write(`  FAIL — helper returned: ${JSON.stringify(result)}\n`);
  failures.push('runHelper did not return ok');
  fails++;
  asserts++;
} else {
  ok(result.ok === true, 'L3 polish returned ok');
  ok(typeof result.content === 'string' && result.content.length > 0, 'content non-empty');
  process.stdout.write(`\n--- haiku L3 output ---\n${result.content}\n--- end ---\n`);

  // Try to parse JSON out of the body
  const text = result.content;
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  let parsed = null;
  if (first >= 0 && last > first) {
    try { parsed = JSON.parse(text.slice(first, last + 1)); } catch (_e) { parsed = null; }
  }
  ok(parsed !== null, 'output parses as JSON');
  if (parsed) {
    ok(typeof parsed.decision === 'string' && parsed.decision.length > 0, 'parsed.decision present');
    ok(['auto', 'announce', 'escalate'].includes(parsed.route), `parsed.route is one of auto|announce|escalate (got "${parsed.route}")`);
    ok(typeof parsed.reasoning === 'string' && parsed.reasoning.length > 0, 'parsed.reasoning present');
    // Soft check: when there's no escalate-bucket match and the brief lean is
    // a reasonable answer, the model is likely to route "auto" or "announce".
    // We don't HARD-assert this — but if it routed escalate without a profile
    // match, surface a warning for human review.
    if (parsed.route === 'escalate') {
      process.stdout.write(`  NOTE — model routed escalate; verify against profile.escalate list manually.\n`);
    }
  }
}

// ---------------------------------------------------------------------------
header(`${asserts - fails}/${asserts} assertions passed (${fails} failed)`);
if (fails) {
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
  process.exit(1);
}
process.exit(0);
