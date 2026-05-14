'use strict';

/**
 * mode-a-loop.cjs — Mode A "长程 mentor-driven" loop, deterministic slice.
 *
 * Per CEO 2026-05-14 reframe (plan §2 in
 * docs/superpowers/plans/2026-05-14-mode-ab-reframe.md):
 *
 *   "Mode A 可以简单理解为 mentor 模式 / 小白模式：之后 llm mentor 就可以
 *    按照项目的 goal 以及 cairn.md 来开始设计方案 [...] 实现长程任务的执行".
 *
 * Phase MA-2a (this commit) — deterministic plan drafting only:
 *   1. Read project.active_goal + (optionally) profile.whole_sentence.
 *   2. Draft an execution plan: one step per success_criterion.
 *   3. Persist as scratchpad `mode_a_plan/<project_id>`. Idempotent —
 *      re-running ensurePlan with the same goal_id is a no-op; goal
 *      edits create a new plan_id and supersede the previous.
 *
 * NOT in this slice (deferred to MA-2b):
 *   - Auto-dispatching plan steps via dispatch_requests
 *   - Advancing on outcomes.PASS
 *   - Aggressive Rule D auto-answer (LLM-polished)
 *   - LLM-driven plan polish (deterministic is fine for v0)
 *
 * Read-only contract: this module reads SQLite + writes only to
 * scratchpad (the same surface the kernel uses for nudges /
 * escalations). No new state object, no new MCP tool, no new
 * migration.
 */

const crypto = require('node:crypto');
const cairnLog = require('./cairn-log.cjs');

/**
 * Crockford ULID. Same code path as mentor-policy.newUlid; duplicated
 * here to avoid cross-module coupling for one helper.
 */
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

/**
 * Scratchpad key for a project's active Mode-A plan. One per project.
 * Goal supersession creates a new plan_id INSIDE the value (the key
 * stays stable so the panel can fetch by project_id without indexing).
 */
function planKey(projectId) {
  return `mode_a_plan/${projectId}`;
}

/**
 * Pure plan drafter — given a goal, produce an ordered list of steps.
 * Each success_criterion → one step. Empty / whitespace criteria are
 * dropped. Drift-tolerant: handles goal as string OR {title, ...}.
 */
function planStepsFromGoal(goal) {
  if (!goal) return [];
  // Goal may be a plain string (early profile.goal shape) — synthesize
  // a single step from the whole title. Matches extractGoalTitle
  // semantics in mentor-policy.cjs.
  if (typeof goal === 'string') {
    const t = goal.trim();
    return t ? [{ idx: 0, label: t, state: 'PENDING' }] : [];
  }
  const sc = Array.isArray(goal.success_criteria) ? goal.success_criteria : [];
  const valid = sc
    .map(s => (typeof s === 'string' ? s.trim() : ''))
    .filter(s => s.length > 0);
  return valid.map((label, idx) => ({ idx, label, state: 'PENDING' }));
}

/**
 * Build the initial plan value object. plan_id is regenerated on every
 * call — caller is responsible for supersession logic (see ensurePlan).
 */
function buildPlan(goal, profile, now) {
  return {
    plan_id: newUlid(),
    goal_id: (goal && goal.id) || null,
    goal_title: typeof goal === 'string' ? goal : (goal && goal.title) || null,
    whole_sentence: (profile && profile.whole_sentence) || null,
    status: 'ACTIVE',
    steps: planStepsFromGoal(goal),
    current_idx: 0,
    drafted_at: now,
    updated_at: now,
  };
}

/**
 * Read the current plan, if any. Returns null if scratchpad is absent
 * or value isn't a parseable object.
 */
function getPlan(db, projectId) {
  if (!db) return null;
  try {
    const row = db.prepare('SELECT value_json FROM scratchpad WHERE key = ?').get(planKey(projectId));
    if (!row || !row.value_json) return null;
    return JSON.parse(row.value_json);
  } catch (_e) {
    return null;
  }
}

/**
 * Write (or overwrite) the plan. Caller decides whether to
 * supersede or skip — this is the side-effecting primitive.
 */
function writePlan(db, projectId, plan, now) {
  if (!db) return;
  const key = planKey(projectId);
  const valueJson = JSON.stringify(plan);
  const ts = now || Date.now();
  // Upsert: same shape as mentor-policy emit functions.
  const existing = db.prepare('SELECT key FROM scratchpad WHERE key = ?').get(key);
  if (existing) {
    db.prepare(`UPDATE scratchpad SET value_json = ?, updated_at = ? WHERE key = ?`)
      .run(valueJson, ts, key);
  } else {
    db.prepare(`
      INSERT INTO scratchpad
        (key, value_json, value_path, task_id, expires_at, created_at, updated_at)
      VALUES
        (?, ?, NULL, NULL, NULL, ?, ?)
    `).run(key, valueJson, ts, ts);
  }
}

