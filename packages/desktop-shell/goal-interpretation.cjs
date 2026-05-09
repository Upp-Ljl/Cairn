'use strict';

/**
 * Goal Interpretation v1 — advisory layer over Goal + Project Pulse +
 * AgentActivity + tasks/blockers/outcomes/checkpoints summaries.
 *
 * Two modes:
 *
 *   deterministic — a pure function over the inputs; never calls an
 *                   LLM. Returned when no provider is configured, when
 *                   the LLM call fails, or when the LLM body fails to
 *                   JSON-parse against our schema. Always available.
 *
 *   llm           — an LLM rephrases the deterministic finding (and
 *                   adds "watch for" risk language) given a TIGHTLY
 *                   SCOPED state envelope. The LLM does NOT receive
 *                   any raw transcript, prompt, tool args, command
 *                   output, agent_id, session_id, cwd path, or env.
 *                   The system prompt explicitly bans recommending
 *                   agent actions or claiming completion without
 *                   evidence.
 *
 * Output shape:
 *
 *   {
 *     mode:           'deterministic' | 'llm',
 *     summary:        string (2-4 sentences),
 *     risks:          [{ kind, severity, title, detail }],
 *     next_attention: string[]   (things the human should look at)
 *     evidence_ids:   string[]   (signal kinds / report ids referenced)
 *     generated_at:   unix ms,
 *     model:          string?    (only on llm mode)
 *     error_code:     string?    (only when llm path failed; for diag)
 *   }
 *
 * Read-only: no I/O outside the (optional) outbound LLM HTTP call.
 */

const llmClient = require('./llm-client.cjs');

// ---------------------------------------------------------------------------
// State sanitization
// ---------------------------------------------------------------------------
//
// What we send to the LLM is intentionally smaller than what the panel
// shows. Anything that could leak prompt text, code, file paths
// outside the project root, or PII is stripped here — the system
// prompt below is also a defense in depth, but the data shape is the
// real boundary.

const STR_TITLE_MAX     = 200;
const STR_DETAIL_MAX    = 400;
const STR_DESCR_MAX     = 800;
const LIST_SHORT_MAX    = 8;
const ACTIVITIES_MAX    = 6;
const REPORTS_MAX       = 3;

function clip(s, max) {
  if (typeof s !== 'string') return '';
  const t = s.trim();
  return t.length > max ? t.slice(0, max) : t;
}
function clipList(xs, maxItems, maxLen) {
  if (!Array.isArray(xs)) return [];
  const out = [];
  for (const x of xs) {
    if (out.length >= maxItems) break;
    const t = clip(x, maxLen);
    if (t) out.push(t);
  }
  return out;
}

/**
 * Build the compact state envelope the LLM will see. Cross-checked
 * by the smoke's POISON marker test: nothing here may carry agent_id,
 * session_id, raw cwd path, capability tag list, or any field name
 * we know to be sensitive.
 */
