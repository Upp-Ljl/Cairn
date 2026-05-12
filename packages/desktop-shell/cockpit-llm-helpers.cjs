'use strict';

/**
 * Cockpit LLM helpers — Phase 6 of panel-cockpit-redesign.
 *
 * Auxiliary LLM hooks per plan decisions #10 / §1.3.cockpit (PoC-3 boundary
 * correction memory): Cairn's internal LLM is OK for auxiliary提效 tasks
 * (summarize / explain / sort / coach), NOT for strategic decisions
 * (those still go via the external leader coding agent).
 *
 * Four helpers locked in plan Round 7:
 *
 *   1. tail.log → 3-sentence summary           (low-cost,  default ON)
 *   2. conflict / blocker diff one-liner        (low-cost,  default ON)
 *   3. inbox smart sort + rationale             (high-cost, default OFF)
 *   4. goal input assist (for non-developers)   (high-cost, default OFF)
 *
 * Phase 6 deliverable: helpers 1 + 2 fully wired; 3 + 4 stubbed with
 * the same shape so future phases can plug in the actual prompts.
 *
 * All helpers are GATED by the per-project cockpit_settings.llm_helpers
 * flag, plus the global provider availability check from llm-client.cjs.
 * If gating fails, the helper returns
 *   { ok:false, reason: 'disabled' | 'no_provider' | 'no_input' }
 * without making any network call.
 */

const path = require('node:path');
const llmClient = require('./llm-client.cjs');

// ---------------------------------------------------------------------------
// Shared invocation primitive
// ---------------------------------------------------------------------------

/**
 * Run an LLM helper with a budget. Each helper supplies a system
 * prompt + user prompt + max_tokens; this function returns a uniform
 * result struct.
 */
async function runHelper(input, opts) {
  const o = opts || {};
  if (!input || !input.user) {
    return { ok: false, reason: 'no_input' };
  }
  const payload = {
    model: o.model || 'cheap',
    messages: [
      { role: 'system', content: input.system || 'You are a terse code assistant. No prose; answer in 3 sentences max.' },
      { role: 'user', content: input.user },
    ],
    max_tokens: o.maxTokens || 400,
    temperature: o.temperature !== undefined ? o.temperature : 0.2,
  };
  const res = await llmClient.chatJson(payload, {
    provider: o.provider,
    fetchImpl: o.fetchImpl,
    timeoutMs: o.timeoutMs,
    keysFile: o.keysFile,
  });
  if (!res.enabled) return { ok: false, reason: 'no_provider', detail: res.error_code };
  if (!res.ok) return { ok: false, reason: 'llm_failed', detail: res.error_code, raw: res.raw };
  // llm-client.chatJson returns the model output under `text`.
  const content = (res.text || res.content || '').toString().trim();
  return {
    ok: true,
    content,
    model: res.model || payload.model,
  };
}

// ---------------------------------------------------------------------------
// Helper 1 — tail.log → 3-sentence summary (low-cost, default ON)
// ---------------------------------------------------------------------------

function tailSummaryPrompt(runId, tailText) {
  return {
    system:
      'You are a terse assistant. Given a worker tail.log, return EXACTLY 3 lines:\n' +
      '  did:   <≤80 chars one-line summary of what the agent accomplished>\n' +
      '  stuck: <≤80 chars one-line summary of where it got stuck (or "no blockers")>\n' +
      '  next:  <≤80 chars one-line suggested next step>\n' +
      'No prose, no markdown, just those three lines.',
    user: `Worker run ${runId} tail.log (most recent first if truncated):\n\n${tailText.slice(-6000)}`,
  };
}

async function summarizeTail(input, opts) {
  if (!input || !input.tail || !input.tail.trim()) {
    return { ok: false, reason: 'no_input' };
  }
  if (input.enabled === false) return { ok: false, reason: 'disabled' };
  const prompts = tailSummaryPrompt(input.run_id || '<unknown>', input.tail);
  return await runHelper(prompts, Object.assign({ maxTokens: 200 }, opts));
}

// ---------------------------------------------------------------------------
// Helper 2 — conflict / blocker one-liner (low-cost, default ON)
// ---------------------------------------------------------------------------

