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
const mentorProfile = require('./mentor-project-profile.cjs');

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
 * Rule D — BLOCKED with question (3-layer).
 *
 * Trigger: task is BLOCKED + has open blocker.
 *
 * Decision order:
 *   L1.0  profile.known_answers substring match    → nudge with answer (cheapest)
 *   L1.1  profile.authority.escalate match         → escalate (always-escalate wins)
 *   L1.2  profile.authority.auto_decide match      → nudge per L2 brief / matched bullet
 *   L1.3  profile.authority.decide_and_announce    → nudge + announce in Activity
 *   L2    config.knownAnswers legacy map           → nudge (back-compat)
 *   ----  no match anywhere → conservative default → escalate
 *
 * The L3 LLM polish call is intentionally NOT in this synchronous path;
 * see ctx.llmPolish + plan §3 acceptance gate. dogfood-llm-3layer.mjs
 * exercises L3 directly.
 */
function evaluateRuleD_blocked(ctx) {
  const { db, project, task, openBlockers, config, emit, profile, briefs } = ctx;
  if (!task || task.state !== 'BLOCKED' || !openBlockers || openBlockers.length === 0) return null;
  const state = readMentorState(db, task.task_id);
  const fresh = openBlockers.filter(b => b.raised_at > state.last_check_at);
  if (fresh.length === 0) return null;
  const blocker = fresh[0];
  const question = String(blocker.question || '');

  // L1.0 — known_answers from CAIRN.md (cheapest path)
  if (profile && profile.exists) {
    const known = mentorProfile.matchKnownAnswer(profile.known_answers, question);
    if (known) {
      const nudgeKey = emit.nudge({
        message: `Mentor → agent (re: blocker ${blocker.blocker_id}): ${known.answer}`,
        to_agent_id: task.created_by_agent_id || null,
        task_id: task.task_id,
        rule: 'D',
        layer: 'L1',
        source: 'profile.known_answers',
        match_pattern: known.pattern,
      });
      writeMentorState(db, task.task_id, {
        ...state, nudge_count: state.nudge_count + 1,
        last_nudge_at: Date.now(), last_check_at: Date.now(),
      });
      return { rule: 'D', action: 'nudge_from_profile', route: 'auto',
               source: 'profile.known_answers', match_pattern: known.pattern,
               nudge_key: nudgeKey };
    }

    // L1.1 / L1.2 / L1.3 — route by authority bucket
    const routed = routeBySignal(profile, question);
    if (routed.route === 'escalate') {
      const r = emit.escalation({
        reason: 'AGENT_BLOCKED_QUESTION',
        task_id: task.task_id,
        blocker_id: blocker.blocker_id,
        body: question,
        rule: 'D',
        layer: 'L1',
        source: 'profile.authority.escalate',
        matched_bullet: routed.matched_bullet,
      });
      writeMentorState(db, task.task_id, {
        ...state, escalation_count: state.escalation_count + 1, last_check_at: Date.now(),
      });
      return { rule: 'D', action: 'escalate', route: 'escalate',
               source: 'profile.authority.escalate', matched_bullet: routed.matched_bullet,
               escalation: r };
    }
    if (routed.route === 'auto' || routed.route === 'announce') {
      // L2 — use brief lean if available
      const brief = pickBriefForTask(briefs, task);
      const briefLine = brief ? require('./mentor-agent-brief.cjs').briefSnippet(brief.brief) : null;
      const body = composeNudgeBody(
        `Mentor → agent (re: blocker ${blocker.blocker_id}):`,
        briefLine ? 'proceed with your stated lean' : `proceed per CAIRN.md rule`,
        routed.matched_bullet,
        briefLine,
      );
      const nudgeKey = emit.nudge({
        message: body,
        to_agent_id: task.created_by_agent_id || null,
        task_id: task.task_id,
        rule: 'D',
        layer: brief ? 'L2' : 'L1',
        source: routed.route === 'auto' ? 'profile.authority.auto_decide' : 'profile.authority.decide_and_announce',
        matched_bullet: routed.matched_bullet,
        brief_consulted: !!brief,
        brief_stale: brief ? brief.is_stale : false,
        announce: routed.route === 'announce',
      });
      writeMentorState(db, task.task_id, {
        ...state, nudge_count: state.nudge_count + 1,
        last_nudge_at: Date.now(), last_check_at: Date.now(),
      });
      return { rule: 'D', action: 'nudge_from_profile', route: routed.route,
               source: routed.route === 'auto' ? 'profile.authority.auto_decide' : 'profile.authority.decide_and_announce',
               matched_bullet: routed.matched_bullet,
               brief_used: !!brief, brief_stale: brief ? brief.is_stale : false,
               nudge_key: nudgeKey };
    }
    // route === 'unmatched' → fall through to L2 legacy / default
  }

  // L2 legacy — config.knownAnswers map (back-compat for callers without a profile)
  const qLower = question.toLowerCase();
  for (const [pat, ans] of Object.entries(config.knownAnswers || {})) {
    if (pat && qLower.includes(pat.toLowerCase())) {
      const nudgeKey = emit.nudge({
        message: `Mentor → agent (re: blocker ${blocker.blocker_id}): ${ans}`,
        to_agent_id: task.created_by_agent_id || null,
        task_id: task.task_id,
        rule: 'D',
        layer: 'L2-legacy',
        source: 'config.knownAnswers',
        match_pattern: pat,
      });
      writeMentorState(db, task.task_id, {
        ...state, nudge_count: state.nudge_count + 1,
        last_nudge_at: Date.now(), last_check_at: Date.now(),
      });
      return { rule: 'D', action: 'nudge_with_known_answer', nudge_key: nudgeKey, source: 'config.knownAnswers' };
    }
  }

  // No match anywhere → conservative escalate
  const r = emit.escalation({
    reason: 'AGENT_BLOCKED_QUESTION',
    task_id: task.task_id,
    blocker_id: blocker.blocker_id,
    body: question || '(empty question)',
    rule: 'D',
    layer: 'fallback',
    source: profile && profile.exists ? 'profile.unmatched' : 'no_profile',
  });
  writeMentorState(db, task.task_id, {
    ...state, escalation_count: state.escalation_count + 1, last_check_at: Date.now(),
  });
  return { rule: 'D', action: 'escalate', escalation: r,
           source: profile && profile.exists ? 'profile.unmatched' : 'no_profile' };
}