function buildCompactState(input) {
  const o = input || {};
  const goal = o.goal ? {
    title:            clip(o.goal.title,           STR_TITLE_MAX),
    desired_outcome:  clip(o.goal.desired_outcome, STR_DESCR_MAX),
    success_criteria: clipList(o.goal.success_criteria, LIST_SHORT_MAX, STR_TITLE_MAX),
    non_goals:        clipList(o.goal.non_goals,        LIST_SHORT_MAX, STR_TITLE_MAX),
  } : null;

  const pulse = o.pulse ? {
    level: o.pulse.pulse_level || 'ok',
    signals: (Array.isArray(o.pulse.signals) ? o.pulse.signals : [])
      .slice(0, LIST_SHORT_MAX)
      .map(s => ({
        kind: clip(s && s.kind, 60),
        severity: clip(s && s.severity, 20),
        title: clip(s && s.title, STR_TITLE_MAX),
        // Detail strings sometimes contain numeric counts / minutes
        // — those are safe. They never contain user content. Still,
        // truncate hard to discourage prompt-shaped abuse.
        detail: clip(s && s.detail, STR_DETAIL_MAX),
      })),
  } : null;

  const activitySummary = o.activity_summary ? {
    total: o.activity_summary.total | 0,
    by_family: Object.assign(
      { live:0, recent:0, inactive:0, dead:0, unknown:0 },
      o.activity_summary.by_family || {},
    ),
    by_app: Object.assign(
      { mcp:0, 'claude-code':0, codex:0 },
      o.activity_summary.by_app || {},
    ),
  } : null;

  // Per-activity entries: ONLY app + state + state_family + a short
  // display label. No agent_id, no cwd, no capability tags.
  const topActivities = (Array.isArray(o.top_activities) ? o.top_activities : [])
    .slice(0, ACTIVITIES_MAX)
    .map(a => ({
      app:          clip(a && a.app, 30),
      state:        clip(a && a.state, 30),
      state_family: clip(a && a.state_family, 30),
      // Display name is already the short, redacted form (e.g.
      // "claude:7f5b…") — we still cap it.
      display_name: clip(a && a.display_name, 30),
    }));

  const tasks = o.tasks_summary ? {
    running:        o.tasks_summary.running        | 0,
    blocked:        o.tasks_summary.blocked        | 0,
    waiting_review: o.tasks_summary.waiting_review | 0,
    failed:         o.tasks_summary.failed         | 0,
    done:           o.tasks_summary.done           | 0,
  } : null;

  const blockers = o.blockers_summary ? {
    open: o.blockers_summary.open | 0,
  } : null;

  const outcomes = o.outcomes_summary ? {
    failed:  o.outcomes_summary.failed  | 0,
    pending: o.outcomes_summary.pending | 0,
  } : null;

  const checkpoints = o.checkpoints_summary ? {
    total:           o.checkpoints_summary.total | 0,
    last_ready_ago_min: Number.isFinite(o.checkpoints_summary.last_ready_ago_min)
      ? Math.round(o.checkpoints_summary.last_ready_ago_min) : null,
  } : null;

  // Worker reports are summarized — only counts and titles, never
  // full report bodies (those may contain code snippets).
  const recent_reports = (Array.isArray(o.recent_reports) ? o.recent_reports : [])
    .slice(0, REPORTS_MAX)
    .map(r => ({
      title:            clip(r && r.title, STR_TITLE_MAX),
      completed_count:  Array.isArray(r && r.completed)  ? r.completed.length  : 0,
      remaining_count:  Array.isArray(r && r.remaining)  ? r.remaining.length  : 0,
      blocker_count:    Array.isArray(r && r.blockers)   ? r.blockers.length   : 0,
      next_steps_count: Array.isArray(r && r.next_steps) ? r.next_steps.length : 0,
      needs_human:      !!(r && r.needs_human),
    }));

  // Project rules summary (governance v1). Rules are user-authored
  // policy; we send them to the LLM so it can interpret state
  // against the user's constraints, but we cap each section's items
  // (top 4) to bound the payload. Counts always go through; sample
  // items go through truncated — the same width caps as goal fields.
  const rulesIn = o && o.project_rules;
  const rules_summary = rulesIn ? {
    counts: {
      coding_standards: Array.isArray(rulesIn.coding_standards) ? rulesIn.coding_standards.length : 0,
      testing_policy:   Array.isArray(rulesIn.testing_policy)   ? rulesIn.testing_policy.length   : 0,
      reporting_policy: Array.isArray(rulesIn.reporting_policy) ? rulesIn.reporting_policy.length : 0,
      pre_pr_checklist: Array.isArray(rulesIn.pre_pr_checklist) ? rulesIn.pre_pr_checklist.length : 0,
      non_goals:        Array.isArray(rulesIn.non_goals)        ? rulesIn.non_goals.length        : 0,
    },
    is_default: !!o.project_rules_is_default,
    pre_pr_top:    clipList(rulesIn.pre_pr_checklist, 4, STR_TITLE_MAX),
    testing_top:   clipList(rulesIn.testing_policy,   4, STR_TITLE_MAX),
    reporting_top: clipList(rulesIn.reporting_policy, 4, STR_TITLE_MAX),
    // non_goals are the most positioning-sensitive — send all of
    // them (already capped to ≤12 by registry); they're the LLM's
    // boundary contract.
    non_goals:     clipList(rulesIn.non_goals,        12, STR_TITLE_MAX),
  } : null;

  return {
    goal, pulse,
    activity_summary: activitySummary,
    top_activities: topActivities,
    tasks_summary: tasks,
    blockers_summary: blockers,
    outcomes_summary: outcomes,
    checkpoints_summary: checkpoints,
    recent_reports,
    rules_summary,
  };
}

