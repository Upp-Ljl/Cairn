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
 * Per-project tick — called from mentor-tick when project mode === 'A'.
 * Reads goal + profile + ensures plan exists. Returns the decision
 * object from ensurePlan so the caller can include it in tick output.
 *
 * Future (MA-2b): also dispatch the current step if no RUNNING task,
 * advance on outcomes PASS, mark COMPLETE / TERMINAL_FAIL.
 */
function runOnceForProject(deps) {
  const { db, project, goal, profile } = deps || {};
  try {
    return ensurePlan(db, project, goal, profile, { nowFn: deps.nowFn });
  } catch (e) {
    cairnLog.error('mode-a-loop', 'tick_failed', {
      project_id: project && project.id,
      message: (e && e.message) || String(e),
    });
    return { action: 'error', error: (e && e.message) || String(e) };
  }
}

module.exports = {
  planKey,
  planStepsFromGoal,
  buildPlan,
  getPlan,
  writePlan,
  ensurePlan,
  runOnceForProject,
};