/**
 * Idempotent plan ensure. Behavior:
 *
 *   - No existing plan + goal present     → draft + write + return { action: 'drafted', plan }
 *   - Existing plan + same goal_id        → no-op + return { action: 'unchanged', plan }
 *   - Existing plan + different goal_id   → draft new + write + return { action: 'superseded', plan, prior_plan_id }
 *   - No goal                             → return { action: 'no_goal' }
 *
 * Logs every action to cairn-log under component 'mode-a-loop'.
 */
function ensurePlan(db, project, goal, profile, opts) {
  const now = (opts && opts.nowFn ? opts.nowFn() : Date.now());
  const projectId = project && project.id;
  if (!projectId) return { action: 'no_project' };
  if (!goal) {
    return { action: 'no_goal', project_id: projectId };
  }
  const existing = getPlan(db, projectId);
  const newGoalId = (typeof goal === 'object' && goal && goal.id) || null;
  const newGoalTitle = typeof goal === 'string'
    ? goal
    : (goal && typeof goal.title === 'string' ? goal.title : null);
  if (existing) {
    // Same-goal short-circuit: prefer goal_id equality (object-shape
    // goals carry a stable id); fall back to title equality so
    // string-shape goals don't superseded-loop every tick — subagent
    // verdict 2026-05-14: A flagged the null/null path.
    const sameById    = existing.goal_id && newGoalId && existing.goal_id === newGoalId;
    const sameByTitle = !existing.goal_id && !newGoalId
                       && existing.goal_title && newGoalTitle
                       && existing.goal_title === newGoalTitle;
    if (sameById || sameByTitle) {
      return { action: 'unchanged', plan: existing, project_id: projectId };
    }
  }
  const plan = buildPlan(goal, profile, now);
  writePlan(db, projectId, plan, now);
  if (existing) {
    cairnLog.info('mode-a-loop', 'plan_superseded', {
      project_id: projectId,
      prior_plan_id: existing.plan_id,
      new_plan_id: plan.plan_id,
      new_goal_id: plan.goal_id,
      steps: plan.steps.length,
    });
    return { action: 'superseded', plan, prior_plan_id: existing.plan_id, project_id: projectId };
  }
  cairnLog.info('mode-a-loop', 'plan_drafted', {
    project_id: projectId,
    plan_id: plan.plan_id,
    goal_id: plan.goal_id,
    steps: plan.steps.length,
  });
  return { action: 'drafted', plan, project_id: projectId };
}

/**
 * Decide whether to dispatch the current step. Pure read; returns one
 * of:
 *   { action: 'dispatch', step, target_agent_id }   — go for it
 *   { action: 'waiting',  step }                    — step DISPATCHED, awaiting outcome
 *   { action: 'plan_complete' }                     — all steps DONE
 *   { action: 'no_steps' }                          — plan empty (no success_criteria)
 *   { action: 'no_agent' }                          — no ACTIVE process to target
 *
 * Target selection: prefer ACTIVE process whose agent_type matches the
 * project leader; fall back to the first ACTIVE process in `agentIds`.
 * Static 'mcp-server' presence rows count — those ARE the agent
 * sessions (claude-code / cursor / aider / etc. each register one).
 */