function conflictExplanationPrompt(input) {
  const paths = (input.paths || []).join(', ');
  return {
    system:
      'You are a terse assistant. Given a conflict between two agents on the same file(s), ' +
      'write ONE sentence (≤120 chars) explaining the divergence + ONE sentence suggesting how to merge. ' +
      'Format:\n  what: <one line>\n  merge: <one line>\nNo prose, no markdown.',
    user:
      `Conflict on: ${paths}\n` +
      `Agent A diff (excerpt):\n${(input.diff_a || '').slice(0, 1500)}\n\n` +
      `Agent B diff (excerpt):\n${(input.diff_b || '').slice(0, 1500)}\n\n` +
      `Existing summary: ${input.summary || '(none)'}`,
  };
}

async function explainConflict(input, opts) {
  if (!input || (!input.diff_a && !input.diff_b && !input.summary)) {
    return { ok: false, reason: 'no_input' };
  }
  if (input.enabled === false) return { ok: false, reason: 'disabled' };
  const prompts = conflictExplanationPrompt(input);
  return await runHelper(prompts, Object.assign({ maxTokens: 250 }, opts));
}

// ---------------------------------------------------------------------------
// Helper 3 — inbox smart sort + rationale (high-cost, default OFF)
// ---------------------------------------------------------------------------

function inboxSortPrompt(input) {
  const itemSummaries = (input.items || []).map((it, i) =>
    `[${i}] kind=${it.kind} body=${(it.body || '').slice(0, 200)}`
  ).join('\n');
  return {
    system:
      'You are a terse triage assistant. Given a list of inbox items, return JSON ONLY:\n' +
      '  { "order": [<indexes in suggested order>], "reasons": { "<index>": "<≤80 char reason>" } }\n' +
      'No prose, no markdown, just the JSON.',
    user:
      `Project goal: ${input.goal || '(none)'}\n\n` +
      `Inbox items:\n${itemSummaries}`,
  };
}

async function sortInbox(input, opts) {
  if (!input || !input.items || input.items.length === 0) {
    return { ok: false, reason: 'no_input' };
  }
  if (input.enabled === false) return { ok: false, reason: 'disabled' };
  const prompts = inboxSortPrompt(input);
  const r = await runHelper(prompts, Object.assign({ maxTokens: 600, temperature: 0.1 }, opts));
  if (!r.ok) return r;
  // Try to parse JSON from content; fall back gracefully.
  try {
    const first = r.content.indexOf('{');
    const last = r.content.lastIndexOf('}');
    if (first >= 0 && last > first) {
      const parsed = JSON.parse(r.content.slice(first, last + 1));
      if (Array.isArray(parsed.order)) {
        return { ok: true, order: parsed.order, reasons: parsed.reasons || {}, model: r.model };
      }
    }
  } catch (_e) {}
  return { ok: false, reason: 'parse_failed', raw: r.content };
}

// ---------------------------------------------------------------------------
// Helper 4 — goal input assist (high-cost, default OFF)
// ---------------------------------------------------------------------------

function goalAssistPrompt(input) {
  return {
    system:
      'You are a gentle coach helping a user (possibly non-developer) clarify a project goal. ' +
      'Given a vague description, return EXACTLY this JSON shape:\n' +
      '  { "sharpened_goal": "<concrete one-sentence goal>", "questions": ["<≤80 char clarifying q>", ...up to 3] }\n' +
      'No prose, no markdown.',
    user:
      `Project root file listing (excerpt):\n${(input.files || []).slice(0, 30).join('\n')}\n\n` +
      `User's rough idea: "${input.rough_idea || ''}"`,
  };
}

async function assistGoal(input, opts) {
  if (!input || !input.rough_idea) {
    return { ok: false, reason: 'no_input' };
  }
  if (input.enabled === false) return { ok: false, reason: 'disabled' };
  const prompts = goalAssistPrompt(input);
  const r = await runHelper(prompts, Object.assign({ maxTokens: 500 }, opts));
  if (!r.ok) return r;
  try {
    const first = r.content.indexOf('{');
    const last = r.content.lastIndexOf('}');
    if (first >= 0 && last > first) {
      const parsed = JSON.parse(r.content.slice(first, last + 1));
      if (parsed.sharpened_goal) {
        return {
          ok: true,
          sharpened_goal: parsed.sharpened_goal,
          questions: Array.isArray(parsed.questions) ? parsed.questions : [],
          model: r.model,
        };
      }
    }
  } catch (_e) {}
  return { ok: false, reason: 'parse_failed', raw: r.content };
}

module.exports = {
  runHelper,
  summarizeTail,
  explainConflict,
  sortInbox,
  assistGoal,
  // exported for tests
  tailSummaryPrompt,
  conflictExplanationPrompt,
  inboxSortPrompt,
  goalAssistPrompt,
};
