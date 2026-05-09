'use strict';

/**
 * Coordination Signals (Coordination Surface Pass).
 *
 * The bridge from "seeing the worksite" (Goal Mode Lite, Pulse) to
 * "making the worksite governable" (Xproduct.md §6.4 governance debt
 * candidates). Pure derivation over existing project state — no
 * persistence, no SQL, no LLM. The panel + prompt pack consume the
 * same shape so coordination signals are visible AND copy-pasteable.
 *
 * Hard product boundary (PRODUCT.md §1.3 #4 / §6.4.5):
 *   - Cairn does NOT auto-dispatch / resolve conflict / rewind.
 *   - Signals are observational; each carries an OPTIONAL prompt_action
 *     (`copy_handoff_prompt` | `copy_recovery_prompt` |
 *      `copy_review_prompt` | `copy_conflict_prompt`) that the panel
 *     wires to a Copy button. The user copies; nothing auto-sends.
 *   - "report_missing" / "stale_agent_with_task" / "no_checkpoint_for_inflight"
 *     are early Governance Debt candidates surfaced as signals, NOT
 *     persisted to a new table.
 *
 * Output shape:
 *   {
 *     coordination_level: 'ok' | 'watch' | 'attention',
 *     signals: [
 *       {
 *         kind, severity, title, detail,
 *         related: { task_id?, agent_id?, checkpoint_id?, report_id?, conflict_id? },
 *         prompt_action?: string,
 *       }, …
 *     ],
 *     handoff_candidates: [task_id, …],
 *     conflict_candidates: [conflict_id, …],
 *     recovery_candidates: [task_id, …],
 *     ts: number,
 *   }
 */

const SEVERITY_RANK = { attention: 0, watch: 1, info: 2 };

const STR_TITLE_MAX  = 200;
const STR_DETAIL_MAX = 400;

function clip(s, max) {
  if (typeof s !== 'string') return '';
  const t = s.trim();
  return t.length > max ? t.slice(0, max) : t;
}

// ---------------------------------------------------------------------------
// Tunables (intentionally light — Goal Mode v3+ may make these per-project)
// ---------------------------------------------------------------------------

const STALE_BLOCKER_MS    = 24 * 60 * 60 * 1000;   // 24h
const STALE_INFLIGHT_MS   = 30 * 60 * 1000;        // 30 min — same as goal-signals
const RISKY_INFLIGHT_TASKS = 1;                    // ≥1 RUNNING/BLOCKED → "risky in flight"

/**
 * @param {object} input
 * @param {object[]} [input.activities]            AgentActivity[]
 * @param {object} [input.summary]                 project-scoped summary fields
 * @param {object[]} [input.tasks]                 array of project-scoped task rows
 *                                                  (intent, state, created_by_agent_id, updated_at, …)
 * @param {object[]} [input.blockers]              { id, task_id, status, raised_at, answered_at, question }
 * @param {object[]} [input.outcomes]              { task_id, status, evaluated_at, evaluation_summary }
 * @param {object[]} [input.checkpoints]           queryProjectScopedCheckpoints rows
 * @param {object[]} [input.scratchpad]            { key, task_id, updated_at, … } (ranges only — no values)
 * @param {object[]} [input.conflicts]             rows from project-scoped conflicts
 * @param {object[]} [input.recent_reports]        worker-reports
 * @param {object} [input.goal]
 * @param {object} [input.project_rules]
 * @param {object} [opts]                          { now, staleBlockerMs, staleInflightMs }
 */