function decideNextDispatch(db, project, plan, agentIds, opts) {
  if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) {
    return { action: 'no_steps' };
  }
  const idx = typeof plan.current_idx === 'number' ? plan.current_idx : 0;
  if (idx >= plan.steps.length) {
    return { action: 'plan_complete' };
  }
  const step = plan.steps[idx];
  if (!step) return { action: 'plan_complete' };

  // If step already DISPATCHED, the loop's job is to wait for advance —
  // not to re-dispatch. advanceOnComplete handles the transition.
  if (step.state === 'DISPATCHED') {
    return { action: 'waiting', step };
  }
  if (step.state === 'DONE') {
    // Should never happen — current_idx should have advanced past DONE
    // steps. Defensive: treat as plan_complete signal if all subsequent
    // are also DONE; else return waiting on next pending.
    return { action: 'noop', reason: 'current_step_already_done' };
  }
  if (step.state !== 'PENDING') {
    return { action: 'noop', reason: 'unknown_state:' + step.state };
  }

  // Pick target agent. Filter to ACTIVE rows in agentIds.
  if (!Array.isArray(agentIds) || agentIds.length === 0) {
    return { action: 'no_agent' };
  }
  const placeholders = '(' + agentIds.map(() => '?').join(',') + ')';
  let candidates = [];
  try {
    candidates = db.prepare(`
      SELECT agent_id, agent_type
      FROM processes
      WHERE agent_id IN ${placeholders}
        AND status = 'ACTIVE'
      ORDER BY last_heartbeat DESC
    `).all(...agentIds);
  } catch (_e) {
    return { action: 'no_agent' };
  }
  if (candidates.length === 0) {
    return { action: 'no_agent' };
  }
  // Leader-preferred selection.
  //
  // KNOWN LIMITATION (subagent verdict 2026-05-14 D): in production
  // mcp-server registers every session with agent_type='mcp-server'
  // (see packages/mcp-server/src/presence.ts), so this filter never
  // matches a leader like 'claude-code' / 'cursor' / etc. and we always
  // fall through to candidates[0]. The opts.leader plumbing stays as
  // forward-compat for a future kernel change that discriminates by
  // client IDE — likely via the `client:<name>` capability tag, but
  // that requires a kernel-side change to surface it on `processes`.
  // For MA-2c this is documented, not fixed: behavior degrades to
  // "most recently heartbeated ACTIVE session", which is usually right.
  const leader = (opts && opts.leader) || null;
  let chosen = null;
  if (leader) {
    chosen = candidates.find(c => c.agent_type === leader);
  }
  if (!chosen) chosen = candidates[0];
  return {
    action: 'dispatch',
    step,
    step_idx: idx,
    target_agent_id: chosen.agent_id,
  };
}

/**
 * Side-effecting: marks step at idx DISPATCHED with dispatch_id +
 * dispatched_at and rewrites the plan to scratchpad. Caller is
 * responsible for actually creating the dispatch row first (so the
 * dispatch_id is real).
 */
function markStepDispatched(db, projectId, stepIdx, dispatchId, now) {
  const plan = getPlan(db, projectId);
  if (!plan || !Array.isArray(plan.steps)) return null;
  const step = plan.steps[stepIdx];
  if (!step) return null;
  const ts = now || Date.now();
  step.state = 'DISPATCHED';
  step.dispatch_id = dispatchId;
  step.dispatched_at = ts;
  // 2026-05-14: stamp inbox_injected_at synchronously — cockpit-dispatch
  // already wrote agent_inbox by the time markStepDispatched is called
  // (commit f1e88af). The stamp is the signal to reconcileInbox below
  // that this step does NOT need a replay injection. Pre-f1e88af
  // dispatches lack this stamp, so reconciliation will heal them.
  step.inbox_injected_at = ts;
  plan.updated_at = ts;
  writePlan(db, projectId, plan, ts);
  cairnLog.info('mode-a-loop', 'step_dispatched', {
    project_id: projectId,
    plan_id: plan.plan_id,
    step_idx: stepIdx,
    dispatch_id: dispatchId,
  });
  return plan;
}

/**
 * Heal orphan dispatches: any plan step in DISPATCHED state whose
 * inbox_injected_at is missing → re-inject the cockpit-steer message
 * so the agent's polling loop can pick it up. Idempotent on
 * inbox_injected_at — once stamped, subsequent ticks skip the step.
 *
 * Why this exists: dispatchTodo only started writing agent_inbox in
 * commit f1e88af. Pre-f1e88af dispatches sit in dispatch_requests as
 * PENDING with no inbox notification, and since the step is already
 * DISPATCHED, decideNextDispatch won't redispatch. The reconciler is
 * the only path that closes the loop for those stragglers.
 *
 * Returns { reconciled: number, errors: number }.
 */
