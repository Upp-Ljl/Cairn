'use strict';

/**
 * Mentor supervisor — Phase 5 of panel-cockpit-redesign.
 *
 * Implements the escalation policy table from the plan (§5):
 *
 *   Rule A. Ambiguous decision (LLM-judged)        → Phase 6 LLM hook
 *   Rule B. Compile/test error                     → 2 mentor nudges then escalate
 *   Rule C. Off-goal drift (LLM-judged)            → Phase 6 LLM hook (silent nudge then escalate)
 *   Rule D. BLOCKED with question                  → match known pattern → answer; else escalate
 *   Rule E. Time budget hit                        → escalate at 80% of per-task budget
 *   Rule F. User-named abort keywords              → ALWAYS escalate (no Mentor self-resolve)
 *   Rule G. Outcome eval failure                   → 1 retry → escalate on 2nd fail
 *
 * Phase 5 deliverable: rules B / D / E / F / G (deterministic).
 * Rules A / C are stubbed with "no_action_phase_5" decisions; Phase 6
 * wires the LLM helpers (`mentor_llm_off_goal` / `mentor_llm_ambiguity`).
 *
 * State storage: per-task scratchpad key
 *   `mentor_state/<task_id>`
 *   value_json = { nudge_count, last_nudge_at, escalation_count, last_check_at }
 *
 * Nudges write to `mentor/<project_id>/nudge/<ulid>` (consumed by
 * cockpit-state activity feed).
 *
 * Escalations write to `escalation/<project_id>/<ulid>` with status
 * = 'PENDING'. Cockpit Module 5 surfaces them. User ack flips status
 * to 'ACKED' via cockpitAckEscalation (cockpit-mentor.cjs).
 *
 * Strict read+write to scratchpad only. Does NOT touch tasks /
 * blockers / outcomes tables — those are the kernel's domain.
 */

const crypto = require('node:crypto');

const ENC = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function newUlid() {
  const ts = Date.now();
  let timePart = '';
  let n = ts;
  for (let i = 9; i >= 0; i--) {
    timePart = ENC[n % 32] + timePart;
    n = Math.floor(n / 32);
  }
  const rand = crypto.randomBytes(10);
  let randPart = '';
  for (let i = 0; i < 16; i++) {
    randPart += ENC[rand[i % 10] % 32];
  }
  return timePart + randPart;
}

// ---------------------------------------------------------------------------
// Configuration (per-project defaults; phase 6 plugs settings UI)
// ---------------------------------------------------------------------------

const DEFAULTS = Object.freeze({
  // Rule B: compile/test error tolerance before escalation.
  errorNudgeCap: 2,
  // Rule E: escalate at this fraction of task time budget.
  timeBudgetEscalationFraction: 0.80,
  // Rule E: default time budget per task (ms). 0 = no budget.
  defaultTaskBudgetMs: 0,
  // Rule G: outcomes retry budget.
  outcomesRetryCap: 1,
  // Rule F: abort keywords — case-insensitive substring match against
  // any agent-emitted text (committed message / stderr / response).
  abortKeywords: ['rm -rf', 'force push', 'force-push', '--force', 'DROP TABLE', 'TRUNCATE TABLE'],
  // Rule D: known-pattern auto-answer cache. Keys are normalized question
  // substrings; values are the canonical answer Mentor returns. Empty
  // by default — populated by the project via cairn.mentor.knownAnswer
  // (not exposed in Phase 5; placeholder).
  knownAnswers: {},
});

// ---------------------------------------------------------------------------
// Scratchpad helpers
// ---------------------------------------------------------------------------

function readMentorState(db, taskId) {
  const row = db.prepare(`
    SELECT value_json FROM scratchpad WHERE key = ?
  `).get(`mentor_state/${taskId}`);
  if (!row) return { nudge_count: 0, escalation_count: 0, last_nudge_at: 0, last_check_at: 0 };
  try {
    const j = JSON.parse(row.value_json);
    return {
      nudge_count: Number(j.nudge_count) || 0,
      escalation_count: Number(j.escalation_count) || 0,
      last_nudge_at: Number(j.last_nudge_at) || 0,
      last_check_at: Number(j.last_check_at) || 0,
    };
  } catch (_e) {
    return { nudge_count: 0, escalation_count: 0, last_nudge_at: 0, last_check_at: 0 };
  }
}

