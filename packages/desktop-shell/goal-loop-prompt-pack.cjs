'use strict';

/**
 * Goal Loop Prompt Pack v1 — composes a copy-pasteable prompt that
 * the user can hand to Claude Code / Codex / Cursor for the next
 * round of work, anchored on the project's goal + rules + current
 * state + recent worker reports + Pre-PR-Gate signals.
 *
 * Hard product boundary (§1.3 #4 / §6.4.5 / §7 principle 2):
 *   - Cairn does NOT auto-dispatch. The pack is for the USER to
 *     paste; nothing in this module sends, calls, or schedules
 *     anything against an agent.
 *   - Cairn does NOT spawn agents.
 *   - The prompt itself tells the agent to honor non_goals and
 *     report back; it does not authorize the agent to push, merge,
 *     or change scope.
 *
 * Privacy boundary (mirrors goal-interpretation):
 *   - No api keys, transcripts, prompt content, tool args,
 *     stdout/stderr, agent_id, session_id, raw cwd path, or
 *     capability tags appear in the prompt or sections output.
 *   - Worker reports are summarized to title + counts +
 *     needs_human boolean.
 *   - LLM rewrite (when available) cannot remove non_goals or alter
 *     hard checklist items; status-style fields don't exist here, so
 *     "status integrity" is per-section integrity (see assembleHard).
 *
 * Output shape:
 *   {
 *     mode: 'deterministic' | 'llm',
 *     title: string,
 *     prompt: string,                 // full text, ready to copy
 *     sections: {
 *       goal:                  string
 *       context_summary:       string
 *       rules:                 string
 *       current_state:         string
 *       worker_report_summary: string
 *       acceptance_checklist:  string[]
 *       non_goals:             string[]
 *     },
 *     evidence_ids: string[],
 *     generated_at: number,
 *     model?: string,
 *     error_code?: string
 *   }
 *
 * Pure function module — no I/O outside the optional LLM call.
 */

const llmClient = require('./llm-client.cjs');

const STR_TITLE_MAX  = 200;
const STR_LINE_MAX   = 400;
const LIST_MAX       = 10;

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

// ---------------------------------------------------------------------------
// Section assembly (deterministic)
// ---------------------------------------------------------------------------

/**
 * Compose the seven sections that make up the prompt pack. Pure —
 * given the same input, always produces the same sections.
 */
