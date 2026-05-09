'use strict';

/**
 * Project Pulse — read-only derivation layer (Goal-Mode pre-work).
 *
 * Inputs: a project's summary card data (from project-queries.cjs +
 * the AgentActivity fold) and the unified activities[] list. Outputs:
 *
 *   {
 *     pulse_level: "ok" | "watch" | "attention",
 *     signals: [
 *       { kind, severity, title, detail, related_id }
 *     ],
 *     next_attention: [ ... up to 3 signals ... ]
 *   }
 *
 * Cairn does NOT decide what the user should work on next. This module
 * only surfaces "what should you look at right now?" — never "Cairn
 * recommends agent X do Y". The wording in `title` and `detail` reflects
 * that boundary. Do not add signals here that suggest mutations or
 * dispatch (PRODUCT.md §1.3 #4 / §7 principle 2).
 *
 * The surface is intentionally small and locked: minimum signals
 * documented here, no machine-learning, no deduplication-by-history.
 * Each call is a pure function over the inputs of one poll.
 *
 * Read-only: no I/O, no side effects.
 */

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------
//
// "Recent activity" threshold for the "running task with no recent
// activity" watch signal. 30 min picked as a humane "you should
// probably check on this" interval — not a hard heartbeat boundary.
// Tuneable per call via opts.staleActivityMs.

const DEFAULT_STALE_ACTIVITY_MS = 30 * 60 * 1000;

// "Recently active" threshold for the ok-evidence signal. Strict (60s)
// so we only emit "ok evidence" when there's positive freshness.

const DEFAULT_RECENT_ACTIVITY_MS = 60 * 1000;

// ---------------------------------------------------------------------------
// Severity ordering
// ---------------------------------------------------------------------------
//
// attention > watch > info. next_attention sort key.

const SEVERITY_RANK = { attention: 0, watch: 1, info: 2 };

// ---------------------------------------------------------------------------
// Signal builders
// ---------------------------------------------------------------------------

/**
 * Build the project-scoped pulse from one summary + activities pair.
 *
 * The signature is intentionally small — anything we want to surface
 * later (run-log entries, next-checkpoint TTLs, etc.) gets passed via
 * `opts` so this module never has to reach into the SQL layer.
 *
 * @param {object|null} summary       From queryProjectScopedSummary +
 *                                    foldClaude/foldCodex + activity
 *                                    fold. May be null when the project
 *                                    has no DB connection.
 * @param {Array<object>} activities  Unified AgentActivity rows for the
 *                                    project (or [] when none).
 * @param {object} [opts]             { now, staleActivityMs,
 *                                      recentActivityMs }
 * @returns {{ pulse_level:string, signals:Array, next_attention:Array }}
 */
