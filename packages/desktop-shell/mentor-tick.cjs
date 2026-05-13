'use strict';

/**
 * Mentor auto-tick — Phase 8 of panel-cockpit-redesign.
 *
 * The "engine" the user named: when you walk away, Cairn's Mentor
 * keeps watching the kernel state and nudges/escalates per the
 * policy table in §5 of the plan.
 *
 * Design:
 *   - One tick runs every TICK_INTERVAL_MS in the Electron main process
 *   - Iterates all registered projects
 *   - For each project: resolves agent_id_hints → finds RUNNING tasks
 *     → gathers kernel-level context for those tasks (open blockers,
 *     latest outcome row, etc.) → calls mentor-policy.evaluatePolicy()
 *     → which writes nudges to scratchpad mentor/<pid>/nudge/* and
 *     escalations to scratchpad escalation/<pid>/*
 *   - Writes propagate into cockpit Module 3 (activity feed) and
 *     Module 5 (needs you) on the next panel poll
 *
 * Tick v1 (today's ship) fires Rules D / E / G — the rules whose
 * context comes purely from kernel state (blockers, time budget,
 * outcomes). Rules B (compile/test errors) and F (abort keywords)
 * need raw agent stdout, which would require tail.log scanning —
 * deferred to tick v2.
 *
 * No new MCP tool, no new schema, no new dependencies.
 */

const TICK_INTERVAL_MS = 30 * 1000;
/** Cap on RUNNING tasks examined per project per tick. Tasks are sorted
 *  by updated_at DESC — most-recent first; deeper backlog evaluated on
 *  subsequent ticks. */
const TASKS_PER_PROJECT_CAP = 10;

let _timer = null;
let _tickCount = 0;
let _lastTickError = null;

/**
 * Run one tick.
 *
 * @param {{
 *   reg: object,
 *   ensureDbHandle: (path) => {db, tables} | null,
 *   projectQueries: object,
 *   mentorPolicy: object,
 *   registry: object,
 *   mentorProfile?: object,    // optional injection for tests; defaults to ./mentor-project-profile.cjs
 *   mentorAgentBrief?: object, // optional injection for tests; defaults to ./mentor-agent-brief.cjs
 *   nowFn?: () => number,
 *   onDecision?: (project_id, decision) => void,
 * }} deps
 *
 * @returns {{ticks_run: number, decisions: number, projects_scanned: number, errors: any[]}}
 */
function runOnce(deps) {
  const now = (deps.nowFn || Date.now)();
  const mentorProfile = deps.mentorProfile || require('./mentor-project-profile.cjs');
  const mentorAgentBrief = deps.mentorAgentBrief || require('./mentor-agent-brief.cjs');
  const out = { ticks_run: 1, decisions: 0, projects_scanned: 0, errors: [] };
  if (!deps.reg || !Array.isArray(deps.reg.projects)) return out;
  for (const project of deps.reg.projects) {
    try {
      // /dev/null / (unknown) sentinel — fall back to default DB.
      let dbPath = project.db_path;
      if (!dbPath || dbPath === '/dev/null' || dbPath === '(unknown)') {
        dbPath = deps.registry.DEFAULT_DB_PATH;
      }
      const entry = deps.ensureDbHandle(dbPath);
      if (!entry) continue;
      out.projects_scanned++;

      const agentIds = deps.projectQueries.resolveProjectAgentIds(entry.db, entry.tables, project);
      const hints = Array.from(agentIds || []);
      if (hints.length === 0) continue;

      // L1: load / refresh the per-project profile (CAIRN.md cache).
      let profile = null;
      try { profile = mentorProfile.loadProfile(entry.db, project); } catch (_e) { profile = null; }

      // L2: read agent_brief scratchpad for any agent associated with this project.
      let briefs = [];
      try { briefs = mentorAgentBrief.readAgentBriefs(entry.db, hints) || []; } catch (_e) { briefs = []; }

      // RUNNING tasks for this project (sorted most-recent updated_at first).
      const placeholders = '(' + hints.map(() => '?').join(',') + ')';
      const tasks = entry.db.prepare(`
        SELECT task_id, intent, state, created_at, updated_at, created_by_agent_id, metadata_json
        FROM tasks
        WHERE created_by_agent_id IN ${placeholders}
          AND state IN ('RUNNING', 'BLOCKED', 'WAITING_REVIEW')
        ORDER BY updated_at DESC
        LIMIT ?
      `).all(...hints, TASKS_PER_PROJECT_CAP);

      for (const task of tasks) {
        // Context for Rule D (BLOCKED + open blockers)
        const openBlockers = entry.tables.has('blockers')
          ? entry.db.prepare(`
              SELECT blocker_id, task_id, question, status, raised_at, answered_at, answer
              FROM blockers
              WHERE task_id = ? AND status = 'OPEN'
              ORDER BY raised_at ASC
            `).all(task.task_id)
          : [];

        // Context for Rule G (outcomes FAILED)
        const outcome = entry.tables.has('outcomes')
          ? entry.db.prepare(`
              SELECT task_id, status, evaluated_at, updated_at
              FROM outcomes
              WHERE task_id = ?
              LIMIT 1
            `).get(task.task_id)
          : null;

        // Rules B + F require raw agent text streams (tail.log / scratchpad
        // raw output). Tick v1 omits them — evaluatePolicy returns null
        // for those rules when context arrays are missing.
        const result = deps.mentorPolicy.evaluatePolicy({
          db: entry.db,
          project,
          task,
          openBlockers,
          outcome,
          profile,
          briefs,
          // recentErrors, recentAgentText omitted in tick v1
        });

        for (const decision of result.decisions) {
          // 'no_action_phase_5' decisions for rules A/C are placeholders;
          // skip them in metrics. Real-fire decisions land in scratchpad
          // via emit.* inside evaluatePolicy.
          if (decision.action === 'no_action_phase_5') continue;
          out.decisions++;
          if (typeof deps.onDecision === 'function') {
            try { deps.onDecision(project.id, decision); } catch (_e) {}
          }
        }
      }
    } catch (e) {
      out.errors.push({ project_id: project && project.id, error: e && e.message ? e.message : String(e) });
    }
  }
  _tickCount++;
  if (out.errors.length > 0) _lastTickError = out.errors[0];
  return out;
}

/**
 * Start the auto-tick loop. Idempotent — calling twice is a no-op (a
 * single timer is kept). Returns a handle with stop() for shutdown +
 * testing.
 */
function start(deps, opts) {
  const o = opts || {};
  if (_timer) return { already_running: true, stop };
  const interval = o.intervalMs || TICK_INTERVAL_MS;
  // Drive the first tick on next event loop turn (don't block boot).
  setImmediate(() => {
    try { runOnce(deps); } catch (_e) {}
  });
  _timer = setInterval(() => {
    try { runOnce(deps); } catch (_e) {}
  }, interval).unref();  // unref so the panel can exit cleanly.
  return { stop };
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

function stats() {
  return { tick_count: _tickCount, last_error: _lastTickError };
}

module.exports = {
  TICK_INTERVAL_MS,
  TASKS_PER_PROJECT_CAP,
  runOnce,
  start,
  stop,
  stats,
};