function reconcileInbox(db, project, opts) {
  const out = { reconciled: 0, errors: 0 };
  if (!db || !project) return out;
  const plan = getPlan(db, project.id);
  if (!plan || !Array.isArray(plan.steps)) return out;
  let dirty = false;
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    if (!step || step.state !== 'DISPATCHED' || !step.dispatch_id) continue;
    if (step.inbox_injected_at) continue;
    let drow = null;
    try {
      drow = db.prepare(
        'SELECT target_agent, nl_intent FROM dispatch_requests WHERE id = ?'
      ).get(step.dispatch_id);
    } catch (_e) { /* skip */ }
    if (!drow || !drow.target_agent) {
      out.errors++;
      continue;
    }
    try {
      const cockpitSteer = require('./cockpit-steer.cjs');
      const tables = opts && opts.tables ? opts.tables : new Set(['scratchpad']);
      const r = cockpitSteer.injectSteer(db, tables, {
        project_id: project.id,
        agent_id: drow.target_agent,
        message: '[Mode A 重补派单/' + step.dispatch_id + '] ' +
                 (step.label || drow.nl_intent || '(unnamed step)'),
        supervisor_id: 'cairn-mode-a-recon',
      });
      if (r.ok) {
        step.inbox_injected_at = Date.now();
        dirty = true;
        out.reconciled++;
        cairnLog.info('mode-a-loop', 'inbox_reconciled', {
          project_id: project.id,
          plan_id: plan.plan_id,
          step_idx: i,
          dispatch_id: step.dispatch_id,
          target_agent_id: drow.target_agent,
        });
      } else {
        out.errors++;
        cairnLog.warn('mode-a-loop', 'inbox_reconcile_failed', {
          project_id: project.id,
          step_idx: i,
          dispatch_id: step.dispatch_id,
          error: r.error,
        });
      }
    } catch (e) {
      out.errors++;
      cairnLog.error('mode-a-loop', 'inbox_reconcile_threw', {
        project_id: project.id,
        step_idx: i,
        message: (e && e.message) || String(e),
      });
    }
  }
  if (dirty) {
    try { writePlan(db, project.id, plan, Date.now()); }
    catch (_e) { /* logged above */ }
  }
  return out;
}

/**
 * Check whether a DISPATCHED step's downstream task has reached a
 * terminal outcome. Returns:
 *   { action: 'advanced', step_idx, to_idx, task_id }
 *   { action: 'failed',   step_idx, task_id }
 *   { action: 'no_change' }
 *
 * Linkage: step.dispatch_id → dispatch_requests.task_id →
 * outcomes(task_id) with status='PASS' (advance) or 'FAILED' (fail).
 * Outcomes 'PENDING' / null → no_change.
 */
function advanceOnComplete(db, projectId, opts) {
  const plan = getPlan(db, projectId);
  if (!plan || !Array.isArray(plan.steps)) return { action: 'no_change' };
  const idx = typeof plan.current_idx === 'number' ? plan.current_idx : 0;
  const step = plan.steps[idx];
  if (!step || step.state !== 'DISPATCHED' || !step.dispatch_id) {
    return { action: 'no_change' };
  }

  let dispatchRow = null;
  try {
    dispatchRow = db.prepare('SELECT task_id FROM dispatch_requests WHERE id = ?').get(step.dispatch_id);
  } catch (_e) {
    return { action: 'no_change' };
  }
  if (!dispatchRow || !dispatchRow.task_id) {
    return { action: 'no_change' };
  }

  let outcomeRow = null;
  try {
    outcomeRow = db.prepare('SELECT status FROM outcomes WHERE task_id = ?').get(dispatchRow.task_id);
  } catch (_e) {
    return { action: 'no_change' };
  }
  if (!outcomeRow || !outcomeRow.status) {
    return { action: 'no_change' };
  }

  const now = (opts && opts.nowFn ? opts.nowFn() : Date.now());
  if (outcomeRow.status === 'PASS') {
    step.state = 'DONE';
    step.completed_at = now;
    step.task_id = dispatchRow.task_id;
    const toIdx = idx + 1;
    plan.current_idx = toIdx;
    plan.updated_at = now;
    if (toIdx >= plan.steps.length) {
      plan.status = 'COMPLETE';
      plan.completed_at = now;
    }
    writePlan(db, projectId, plan, now);
    cairnLog.info('mode-a-loop', 'plan_advanced', {
      project_id: projectId,
      plan_id: plan.plan_id,
      step_idx: idx,
      to_idx: toIdx,
      task_id: dispatchRow.task_id,
      now_complete: plan.status === 'COMPLETE',
    });
    return { action: 'advanced', step_idx: idx, to_idx: toIdx, task_id: dispatchRow.task_id };
  }
  if (outcomeRow.status === 'FAILED' || outcomeRow.status === 'TERMINAL_FAIL') {
    step.state = 'FAILED';
    step.failed_at = now;
    step.task_id = dispatchRow.task_id;
    plan.status = 'BLOCKED';
    plan.updated_at = now;
    writePlan(db, projectId, plan, now);
    cairnLog.warn('mode-a-loop', 'plan_step_failed', {
      project_id: projectId,
      plan_id: plan.plan_id,
      step_idx: idx,
      task_id: dispatchRow.task_id,
      outcome_status: outcomeRow.status,
    });
    return { action: 'failed', step_idx: idx, task_id: dispatchRow.task_id };
  }
  return { action: 'no_change' };
}

