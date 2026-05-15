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

const cairnLog = require('./cairn-log.cjs');
const modeALoop = require('./mode-a-loop.cjs');
const modeAAutoAnswer = require('./mode-a-auto-answer.cjs');
const modeBSuggester = require('./mode-b-suggester.cjs');
const harnessGc = require('./harness-gc.cjs');

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
  } catch (_e) { cairnLog.warn('mentor-tick', 'tasks_query_failed', { message: (_e && _e.message) || String(_e) }); }
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
  } catch (_e) { cairnLog.debug('mentor-tick', 'git_log_unavailable', { message: (_e && _e.message) || String(_e) }); }
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

  // Harness GC: reap stale processes + recover orphaned tasks.
  // Runs once per tick (30s), not per project. Uses the first available DB handle.
  if (deps.reg.projects.length > 0) {
    try {
      const firstProject = deps.reg.projects[0];
      let gcDbPath = firstProject.db_path;
      if (!gcDbPath || gcDbPath === '/dev/null' || gcDbPath === '(unknown)') {
        gcDbPath = deps.registry.DEFAULT_DB_PATH;
      }
      const gcEntry = deps.ensureDbHandle(gcDbPath);
      if (gcEntry && gcEntry.db) {
        const reaped = harnessGc.reapStaleProcesses(gcEntry.db, { nowFn: deps.nowFn });
        if (reaped.reaped > 0) {
          cairnLog.info('harness-gc', 'processes_reaped', { count: reaped.reaped, agent_ids: reaped.agent_ids });
        }
        const recovered = harnessGc.recoverOrphanedTasks(gcEntry.db, { nowFn: deps.nowFn });
        if (recovered.recovered > 0) {
          cairnLog.info('harness-gc', 'tasks_recovered', { count: recovered.recovered, task_ids: recovered.task_ids });
        }
      }
    } catch (_e) {
      cairnLog.warn('harness-gc', 'gc_tick_failed', { message: (_e && _e.message) || String(_e) });
    }
  }

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
      try { profile = mentorProfile.loadProfile(entry.db, project); } catch (_e) { cairnLog.warn('mentor-tick', 'profile_load_failed', { project_id: project.id, message: (_e && _e.message) || String(_e) }); profile = null; }

      // L2: read agent_brief scratchpad for any agent associated with this project.
      let briefs = [];
      try { briefs = mentorAgentBrief.readAgentBriefs(entry.db, hints) || []; } catch (_e) { cairnLog.warn('mentor-tick', 'briefs_read_failed', { message: (_e && _e.message) || String(_e) }); briefs = []; }

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
            try { deps.onDecision(project.id, decision); } catch (_e) { cairnLog.warn('mentor-tick', 'onDecision_callback_failed', { message: (_e && _e.message) || String(_e) }); }
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
                  cairnLog.info('mentor-tick', 'rule_decision', {
                    project_id: project.id,
                    task_id: task.task_id,
                    rule: decision.rule || 'C',
                    action: decision.action,
                  });
                  if (typeof deps.onDecision === 'function') {
                    try { deps.onDecision(project.id, decision); } catch (_e) { cairnLog.warn('mentor-tick', 'onDecision_callback_failed', { message: (_e && _e.message) || String(_e) }); }
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
          } catch (_e) { cairnLog.warn('mentor-tick', 'tasks_table_query_failed', { message: (_e && _e.message) || String(_e) }); }
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
              try { deps.onDecision(project.id, { rule: 'B-mode', action: 'lane_to_review', lane_id: L.id, task_id: currentTaskId }); } catch (_e) { cairnLog.warn('mentor-tick', 'onDecision_callback_failed', { message: (_e && _e.message) || String(_e) }); }
            }
          } catch (_e) { cairnLog.warn('mentor-tick', 'lane_review_failed', { message: (_e && _e.message) || String(_e) }); }
        }
      } catch (_e) { cairnLog.debug('mentor-tick', 'lane_module_unavailable', { message: (_e && _e.message) || String(_e) }); }

      // ----- Mode A loop (CEO 2026-05-14): "长程任务的执行" path.
      // Per-project: only fire when cockpit_settings.mode === 'A'.
      // MA-2a slice = deterministic plan drafting only. Re-runs are
      // idempotent against goal_id (see mode-a-loop.ensurePlan).
      try {
        const cockpitSettings = deps.registry.getCockpitSettings(deps.reg, project.id);
        if (cockpitSettings && cockpitSettings.mode === 'A') {
          const goal = deps.registry.getProjectGoal(deps.reg, project.id);
          // 2026-05-14 subagent verdict: per-project tick summary so
          // future "Mode A 没反应" sessions can grep one log line to
          // see all 6 conditions at once: mode / has_goal / sc_count
          // / agentIds / active_candidates / has_plan.
          try {
            const scCount = goal && Array.isArray(goal.success_criteria)
              ? goal.success_criteria.filter(s => typeof s === 'string' && s.trim().length > 0).length
              : 0;
            let activeCandidates = 0;
            if (entry.tables.has('processes') && hints.length > 0) {
              const phs = '(' + hints.map(() => '?').join(',') + ')';
              try {
                activeCandidates = entry.db.prepare(
                  `SELECT COUNT(*) AS n FROM processes WHERE agent_id IN ${phs} AND status='ACTIVE'`
                ).get(...hints).n;
              } catch (_e) { cairnLog.debug('mentor-tick', 'telemetry_query_failed', { message: (_e && _e.message) || String(_e) }); }
            }
            const hasPlan = !!modeALoop.getPlan(entry.db, project.id);
            cairnLog.info('mode-a-loop', 'tick_summary', {
              project_id: project.id,
              mode: 'A',
              has_goal: !!goal,
              sc_count: scCount,
              agent_ids_count: hints.length,
              active_candidates: activeCandidates,
              has_plan: hasPlan,
            });
          } catch (_e) { cairnLog.debug('mentor-tick', 'telemetry_block_failed', { message: (_e && _e.message) || String(_e) }); }
          // 2026-05-14: reconcile any orphan DISPATCHED step whose
          // inbox notification didn't go out (pre-f1e88af dispatches
          // sit PENDING in dispatch_requests with no agent_inbox row;
          // step is DISPATCHED so decideNextDispatch won't redispatch;
          // only this reconciler closes the loop). Idempotent on
          // step.inbox_injected_at — runs at most once per step.
          try {
            modeALoop.reconcileInbox(entry.db, project, { tables: entry.tables });
          } catch (e) {
            cairnLog.error('mode-a-loop', 'reconcile_threw', {
              project_id: project.id,
              message: (e && e.message) || String(e),
            });
          }
          // MA-2d: aggressive Rule D auto-answer for Mode A — before
          // the plan loop runs, sweep any OPEN blockers and answer them
          // so CC doesn't sit indefinitely waiting for a human.
          // (Plan §2.3 / CEO 命题: "确保 cc 在任务完成前能够不断")
          try {
            const goalTitle = deps.mentorPolicy ? deps.mentorPolicy.extractGoalTitle(goal, { component: 'mode-a-auto-answer' })
              : (typeof goal === 'string' ? goal : (goal && goal.title) || null);
            const answerResult = modeAAutoAnswer.runOnceForProject({
              db: entry.db,
              tables: entry.tables,
              project,
              agentIds: hints,
              profile,
              goalTitle,
              nowFn: deps.nowFn,
            });
            if (answerResult && answerResult.answered > 0) {
              out.decisions += answerResult.answered;
            }
          } catch (e) {
            cairnLog.error('mode-a-auto-answer', 'tick_threw', {
              project_id: project.id,
              message: (e && e.message) || String(e),
            });
          }
          // 2026-05-14 stale-dispatch recovery: if a step has been
          // DISPATCHED for >3min without the assigned agent picking
          // it up (no task_id on the dispatch row), reset it to
          // PENDING + bump retry_count. The next decideNextDispatch
          // will re-dispatch (or no_agent → spawn). After 2 retries
          // we force a spawn regardless of how many ACTIVE agents
          // claim to be alive — the idle ones aren't actually
          // working, so we need a fresh worker process.
          // 2026-05-14: bind orphan tasks. Some spawn paths (notably
          // mode-a-spawner via worker-launcher) leave step.task_id
          // unbound — the spawned CC creates a task but doesn't write
          // back to dispatch_requests.task_id. bindOrphanTask scans
          // for matching tasks by intent text and binds them.
          try {
            modeALoop.bindOrphanTask(entry.db, project, hints, { nowFn: deps.nowFn });
          } catch (e) {
            cairnLog.error('mode-a-loop', 'bind_orphan_threw', {
              project_id: project.id,
              message: (e && e.message) || String(e),
            });
          }
          let forceSpawn = false;
          try {
            const staleRes = modeALoop.detectStaleAndReset(entry.db, project, { nowFn: deps.nowFn });
            if (staleRes.reset > 0) {
              out.decisions += staleRes.reset;
              const maxRetry = Math.max(0, ...Object.values(staleRes.retry_counts));
              // First stale (retry_count >= 1) → already enough to
              // conclude the assigned agent isn't actually working;
              // re-dispatching to the same idle agent is pointless.
              // Force spawn immediately on the first stale-reset.
              if (maxRetry >= 1) forceSpawn = true;
            }
          } catch (e) {
            cairnLog.error('mode-a-loop', 'stale_detect_threw', {
              project_id: project.id,
              message: (e && e.message) || String(e),
            });
          }
          // Mode A v2 race fix (CEO 2026-05-14, opus reviewer 2026-05-14
          // P2): runOnceForProject calls ensurePlan which writes a
          // DETERMINISTIC plan to mode_a_plan/<pid>. While scout is
          // in-flight (phase='planning') that overwrites scout's
          // half-built state and the panel shows the wrong plan
          // briefly until scout exits and rewrites. While the user is
          // reviewing scout's draft (phase='plan_pending') we MUST NOT
          // re-draft either — scout's plan is the source of truth and
          // user is about to Start it. paused = user explicitly told
          // us to stop — don't keep drafting/advancing/dispatching.
          //
          // Only run the full plan/advance/dispatch loop when:
          //   - 'running' (live execution — advance + dispatch needed)
          //   - 'idle'    (legacy path: pre-Mode-A-v2 projects that
          //                never went through scout. ensurePlan does
          //                the only-on-first-draft work; if a plan
          //                already exists it returns 'unchanged'.)
          const modeAPhaseForLoop = (cockpitSettings && cockpitSettings.mode_a && cockpitSettings.mode_a.phase) || 'idle';
          let decision = null;
          if (modeAPhaseForLoop === 'running' || modeAPhaseForLoop === 'idle') {
            decision = modeALoop.runOnceForProject({
              db: entry.db,
              project,
              goal,
              profile,
              agentIds: hints,
              leader: (cockpitSettings && cockpitSettings.leader) || null,
              nowFn: deps.nowFn,
            });
          } else {
            // phase is 'planning' / 'plan_pending' / 'paused' — scout
            // owns plan state, user owns execution state. Tick has
            // nothing to do for this project this round.
            cairnLog.info('mode-a-loop', 'tick_skipped_by_phase', {
              project_id: project.id,
              phase: modeAPhaseForLoop,
            });
          }
          // MA-2c: execute the dispatch decision (if any). The pure
          // module decided WHAT to dispatch; the tick is responsible
          // for WRITING the dispatch_requests row + bookkeeping back
          // to the plan. When forceSpawn is set (retry_count ≥ 2), we
          // skip the normal dispatch path so the spawn block below
          // creates a fresh worker instead of re-dispatching to the
          // same idle agent that's been failing to pick up.
          //
          // Mode A v2 gate: same as the spawn block below — no
          // dispatch unless phase === 'running'.
          const modeAPhaseForDispatch = (cockpitSettings && cockpitSettings.mode_a && cockpitSettings.mode_a.phase) || 'idle';
          if (decision && decision.dispatch_request && decision.dispatch_request.action === 'dispatch' && !forceSpawn && modeAPhaseForDispatch === 'running') {
            const dr = decision.dispatch_request;
            try {
              // Defensive re-read (subagent verdict 2026-05-14 C): if a
              // prior tick wrote dispatch_requests but failed at
              // markStepDispatched, the in-memory `plan` from this tick's
              // decideNextDispatch may already be stale by the time we
              // call dispatchTodo. Re-read the plan + bail if the step
              // has flipped to DISPATCHED in the interim. Cheap belt-and-
              // -suspenders that costs one scratchpad SELECT.
              const freshPlan = modeALoop.getPlan(entry.db, project.id);
              const freshStep = freshPlan && Array.isArray(freshPlan.steps) ? freshPlan.steps[dr.step_idx] : null;
              if (freshStep && freshStep.state === 'DISPATCHED') {
                cairnLog.info('mode-a-loop', 'auto_dispatch_skipped', {
                  project_id: project.id,
                  step_idx: dr.step_idx,
                  reason: 'already_dispatched_concurrently',
                });
                throw new Error('__skip_already_dispatched__');
              }
              const cockpitDispatch = deps.cockpitDispatch || require('./cockpit-dispatch.cjs');
              const res = cockpitDispatch.dispatchTodo(entry.db, entry.tables, {
                project_id: project.id,
                target_agent_id: dr.target_agent_id,
                label: dr.step.label,
                source: 'mode-a-loop',
                todo_id: `mode_a_step/${decision.plan && decision.plan.plan_id}/${dr.step_idx}`,
                why: 'Mode A — auto-dispatched plan step',
              });
              if (res && res.ok && res.dispatch_id) {
                modeALoop.markStepDispatched(entry.db, project.id, dr.step_idx, res.dispatch_id, deps.nowFn ? deps.nowFn() : Date.now());
                out.decisions++;
              } else {
                cairnLog.warn('mode-a-loop', 'auto_dispatch_failed', {
                  project_id: project.id,
                  step_idx: dr.step_idx,
                  target_agent_id: dr.target_agent_id,
                  error: res && res.error,
                });
              }
            } catch (e) {
              // Sentinel for the concurrent-dispatch skip path — already
              // logged as 'auto_dispatch_skipped'. Suppress here.
              if (e && e.message === '__skip_already_dispatched__') {
                /* expected, swallow */
              } else {
                cairnLog.error('mode-a-loop', 'auto_dispatch_threw', {
                  project_id: project.id,
                  step_idx: dr.step_idx,
                  message: (e && e.message) || String(e),
                });
              }
            }
          }
          if (decision && decision.advance && decision.advance.action === 'advanced') {
            out.decisions++;
            // 2026-05-14 Mode A auto-ship (CEO 鸭总): when a step
            // advances to DONE, optionally git commit + push the
            // CC-produced changes. Uses outcome.evaluation_summary as
            // the commit message (CC fills it via cairn.outcomes.evaluate),
            // falls back to "step N done: <label>". Off by default
            // (push is irreversible; user opts in per project via
            // cockpit_settings.auto_ship.enabled). All failures are
            // non-fatal — kernel state is authoritative, commit/push
            // are best-effort side effects.
            try {
              if (cockpitSettings && cockpitSettings.auto_ship && cockpitSettings.auto_ship.enabled) {
                const autoShip = require('./mode-a-auto-ship.cjs');
                const taskId = decision.advance.task_id;
                let summary = null;
                try {
                  const row = entry.db.prepare(
                    "SELECT evaluation_summary FROM outcomes WHERE task_id = ? AND status = 'PASS'"
                  ).get(taskId);
                  if (row && row.evaluation_summary) summary = row.evaluation_summary;
                } catch (_e) { cairnLog.warn('mentor-tick', 'outcomes_query_failed', { message: (_e && _e.message) || String(_e) }); }
                const stepIdx = decision.advance.step_idx;
                const stepLabel = decision.plan && decision.plan.steps && decision.plan.steps[stepIdx]
                  ? decision.plan.steps[stepIdx].label : null;
                const message = summary || (stepLabel ? 'step ' + stepIdx + ' done: ' + stepLabel : 'Mode A step ' + stepIdx + ' done');
                const shipRes = autoShip.autoShip(project.project_root, message, {
                  patPath: cockpitSettings.auto_ship.pat_path,
                  branch: cockpitSettings.auto_ship.default_branch,
                  remoteUrl: cockpitSettings.auto_ship.remote_url,
                });
                cairnLog.info('mode-a-auto-ship', shipRes.ok ? 'ship_ok' : 'ship_skipped_or_failed', {
                  project_id: project.id,
                  step_idx: stepIdx,
                  task_id: taskId,
                  ok: !!shipRes.ok,
                  commit_sha: shipRes.commit_sha,
                  push_backend: shipRes.push_backend,
                  reason: shipRes.reason,
                  error_preview: shipRes.error ? String(shipRes.error).slice(0, 200) : undefined,
                });
              }
            } catch (e) {
              cairnLog.error('mode-a-auto-ship', 'hook_threw', {
                project_id: project.id,
                message: (e && e.message) || String(e),
              });
            }
          }
          if (decision && (decision.action === 'drafted' || decision.action === 'superseded')) {
            out.decisions++;
          }
          // 2026-05-14 CEO escalation: when decideNextDispatch returns
          // no_agent OR when retry_count ≥ 2 (existing ACTIVE agents
          // keep failing to pick up), auto-spawn a CC subprocess in the
          // project root. Without this, Mode A silently sits on PENDING
          // steps forever any time the user doesn't happen to have a
          // working CC session in the project. Cooldown-bounded (60s).
          //
          // Mode A v2 gate (2026-05-14 CEO reframe): only spawn the
          // execution CC when phase === 'running'. Earlier phases mean
          // either Scout is drafting (planning), the plan is waiting
          // for user Start (plan_pending), the user paused (paused),
          // or Mode A isn't engaged (idle). The phase machine is
          // owned by IPC handlers + mode-a-scout.cjs.
          const modeAPhase = (cockpitSettings && cockpitSettings.mode_a && cockpitSettings.mode_a.phase) || 'idle';
          if (decision && decision.dispatch_request &&
              (decision.dispatch_request.action === 'no_agent' || forceSpawn) &&
              modeAPhase === 'running') {
            try {
              const modeASpawner = deps.modeASpawner || require('./mode-a-spawner.cjs');
              const freshPlan = modeALoop.getPlan(entry.db, project.id);
              const spawnRes = modeASpawner.spawnModeAWorker({
                project,
                plan: freshPlan,
                profile, // 2026-05-14 Q1: thread CAIRN.md profile into boot prompt
                db: entry.db,
                tables: entry.tables,
              }, { nowFn: deps.nowFn });
              if (spawnRes && spawnRes.ok) {
                out.decisions++;
                if (typeof deps.onDecision === 'function') {
                  try { deps.onDecision(project.id, {
                    rule: 'A-mode',
                    action: 'worker_spawned',
                    run_id: spawnRes.run_id,
                    agent_id: spawnRes.agent_id,
                  }); } catch (_e) { cairnLog.warn('mentor-tick', 'onDecision_callback_failed', { message: (_e && _e.message) || String(_e) }); }
                }
              }
            } catch (e) {
              cairnLog.error('mode-a-spawner', 'tick_spawn_threw', {
                project_id: project.id,
                message: (e && e.message) || String(e),
              });
            }
          }
          if (typeof deps.onDecision === 'function' && decision && decision.action !== 'no_goal' && decision.action !== 'unchanged' && decision.action !== 'no_project') {
            try { deps.onDecision(project.id, Object.assign({ rule: 'A-mode' }, decision)); } catch (_e) { cairnLog.warn('mentor-tick', 'onDecision_callback_failed', { message: (_e && _e.message) || String(_e) }); }
          }
        } else if (cockpitSettings && cockpitSettings.mode === 'B') {
          // ----- Mode B suggestion ranking (MA-3 2026-05-14).
          // Heuristic-based mentor_todo entries. Writes ranked suggestions
          // to scratchpad — existing Todolist render path picks them up.
          const bDecision = modeBSuggester.runOnceForProject({
            db: entry.db,
            tables: entry.tables,
            project,
            agentIds: hints,
            nowFn: deps.nowFn,
          });
          if (bDecision && bDecision.added > 0) {
            out.decisions += bDecision.added;
          }
          if (typeof deps.onDecision === 'function' && bDecision && bDecision.action === 'ran' && bDecision.added > 0) {
            try { deps.onDecision(project.id, Object.assign({ rule: 'B-mode' }, bDecision)); } catch (_e) { cairnLog.warn('mentor-tick', 'onDecision_callback_failed', { message: (_e && _e.message) || String(_e) }); }
          }
        }
      } catch (e) {
        cairnLog.error('mode-a-loop', 'tick_failed', {
          project_id: project && project.id,
          message: (e && e.message) || String(e),
        });
      }
    } catch (e) {
      out.errors.push({ project_id: project && project.id, error: e && e.message ? e.message : String(e) });
      cairnLog.error('mentor-tick', 'tick_failed', {
        project_id: project && project.id,
        message: (e && e.message) || String(e),
      });
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
    try { runOnce(deps); } catch (_e) { cairnLog.error('mentor-tick', 'initial_tick_failed', { message: (_e && _e.message) || String(_e) }); }
  });
  _timer = setInterval(() => {
    try { runOnce(deps); } catch (_e) { cairnLog.error('mentor-tick', 'interval_tick_failed', { message: (_e && _e.message) || String(_e) }); }
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