function writeMentorState(db, taskId, state) {
  const now = Date.now();
  const v = JSON.stringify(state);
  db.prepare(`
    INSERT INTO scratchpad (key, value_json, value_path, task_id, expires_at, created_at, updated_at)
    VALUES (?, ?, NULL, ?, NULL, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
  `).run(`mentor_state/${taskId}`, v, taskId, now, now);
}

function emitNudge(db, projectId, payload) {
  const now = Date.now();
  const key = `mentor/${projectId}/nudge/${newUlid()}`;
  db.prepare(`
    INSERT INTO scratchpad (key, value_json, value_path, task_id, expires_at, created_at, updated_at)
    VALUES (?, ?, NULL, ?, NULL, ?, ?)
  `).run(
    key,
    JSON.stringify({ ...payload, ts: now, source: 'mentor-policy' }),
    payload.task_id || null,
    now, now,
  );
  return key;
}

function emitEscalation(db, projectId, payload) {
  const now = Date.now();
  const escId = newUlid();
  const key = `escalation/${projectId}/${escId}`;
  db.prepare(`
    INSERT INTO scratchpad (key, value_json, value_path, task_id, expires_at, created_at, updated_at)
    VALUES (?, ?, NULL, ?, NULL, ?, ?)
  `).run(
    key,
    JSON.stringify({ ...payload, status: 'PENDING', created_at: now, source: 'mentor-policy' }),
    payload.task_id || null,
    now, now,
  );
  return { key, id: escId };
}

// ---------------------------------------------------------------------------
// Rule implementations (all pure-of-side-effects except they call the
// emit*/writeMentorState helpers above — caller-injectable for tests)
// ---------------------------------------------------------------------------

/**
 * Rule B — repeated compile/test errors.
 *
 * Trigger: same task has emitted ≥ N error-state events since the last
 * Mentor nudge. Action: nudge once if under cap, escalate at cap.
 */
function evaluateRuleB_errorRepetition(ctx) {
  const { db, project, task, recentErrors, config, emit } = ctx;
  if (!task || !recentErrors || recentErrors.length === 0) return null;
  const state = readMentorState(db, task.task_id);
  const newErrors = recentErrors.filter(e => e.ts > state.last_check_at);
  if (newErrors.length === 0) return null;

  if (state.nudge_count >= config.errorNudgeCap) {
    const r = emit.escalation({
      reason: 'AGENT_ERROR_REPEATED',
      task_id: task.task_id,
      body: `Agent has hit ${state.nudge_count + 1} errors on this task without progress. ` +
            `Latest: ${(newErrors[newErrors.length - 1].body || '').slice(0, 200)}`,
      rule: 'B',
    });
    writeMentorState(db, task.task_id, {
      ...state,
      escalation_count: state.escalation_count + 1,
      last_check_at: Date.now(),
    });
    return { rule: 'B', action: 'escalate', escalation: r };
  }

  const msg =
    state.nudge_count === 0
      ? `${task.task_id}: 检测到测试/编译错误，建议先看错误信息再继续`
      : `${task.task_id}: 还在卡在同样问题，要不要换个思路？`;
  const nudgeKey = emit.nudge({
    message: msg,
    to_agent_id: task.created_by_agent_id || null,
    task_id: task.task_id,
    rule: 'B',
  });
  writeMentorState(db, task.task_id, {
    ...state,
    nudge_count: state.nudge_count + 1,
    last_nudge_at: Date.now(),
    last_check_at: Date.now(),
  });
  return { rule: 'B', action: 'nudge', nudge_key: nudgeKey };
}

/**
 * Rule D — BLOCKED with question.
 *
 * Trigger: task is BLOCKED + has open blocker. Action: match question
 * substring against config.knownAnswers; on match → emit nudge with
 * answer; on no-match → escalate.
 */
function evaluateRuleD_blocked(ctx) {
  const { db, project, task, openBlockers, config, emit } = ctx;
  if (!task || task.state !== 'BLOCKED' || !openBlockers || openBlockers.length === 0) return null;
  // Only consider blockers we haven't decided on yet.
  const state = readMentorState(db, task.task_id);
  const fresh = openBlockers.filter(b => b.raised_at > state.last_check_at);
  if (fresh.length === 0) return null;
  const blocker = fresh[0];
  const q = (blocker.question || '').toLowerCase();

  // Try known-answer match.
  for (const [pat, ans] of Object.entries(config.knownAnswers || {})) {
    if (pat && q.includes(pat.toLowerCase())) {
      const nudgeKey = emit.nudge({
        message: `Mentor → agent (re: blocker ${blocker.blocker_id}): ${ans}`,
        to_agent_id: task.created_by_agent_id || null,
        task_id: task.task_id,
        rule: 'D',
        match_pattern: pat,
      });
      writeMentorState(db, task.task_id, {
        ...state,
        nudge_count: state.nudge_count + 1,
        last_nudge_at: Date.now(),
        last_check_at: Date.now(),
      });
      return { rule: 'D', action: 'nudge_with_known_answer', nudge_key: nudgeKey };
    }
  }

  // No pattern match → escalate.
  const r = emit.escalation({
    reason: 'AGENT_BLOCKED_QUESTION',
    task_id: task.task_id,
    blocker_id: blocker.blocker_id,
    body: blocker.question || '(empty question)',
    rule: 'D',
  });
  writeMentorState(db, task.task_id, {
    ...state,
    escalation_count: state.escalation_count + 1,
    last_check_at: Date.now(),
  });
  return { rule: 'D', action: 'escalate', escalation: r };
}