function deriveCoordinationSignals(input, opts) {
  const o = opts || {};
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const staleBlockerMs  = Number.isFinite(o.staleBlockerMs)  ? o.staleBlockerMs  : STALE_BLOCKER_MS;
  const staleInflightMs = Number.isFinite(o.staleInflightMs) ? o.staleInflightMs : STALE_INFLIGHT_MS;

  const activities  = Array.isArray(input && input.activities)  ? input.activities  : [];
  const summary     = (input && input.summary) || null;
  const tasks       = Array.isArray(input && input.tasks)       ? input.tasks       : [];
  const blockers    = Array.isArray(input && input.blockers)    ? input.blockers    : [];
  const outcomes    = Array.isArray(input && input.outcomes)    ? input.outcomes    : [];
  const checkpoints = Array.isArray(input && input.checkpoints) ? input.checkpoints : [];
  const scratchpad  = Array.isArray(input && input.scratchpad)  ? input.scratchpad  : [];
  const conflicts   = Array.isArray(input && input.conflicts)   ? input.conflicts   : [];
  const reports     = Array.isArray(input && input.recent_reports) ? input.recent_reports : [];

  const signals = [];
  const handoffSet  = new Set();
  const conflictSet = new Set();
  const recoverySet = new Set();

  // ---- helpers ----
  function push(severity, kind, title, detail, related, prompt_action) {
    signals.push({
      kind,
      severity,
      title:  clip(title,  STR_TITLE_MAX),
      detail: clip(detail, STR_DETAIL_MAX),
      related: related || {},
      prompt_action: prompt_action || null,
    });
  }
  // Build a quick map task_id → activity (heuristic: first MCP activity
  // that owns this task via owns_tasks counts; fallback to attribution).
  const tasksByOwner = new Map();
  for (const t of tasks) {
    if (t && t.created_by_agent_id) {
      if (!tasksByOwner.has(t.created_by_agent_id)) tasksByOwner.set(t.created_by_agent_id, []);
      tasksByOwner.get(t.created_by_agent_id).push(t);
    }
  }
  function activityForAgent(agentId) {
    if (!agentId) return null;
    return activities.find(a => a && a.agent_id === agentId) || null;
  }

  // ===========================================================================
  // ATTENTION signals
  // ===========================================================================

  // open_blocker — every OPEN blocker is its own signal so users can act.
  for (const b of blockers) {
    if (!b || b.status !== 'OPEN') continue;
    const ageMs = (b.raised_at && now > b.raised_at) ? (now - b.raised_at) : 0;
    const isStale = ageMs > staleBlockerMs;
    const ageMin = Math.round(ageMs / 60000);
    const title = isStale
      ? `Blocker open ${Math.round(ageMin / 60)}h+ — ${clip(b.question, 80) || '(no question text)'}`
      : `Blocker waiting — ${clip(b.question, 80) || '(no question text)'}`;
    push('attention', 'blocker_waiting',
      title,
      `Task ${b.task_id || '(none)'} is stalled waiting for an answer.`,
      { task_id: b.task_id || null },
      'copy_handoff_prompt',
    );
    if (b.task_id) handoffSet.add(b.task_id);
  }

  // outcome_failed — explicit "needs review" signal per task.
  for (const oc of outcomes) {
    if (!oc) continue;
    if (oc.status !== 'FAIL' && oc.status !== 'TERMINAL_FAIL') continue;
    push('attention', 'outcome_failed',
      `Failed outcome on task ${oc.task_id || '(unknown)'}`,
      clip(oc.evaluation_summary || 'Acceptance check did not pass.', STR_DETAIL_MAX),
      { task_id: oc.task_id || null },
      'copy_review_prompt',
    );
    if (oc.task_id) recoverySet.add(oc.task_id);
  }

  // conflict_open — every OPEN / PENDING_REVIEW conflict.
  for (const c of conflicts) {
    if (!c) continue;
    const status = c.status || '';
    if (status !== 'OPEN' && status !== 'PENDING_REVIEW') continue;
    const pathCount = _parsePaths(c.paths_json).length;
    const partyB = c.agent_b ? ` ↔ ${c.agent_b}` : '';
    push('attention', 'conflict_open',
      `Conflict ${status} — ${c.conflict_type || 'unknown'} (${pathCount} path${pathCount === 1 ? '' : 's'})`,
      `${c.agent_a || '?'}${partyB}: ${clip(c.summary || '(no summary)', STR_DETAIL_MAX)}`,
      { conflict_id: c.id || null, agent_id: c.agent_a || null },
      'copy_conflict_prompt',
    );
    if (c.id) conflictSet.add(c.id);
  }

  // ===========================================================================
  // WATCH signals
  // ===========================================================================

  // review_needed — WAITING_REVIEW tasks.
  for (const t of tasks) {
    if (!t || t.state !== 'WAITING_REVIEW') continue;
    push('watch', 'review_needed',
      `Task awaiting review — ${clip(t.intent, 80) || '(no intent)'}`,
      `Submitted for evaluation; outcome decides PASS / FAIL / RETRY.`,
      { task_id: t.task_id, agent_id: t.created_by_agent_id || null },
      'copy_review_prompt',
    );
  }

  // handoff_needed: task in flight + owner agent inactive/stale/dead.
  for (const t of tasks) {
    if (!t) continue;
    const isInFlight = (t.state === 'RUNNING' || t.state === 'BLOCKED' ||
                        t.state === 'WAITING_REVIEW' || t.state === 'READY_TO_RESUME');
    if (!isInFlight) continue;
    const owner = t.created_by_agent_id;
    if (!owner) continue;
    const a = activityForAgent(owner);
    if (!a) {
      // owner agent never seen in current activities → likely needs handoff.
      push('watch', 'handoff_needed',
        `Task ${clip(t.intent, 60) || t.task_id} — owning agent not present`,
        `The agent that started this task isn't visible in current activity. A handoff may be needed.`,
        { task_id: t.task_id, agent_id: owner },
        'copy_handoff_prompt',
      );
      handoffSet.add(t.task_id);
      continue;
    }
    if (a.state_family === 'dead' || a.state === 'stale' || a.state_family === 'inactive') {
      push('watch', 'handoff_needed',
        `Task ${clip(t.intent, 60) || t.task_id} — owning agent ${a.human_state_label || a.state}`,
        `Owner ${a.display_label || owner} is ${a.human_state_label || a.state}; another agent (or you) may need to pick up where it left off.`,
        { task_id: t.task_id, agent_id: owner },
        'copy_handoff_prompt',
      );
      handoffSet.add(t.task_id);
    }
  }

  // stale_agent_with_task: distinct from handoff_needed in framing — this
  // surface keeps the agent identity central, useful when the user is
  // looking at the Agent Activity tab. When stale_agent already produced
  // a handoff_needed entry above we don't double-emit; we only fire
  // when the agent is stale/dead AND no handoff_needed has been emitted
  // for any of its owned tasks yet.
  for (const a of activities) {
    if (!a) continue;
    if (a.state !== 'stale' && a.state_family !== 'dead') continue;
    const owned = tasksByOwner.get(a.agent_id) || [];
    const inFlight = owned.filter(t => ['RUNNING','BLOCKED','WAITING_REVIEW','READY_TO_RESUME'].includes(t.state));
    if (inFlight.length === 0) continue;
    // Skip when a handoff_needed signal already covers any of this
    // agent's tasks.
    const alreadyCovered = inFlight.some(t => handoffSet.has(t.task_id));
    if (alreadyCovered) continue;
    push('watch', 'stale_agent_with_task',
      `${a.display_label || a.agent_id} is ${a.human_state_label || a.state} but owns ${inFlight.length} unfinished task${inFlight.length === 1 ? '' : 's'}`,
      `Tasks: ${inFlight.slice(0, 3).map(t => clip(t.intent, 30) || t.task_id).join('; ')}.`,
      { agent_id: a.agent_id },
      'copy_handoff_prompt',
    );
    for (const t of inFlight) handoffSet.add(t.task_id);
  }

  // recovery_missing: in-flight task without any READY checkpoint.
  const inflightTotal = tasks.filter(t => t && (t.state === 'RUNNING' || t.state === 'BLOCKED')).length;
  const readyByTask = new Set(
    checkpoints.filter(c => c && (c.snapshot_status || '').toUpperCase() === 'READY')
               .map(c => c.task_id),
  );
  if (inflightTotal >= RISKY_INFLIGHT_TASKS) {
    const taskWithoutAnchor = tasks.find(t => t
      && (t.state === 'RUNNING' || t.state === 'BLOCKED')
      && !readyByTask.has(t.task_id));
    if (taskWithoutAnchor) {
      push('watch', 'recovery_missing',
        `In-flight work without a READY checkpoint`,
        `Task ${clip(taskWithoutAnchor.intent, 60) || taskWithoutAnchor.task_id} has risky in-flight state but no recoverable anchor. Ask an agent to create one before the next risky step.`,
        { task_id: taskWithoutAnchor.task_id },
        'copy_recovery_prompt',
      );
      recoverySet.add(taskWithoutAnchor.task_id);
    }
  }

  // recovery_available: at least one READY checkpoint somewhere — surfaced
  // so the user remembers it exists. This is INFO-level (positive evidence).
  if (readyByTask.size > 0) {
    const sample = checkpoints.find(c => (c.snapshot_status || '').toUpperCase() === 'READY');
    push('info', 'recovery_available',
      `${readyByTask.size} task${readyByTask.size === 1 ? '' : 's'} have a READY recovery anchor`,
      `If something goes sideways, you can ask an agent to inspect and rewind to a checkpoint.`,
      { checkpoint_id: sample ? sample.id : null },
      'copy_recovery_prompt',
    );
  }

  // report_missing: live/recent agent activity but no recent worker report.
  const familyCounts = (summary && summary.agent_activity && summary.agent_activity.by_family) || null;
  const liveOrRecent = familyCounts ? (familyCounts.live + familyCounts.recent) : 0;
  if (liveOrRecent > 0 && reports.length === 0) {
    push('watch', 'report_missing',
      `${liveOrRecent} active/recent agent${liveOrRecent === 1 ? '' : 's'} but no worker report`,
      `Agents are present but haven't logged a structured update. Without one, handoff has no first-person summary to inherit.`,
      {},
      'copy_handoff_prompt',
    );
  }

  // ===========================================================================
  // Coordination level (highest severity wins)
  // ===========================================================================

  let coordination_level;
  if (signals.some(s => s.severity === 'attention')) coordination_level = 'attention';
  else if (signals.some(s => s.severity === 'watch')) coordination_level = 'watch';
  else coordination_level = 'ok';

  // Sort signals: attention → watch → info; preserve insertion order
  // within each severity (deterministic).
  signals.sort((a, b) => {
    const ra = SEVERITY_RANK[a.severity] != null ? SEVERITY_RANK[a.severity] : 9;
    const rb = SEVERITY_RANK[b.severity] != null ? SEVERITY_RANK[b.severity] : 9;
    return ra - rb;
  });

  return {
    coordination_level,
    signals,
    handoff_candidates:  [...handoffSet],
    conflict_candidates: [...conflictSet],
    recovery_candidates: [...recoverySet],
    ts: now,
  };
}

