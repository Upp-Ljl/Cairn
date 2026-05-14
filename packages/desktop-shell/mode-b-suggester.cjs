'use strict';

/**
 * mode-b-suggester.cjs — Mode B ranked suggestion heuristics.
 *
 * CEO 2026-05-14: "modeB... mentor 按照项目管理的一些原则和方法来指导
 * 用户为用户提一些建议——类似下一步待办的性质——然后用户可以在这个排序的
 * 模块中主动选择去委派哪个任务".
 *
 * MA-3 slice = deterministic suggestion drafting from kernel state.
 * Each tick, the suggester evaluates a small set of project-management
 * heuristics (plan §3.1) and emits `mentor_todo/<project_id>/<ulid>`
 * scratchpad rows that surface in the existing Todolist panel (rendered
 * by panel.js, sorted by priority desc).
 *
 * Heuristics shipped in MA-3:
 *   H1 — running_task_overload:  N >= 2 RUNNING tasks → suggest finish-one-first
 *   H2 — outcomes_repeated_fail: ≥2 FAILED outcomes (per task) → suggest review
 *   H3 — running_task_stale:     RUNNING task with updated_at > 30min ago →
 *                                suggest checkpoint or status check
 *   H4 — agent_proposal_idle:    agent_proposal scratchpad entry with no
 *                                dispatched_to + >5min old → suggest review
 *
 * Idempotence: each heuristic produces a deterministic `signature`
 * (e.g. `running_task_overload:p_a:3`). The suggester de-dupes by
 * looking up existing mentor_todo rows with the same signature in
 * `value_json.signature`. Re-tick is a no-op if signature hasn't
 * changed AND the existing row hasn't been dispatched.
 *
 * Priority ranking (higher fires first in panel render — same scale as
 * existing user_todo entries):
 *   1 = quality-of-life nudge
 *   2 = process hygiene
 *   3 = work blocked / risk of regression
 *   4 = critical / data-loss-adjacent
 */

const crypto = require('node:crypto');
const cairnLog = require('./cairn-log.cjs');

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

const STALE_TASK_MS = 30 * 60 * 1000;   // 30 min — H3
const IDLE_PROPOSAL_MS = 5 * 60 * 1000; // 5 min — H4
const RUNNING_OVERLOAD_THRESHOLD = 2;   // H1

/**
 * H1 — multiple RUNNING tasks → suggest finishing one before starting
 * a third. Returns one suggestion or null.
 */
function suggestRunningOverload(tasks, project, now) {
  const running = tasks.filter(t => t.state === 'RUNNING');
  if (running.length < RUNNING_OVERLOAD_THRESHOLD) return null;
  // Signature does NOT include count (subagent verdict 2026-05-14 A):
  // count fluctuation 3→2→3 would otherwise spawn fresh rows. One row
  // per overload regime is right. Label / why carry the live count.
  return {
    signature: `running_task_overload:${project.id}`,
    label: `${running.length} 个任务同时 RUNNING——优先把最早开始的那个推进到 review，再开新工作`,
    priority: 2,
    why: `process hygiene — switching cost piles up when ${running.length} tasks are active in parallel`,
    rule: 'H1',
  };
}

/**
 * H2 — outcomes table has ≥2 FAILED rows for the same task → suggest
 * stepping back to review test setup / inputs. Returns up to one
 * suggestion per project (the worst-offending task).
 */
function suggestRepeatedFailures(outcomes, project, _now) {
  // Group FAILED by task_id.
  const byTask = new Map();
  for (const o of outcomes) {
    if (o.status !== 'FAILED' && o.status !== 'TERMINAL_FAIL') continue;
    if (!o.task_id) continue;
    const c = byTask.get(o.task_id) || 0;
    byTask.set(o.task_id, c + 1);
  }
  let worstTask = null, worstCount = 0;
  for (const [task_id, count] of byTask.entries()) {
    if (count >= 2 && count > worstCount) {
      worstTask = task_id;
      worstCount = count;
    }
  }
  if (!worstTask) return null;
  return {
    signature: `outcomes_repeated_fail:${project.id}:${worstTask}:${worstCount}`,
    label: `任务 ${worstTask.slice(0, 10)}… 已经失败 ${worstCount} 次——先回头看 test setup 或 inputs，再让 agent 重试`,
    priority: 3,
    why: `repeat failure usually means the rubric or fixture is wrong, not the implementation`,
    rule: 'H2',
    task_id: worstTask,
  };
}

/**
 * H3 — RUNNING task whose updated_at is older than STALE_TASK_MS →
 * suggest a checkpoint or status check (the agent may be stuck).
 */