/**
 * Rule E — time budget hit.
 *
 * Trigger: task has a budget set (via task.metadata_json.budget_ms or
 * project default) and elapsed >= fraction × budget. Action: escalate.
 */
function evaluateRuleE_timeBudget(ctx) {
  const { db, project, task, config, emit } = ctx;
  if (!task) return null;
  const meta = task.metadata_json ? safeJson(task.metadata_json) : {};
  const budget = Number(meta && meta.budget_ms) || config.defaultTaskBudgetMs || 0;
  if (budget <= 0) return null;
  const elapsed = Date.now() - (task.created_at || Date.now());
  if (elapsed < budget * config.timeBudgetEscalationFraction) return null;
  const state = readMentorState(db, task.task_id);
  // Avoid duplicate escalations: once we've escalated for this budget,
  // don't re-escalate every tick.
  if (state.escalation_count > 0 && state.last_check_at > task.created_at) return null;
  const r = emit.escalation({
    reason: 'TIME_BUDGET_NEAR_LIMIT',
    task_id: task.task_id,
    body: `Task has run ${Math.round(elapsed / 60000)}m vs ${Math.round(budget / 60000)}m budget` +
          ` (${Math.round((elapsed / budget) * 100)}%).`,
    rule: 'E',
  });
  writeMentorState(db, task.task_id, {
    ...state,
    escalation_count: state.escalation_count + 1,
    last_check_at: Date.now(),
  });
  return { rule: 'E', action: 'escalate', escalation: r };
}

/**
 * Rule F — abort keywords.
 *
 * Trigger: any agent-emitted text in recent events contains an abort
 * keyword. Action: ALWAYS escalate; never Mentor-resolve. This is
 * the destructive-action tripwire.
 */
function evaluateRuleF_abortKeywords(ctx) {
  const { db, project, task, recentAgentText, config, emit } = ctx;
  if (!task || !recentAgentText) return null;
  const corpus = (recentAgentText || []).join('\n').toLowerCase();
  const hits = [];
  for (const kw of config.abortKeywords) {
    if (corpus.includes(kw.toLowerCase())) hits.push(kw);
  }
  if (hits.length === 0) return null;
  const state = readMentorState(db, task.task_id);
  const r = emit.escalation({
    reason: 'ABORT_KEYWORD_DETECTED',
    task_id: task.task_id,
    body: `Agent plan contains abort keyword(s): ${hits.join(', ')}. Mentor refuses to auto-resolve.`,
    keywords_matched: hits,
    rule: 'F',
  });
  writeMentorState(db, task.task_id, {
    ...state,
    escalation_count: state.escalation_count + 1,
    last_check_at: Date.now(),
  });
  return { rule: 'F', action: 'escalate', escalation: r };
}

/**
 * Rule G — outcomes evaluation repeated failure.
 *
 * Trigger: task has an outcomes row with status='FAILED' AND task is
 * not at TERMINAL_FAIL. Phase 5 simplification: escalate after `outcomesRetryCap`
 * accumulated failures (counted via mentor_state.escalation_count).
 */
