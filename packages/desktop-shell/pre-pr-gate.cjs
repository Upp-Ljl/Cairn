'use strict';

/**
 * Pre-PR Gate v1 — read-only, advisory-only readiness check.
 *
 * Per PRODUCT.md §6.4.4 (Lightweight Pre-PR Gate, Phase A demo):
 *
 *   "Cairn is the project state console; the user is the decider."
 *
 * The gate produces a checklist + risks + status (not_ready /
 * ready_with_risks / unknown). It DOES NOT:
 *   - run tests
 *   - block git operations
 *   - install hooks
 *   - claim a PR is good to ship
 *   - dispatch agents
 *   - decide priority
 *
 * Status semantics:
 *
 *   not_ready          — at least one deterministic rule produced a
 *                        blocking signal (open blocker, failed outcome,
 *                        failed task, open conflict). The user should
 *                        clear it before merging.
 *
 *   ready_with_risks   — no blocking deterministic signal; some
 *                        observational risks remain (e.g. no recent
 *                        worker report; goal but no positive evidence
 *                        of progress; in-flight task with stale activity).
 *
 *   unknown            — not enough state to comment (no goal set; no
 *                        agent activity at all). The gate offers no
 *                        opinion until the user provides anchor state.
 *
 * Optional LLM rewrite: an LLM may rephrase the checklist + risks
 * (advisory tone). It does NOT change `status`. The deterministic
 * `status` remains the binding contract.
 *
 * Read/write boundary: pure derivation. No I/O outside the optional
 * outbound LLM call (handled by goal-interpretation's chatJson, with
 * the same privacy boundary as Phase 2).
 */

const llmClient = require('./llm-client.cjs');

const STR_TITLE_MAX  = 200;
const STR_DETAIL_MAX = 400;
const LIST_MAX       = 8;

function clip(s, max) {
  if (typeof s !== 'string') return '';
  const t = s.trim();
  return t.length > max ? t.slice(0, max) : t;
}

// ---------------------------------------------------------------------------
// Deterministic rules
// ---------------------------------------------------------------------------

/**
 * Apply the locked set of deterministic rules. Inputs are the same
 * shape as Goal Interpretation v1 + a recent_reports list, plus an
 * optional project_rules object (governance v1).
 *
 * Project rules are ADVISORY — they extend the checklist (with the
 * pre_pr_checklist items + items derived from testing_policy /
 * reporting_policy / coding_standards) and they sharpen the
 * "missing report" wording when reporting_policy says reports are
 * required. They DO NOT change the locked status decision: blocker /
 * failed_outcome / failed_task / open_conflict still wins.
 *
 * @returns {{ status, checklist, risks, evidence, rule_log }}
 */
