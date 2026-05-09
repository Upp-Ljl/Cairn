'use strict';

/**
 * Managed Loop Review v1 — advisory verdict on one iteration.
 *
 * Given an iteration + worker report + evidence + Pre-PR-Gate result
 * (+ goal + rules), produce one of:
 *
 *   continue          — work is partial; no fatal issues; another
 *                       round is fine.
 *   ready_for_review  — this iteration looks complete; user should
 *                       review and decide PR.
 *   blocked           — there is a blocker the worker can't proceed
 *                       past; needs human input.
 *   needs_evidence    — gap between report claims and evidence; or
 *                       no report; or no commits; cannot decide.
 *   unknown           — not enough state to call (no goal, no
 *                       activity, etc.).
 *
 * Status rules (deterministic — LLM CANNOT change `status`):
 *
 *   if pre_pr_gate.status === 'not_ready' or has open blockers:
 *      → blocked  (deterministic — gate already locked it)
 *   else if no worker report:
 *      → needs_evidence
 *   else if report.blockers.length > 0:
 *      → blocked
 *   else if report.needs_human === true:
 *      → ready_for_review (with caveat in summary)
 *   else if evidence.dirty === false AND no last commit referenced
 *           in report:
 *      → needs_evidence (worker says done but nothing landed)
 *   else if report.remaining.length === 0
 *           AND report.completed.length > 0
 *           AND (no failed tests in evidence):
 *      → ready_for_review
 *   else if report.remaining.length > 0:
 *      → continue
 *   else:
 *      → unknown
 *
 * Optional LLM polish: rephrase the `summary` field and the
 * `next_attention[]` items. Cannot change status / risks / next_prompt_seed.
 *
 * No I/O outside the optional LLM call (handled by llm-client).
 */

const llmClient = require('./llm-client.cjs');

const STR_TITLE_MAX = 200;
const STR_DETAIL_MAX = 600;
const LIST_MAX = 8;

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

const STATUS_VALUES = new Set([
  'continue', 'ready_for_review', 'blocked', 'needs_evidence', 'unknown',
]);

/**
 * Run the deterministic decision rules.
 *
 * Inputs:
 *   - iteration:    the current iteration record (latest snapshot)
 *   - worker_report: latest report (post-coercion shape from worker-reports)
 *   - evidence:     summary or full collectGitEvidence output
 *   - pre_pr_gate:  result from pre-pr-gate.evaluatePrePrGate
 *   - goal:         registry.getProjectGoal output
 *   - rules:        registry.getEffectiveProjectRules output (or null)
 */