function evaluateRuleG_outcomesFail(ctx) {
  const { db, project, task, outcome, config, emit } = ctx;
  if (!task || !outcome || outcome.status !== 'FAILED') return null;
  const state = readMentorState(db, task.task_id);
  if (state.escalation_count >= config.outcomesRetryCap) {
    const r = emit.escalation({
      reason: 'OUTCOMES_REPEATED_FAILURE',
      task_id: task.task_id,
      body: `Outcomes evaluation failed ${state.escalation_count + 1} times. ` +
            `Manual review required before another retry.`,
      rule: 'G',
    });
    writeMentorState(db, task.task_id, {
      ...state,
      escalation_count: state.escalation_count + 1,
      last_check_at: Date.now(),
    });
    return { rule: 'G', action: 'escalate', escalation: r };
  }
  const nudgeKey = emit.nudge({
    message: `${task.task_id}: outcomes FAILED — Mentor 建议重跑一次（修复后）再 evaluate`,
    to_agent_id: task.created_by_agent_id || null,
    task_id: task.task_id,
    rule: 'G',
  });
  writeMentorState(db, task.task_id, {
    ...state,
    nudge_count: state.nudge_count + 1,
    last_nudge_at: Date.now(),
    last_check_at: Date.now(),
  });
  return { rule: 'G', action: 'nudge', nudge_key: nudgeKey };
}

function safeJson(s) {
  try { return JSON.parse(s); } catch (_e) { return null; }
}

// ---------------------------------------------------------------------------
// Public API: evaluatePolicy
// ---------------------------------------------------------------------------

/**
 * Evaluate all active rules against a task's current context.
 *
 * @param {object} ctx
 * @param {Database} ctx.db
 * @param {object} ctx.project        { id, ... }
 * @param {object} ctx.task           latest tasks row
 * @param {Array<{ts,body}>} [ctx.recentErrors]   for Rule B
 * @param {Array<{blocker_id,question,raised_at}>} [ctx.openBlockers]   for Rule D
 * @param {Array<string>} [ctx.recentAgentText]   for Rule F
 * @param {object|null} [ctx.outcome] for Rule G
 * @param {object} [ctx.config]
 *
 * @returns {{decisions: Array<{rule, action, ...}>}}
 */
function evaluatePolicy(ctx) {
  const config = Object.assign({}, DEFAULTS, ctx.config || {});
  const projectId = ctx.project && ctx.project.id;
  if (!projectId) return { decisions: [] };
  const emit = {
    nudge: (payload) => emitNudge(ctx.db, projectId, payload),
    escalation: (payload) => emitEscalation(ctx.db, projectId, payload),
  };
  const fullCtx = { ...ctx, config, emit };
  const decisions = [];
  // Order matters: Rule F (abort keyword) is highest priority, then D
  // (BLOCKED), then E (time), B (errors), G (outcomes). A/C deferred to
  // Phase 6 LLM hooks; we return placeholder decisions so callers see
  // the gap.
  for (const evaluator of [
    evaluateRuleF_abortKeywords,
    evaluateRuleD_blocked,
    evaluateRuleE_timeBudget,
    evaluateRuleB_errorRepetition,
    evaluateRuleG_outcomesFail,
  ]) {
    const r = evaluator(fullCtx);
    if (r) decisions.push(r);
  }
  // Phase 6 stubs:
  decisions.push({ rule: 'A', action: 'no_action_phase_5', note: 'ambiguous-decision rule defers to LLM helper (Phase 6)' });
  decisions.push({ rule: 'C', action: 'no_action_phase_5', note: 'off-goal-drift rule defers to LLM helper (Phase 6)' });
  return { decisions };
}

/**
 * Ack an escalation (Module 5 UI action). Flips status PENDING → ACKED
 * and stamps acked_at.
 *
 * @returns {{ok, error?}}
 */
function ackEscalation(db, projectId, escalationId) {
  if (!db || !projectId || !escalationId) {
    return { ok: false, error: 'project_id_escalation_id_required' };
  }
  const key = `escalation/${projectId}/${escalationId}`;
  const row = db.prepare('SELECT value_json FROM scratchpad WHERE key = ?').get(key);
  if (!row) return { ok: false, error: 'escalation_not_found' };
  let body;
  try { body = JSON.parse(row.value_json); } catch (_e) {
    return { ok: false, error: 'escalation_body_malformed' };
  }
  body.status = 'ACKED';
  body.acked_at = Date.now();
  db.prepare('UPDATE scratchpad SET value_json = ?, updated_at = ? WHERE key = ?')
    .run(JSON.stringify(body), Date.now(), key);
  return { ok: true, key };
}

module.exports = {
  DEFAULTS,
  newUlid,
  // sub-evaluators (exported for tests)
  evaluateRuleB_errorRepetition,
  evaluateRuleD_blocked,
  evaluateRuleE_timeBudget,
  evaluateRuleF_abortKeywords,
  evaluateRuleG_outcomesFail,
  // state helpers
  readMentorState,
  writeMentorState,
  emitNudge,
  emitEscalation,
  // public
  evaluatePolicy,
  ackEscalation,
};