// ---------------------------------------------------------------------------
// Deterministic interpretation (always available)
// ---------------------------------------------------------------------------

function deterministicInterpretation(state, opts) {
  const o = opts || {};
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const risks = [];
  const evidenceIds = [];
  const nextAttention = [];

  // Promote the pulse signals verbatim — they're already user-safe.
  const signals = (state.pulse && state.pulse.signals) || [];
  for (const s of signals) {
    if (s.kind) evidenceIds.push(s.kind);
    risks.push({
      kind:     s.kind,
      severity: s.severity || 'watch',
      title:    s.title,
      detail:   s.detail || '',
    });
  }

  // Add narrative summary.
  let summary;
  if (!state.goal) {
    summary = 'No goal set yet for this project. Set one to get focused interpretation; until then, Cairn surfaces raw activity and pulse signals only.';
    nextAttention.push('Set a project goal so future interpretations have an anchor.');
  } else {
    const t = state.goal.title;
    const pulseLv = (state.pulse && state.pulse.level) || 'ok';
    if (pulseLv === 'attention') {
      summary = `Goal "${t}" has open issues that need review (pulse=ATTENTION). ` +
        `${risks.filter(r => r.severity === 'attention').length} attention-level signal(s); ` +
        `${(state.blockers_summary && state.blockers_summary.open) || 0} open blocker(s).`;
    } else if (pulseLv === 'watch') {
      summary = `Goal "${t}" is progressing but has signals worth checking (pulse=WATCH). ` +
        `${risks.filter(r => r.severity === 'watch').length} watch-level signal(s).`;
    } else {
      summary = `Goal "${t}" — no open issues surfaced. ` +
        `Activity: ${(state.activity_summary && state.activity_summary.by_family.live) || 0} live, ` +
        `${(state.activity_summary && state.activity_summary.by_family.recent) || 0} recent.`;
    }
  }

  // Surface the top 3 signal titles as next-attention candidates.
  for (const r of risks.slice(0, 3)) nextAttention.push(r.title);

  // Recent reports: count remaining/blockers as next-attention prompts.
  for (const r of state.recent_reports || []) {
    if (r.blocker_count > 0) {
      nextAttention.push(`Worker report "${r.title}" lists ${r.blocker_count} blocker(s).`);
    } else if (r.needs_human) {
      nextAttention.push(`Worker report "${r.title}" flagged needs_human.`);
    }
  }

  return {
    mode: 'deterministic',
    summary,
    risks: risks.slice(0, 6),
    next_attention: nextAttention.slice(0, 5),
    evidence_ids: evidenceIds,
    generated_at: now,
  };
}

// ---------------------------------------------------------------------------
// LLM interpretation
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = [
  'You are an advisory observer for a local desktop tool called Cairn. Cairn is a project control surface, NOT a coding agent. Cairn does not write code, does not dispatch agents, does not decide when a task is complete.',
  '',
  'Your job: given the compact state of one project, produce a short observation that helps the human user notice what currently matters. You are NOT the decider.',
  '',
  'The input may include a `rules_summary` field — that is the user\'s own engineering policy for this project (coding standards, testing policy, reporting policy, Pre-PR checklist, non_goals). Treat rules as ADVISORY CONSTRAINTS, not as authority to execute. You should:',
  ' - read state through the lens of these rules (e.g. if testing_policy expects targeted smokes, note when no recent run is visible)',
  ' - respect non_goals: never suggest anything that crosses a non_goal',
  ' - never claim Cairn judges PR readiness or task completion based on rules — rules only inform what the human user should look at',
  '',
  'Hard rules:',
  ' - DO NOT recommend that any agent execute any specific code/task.',
  ' - DO NOT claim a task or goal is complete unless the input state explicitly says so.',
  ' - DO NOT invent facts not present in the input.',
  ' - DO reference signal kinds verbatim (open_blocker, failed_outcome, etc.) when they appear.',
  ' - Tone: observational, hedged. Use "worth checking" / "the user should look at" rather than imperatives directed at agents.',
  '',
  'Output: a single JSON object with exactly these fields:',
  '  summary:        2-4 sentence plain string',
  '  risks:          array of {kind, severity, title, detail} (severity is one of attention|watch|info)',
  '  next_attention: array of short strings the human should look at',
  '  evidence_ids:   array of signal kinds / report titles you cited',
  '',
  'No prose outside the JSON. No code fences.',
].join('\n');