function suggestStaleRunning(tasks, project, now) {
  // Pick the staleest RUNNING task.
  let oldest = null;
  for (const t of tasks) {
    if (t.state !== 'RUNNING') continue;
    if (typeof t.updated_at !== 'number') continue;
    if (now - t.updated_at < STALE_TASK_MS) continue;
    if (!oldest || t.updated_at < oldest.updated_at) oldest = t;
  }
  if (!oldest) return null;
  const minutes = Math.round((now - oldest.updated_at) / 60000);
  // Signature drops `minutes` (subagent verdict 2026-05-14 #3): otherwise
  // every tick past the 30min threshold produces a new mentor_todo row
  // as minutes ticks up. Keep minutes in the label for context but not
  // in the signature — H3 fires once per stalled task, not once a minute.
  return {
    signature: `running_task_stale:${project.id}:${oldest.task_id}`,
    label: `任务 ${oldest.task_id.slice(0, 10)}… RUNNING 已 ${minutes} 分钟没动——建议 checkpoint 或问 agent 进度`,
    priority: 3,
    why: `silent RUNNING tasks often indicate an undeclared blocker`,
    rule: 'H3',
    task_id: oldest.task_id,
  };
}

/**
 * H4 — agent_proposal scratchpad entries older than IDLE_PROPOSAL_MS
 * with no `dispatched_to` set → suggest reviewing them (probably they
 * piled up while user was away).
 */
function suggestIdleProposals(proposals, project, now) {
  // proposals = scratchpad rows with key starting with agent_proposal/
  let oldest = null;
  let countIdle = 0;
  for (const p of proposals) {
    if (!p.value) continue;
    if (p.value.dispatched_to) continue;
    const ts = p.value.ts || p.value.created_at || 0;
    if (now - ts < IDLE_PROPOSAL_MS) continue;
    countIdle++;
    if (!oldest || ts < oldest.ts) oldest = { key: p.key, ts };
  }
  if (countIdle === 0) return null;
  return {
    signature: `agent_proposal_idle:${project.id}`,
    label: `${countIdle} 个 agent 自荐项已等待 review——花 30 秒过一遍，挑一两个 dispatch 或忽略`,
    priority: 1,
    why: `un-reviewed proposals stagnate; quick triage prevents the queue from rotting`,
    rule: 'H4',
  };
}

/**
 * Top-level orchestrator. Runs all heuristics, returns ordered
 * suggestions array (priority desc). Pure — no I/O.
 */
function rankSuggestions(ctx) {
  const { project, tasks = [], outcomes = [], proposals = [] } = ctx || {};
  const now = ctx.nowFn ? ctx.nowFn() : Date.now();
  const out = [];
  for (const fn of [
    () => suggestRunningOverload(tasks, project, now),
    () => suggestRepeatedFailures(outcomes, project, now),
    () => suggestStaleRunning(tasks, project, now),
    () => suggestIdleProposals(proposals, project, now),
  ]) {
    try {
      const s = fn();
      if (s) out.push(s);
    } catch (e) {
      cairnLog.error('mode-b-suggester', 'heuristic_threw', {
        project_id: project && project.id,
        message: (e && e.message) || String(e),
      });
    }
  }
  out.sort((a, b) => (b.priority || 0) - (a.priority || 0));
  return out;
}

/**
 * Persist new suggestions to scratchpad. Idempotent on `signature`:
 * if a non-dispatched mentor_todo row with the same signature already
 * exists, skip. Returns array of {suggestion, action: 'added'|'skipped'}.
 *
 * Scratchpad key pattern: `mentor_todo/<project_id>/<ulid>`.
 * Value shape compatible with the existing Todolist render path:
 *   { label, source: 'mentor_todo', project_id, priority, why, ts,
 *     signature, rule, task_id? }
 */