function deterministicReview(input) {
  const i = input || {};
  const iteration = i.iteration || null;
  const report    = i.worker_report || null;
  const evidence  = i.evidence || null;
  const gate      = i.pre_pr_gate || null;
  const goal      = i.goal || null;

  const risks = [];
  const next_attention = [];
  let next_prompt_seed = null;

  function addRisk(severity, kind, title, detail) {
    risks.push({
      severity, kind,
      title: clip(title, STR_TITLE_MAX),
      detail: clip(detail, STR_DETAIL_MAX),
    });
  }
  function addAttention(s) {
    const t = clip(s, STR_TITLE_MAX);
    if (t) next_attention.push(t);
  }

  // -------------------------- Status decision --------------------------

  let status = 'unknown';
  let summary = '';

  // Hard blockers from the gate.
  if (gate && gate.status === 'not_ready') {
    status = 'blocked';
    summary = 'Pre-PR Gate flagged blocking signals. Resolve them before continuing.';
    addRisk('attention', 'gate_not_ready', 'Pre-PR Gate is not_ready', 'See gate.checklist for the unresolved items.');
    if (Array.isArray(gate.checklist)) {
      for (const c of gate.checklist.slice(0, 3)) addAttention(c);
    }
  } else if (!report) {
    status = 'needs_evidence';
    summary = 'No worker report attached to this iteration yet. The reviewer can\'t evaluate progress without one.';
    addRisk('watch', 'no_report', 'No worker report on this iteration', 'Paste or attach a worker report so the loop can be reviewed.');
    addAttention('Attach a worker report covering completed / remaining / blockers / next_steps.');
  } else if (Array.isArray(report.blockers) && report.blockers.length > 0) {
    status = 'blocked';
    summary = `Worker reported ${report.blockers.length} blocker${report.blockers.length === 1 ? '' : 's'} — needs human input before another round.`;
    addRisk('attention', 'report_blockers', 'Worker report lists blockers',
      'Read the blocker entries and decide how to unblock before generating a new prompt.');
    for (const b of report.blockers.slice(0, 3)) addAttention(`Resolve blocker: ${clip(b, 160)}`);
  } else {
    // No hard block. Examine evidence ↔ report consistency.
    const evDirty       = !!(evidence && (evidence.dirty || evidence.changed_file_count > 0));
    const evChangedCt   = (evidence && evidence.changed_file_count) != null
      ? evidence.changed_file_count
      : (evidence && Array.isArray(evidence.changed_files) ? evidence.changed_files.length : 0);
    const reportClaimsDone = report.remaining
      ? report.remaining.length === 0 && (report.completed || []).length > 0
      : false;
    const testsRunPass = evidence && evidence.tests_run_pass === true;
    const testsRunFail = evidence && Array.isArray(evidence.tests_run) && evidence.tests_run.some(t => t.exit !== 0);

    if (testsRunFail) {
      status = 'continue';
      summary = 'Tests were run and at least one failed. Another round is needed.';
      addRisk('attention', 'tests_failed', 'A run of detected tests exited non-zero',
        'See evidence.tests_run for the failing command and stderr tail.');
      addAttention('Investigate the failing test command and update the prompt for next round.');
      next_prompt_seed = `Last round\'s tests failed; the next worker should fix the failing test before adding scope.`;
    } else if (reportClaimsDone && !evDirty && evChangedCt === 0 && (!evidence || !(evidence.tests_run_count > 0))) {
      // The agent says "done" but nothing changed on disk and no tests
      // were run. We can\'t verify the claim.
      status = 'needs_evidence';
      summary = 'Worker report claims completion but evidence shows no file changes and no tests run.';
      addRisk('watch', 'no_diff', 'No working-tree changes detected', 'Either the agent forgot to commit, or the work didn\'t happen yet.');
      addAttention('Verify whether the worker actually performed the change (commit / git log).');
    } else if (report.needs_human) {
      status = 'ready_for_review';
      summary = 'Worker flagged needs_human=true; review the report and decide.';
      addRisk('watch', 'needs_human', 'Worker explicitly asked for human input',
        'See latest report; resolve before next round.');
      addAttention('Make the decision the worker is waiting on.');
    } else if (reportClaimsDone) {
      status = 'ready_for_review';
      summary = testsRunPass
        ? 'Worker reports all items completed; detected tests pass; iteration looks ready for human review.'
        : 'Worker reports all items completed; review evidence and decide PR.';
      addAttention('Review the changed files and last commit; decide if it ships.');
      next_prompt_seed = 'Last round was reported complete. Next round can pick a new sub-goal under the same project goal.';
    } else if (Array.isArray(report.remaining) && report.remaining.length > 0) {
      status = 'continue';
      summary = `Worker has ${report.remaining.length} remaining item${report.remaining.length === 1 ? '' : 's'}. Another round is fine.`;
      for (const r of report.remaining.slice(0, 3)) addAttention(`Pick up: ${clip(r, 160)}`);
      next_prompt_seed = 'Carry over the remaining items from the previous round\'s worker report.';
    } else {
      status = 'unknown';
      summary = 'Not enough state to decide: report has no remaining items but no clear completion signal either.';
      addRisk('watch', 'underspecified', 'Iteration state is ambiguous',
        'Worker report does not clearly indicate done vs in-progress; ask the worker to clarify.');
      addAttention('Ask the worker to send a stricter completed/remaining/blockers report.');
    }
  }

  // ----- Anchor sanity: no goal? lower confidence to unknown unless
  // we already have a clear blocker (which is independently useful).
  if (!goal || !goal.title) {
    if (status !== 'blocked') {
      status = 'unknown';
      summary = summary || 'No goal set on this project; the reviewer has nothing to anchor against.';
      addRisk('watch', 'no_goal', 'Project has no goal set',
        'Set a goal in Cairn so the loop can be evaluated against it.');
      addAttention('Set a project goal before running another round.');
    }
  }

  // ----- Cross-check needs_human in report (additive risk).
  if (report && report.needs_human && status !== 'ready_for_review' && status !== 'blocked') {
    addRisk('watch', 'needs_human', 'Worker report flagged needs_human',
      'Worker is waiting on a human decision.');
  }

  // ----- next_prompt_seed default.
  if (!next_prompt_seed) {
    if (status === 'blocked')          next_prompt_seed = 'Do not start another round until the blocker is resolved.';
    else if (status === 'needs_evidence') next_prompt_seed = 'Have the worker re-run with explicit evidence: commits, file diffs, command output.';
  }

  // Sanity-check status is in the closed set.
  if (!STATUS_VALUES.has(status)) status = 'unknown';

  // Evidence id set: pull stable ids the surface can use to render
  // "what fed into this verdict".
  const evidence_ids = [];
  if (gate && gate.rule_log) for (const k of gate.rule_log) if (k && !evidence_ids.includes(k)) evidence_ids.push(k);
  if (report && report.id) evidence_ids.push(`report:${report.id}`);
  if (iteration && iteration.id) evidence_ids.push(`iteration:${iteration.id}`);

  return {
    status,
    summary,
    risks,
    next_attention,
    next_prompt_seed,
    evidence_ids,
    mode: 'deterministic',
  };
}