function deriveProjectPulse(summary, activities, opts) {
  const o = opts || {};
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const staleAfter = Number.isFinite(o.staleActivityMs) ? o.staleActivityMs : DEFAULT_STALE_ACTIVITY_MS;
  const recentWithin = Number.isFinite(o.recentActivityMs) ? o.recentActivityMs : DEFAULT_RECENT_ACTIVITY_MS;
  const acts = Array.isArray(activities) ? activities : [];
  const sigs = [];

  if (!summary || !summary.available) {
    return {
      pulse_level: 'ok',
      signals: [],
      next_attention: [],
    };
  }

  const fam = (summary.agent_activity && summary.agent_activity.by_family) || {
    live: 0, recent: 0, inactive: 0, dead: 0, unknown: 0,
  };
  const liveCount   = fam.live   || 0;
  const recentCount = fam.recent || 0;
  const liveOrRecent = liveCount + recentCount;

  // ---------- attention signals ----------

  // Open blockers (US-P from PRODUCT.md §4: "T-002 BLOCKED — useAuth
  // — etc. is the canonical 'I need to look at this' moment").
  if ((summary.blockers_open || 0) > 0) {
    sigs.push({
      kind: 'open_blocker',
      severity: 'attention',
      title: `${summary.blockers_open} open blocker${summary.blockers_open === 1 ? '' : 's'}`,
      detail: `An agent is stalled waiting for an answer. Open the Tasks tab to see which task and why.`,
      related_id: null,
    });
  }

  // Failed / terminal_fail outcomes — outcomes_failed already conflates
  // FAIL + TERMINAL_FAIL in project-queries; surfacing both names is
  // accurate without splitting the count.
  if ((summary.outcomes_failed || 0) > 0) {
    sigs.push({
      kind: 'failed_outcome',
      severity: 'attention',
      title: `${summary.outcomes_failed} failed outcome${summary.outcomes_failed === 1 ? '' : 's'}`,
      detail: `One or more task acceptance checks (FAIL or TERMINAL_FAIL) need review.`,
      related_id: null,
    });
  }

  // Tasks in FAILED state.
  if ((summary.tasks_failed || 0) > 0) {
    sigs.push({
      kind: 'failed_task',
      severity: 'attention',
      title: `${summary.tasks_failed} failed task${summary.tasks_failed === 1 ? '' : 's'}`,
      detail: `A task hit a terminal failure state. Check the task detail for the last evaluation.`,
      related_id: null,
    });
  }

  // Open conflicts (multi-agent write conflicts, OPEN or PENDING_REVIEW).
  if ((summary.conflicts_open || 0) > 0) {
    sigs.push({
      kind: 'open_conflict',
      severity: 'attention',
      title: `${summary.conflicts_open} open conflict${summary.conflicts_open === 1 ? '' : 's'}`,
      detail: `Two agents touched the same paths. Review what happened before continuing.`,
      related_id: null,
    });
  }

  // ---------- watch signals ----------

  // Live/recent agent but no running tasks: the user has agents up but
  // nothing visible is being worked on. Could be intentional ("waiting
  // for next prompt"), could be "the agent dropped its task". The
  // panel just surfaces the gap.
  if (liveOrRecent > 0 && (summary.tasks_running || 0) === 0
      && (summary.tasks_blocked || 0) === 0
      && (summary.tasks_waiting_review || 0) === 0) {
    sigs.push({
      kind: 'live_agents_no_active_task',
      severity: 'watch',
      title: `${liveOrRecent} agent${liveOrRecent === 1 ? '' : 's'} live but no active task`,
      detail: `Agents are present but no task is currently RUNNING / BLOCKED / WAITING_REVIEW. Either they're between turns or a task was never created.`,
      related_id: null,
    });
  }

  // Running/blocked task but last_activity_at is older than the stale
  // threshold. This is a "the agent owning this work has gone quiet"
  // signal. We don't claim the agent is dead — just that nothing in
  // this project's attribution surface has updated in a while.
  const inFlight = (summary.tasks_running || 0) + (summary.tasks_blocked || 0);
  if (inFlight > 0 && summary.last_activity_at) {
    const idleMs = now - summary.last_activity_at;
    if (idleMs > staleAfter) {
      const idleMin = Math.round(idleMs / 60000);
      sigs.push({
        kind: 'inflight_no_recent_activity',
        severity: 'watch',
        title: `${inFlight} task${inFlight === 1 ? '' : 's'} in flight · no activity in ${idleMin}m`,
        detail: `RUNNING or BLOCKED tasks haven't seen any agent / blocker / outcome update recently. Worth checking whether the owning agent is still working.`,
        related_id: null,
      });
    }
  }

  // Tasks waiting review.
  if ((summary.tasks_waiting_review || 0) > 0) {
    sigs.push({
      kind: 'waiting_review',
      severity: 'watch',
      title: `${summary.tasks_waiting_review} task${summary.tasks_waiting_review === 1 ? '' : 's'} WAITING_REVIEW`,
      detail: `An agent submitted work for evaluation. The outcome decides PASS / FAIL / RETRY.`,
      related_id: null,
    });
  }

  // Stale heartbeat: an MCP agent claimed ACTIVE but stopped
  // heartbeating. Different from DEAD (proven gone) — STALE means
  // "claim is unverifiable". Worth surfacing because long-running
  // sessions sometimes stop heartbeating without exiting.
  if ((summary.agents_stale || 0) > 0) {
    sigs.push({
      kind: 'stale_heartbeat',
      severity: 'watch',
      title: `${summary.agents_stale} agent${summary.agents_stale === 1 ? '' : 's'} with stale heartbeat`,
      detail: `MCP session(s) stopped reporting but never declared DEAD. May be wedged or quietly exited.`,
      related_id: null,
    });
  }

  // ---------- ok evidence ----------
  //
  // We only emit ok evidence when nothing above triggered, AND there's
  // positive freshness signal. "absence of warnings" alone isn't
  // useful — empty projects would always show ok.

  const hasAttention = sigs.some(s => s.severity === 'attention');
  const hasWatch     = sigs.some(s => s.severity === 'watch');

  if (!hasAttention && !hasWatch && summary.last_activity_at) {
    const sinceMs = now - summary.last_activity_at;
    if (sinceMs <= recentWithin && liveOrRecent > 0) {
      sigs.push({
        kind: 'recently_active',
        severity: 'info',
        title: `${liveOrRecent} agent${liveOrRecent === 1 ? '' : 's'} recently active · no open issues`,
        detail: `No blockers, no failures, no conflicts. Agent activity within the last minute.`,
        related_id: null,
      });
    }
  }

  // ---------- pulse level ----------

  let pulse_level;
  if (hasAttention) pulse_level = 'attention';
  else if (hasWatch) pulse_level = 'watch';
  else pulse_level = 'ok';

  // next_attention: sort by severity, take top 3. Attention before
  // watch before info; preserves intra-severity insertion order.
  const ranked = sigs.slice().sort((a, b) => {
    const ra = SEVERITY_RANK[a.severity] != null ? SEVERITY_RANK[a.severity] : 9;
    const rb = SEVERITY_RANK[b.severity] != null ? SEVERITY_RANK[b.severity] : 9;
    return ra - rb;
  });
  const next_attention = ranked.slice(0, 3);

  return { pulse_level, signals: sigs, next_attention };
}

// ---------------------------------------------------------------------------
// Cross-project signals (registry-wide)
// ---------------------------------------------------------------------------

/**
 * Derive cross-project pulse signals — currently the unassigned
 * active/recent agent watch ("you have a Claude / Codex running
 * outside any registered project").
 *
 * @param {Array<object>} unassignedActivities  Activities aggregated
 *                                              across every Unassigned
 *                                              bucket (project_id=null).
 * @returns {{ signals: Array }}
 */
function deriveRegistryPulse(unassignedActivities) {
  const sigs = [];
  const acts = Array.isArray(unassignedActivities) ? unassignedActivities : [];
  let liveOrRecent = 0;
  for (const a of acts) {
    if (!a) continue;
    if (a.state_family === 'live' || a.state_family === 'recent') {
      liveOrRecent++;
    }
  }
  if (liveOrRecent > 0) {
    sigs.push({
      kind: 'unassigned_active_agent',
      severity: 'watch',
      title: `${liveOrRecent} active agent${liveOrRecent === 1 ? '' : 's'} not in any project`,
      detail: `Open Unassigned to register a project from one of these cwds — Cairn won't surface project-level pulse for them until they're attributed.`,
      related_id: null,
    });
  }
  return { signals: sigs };
}

module.exports = {
  deriveProjectPulse,
  deriveRegistryPulse,
  DEFAULT_STALE_ACTIVITY_MS,
  DEFAULT_RECENT_ACTIVITY_MS,
};