async function llmInterpretation(state, opts) {
  const o = opts || {};
  const chatFn = o.chatJson || llmClient.chatJson;
  const userJson = JSON.stringify({ project_state: state });

  const result = await chatFn({
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user',   content: userJson },
    ],
    temperature: o.temperature != null ? o.temperature : 0.2,
    response_format: { type: 'json_object' },
  }, { provider: o.provider, fetchImpl: o.fetchImpl, timeoutMs: o.timeoutMs });

  if (!result.enabled) {
    return { __fallback: 'disabled', error_code: result.error_code };
  }
  if (!result.ok) {
    return { __fallback: 'llm_failed', error_code: result.error_code, model: result.model };
  }
  // Try to parse the body as JSON (even when response_format=json_object,
  // some providers wrap in fences). Strip fences if present.
  let text = result.text;
  const fenceMatch = text && text.match(/^```(?:json)?\s*([\s\S]*?)\s*```\s*$/);
  if (fenceMatch) text = fenceMatch[1];
  let parsed;
  try { parsed = JSON.parse(text); } catch (_e) {
    return { __fallback: 'json_parse', error_code: 'json_parse', model: result.model };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { __fallback: 'json_parse', error_code: 'json_not_object', model: result.model };
  }
  // Coerce shape — drop unknown fields, cap list lengths.
  return {
    mode: 'llm',
    summary:        clip(parsed.summary, 1200),
    risks:          (Array.isArray(parsed.risks) ? parsed.risks : []).slice(0, 6).map(r => ({
      kind:     clip(r && r.kind, 60),
      severity: clip(r && r.severity, 20) || 'watch',
      title:    clip(r && r.title, STR_TITLE_MAX),
      detail:   clip(r && r.detail, STR_DETAIL_MAX),
    })),
    next_attention: (Array.isArray(parsed.next_attention) ? parsed.next_attention : [])
      .slice(0, 6).map(s => clip(s, STR_TITLE_MAX)).filter(Boolean),
    evidence_ids:   (Array.isArray(parsed.evidence_ids) ? parsed.evidence_ids : [])
      .slice(0, 12).map(s => clip(s, 60)).filter(Boolean),
    generated_at:   Date.now(),
    model:          result.model,
  };
}

/**
 * Top-level: build state, try LLM, fall back to deterministic.
 *
 * @param {object} input    Inputs: { goal, pulse, activity_summary,
 *                          top_activities, tasks_summary,
 *                          blockers_summary, outcomes_summary,
 *                          checkpoints_summary, recent_reports }
 * @param {object} [opts]   { chatJson, provider, fetchImpl, timeoutMs,
 *                            forceDeterministic, now }
 */
async function interpretGoal(input, opts) {
  const o = opts || {};
  const state = buildCompactState(input);
  const deterministic = deterministicInterpretation(state, { now: o.now });
  if (o.forceDeterministic) return deterministic;

  // Skip LLM when explicit provider says disabled, or when the caller
  // explicitly opts out.
  const provider = o.provider || llmClient.loadProvider();
  if (!provider || !provider.enabled) {
    return Object.assign({}, deterministic, { error_code: provider && provider.reason });
  }

  const llmResult = await llmInterpretation(state, {
    chatJson: o.chatJson,
    provider,
    fetchImpl: o.fetchImpl,
    timeoutMs: o.timeoutMs,
    temperature: o.temperature,
  });
  if (llmResult.__fallback) {
    // Fall back to deterministic; surface error_code so the panel can
    // optionally show "LLM unavailable: <reason>".
    return Object.assign({}, deterministic, {
      error_code: llmResult.error_code,
      llm_model: llmResult.model,
    });
  }
  return llmResult;
}

module.exports = {
  buildCompactState,
  deterministicInterpretation,
  llmInterpretation,
  interpretGoal,
  SYSTEM_PROMPT,
};