// ---------------------------------------------------------------------------
// Optional LLM polish — never alters status / risks / next_prompt_seed.
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = [
  'You are an advisory observer for Cairn, a local desktop project control surface. You\'re looking at a managed project iteration review.',
  '',
  'Cairn is NOT a coding agent. You do NOT decide outcomes; you only rephrase fields more clearly.',
  '',
  'Hard rules:',
  ' - Output JSON only with shape: { summary: string, next_attention: string[] }.',
  ' - DO NOT change the status field; DO NOT add a status field to your output.',
  ' - DO NOT add new risks beyond what is in the input.',
  ' - DO NOT recommend that any agent push, merge, or skip user authorization.',
  ' - Tone: short, observational, second-person to the user.',
  '',
  'No prose outside the JSON. No code fences.',
].join('\n');

async function llmRewrite(deterministic, opts) {
  const o = opts || {};
  const chatFn = o.chatJson || llmClient.chatJson;
  const userJson = JSON.stringify({
    status: deterministic.status,
    summary: deterministic.summary,
    risks: deterministic.risks,
    next_attention: deterministic.next_attention,
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
  // Coerce: status + risks come from deterministic. We never trust LLM
  // with status. We also re-validate next_attention isn't trying to
  // smuggle a "go push" instruction.
  const nextAttn = clipList(parsed.next_attention, LIST_MAX, STR_TITLE_MAX)
    .filter(s => !/auto[-_ ]?dispatch|push.*without authorization|skip authorization/i.test(s));
  return {
    status: deterministic.status,
    summary: clip(parsed.summary, 1200) || deterministic.summary,
    risks: deterministic.risks,
    next_attention: nextAttn.length ? nextAttn : deterministic.next_attention,
    next_prompt_seed: deterministic.next_prompt_seed,
    evidence_ids: deterministic.evidence_ids,
    mode: 'llm',
    model: result.model,
  };
}

async function reviewIteration(input, opts) {
  const o = opts || {};
  const deterministic = deterministicReview(input);
  if (o.forceDeterministic) return deterministic;

  const provider = o.provider || llmClient.loadProvider();
  if (!provider || !provider.enabled) {
    return Object.assign({}, deterministic, { error_code: provider && provider.reason });
  }
  const llm = await llmRewrite(deterministic, {
    chatJson: o.chatJson, provider, fetchImpl: o.fetchImpl, timeoutMs: o.timeoutMs, temperature: o.temperature,
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
  STATUS_VALUES,
  deterministicReview,
  llmRewrite,
  reviewIteration,
  SYSTEM_PROMPT,
};