/**
 * Rule E — time budget hit (3-layer).
 *
 * Trigger: task has a budget set (via task.metadata_json.budget_ms or
 * project default) and elapsed >= fraction × budget.
 *
 * 3-layer routing:
 *   L1.1  profile escalate matches "time budget"   → escalate (preserves old default)
 *   L1.2  profile auto_decide matches              → nudge "wrap up / extend per lean"
 *   L1.3  profile announce matches                 → same as L1.2 + announce flag
 *   ----  no profile (or unmatched)                → escalate (back-compat)
 */
function evaluateRuleE_timeBudget(ctx) {
  const { db, project, task, config, emit, profile, briefs } = ctx;
  if (!task) return null;
  const meta = task.metadata_json ? safeJson(task.metadata_json) : {};
  const budget = Number(meta && meta.budget_ms) || config.defaultTaskBudgetMs || 0;
  if (budget <= 0) return null;
  const elapsed = Date.now() - (task.created_at || Date.now());
  if (elapsed < budget * config.timeBudgetEscalationFraction) return null;
  const state = readMentorState(db, task.task_id);
  // Avoid duplicate decisions: once we've decided for this budget,
  // don't re-fire every tick.
  if ((state.escalation_count > 0 || state.nudge_count > 0) && state.last_check_at > task.created_at) return null;

  const elapsedMin = Math.round(elapsed / 60000);
  const budgetMin = Math.round(budget / 60000);
  const pctNum = Math.round((elapsed / budget) * 100);
  const signal = `time budget at ${pctNum}% (${elapsedMin}m / ${budgetMin}m budget)`;

  if (profile && profile.exists) {
    const routed = routeBySignal(profile, 'time budget');
    if (routed.route === 'escalate') {
      const r = emit.escalation({
        reason: 'TIME_BUDGET_NEAR_LIMIT',
        task_id: task.task_id,
        body: `Task has run ${elapsedMin}m vs ${budgetMin}m budget (${pctNum}%).`,
        rule: 'E',
        layer: 'L1',
        source: 'profile.authority.escalate',
        matched_bullet: routed.matched_bullet,
      });
      writeMentorState(db, task.task_id, {
        ...state, escalation_count: state.escalation_count + 1, last_check_at: Date.now(),
      });
      return { rule: 'E', action: 'escalate', escalation: r, route: 'escalate',
               source: 'profile.authority.escalate', matched_bullet: routed.matched_bullet };
    }
    if (routed.route === 'auto' || routed.route === 'announce') {
      const brief = pickBriefForTask(briefs, task);
      const briefLine = brief ? require('./mentor-agent-brief.cjs').briefSnippet(brief.brief) : null;
      const body = composeNudgeBody(
        `${task.task_id}: ${signal} —`,
        briefLine ? 'wrap up per your lean' : 'wrap up or request a budget extension',
        routed.matched_bullet,
        briefLine,
      );
      const nudgeKey = emit.nudge({
        message: body,
        to_agent_id: task.created_by_agent_id || null,
        task_id: task.task_id,
        rule: 'E',
        layer: brief ? 'L2' : 'L1',
        source: routed.route === 'auto' ? 'profile.authority.auto_decide' : 'profile.authority.decide_and_announce',
        matched_bullet: routed.matched_bullet,
        brief_consulted: !!brief,
        brief_stale: brief ? brief.is_stale : false,
        announce: routed.route === 'announce',
      });
      writeMentorState(db, task.task_id, {
        ...state, nudge_count: state.nudge_count + 1, last_nudge_at: Date.now(), last_check_at: Date.now(),
      });
      return { rule: 'E', action: 'nudge_from_profile', route: routed.route,
               source: routed.route === 'auto' ? 'profile.authority.auto_decide' : 'profile.authority.decide_and_announce',
               matched_bullet: routed.matched_bullet,
               brief_used: !!brief, brief_stale: brief ? brief.is_stale : false,
               nudge_key: nudgeKey };
    }
  }

  // No-profile or unmatched → escalate (back-compat with Phase 5 behavior)
  const r = emit.escalation({
    reason: 'TIME_BUDGET_NEAR_LIMIT',
    task_id: task.task_id,
    body: `Task has run ${elapsedMin}m vs ${budgetMin}m budget (${pctNum}%).`,
    rule: 'E',
    layer: 'fallback',
    source: profile && profile.exists ? 'profile.unmatched' : 'no_profile',
  });
  writeMentorState(db, task.task_id, {
    ...state, escalation_count: state.escalation_count + 1, last_check_at: Date.now(),
  });
  return { rule: 'E', action: 'escalate', escalation: r,
           source: profile && profile.exists ? 'profile.unmatched' : 'no_profile' };
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
 * Rule G — outcomes evaluation repeated failure (3-layer).
 *
 * Trigger: task has an outcomes row with status='FAILED' AND task is
 * not at TERMINAL_FAIL. Default: nudge first failure, escalate at
 * `outcomesRetryCap` accumulated escalations.
 *
 * 3-layer routing:
 *   L1.1  profile escalate matches "outcomes" or "tests failing" → escalate immediately
 *   L1.2  profile auto_decide matches                            → nudge "retry" per L2 brief
 *   L1.3  profile announce matches                               → nudge + announce
 *   ----  no profile (or unmatched) → existing nudge-then-escalate behavior
 */
function evaluateRuleG_outcomesFail(ctx) {
  const { db, project, task, outcome, config, emit, profile, briefs } = ctx;
  if (!task || !outcome || outcome.status !== 'FAILED') return null;
  const state = readMentorState(db, task.task_id);

  // L1 — profile routing on "outcomes failed" signal
  if (profile && profile.exists) {
    const signal = 'outcomes evaluation failed';
    const routed = routeBySignal(profile, signal);
    if (routed.route === 'escalate') {
      const r = emit.escalation({
        reason: 'OUTCOMES_REPEATED_FAILURE',
        task_id: task.task_id,
        body: `Outcomes evaluation failed. CAIRN.md says always escalate this category.`,
        rule: 'G',
        layer: 'L1',
        source: 'profile.authority.escalate',
        matched_bullet: routed.matched_bullet,
      });
      writeMentorState(db, task.task_id, {
        ...state, escalation_count: state.escalation_count + 1, last_check_at: Date.now(),
      });
      return { rule: 'G', action: 'escalate', escalation: r, route: 'escalate',
               source: 'profile.authority.escalate', matched_bullet: routed.matched_bullet };
    }
    if (routed.route === 'auto' || routed.route === 'announce') {
      const brief = pickBriefForTask(briefs, task);
      const briefLine = brief ? require('./mentor-agent-brief.cjs').briefSnippet(brief.brief) : null;
      const body = composeNudgeBody(
        `${task.task_id}: outcomes FAILED —`,
        briefLine ? 'retry with your stated next step' : 'retry once with the fix applied, then re-evaluate',
        routed.matched_bullet,
        briefLine,
      );
      const nudgeKey = emit.nudge({
        message: body,
        to_agent_id: task.created_by_agent_id || null,
        task_id: task.task_id,
        rule: 'G',
        layer: brief ? 'L2' : 'L1',
        source: routed.route === 'auto' ? 'profile.authority.auto_decide' : 'profile.authority.decide_and_announce',
        matched_bullet: routed.matched_bullet,
        brief_consulted: !!brief,
        announce: routed.route === 'announce',
      });
      writeMentorState(db, task.task_id, {
        ...state, nudge_count: state.nudge_count + 1, last_nudge_at: Date.now(), last_check_at: Date.now(),
      });
      return { rule: 'G', action: 'nudge_from_profile', route: routed.route,
               source: routed.route === 'auto' ? 'profile.authority.auto_decide' : 'profile.authority.decide_and_announce',
               matched_bullet: routed.matched_bullet,
               brief_used: !!brief, nudge_key: nudgeKey };
    }
    // route === 'unmatched' → fall through to legacy behavior
  }

  // Legacy / fallback path — nudge first, escalate after cap
  if (state.escalation_count >= config.outcomesRetryCap) {
    const r = emit.escalation({
      reason: 'OUTCOMES_REPEATED_FAILURE',
      task_id: task.task_id,
      body: `Outcomes evaluation failed ${state.escalation_count + 1} times. ` +
            `Manual review required before another retry.`,
      rule: 'G',
      layer: 'fallback',
      source: profile && profile.exists ? 'profile.unmatched' : 'no_profile',
    });
    writeMentorState(db, task.task_id, {
      ...state, escalation_count: state.escalation_count + 1, last_check_at: Date.now(),
    });
    return { rule: 'G', action: 'escalate', escalation: r };
  }
  const nudgeKey = emit.nudge({
    message: `${task.task_id}: outcomes FAILED — Mentor 建议重跑一次（修复后）再 evaluate`,
    to_agent_id: task.created_by_agent_id || null,
    task_id: task.task_id,
    rule: 'G',
    layer: 'fallback',
    source: profile && profile.exists ? 'profile.unmatched' : 'no_profile',
  });
  writeMentorState(db, task.task_id, {
    ...state, nudge_count: state.nudge_count + 1, last_nudge_at: Date.now(), last_check_at: Date.now(),
  });
  return { rule: 'G', action: 'nudge', nudge_key: nudgeKey };
}

function safeJson(s) {
  try { return JSON.parse(s); } catch (_e) { return null; }
}

// ---------------------------------------------------------------------------
// 3-layer routing helpers (L1 profile / L2 brief / L3 light LLM polish)
//
// L1 = CAIRN.md profile (see mentor-project-profile.cjs).
// L2 = scratchpad agent_brief/<agent_id> (see mentor-agent-brief.cjs).
// L3 = optional async LLM polish; injected via ctx.llmPolish when
//      the caller (mentor-tick) wants to enable it. Default null —
//      rules degrade gracefully to default-escalate.
// ---------------------------------------------------------------------------

/**
 * Match a free-form signal text against the profile authority buckets.
 * Order: 🛑 escalate → ✅ auto_decide → ⚠️ decide_and_announce.
 * Returns { route, matched_bullet } where route ∈ 'escalate'|'auto'|
 * 'announce'|'unmatched'.
 */
function routeBySignal(profile, signalText) {
  if (!profile || !profile.exists || !signalText) {
    return { route: 'unmatched', matched_bullet: null };
  }
  const text = String(signalText);
  // 🛑 first — always-escalate wins over auto/announce when both match.
  const esc = mentorProfile.matchBucket(profile.authority.escalate, text);
  if (esc) return { route: 'escalate', matched_bullet: esc };
  const auto = mentorProfile.matchBucket(profile.authority.auto_decide, text);
  if (auto) return { route: 'auto', matched_bullet: auto };
  const ann = mentorProfile.matchBucket(profile.authority.decide_and_announce, text);
  if (ann) return { route: 'announce', matched_bullet: ann };
  return { route: 'unmatched', matched_bullet: null };
}

/**
 * Pull the most relevant L2 brief lean for a task: prefer the brief
 * tagged with the current task_id; else the most recently written;
 * else null. Briefs are { agent_id, brief, age_ms, is_stale, ... }.
 */
function pickBriefForTask(briefs, task) {
  if (!Array.isArray(briefs) || briefs.length === 0 || !task) return null;
  const taskId = task.task_id;
  let exact = null;
  let fresh = null;
  let any = null;
  for (const b of briefs) {
    if (!b || !b.brief) continue;
    any = any || b;
    if (b.brief.task_id === taskId) {
      if (!exact || (exact.age_ms || 0) > (b.age_ms || 0)) exact = b;
    }
    if (!fresh || (fresh.age_ms || 0) > (b.age_ms || 0)) fresh = b;
  }
  return exact || fresh || any || null;
}

/**
 * Compose a one-line "Mentor decided X" message body. `decisionText` is
 * what Mentor concluded; `signal` describes why we're being polite about
 * announcing it. `brief` is optional L2 input.
 */
function composeNudgeBody(prefix, decisionText, source, briefLine) {
  const bits = [prefix];
  if (decisionText) bits.push(decisionText);
  if (source) bits.push(`(via ${source})`);
  if (briefLine) bits.push(`— agent lean: ${briefLine}`);
  return bits.join(' ');
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
  // 3-layer routing helpers (exported for tests)
  routeBySignal,
  pickBriefForTask,
  composeNudgeBody,
  // state helpers
  readMentorState,
  writeMentorState,
  emitNudge,
  emitEscalation,
  // public
  evaluatePolicy,
  ackEscalation,
};
