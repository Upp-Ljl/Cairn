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
/** Cap on tasks per tick that get a Rule C (off-goal LLM judge) call.
 *  Each call burns a cheap-model token budget; we don't want a 10-task
 *  project to burn 10 LLM calls per tick. Sorted by updated_at DESC so
 *  the most-recently-active task is judged first. */
const RULE_C_CALLS_PER_TICK = 2;
/** Recent task transitions feed for Rule C off-goal judge. */
const RECENT_ACTIVITY_TRANSITION_CAP = 5;
/** Recent commits feed for Rule C off-goal judge. */
const RECENT_ACTIVITY_COMMIT_CAP = 3;

let _timer = null;
let _tickCount = 0;
let _lastTickError = null;

function safeRequire(spec) {
  try { return require(spec); } catch (_e) { return null; }
}

/**
 * Gather recent agent activity for a project — feeds Rule C off-goal judge.
 *
 * Reads:
 *   - last N task transitions (updated_at DESC) across all hint agents
 *   - last N commit subject lines from git log (project.path), via spawnSync
 *
 * Both are best-effort: missing tables or missing git binary degrade to
 * empty arrays. Safe to call every tick.
 *
 * @returns {{ transitions: Array, commits: Array }}
 */
function gatherRecentActivity(input) {
  const { db, project, hints, transitionCap = 5, commitCap = 3, spawnSync } = input;
  const out = { transitions: [], commits: [] };
  try {
    if (db && Array.isArray(hints) && hints.length > 0) {
      const placeholders = '(' + hints.map(() => '?').join(',') + ')';
      out.transitions = db.prepare(`
        SELECT task_id, intent, state, updated_at
        FROM tasks
        WHERE created_by_agent_id IN ${placeholders}
        ORDER BY updated_at DESC
        LIMIT ?
      `).all(...hints, transitionCap);
    }
  } catch (_e) { /* missing tasks table or bad hints — leave empty */ }
  try {
    const path = project && (project.path || project.root || project.project_root);
    if (path) {
      const spawn = spawnSync || require('node:child_process').spawnSync;
      const res = spawn('git', ['-C', path, 'log', `-n${commitCap}`, '--pretty=format:%H\t%s\t%ct'], {
        encoding: 'utf8', timeout: 5000,
      });
      if (res && res.status === 0 && res.stdout) {
        out.commits = res.stdout.split('\n').filter(Boolean).map(line => {
          const [hash, subject, ct] = line.split('\t');
          return { hash, subject: subject || '', ts: Number(ct) * 1000 || 0 };
        });
      }
    }
  } catch (_e) { /* git not on PATH or non-repo — empty commits */ }
  return out;
}

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
  // Rule C off-goal helper is optional — when omitted, the tick simply
  // doesn't fire Rule C. Pass `deps.ruleCEnabled === false` to disable
  // even when a helper is available (per-project gate).
  const llmHelpers = deps.llmHelpers === undefined
    ? safeRequire('./cockpit-llm-helpers.cjs')
    : deps.llmHelpers;
  const ruleCEnabled = deps.ruleCEnabled !== false && !!llmHelpers && typeof llmHelpers.judgeOffGoal === 'function';
  const out = { ticks_run: 1, decisions: 0, projects_scanned: 0, errors: [], rule_c_pending: [] };
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
          // 'no_action_phase_5' decisions for rule A is a placeholder;
          // 'deferred_to_async_caller' is rule C's async marker (we fire
          // it below in a separate await chain). Skip both in metrics.
          if (decision.action === 'no_action_phase_5') continue;
          if (decision.action === 'deferred_to_async_caller') continue;
          out.decisions++;
          if (typeof deps.onDecision === 'function') {
            try { deps.onDecision(project.id, decision); } catch (_e) {}
          }
        }
      }

      // ----- Rule C (off-goal drift) — async, fire-and-track per tick.
      // Only fires when: helper available + profile.whole_sentence + this
      // project has at least one RUNNING task. Budgeted to N calls per
      // tick to keep token cost bounded.
      if (ruleCEnabled && profile && profile.exists && profile.whole_sentence) {
        const runningTasks = tasks.filter(t => t.state === 'RUNNING').slice(0, RULE_C_CALLS_PER_TICK);
        if (runningTasks.length > 0) {
          const recentActivity = gatherRecentActivity({
            db: entry.db, project, hints,
            transitionCap: RECENT_ACTIVITY_TRANSITION_CAP,
            commitCap: RECENT_ACTIVITY_COMMIT_CAP,
            spawnSync: deps.spawnSync,
          });
          for (const task of runningTasks) {
            const p = (async () => {
              try {
                const decision = await deps.mentorPolicy.evaluateRuleC_offGoal({
                  db: entry.db,
                  project, task, profile,
                  recentActivity,
                  config: Object.assign({}, deps.mentorPolicy.DEFAULTS, deps.policyConfig || {}),
                  emit: {
                    nudge: (payload) => deps.mentorPolicy.emitNudge(entry.db, project.id, payload),
                    escalation: (payload) => deps.mentorPolicy.emitEscalation(entry.db, project.id, payload),
                  },
                  llmJudgeOffGoal: (input) => llmHelpers.judgeOffGoal(input, deps.llmOpts || {}),
                  nowFn: deps.nowFn,
                });
                if (decision && decision.action && decision.action !== 'on_path'
                    && decision.action !== 'strike' && decision.action !== 'helper_skipped') {
                  out.decisions++;
                  if (typeof deps.onDecision === 'function') {
                    try { deps.onDecision(project.id, decision); } catch (_e) {}
                  }
                }
                return decision;
              } catch (e) {
                return { rule: 'C', action: 'tick_exception', error: (e && e.message) || String(e) };
              }
            })();
            out.rule_c_pending.push(p);
          }
        }
      }

      // ----- Mode B slice 3: lane review detection.
      // For each PENDING/RUNNING lane, check if current candidate task
      // is WAITING_REVIEW. If so, transition lane state to REVIEW + emit
      // a Mentor nudge so the user sees "Lane X ready for your review".
      // Lane NEVER auto-advances past REVIEW (§1.3 #4a) — user must click.
      try {
        const cockpitLane = deps.cockpitLane || require('./cockpit-lane.cjs');
        const lanes = cockpitLane.queryLanes(entry.db, project.id, { limit: 20 });
        for (const L of lanes) {
          if (L.state !== 'PENDING' && L.state !== 'RUNNING') continue;
          if (!Array.isArray(L.candidates) || L.candidates.length === 0) continue;
          const currentTaskId = L.candidates[L.current_idx];
          if (!currentTaskId) continue;
          let taskRow = null;
          try {
            taskRow = entry.db.prepare('SELECT task_id, state FROM tasks WHERE task_id = ?').get(currentTaskId);
          } catch (_e) { /* tasks table missing — skip */ }
          if (!taskRow) continue;
          if (taskRow.state !== 'WAITING_REVIEW') continue;
          // Transition lane → REVIEW + emit mentor nudge once.
          const updated = Object.assign({}, L, { state: 'REVIEW', updated_at: Date.now() });
          try {
            entry.db.prepare(`UPDATE scratchpad SET value_json = ?, updated_at = ? WHERE key = ?`)
              .run(JSON.stringify(updated), Date.now(), cockpitLane.laneKey(project.id, L.id));
            deps.mentorPolicy.emitNudge(entry.db, project.id, {
              message: `Lane ${L.id.slice(0, 10)}… candidate ${currentTaskId} ready for your review (${L.current_idx + 1}/${L.candidates.length})`,
              to_agent_id: null,
              task_id: currentTaskId,
              rule: 'B-mode',
              layer: 'lane',
              source: 'mode-b-tick',
              lane_id: L.id,
            });
            out.decisions++;
            if (typeof deps.onDecision === 'function') {
              try { deps.onDecision(project.id, { rule: 'B-mode', action: 'lane_to_review', lane_id: L.id, task_id: currentTaskId }); } catch (_e) {}
            }
          } catch (_e) { /* skip — non-fatal */ }
        }
      } catch (_e) { /* lane module missing or other transient — ignore */ }
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
  RULE_C_CALLS_PER_TICK,
  RECENT_ACTIVITY_TRANSITION_CAP,
  RECENT_ACTIVITY_COMMIT_CAP,
  runOnce,
  start,
  stop,
  stats,
  gatherRecentActivity,
};