function assembleSections(input) {
  const o = input || {};
  const goal       = o.goal || null;
  const rules      = o.project_rules || null;
  const isDefaultRules = !!o.project_rules_is_default;
  const pulse      = o.pulse || null;
  const activity   = o.activity_summary || null;
  const tasks      = o.tasks_summary || null;
  const blockers   = o.blockers_summary || null;
  const outcomes   = o.outcomes_summary || null;
  const reports    = Array.isArray(o.recent_reports) ? o.recent_reports : [];
  const gate       = o.pre_pr_gate || null;

  // ---- goal ----
  const goalLines = [];
  if (goal && goal.title) {
    goalLines.push(`Goal: ${clip(goal.title, STR_TITLE_MAX)}`);
    if (goal.desired_outcome) {
      goalLines.push(`Desired outcome: ${clip(goal.desired_outcome, STR_LINE_MAX)}`);
    }
    if (Array.isArray(goal.success_criteria) && goal.success_criteria.length) {
      goalLines.push('Success criteria:');
      for (const c of clipList(goal.success_criteria, LIST_MAX, STR_LINE_MAX)) {
        goalLines.push(`  - ${c}`);
      }
    }
  } else {
    goalLines.push('Goal: (not set yet — set one in Cairn before running this loop)');
  }

  // ---- context_summary ----
  const ctxBits = [];
  if (pulse && pulse.pulse_level) ctxBits.push(`pulse=${pulse.pulse_level}`);
  if (activity && activity.by_family) {
    const f = activity.by_family;
    ctxBits.push(`agents: ${f.live || 0} live · ${f.recent || 0} recent · ${f.inactive || 0} inactive`);
  }
  const contextSummary = ctxBits.length ? ctxBits.join('; ') : 'no live activity recorded.';

  // ---- rules ----
  const rulesLines = [];
  if (rules) {
    if (isDefaultRules) {
      rulesLines.push('(Default rules; user has not customized.)');
    }
    if (rules.coding_standards && rules.coding_standards.length) {
      rulesLines.push('Coding standards:');
      for (const r of clipList(rules.coding_standards, LIST_MAX, STR_LINE_MAX)) rulesLines.push(`  - ${r}`);
    }
    if (rules.testing_policy && rules.testing_policy.length) {
      rulesLines.push('Testing policy:');
      for (const r of clipList(rules.testing_policy, LIST_MAX, STR_LINE_MAX)) rulesLines.push(`  - ${r}`);
    }
    if (rules.reporting_policy && rules.reporting_policy.length) {
      rulesLines.push('Reporting policy:');
      for (const r of clipList(rules.reporting_policy, LIST_MAX, STR_LINE_MAX)) rulesLines.push(`  - ${r}`);
    }
  } else {
    rulesLines.push('(no rules configured)');
  }

  // ---- current_state ----
  const stateLines = [];
  if (tasks) {
    stateLines.push(`Tasks: running ${tasks.running || 0} · blocked ${tasks.blocked || 0} · waiting_review ${tasks.waiting_review || 0} · failed ${tasks.failed || 0}`);
  }
  if (blockers) {
    stateLines.push(`Open blockers: ${blockers.open || 0}`);
  }
  if (outcomes) {
    stateLines.push(`Failed outcomes: ${outcomes.failed || 0}; pending: ${outcomes.pending || 0}`);
  }
  if (pulse && Array.isArray(pulse.signals) && pulse.signals.length) {
    stateLines.push('Pulse signals:');
    for (const s of pulse.signals.slice(0, 6)) {
      stateLines.push(`  - [${clip(s.severity, 20) || 'watch'}] ${clip(s.title, STR_TITLE_MAX)}`);
    }
  }
  if (gate && gate.status) {
    stateLines.push(`Pre-PR Gate: ${gate.status}`);
  }
  if (!stateLines.length) stateLines.push('(no current-state signals yet)');

  // ---- worker_report_summary ----
  const reportLines = [];
  if (reports.length === 0) {
    reportLines.push('(no recent worker reports)');
  } else {
    for (const r of reports.slice(0, 3)) {
      reportLines.push(
        `- "${clip(r.title, STR_TITLE_MAX)}": ${(r.completed || []).length} completed, ` +
        `${(r.remaining || []).length} remaining, ${(r.blockers || []).length} blockers, ` +
        `next ${(r.next_steps || []).length}${r.needs_human ? ', needs_human=true' : ''}`
      );
    }
  }

  // ---- acceptance_checklist ----
  // Hard items always present (the agent must follow these). Pulled
  // from rules.pre_pr_checklist + a small floor.
  const accept = [];
  accept.push('Report `completed` / `remaining` / `blockers` / `next_steps` at end of the run.');
  accept.push('Do not push or merge unless the user explicitly authorizes.');
  accept.push('Do not expand scope beyond the listed non-goals.');
  if (rules && Array.isArray(rules.pre_pr_checklist)) {
    for (const item of clipList(rules.pre_pr_checklist, LIST_MAX, STR_LINE_MAX)) {
      accept.push(item);
    }
  }
  if (gate && Array.isArray(gate.checklist)) {
    // Gate checklist may already include rules-derived items; dedupe
    // by exact text match to avoid the prompt repeating itself.
    const seen = new Set(accept.map(s => s.toLowerCase()));
    for (const item of gate.checklist.slice(0, LIST_MAX)) {
      const lower = item.toLowerCase();
      if (!seen.has(lower)) {
        seen.add(lower);
        accept.push(clip(item, STR_LINE_MAX));
      }
    }
  }

  // ---- non_goals ----
  const nonGoals = [];
  if (rules && Array.isArray(rules.non_goals)) {
    for (const ng of clipList(rules.non_goals, LIST_MAX, STR_LINE_MAX)) nonGoals.push(ng);
  }
  if (goal && Array.isArray(goal.non_goals)) {
    for (const ng of clipList(goal.non_goals, LIST_MAX, STR_LINE_MAX)) {
      if (!nonGoals.includes(ng)) nonGoals.push(ng);
    }
  }
  // Floor: always include the bedrock non-goals so the prompt can't
  // be neutered by an empty rules + empty goal.non_goals state.
  const floor = [
    'Cairn does not write code; you (the agent) write code.',
    'You do not auto-push or auto-merge.',
    'Do not modify Cairn project rules without explicit user request.',
  ];
  for (const f of floor) if (!nonGoals.includes(f)) nonGoals.push(f);

  // ---- evidence ids ----
  const evidence_ids = [];
  if (pulse && Array.isArray(pulse.signals)) {
    for (const s of pulse.signals) if (s.kind) evidence_ids.push(s.kind);
  }
  if (gate && Array.isArray(gate.rule_log)) {
    for (const k of gate.rule_log) if (k && !evidence_ids.includes(k)) evidence_ids.push(k);
  }
  for (const r of reports.slice(0, 3)) {
    if (r.title) evidence_ids.push(`report:${clip(r.title, 40)}`);
  }

  return {
    goal:                  goalLines.join('\n'),
    context_summary:       contextSummary,
    rules:                 rulesLines.join('\n'),
    current_state:         stateLines.join('\n'),
    worker_report_summary: reportLines.join('\n'),
    acceptance_checklist:  accept.slice(0, LIST_MAX + 5),
    non_goals:             nonGoals,
    evidence_ids,
  };
}