function persistSuggestions(db, project, suggestions, opts) {
  if (!db || !project || !Array.isArray(suggestions)) return [];
  const now = (opts && opts.nowFn ? opts.nowFn() : Date.now());
  const out = [];

  // Pre-load all existing mentor_todo rows for this project (cheap —
  // there are usually <50).
  let existingSigs = new Set();
  try {
    const rows = db.prepare(
      `SELECT value_json FROM scratchpad WHERE key LIKE ?`,
    ).all(`mentor_todo/${project.id}/%`);
    for (const r of rows) {
      try {
        const v = JSON.parse(r.value_json || '{}');
        if (v && typeof v.signature === 'string' && !v.dispatched_to) {
          existingSigs.add(v.signature);
        }
      } catch (_e) { /* skip malformed */ }
    }
  } catch (_e) { /* table missing or other transient — fall through */ }

  for (const s of suggestions) {
    if (!s || !s.signature) continue;
    if (existingSigs.has(s.signature)) {
      out.push({ suggestion: s, action: 'skipped', reason: 'same_signature_pending' });
      continue;
    }
    const key = `mentor_todo/${project.id}/${newUlid()}`;
    const value = {
      label: s.label,
      source: 'mentor_todo',
      project_id: project.id,
      priority: s.priority || 1,
      why: s.why || null,
      ts: now,
      signature: s.signature,
      rule: s.rule || null,
      task_id: s.task_id || null,
    };
    try {
      db.prepare(`
        INSERT INTO scratchpad
          (key, value_json, value_path, task_id, expires_at, created_at, updated_at)
        VALUES
          (?, ?, NULL, ?, NULL, ?, ?)
      `).run(key, JSON.stringify(value), s.task_id || null, now, now);
      cairnLog.info('mode-b-suggester', 'suggestion_added', {
        project_id: project.id,
        signature: s.signature,
        priority: s.priority,
        rule: s.rule,
      });
      out.push({ suggestion: s, action: 'added', key });
    } catch (e) {
      cairnLog.error('mode-b-suggester', 'persist_failed', {
        project_id: project.id,
        signature: s.signature,
        message: (e && e.message) || String(e),
      });
      out.push({ suggestion: s, action: 'error', error: (e && e.message) || String(e) });
    }
  }
  return out;
}

/**
 * Per-project tick — called from mentor-tick when project mode === 'B'.
 * Gathers context from db (running tasks, outcomes, idle proposals)
 * then ranks + persists.
 */
function runOnceForProject(deps) {
  const { db, tables, project, agentIds } = deps || {};
  try {
    if (!db || !project) return { action: 'noop', reason: 'no_db_or_project' };
    if (!Array.isArray(agentIds) || agentIds.length === 0) {
      return { action: 'noop', reason: 'no_agent_hints' };
    }
    const hasTables = tables && typeof tables.has === 'function';
    const placeholders = '(' + agentIds.map(() => '?').join(',') + ')';
    // Tasks (running / blocked / waiting_review).
    let tasks = [];
    if (!hasTables || tables.has('tasks')) {
      try {
        tasks = db.prepare(`
          SELECT task_id, state, updated_at
          FROM tasks
          WHERE created_by_agent_id IN ${placeholders}
        `).all(...agentIds);
      } catch (_e) { tasks = []; }
    }
    // Outcomes.
    let outcomes = [];
    if (!hasTables || tables.has('outcomes')) {
      try {
        outcomes = db.prepare(`
          SELECT task_id, status
          FROM outcomes
          WHERE task_id IN (SELECT task_id FROM tasks WHERE created_by_agent_id IN ${placeholders})
        `).all(...agentIds);
      } catch (_e) { outcomes = []; }
    }
    // Agent proposals from scratchpad.
    let proposals = [];
    try {
      const rows = db.prepare(`
        SELECT key, value_json
        FROM scratchpad
        WHERE key LIKE 'agent_proposal/%'
      `).all();
      for (const r of rows) {
        try {
          const v = JSON.parse(r.value_json || '{}');
          if (v && v.project_id === project.id) {
            proposals.push({ key: r.key, value: v });
          }
        } catch (_e) { /* skip */ }
      }
    } catch (_e) { proposals = []; }

    const suggestions = rankSuggestions({
      project, tasks, outcomes, proposals, nowFn: deps.nowFn,
    });
    const results = persistSuggestions(db, project, suggestions, { nowFn: deps.nowFn });
    return {
      action: 'ran',
      suggestions_total: suggestions.length,
      added: results.filter(r => r.action === 'added').length,
      skipped: results.filter(r => r.action === 'skipped').length,
    };
  } catch (e) {
    cairnLog.error('mode-b-suggester', 'tick_failed', {
      project_id: project && project.id,
      message: (e && e.message) || String(e),
    });
    return { action: 'error', error: (e && e.message) || String(e) };
  }
}

module.exports = {
  suggestRunningOverload,
  suggestRepeatedFailures,
  suggestStaleRunning,
  suggestIdleProposals,
  rankSuggestions,
  persistSuggestions,
  runOnceForProject,
  STALE_TASK_MS,
  IDLE_PROPOSAL_MS,
  RUNNING_OVERLOAD_THRESHOLD,
};