function deterministicGate(input, opts) {
  const o = opts || {};
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const goal     = input && input.goal;
  const pulse    = input && input.pulse;
  const summary  = input && input.summary;
  const activity = input && input.activity_summary;
  const reports  = Array.isArray(input && input.recent_reports) ? input.recent_reports : [];
  const rules    = (input && input.project_rules) || null; // already an effective ruleset
  const isDefaultRules = !!(input && input.project_rules_is_default);

  const checklist = [];
  const risks = [];
  const evidence = [];
  const ruleLog = [];

  let blockingHits = 0;
  let positiveHits = 0;

  function addRisk(severity, kind, title, detail) {
    risks.push({ severity, kind, title: clip(title, STR_TITLE_MAX), detail: clip(detail, STR_DETAIL_MAX) });
    ruleLog.push(kind);
  }
  function addCheck(item) { checklist.push(clip(item, STR_TITLE_MAX)); }
  function addEvidence(label) { evidence.push(clip(label, STR_TITLE_MAX)); }

  // ----- Blocking rules -----

  const blockersOpen = (summary && summary.blockers_open) || 0;
  if (blockersOpen > 0) {
    blockingHits++;
    addRisk('attention', 'open_blocker',
      `${blockersOpen} open blocker${blockersOpen === 1 ? '' : 's'}`,
      'A task is stalled waiting for an answer. Resolving the blocker should come before PR.');
    addCheck(`Resolve ${blockersOpen} open blocker${blockersOpen === 1 ? '' : 's'} before PR.`);
  }

  const outcomesFailed = (summary && summary.outcomes_failed) || 0;
  if (outcomesFailed > 0) {
    blockingHits++;
    addRisk('attention', 'failed_outcome',
      `${outcomesFailed} failed outcome${outcomesFailed === 1 ? '' : 's'}`,
      'One or more acceptance checks (FAIL or TERMINAL_FAIL) need review or retry.');
    addCheck(`Review ${outcomesFailed} failed outcome${outcomesFailed === 1 ? '' : 's'}.`);
  }

  const tasksFailed = (summary && summary.tasks_failed) || 0;
  if (tasksFailed > 0) {
    blockingHits++;
    addRisk('attention', 'failed_task',
      `${tasksFailed} failed task${tasksFailed === 1 ? '' : 's'}`,
      'A task hit a terminal failure state. Inspect the task detail before PR.');
    addCheck(`Inspect ${tasksFailed} failed task${tasksFailed === 1 ? '' : 's'}.`);
  }

  const conflictsOpen = (summary && summary.conflicts_open) || 0;
  if (conflictsOpen > 0) {
    blockingHits++;
    addRisk('attention', 'open_conflict',
      `${conflictsOpen} open conflict${conflictsOpen === 1 ? '' : 's'}`,
      'Two agents touched overlapping paths. Reconcile before merging.');
    addCheck(`Reconcile ${conflictsOpen} open conflict${conflictsOpen === 1 ? '' : 's'}.`);
  }

  // ----- Anchor rules (status decision) -----

  const haveGoal = !!(goal && goal.title);
  if (!haveGoal) {
    addRisk('watch', 'no_goal',
      'No goal set for this project',
      'The gate has no anchor to evaluate against. Set a goal so PR readiness can be checked against it.');
    ruleLog.push('no_goal');
  } else {
    addEvidence(`Goal: ${goal.title}`);
  }

  // ----- Observational watch rules -----

  if (haveGoal && reports.length === 0) {
    // If reporting_policy says reports are required, sharpen the
    // wording. Otherwise it's still a watch-level "you'd benefit from
    // one" hint.
    const policyRequiresReport = !!(rules && Array.isArray(rules.reporting_policy)
      && rules.reporting_policy.length > 0);
    addRisk('watch', 'no_recent_report',
      policyRequiresReport
        ? 'No recent worker report (reporting policy expects one)'
        : 'No recent worker report',
      policyRequiresReport
        ? `The project's reporting policy lists ${rules.reporting_policy.length} item(s); a worker report covering them is the floor.`
        : 'Without a worker report from the agent, the gate has no first-person summary of "what was done / what is left / what is blocked".');
    addCheck('Add a worker report from the agent before PR.');
  }
  if (reports.length > 0) {
    const latest = reports[0];
    addEvidence(`Latest worker report: "${clip(latest.title, 80)}" (${(latest.completed || []).length} completed, ${(latest.blockers || []).length} blockers, needs_human=${!!latest.needs_human})`);
    if (latest.needs_human) {
      addRisk('watch', 'report_needs_human',
        'Latest worker report flagged needs_human',
        'The agent explicitly asked for a human decision. Make sure that decision was made before PR.');
      addCheck('Confirm the needs_human flag from the latest report has been addressed.');
    }
    if (Array.isArray(latest.blockers) && latest.blockers.length > 0) {
      addCheck(`Review ${latest.blockers.length} blocker(s) listed in the latest report.`);
    }
  }

  const tasksRunning   = (summary && summary.tasks_running)        || 0;
  const tasksWaiting   = (summary && summary.tasks_waiting_review) || 0;
  if (tasksWaiting > 0) {
    addRisk('watch', 'waiting_review',
      `${tasksWaiting} task${tasksWaiting === 1 ? '' : 's'} WAITING_REVIEW`,
      'An agent submitted work for evaluation; the outcome decides PASS / FAIL / RETRY.');
    addCheck(`Run the WAITING_REVIEW task${tasksWaiting === 1 ? "'s" : "s'"} acceptance checks.`);
  }

  // Pulse-driven extras (carried verbatim from the deterministic
  // pulse layer; we don't re-derive).
  const pulseSignals = (pulse && Array.isArray(pulse.signals)) ? pulse.signals : [];
  for (const s of pulseSignals) {
    if (s.kind === 'inflight_no_recent_activity') {
      addRisk('watch', s.kind,
        s.title || 'Task in flight with no recent activity',
        s.detail || '');
      addCheck('Confirm the in-flight task is still actively being worked on, or close it.');
    }
  }

  // ----- Rules-derived advisory checklist -----
  //
  // Project rules feed the checklist as advisory items (status remains
  // locked to deterministic). Each item is a one-line reminder, NOT a
  // "Cairn judges PR by this" claim. Order: pre_pr_checklist →
  // testing_policy → reporting_policy → coding_standards (selective).
  //
  // We tag default-ruleset items with " [default]" so the user sees
  // which floor they're inheriting; their own rules render plain.

  function pushRuleItems(list, label) {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      const tag = isDefaultRules ? ' [default]' : '';
      addCheck(`${label}: ${item}${tag}`);
    }
  }

  if (rules) {
    pushRuleItems(rules.pre_pr_checklist, 'Pre-PR');
    pushRuleItems(rules.testing_policy,   'Testing');
    pushRuleItems(rules.reporting_policy, 'Reporting');
    // Coding standards: only the first 2-3 to avoid drowning the user.
    // The full list is visible in the Rules Card; the gate surface is
    // a compact reminder, not a regurgitator.
    if (Array.isArray(rules.coding_standards) && rules.coding_standards.length) {
      const csTop = rules.coding_standards.slice(0, 2);
      pushRuleItems(csTop, 'Coding');
    }

    // non_goals are the boundary contract — surface separately as
    // risk-level info so the user sees them before composing the PR.
    if (Array.isArray(rules.non_goals) && rules.non_goals.length) {
      addEvidence(`Non-goals (${rules.non_goals.length}): ` +
        rules.non_goals.slice(0, 3).join(' · ') +
        (rules.non_goals.length > 3 ? ' …' : ''));
    }
    ruleLog.push(isDefaultRules ? 'rules_default_applied' : 'rules_applied');
  }

  // ----- Positive evidence -----

  // Cairn doesn't read git diffs. The "positive evidence" today is
  // limited to: at least one worker report exists, in-flight task
  // count is zero, and there's a goal anchor. We don't try to be
  // cleverer than that — it's advisory.
  const inflightTotal = tasksRunning + (summary && summary.tasks_blocked || 0) + tasksWaiting;
  if (haveGoal && inflightTotal === 0 && reports.length > 0 && blockingHits === 0) {
    positiveHits++;
    addEvidence('No tasks in flight; recent worker report present; goal anchor set.');
  }

  // ----- Status decision -----

  let status;
  if (blockingHits > 0) {
    status = 'not_ready';
  } else if (!haveGoal && (!activity || !activity.total)) {
    status = 'unknown';
  } else if (!haveGoal) {
    status = 'unknown';
  } else if (risks.some(r => r.severity === 'watch')) {
    status = 'ready_with_risks';
  } else if (positiveHits > 0) {
    status = 'ready_with_risks';
    addEvidence('No deterministic blockers found; treat as advisory ready.');
  } else {
    // Have goal, no risks, no positive evidence — can't say.
    status = 'unknown';
  }

  return { status, checklist, risks, evidence, rule_log: ruleLog, mode: 'deterministic' };
}