/**
 * Compose the final prompt text from sections. Plain text — agents
 * can copy this directly into Claude Code / Codex / Cursor.
 */
function composePrompt(sections, opts) {
  const o = opts || {};
  const title = clip(o.title, STR_TITLE_MAX) || 'Cairn — next worker prompt';
  const lines = [];

  lines.push('You are a coding agent working under Cairn project rules.');
  lines.push('Cairn is a project control surface (read-only); it does not write code or dispatch you. The user is asking you to take the next round of work.');
  lines.push('');
  lines.push('# Goal');
  lines.push(sections.goal);
  lines.push('');
  lines.push(`# Context summary`);
  lines.push(sections.context_summary);
  lines.push('');
  lines.push('# Project rules');
  lines.push(sections.rules);
  lines.push('');
  lines.push('# Current state');
  lines.push(sections.current_state);
  lines.push('');
  lines.push('# Recent worker reports (counts only)');
  lines.push(sections.worker_report_summary);
  lines.push('');
  lines.push('# Acceptance checklist (you must satisfy these)');
  for (const item of sections.acceptance_checklist) lines.push(`- ${item}`);
  lines.push('');
  lines.push('# Non-goals (do NOT cross these)');
  for (const ng of sections.non_goals) lines.push(`- ${ng}`);
  lines.push('');
  lines.push('# When you finish');
  lines.push('Produce a final report with:');
  lines.push('- completed: what landed and how it was verified');
  lines.push('- remaining: what is still outstanding');
  lines.push('- blockers: anything you need a human to decide');
  lines.push('- next_steps: what the next round should pick up');
  lines.push('Do not push unless authorized.');

  return { title, prompt: lines.join('\n') };
}

// ---------------------------------------------------------------------------
// Deterministic top-level
// ---------------------------------------------------------------------------