function _parsePaths(s) {
  if (!s || typeof s !== 'string') return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch (_e) { return []; }
}

/**
 * Compact summary of a coordination derivation — safe to send to the
 * LLM (counts + signal kinds + top titles). Never includes scratchpad
 * value bodies, conflict path lists, or task intents beyond the
 * already-truncated signal title.
 */
function summarizeCoordination(coord) {
  const out = {
    level: 'ok',
    counts: { attention: 0, watch: 0, info: 0 },
    by_kind: {},
    top_titles: [],
    handoff_count:  0,
    conflict_count: 0,
    recovery_count: 0,
  };
  if (!coord || !Array.isArray(coord.signals)) return out;
  out.level = coord.coordination_level || 'ok';
  for (const s of coord.signals) {
    if (s.severity in out.counts) out.counts[s.severity]++;
    out.by_kind[s.kind] = (out.by_kind[s.kind] || 0) + 1;
  }
  out.top_titles = coord.signals.slice(0, 5).map(s => clip(s.title, STR_TITLE_MAX));
  out.handoff_count  = (coord.handoff_candidates  || []).length;
  out.conflict_count = (coord.conflict_candidates || []).length;
  out.recovery_count = (coord.recovery_candidates || []).length;
  return out;
}

module.exports = {
  deriveCoordinationSignals,
  summarizeCoordination,
  STALE_BLOCKER_MS,
  STALE_INFLIGHT_MS,
};