/**
 * Per-project tick — called from mentor-tick when project mode === 'A'.
 * Composes ensurePlan → advanceOnComplete → decideNextDispatch.
 *
 * Caller (mentor-tick) is responsible for actually creating the
 * dispatch_requests row (via cockpit-dispatch.dispatchTodo) — we
 * keep that side effect out of this pure-ish module so smoke tests
 * can exercise the decision logic without spinning up the full
 * dispatch validation stack.
 *
 * Returns:
 *   { action: 'drafted' | 'superseded' | 'unchanged' | 'no_goal' | 'no_project' }
 *   plus optionally { advanced: <advanceOnComplete result>, dispatch_request: <decideNextDispatch result> }
 */
function runOnceForProject(deps) {
  const { db, project, goal, profile, agentIds, leader } = deps || {};
  try {
    const planDecision = ensurePlan(db, project, goal, profile, { nowFn: deps.nowFn });
    if (planDecision.action === 'no_goal' || planDecision.action === 'no_project' || planDecision.action === 'error') {
      return planDecision;
    }
    const advanceDecision = advanceOnComplete(db, project.id, { nowFn: deps.nowFn });
    const dispatchDecision = decideNextDispatch(db, project, getPlan(db, project.id), agentIds, { leader });
    return Object.assign({}, planDecision, {
      advance: advanceDecision,
      dispatch_request: dispatchDecision,
    });
  } catch (e) {
    cairnLog.error('mode-a-loop', 'tick_failed', {
      project_id: project && project.id,
      message: (e && e.message) || String(e),
    });
    return { action: 'error', error: (e && e.message) || String(e) };
  }
}

/**
 * Reset stale DISPATCHED steps back to PENDING so the next tick can
 * re-decide (dispatch again or spawn a fresh worker).
 *
 * "Stale" = step.state==='DISPATCHED' AND step.dispatched_at older
 * than `staleMs` AND the linked dispatch_requests row has no task_id
 * (= no agent has actually picked it up via cairn.task.create yet).
 *
 * Increments step.retry_count. Callers (mentor-tick) can read
 * retry_count to escalate after N attempts (e.g. force-spawn a fresh
 * worker rather than re-dispatching to the same idle agent).
 *
 * Why this matters: subagent verdict 2026-05-14 caught the bug where
 * Mode A step 0 went DISPATCHED → forever-waiting → CC never picks
 * up → no outcomes → advanceOnComplete returns no_change → plan
 * frozen. Without this reset, the loop has no recovery path.
 *
 * Returns { reset: number, retry_counts: { step_idx: count } }.
 */
function detectStaleAndReset(db, project, opts) {
  const out = { reset: 0, retry_counts: {} };
  if (!db || !project) return out;
  const plan = getPlan(db, project.id);
  if (!plan || !Array.isArray(plan.steps)) return out;
  const staleMs = (opts && typeof opts.staleMs === 'number') ? opts.staleMs : (3 * 60 * 1000);
  const now = (opts && opts.nowFn ? opts.nowFn() : Date.now());
  let dirty = false;
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    if (!step || step.state !== 'DISPATCHED') continue;
    if (!step.dispatched_at || (now - step.dispatched_at) < staleMs) continue;
    // Check the dispatch_requests row for task_id linkage.
    let dr = null;
    if (step.dispatch_id) {
      try {
        dr = db.prepare('SELECT task_id, status FROM dispatch_requests WHERE id = ?').get(step.dispatch_id);
      } catch (_e) { /* skip */ }
    }
    if (dr && dr.task_id) continue; // agent picked up; not stale
    // Reset.
    const retryCount = (step.retry_count || 0) + 1;
    step.state = 'PENDING';
    step.retry_count = retryCount;
    step.last_stale_reset_at = now;
    // Clear dispatch tracking so a fresh decideNextDispatch round
    // can write new linkage on its next attempt.
    delete step.dispatch_id;
    delete step.dispatched_at;
    delete step.inbox_injected_at;
    dirty = true;
    out.reset++;
    out.retry_counts[i] = retryCount;
    cairnLog.warn('mode-a-loop', 'stale_dispatch_reset', {
      project_id: project.id,
      plan_id: plan.plan_id,
      step_idx: i,
      retry_count: retryCount,
      stale_age_ms: now - (step.dispatched_at || now),
    });
  }
  if (dirty) {
    try {
      plan.updated_at = now;
      writePlan(db, project.id, plan, now);
    } catch (_e) { /* logged above */ }
  }
  return out;
}

module.exports = {
  planKey,
  planStepsFromGoal,
  buildPlan,
  getPlan,
  writePlan,
  ensurePlan,
  decideNextDispatch,
  markStepDispatched,
  advanceOnComplete,
  reconcileInbox,
  detectStaleAndReset,
  runOnceForProject,
};