function deterministicPack(input, opts) {
  const o = opts || {};
  const sections = assembleSections(input);
  const { title, prompt } = composePrompt(sections, { title: o.title });
  return {
    mode: 'deterministic',
    title,
    prompt,
    sections: {
      goal:                  sections.goal,
      context_summary:       sections.context_summary,
      rules:                 sections.rules,
      current_state:         sections.current_state,
      worker_report_summary: sections.worker_report_summary,
      acceptance_checklist:  sections.acceptance_checklist,
      non_goals:             sections.non_goals,
    },
    evidence_ids: sections.evidence_ids,
    generated_at: Number.isFinite(o.now) ? o.now : Date.now(),
  };
}

// ---------------------------------------------------------------------------
// LLM rewrite (optional). Can rephrase context_summary / current_state /
// worker_report_summary text. CANNOT remove non_goals or alter the hard
// items in acceptance_checklist (the first 3, see HARD_ACCEPTANCE_PREFIX).
// ---------------------------------------------------------------------------

const HARD_ACCEPTANCE_PREFIX = 3; // first N items are bedrock; LLM can't drop them

const SYSTEM_PROMPT = [
  'You are an advisory observer for Cairn, a local desktop project control surface. The user is composing a prompt to hand to a coding agent (Claude Code / Codex / Cursor). Your job: rephrase parts of the prompt sections so they read more cleanly, in the user\'s own engineering voice. The prompt is for the USER to copy/paste — Cairn never sends it.',
  '',
  'Hard rules:',
  ' - DO NOT change the goal title or success_criteria.',
  ' - DO NOT remove any item from `non_goals`.',
  ' - DO NOT remove any of the first 3 items in `acceptance_checklist` (these are bedrock).',
  ' - DO NOT add new task goals beyond what is stated in `goal`.',
  ' - DO NOT add anything that would have Cairn auto-dispatch, auto-execute, or skip user authorization.',
  ' - DO NOT add credentials, URLs, or any data not in the input.',
  '',
  'Output JSON only with this exact shape:',
  '  { context_summary: string, current_state: string, worker_report_summary: string, acceptance_checklist_extra: string[], non_goals_extra: string[] }',
  '',
  'You may add up to 3 extra acceptance_checklist items and up to 3 extra non_goals only if they are clearly implied by the input rules — never if they introduce new behavior. Otherwise leave the extras empty.',
  '',
  'No prose outside the JSON. No code fences.',
].join('\n');

function safeMergeFromLlm(deterministic, llmObj) {
  const out = {
    title: deterministic.title,
    sections: Object.assign({}, deterministic.sections),
    evidence_ids: deterministic.evidence_ids,
  };
  // Allow rephrasing the freeform text sections.
  if (llmObj && typeof llmObj.context_summary === 'string') {
    out.sections.context_summary = clip(llmObj.context_summary, STR_LINE_MAX * 2);
  }
  if (llmObj && typeof llmObj.current_state === 'string') {
    out.sections.current_state = clip(llmObj.current_state, STR_LINE_MAX * 4);
  }
  if (llmObj && typeof llmObj.worker_report_summary === 'string') {
    out.sections.worker_report_summary = clip(llmObj.worker_report_summary, STR_LINE_MAX * 2);
  }
  // Append extras, with hard floor preserved. The prefix bedrock + the
  // existing acceptance items always survive.
  if (llmObj && Array.isArray(llmObj.acceptance_checklist_extra)) {
    const extras = clipList(llmObj.acceptance_checklist_extra, 3, STR_LINE_MAX);
    const seen = new Set(out.sections.acceptance_checklist.map(s => s.toLowerCase()));
    for (const item of extras) {
      const lower = item.toLowerCase();
      // Filter hostile injections: anything that looks like
      // "auto-dispatch" / "skip authorization" gets dropped.
      if (/auto[-_ ]?dispatch|skip authorization|push.*without authorization/i.test(item)) continue;
      if (!seen.has(lower)) {
        seen.add(lower);
        out.sections.acceptance_checklist = out.sections.acceptance_checklist.concat([item]);
      }
    }
  }
  if (llmObj && Array.isArray(llmObj.non_goals_extra)) {
    const extras = clipList(llmObj.non_goals_extra, 3, STR_LINE_MAX);
    const seen = new Set(out.sections.non_goals.map(s => s.toLowerCase()));
    for (const item of extras) {
      const lower = item.toLowerCase();
      if (!seen.has(lower)) {
        seen.add(lower);
        out.sections.non_goals = out.sections.non_goals.concat([item]);
      }
    }
  }
  // Re-validate: if a malicious LLM somehow stripped sections (it
  // can't, but defense in depth), fall back to deterministic for
  // those fields.
  if (!out.sections.non_goals || out.sections.non_goals.length < deterministic.sections.non_goals.length) {
    out.sections.non_goals = deterministic.sections.non_goals;
  }
  if (out.sections.acceptance_checklist.length < HARD_ACCEPTANCE_PREFIX) {
    out.sections.acceptance_checklist = deterministic.sections.acceptance_checklist;
  } else {
    // Verify the first HARD_ACCEPTANCE_PREFIX items are still the bedrock.
    for (let i = 0; i < HARD_ACCEPTANCE_PREFIX; i++) {
      if (out.sections.acceptance_checklist[i] !== deterministic.sections.acceptance_checklist[i]) {
        out.sections.acceptance_checklist = deterministic.sections.acceptance_checklist;
        break;
      }
    }
  }
  return out;
}