// ---------------------------------------------------------------------------
// LLM rewrite — only rephrases; never changes `status` or `rule_log`.
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = [
  'You are an advisory observer for Cairn, a local desktop project control surface. You are looking at a Pre-PR readiness check.',
  '',
  'Cairn is NOT a coding agent and does NOT decide whether a PR is good. Your job: rewrite the deterministic checklist and risks in clear, observational language. The deterministic `status` is final — DO NOT change it.',
  '',
  'Hard rules:',
  ' - Output JSON only with shape: { checklist: string[], risks: [{kind, severity, title, detail}], summary: string }.',
  ' - DO NOT add new checklist items beyond rephrasing the existing rule_log entries; do not invent rules.',
  ' - DO NOT recommend that any agent execute any specific task.',
  ' - DO NOT claim the PR is ready to merge.',
  ' - Tone: observational, second-person to the user ("Confirm X", "Review Y"), never imperatives directed at agents.',
  ' - Severity values: attention | watch | info.',
  '',
  'Output JSON only, no fences, no surrounding prose.',
].join('\n');

async function llmRewrite(deterministic, opts) {
  const o = opts || {};
  const chatFn = o.chatJson || llmClient.chatJson;
  const userJson = JSON.stringify({
    status: deterministic.status,
    rule_log: deterministic.rule_log,
    checklist: deterministic.checklist,
    risks: deterministic.risks,
    evidence: deterministic.evidence,
  });
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
  // Coerce: only rephrasings of existing fields. status / rule_log are
  // copied from deterministic — we never trust the LLM with status.
  return {
    status:    deterministic.status,
    rule_log:  deterministic.rule_log,
    checklist: (Array.isArray(parsed.checklist) ? parsed.checklist : deterministic.checklist)
      .slice(0, LIST_MAX).map(s => clip(s, STR_TITLE_MAX)).filter(Boolean),
    risks:     (Array.isArray(parsed.risks) ? parsed.risks : deterministic.risks)
      .slice(0, LIST_MAX).map(r => ({
        kind:     clip(r && r.kind, 60),
        severity: clip(r && r.severity, 20) || 'watch',
        title:    clip(r && r.title, STR_TITLE_MAX),
        detail:   clip(r && r.detail, STR_DETAIL_MAX),
      })),
    evidence:  deterministic.evidence,
    summary:   clip(parsed.summary, 1200),
    mode:      'llm',
    model:     result.model,
  };
}

/**
 * Top-level: build deterministic gate, optionally pass it through the
 * LLM for tone polish, fall back to deterministic on any failure.
 */
async function evaluatePrePrGate(input, opts) {
  const o = opts || {};
  const deterministic = deterministicGate(input, { now: o.now });
  if (o.forceDeterministic) return deterministic;

  const provider = o.provider || llmClient.loadProvider();
  if (!provider || !provider.enabled) {
    return Object.assign({}, deterministic, { error_code: provider && provider.reason });
  }
  const llm = await llmRewrite(deterministic, {
    chatJson: o.chatJson,
    provider,
    fetchImpl: o.fetchImpl,
    timeoutMs: o.timeoutMs,
    temperature: o.temperature,
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
  deterministicGate,
  llmRewrite,
  evaluatePrePrGate,
  SYSTEM_PROMPT,
};