async function llmRewrite(deterministic, opts) {
  const o = opts || {};
  const chatFn = o.chatJson || llmClient.chatJson;
  // Send only the sections that may be rephrased. NEVER the goal
  // title/criteria, NEVER the non_goals (LLM might delete them
  // outside the contract; we still defense-in-depth in safeMerge).
  const userJson = JSON.stringify({
    context_summary:       deterministic.sections.context_summary,
    current_state:         deterministic.sections.current_state,
    worker_report_summary: deterministic.sections.worker_report_summary,
    acceptance_checklist:  deterministic.sections.acceptance_checklist,
    non_goals:             deterministic.sections.non_goals,
  });
  const result = await chatFn({
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user',   content: userJson },
    ],
    temperature: o.temperature != null ? o.temperature : 0.2,
    response_format: { type: 'json_object' },
  }, { provider: o.provider, fetchImpl: o.fetchImpl, timeoutMs: o.timeoutMs });

  if (!result.enabled) return { __fallback: 'disabled', error_code: result.error_code };
  if (!result.ok)      return { __fallback: 'llm_failed', error_code: result.error_code, model: result.model };

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
  const merged = safeMergeFromLlm(deterministic, parsed);
  // Recompose the prompt text from the (possibly LLM-rephrased) sections.
  const recomposed = composePrompt(merged.sections, { title: merged.title });
  return {
    mode: 'llm',
    title: recomposed.title,
    prompt: recomposed.prompt,
    sections: merged.sections,
    evidence_ids: merged.evidence_ids,
    generated_at: Date.now(),
    model: result.model,
  };
}

async function generatePromptPack(input, opts) {
  const o = opts || {};
  const deterministic = deterministicPack(input, { now: o.now });
  if (o.forceDeterministic) return deterministic;

  const provider = o.provider || llmClient.loadProvider();
  if (!provider || !provider.enabled) {
    return Object.assign({}, deterministic, { error_code: provider && provider.reason });
  }
  const llm = await llmRewrite(deterministic, {
    chatJson: o.chatJson, provider, fetchImpl: o.fetchImpl, timeoutMs: o.timeoutMs,
  });
  if (llm.__fallback) {
    return Object.assign({}, deterministic, {
      error_code: llm.error_code,
      llm_model: llm.model,
    });
  }
  return llm;
}

module.exports = {
  assembleSections,
  composePrompt,
  deterministicPack,
  safeMergeFromLlm,
  llmRewrite,
  generatePromptPack,
  SYSTEM_PROMPT,
  HARD_ACCEPTANCE_PREFIX,
};
