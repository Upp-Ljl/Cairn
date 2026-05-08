'use strict';

/**
 * Read-only SQLite query helpers for the Cairn desktop-shell.
 *
 * Lives separately from main.cjs so that:
 *   - main.cjs can stay focused on Electron / IPC / window / lifecycle
 *   - queries can be unit-tested or reused without spinning up Electron
 *   - Day 2+ Run Log additions don't push main.cjs past readability
 *
 * Schema reference: see SCHEMA_NOTES.md for column names, indexes, CHECK
 * constraints, and graceful-empty rules. Day 1 contract: every query
 * tolerates missing tables (returns empty / safe defaults) and never
 * throws into the IPC layer.
 *
 * Convention: every helper takes (db, tables) where tables is a
 * Set<string> of present table names — pass it in so we don't re-query
 * sqlite_master on every poll. Callers should refresh the set whenever
 * the DB connection is re-opened (e.g. setDbPath).
 */

// ---------------------------------------------------------------------------
// JSDoc typedefs (5 row shapes + the summary projection)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} TaskRow
 * @property {string} task_id
 * @property {string} intent
 * @property {'PENDING'|'RUNNING'|'BLOCKED'|'READY_TO_RESUME'|'WAITING_REVIEW'|'DONE'|'FAILED'|'CANCELLED'} state
 * @property {string|null} parent_task_id
 * @property {number} created_at  unix ms
 * @property {number} updated_at  unix ms
 * @property {string|null} created_by_agent_id
 * @property {string|null} metadata_json
 */

/**
 * @typedef {Object} BlockerRow
 * @property {string} blocker_id
 * @property {string} task_id
 * @property {string} question
 * @property {string|null} context_keys     JSON-encoded string[]
 * @property {'OPEN'|'ANSWERED'|'SUPERSEDED'} status
 * @property {string|null} raised_by
 * @property {number} raised_at             unix ms — primary time anchor (NOT created_at)
 * @property {string|null} answer
 * @property {string|null} answered_by
 * @property {number|null} answered_at      unix ms
 * @property {string|null} metadata_json
 */

/**
 * @typedef {Object} OutcomeRow
 * @property {string} outcome_id
 * @property {string} task_id               UNIQUE — at most one outcome per task
 * @property {string} criteria_json         frozen DSL stack
 * @property {'PENDING'|'PASS'|'FAIL'|'TERMINAL_FAIL'} status
 * @property {number|null} evaluated_at     unix ms; null while PENDING
 * @property {string|null} evaluation_summary
 * @property {string|null} grader_agent_id  reserved; v1 not used
 * @property {number} created_at            unix ms
 * @property {number} updated_at            unix ms
 * @property {string|null} metadata_json
 */

/**
 * @typedef {Object} ConflictRow
 * @property {string} id                    PK is `id`, not `conflict_id`
 * @property {number} detected_at           unix ms
 * @property {'FILE_OVERLAP'|'STATE_CONFLICT'|'INTENT_BOUNDARY'} conflict_type
 * @property {string} agent_a
 * @property {string|null} agent_b
 * @property {string} paths_json            JSON-encoded string[]
 * @property {string|null} summary
 * @property {'OPEN'|'RESOLVED'|'IGNORED'|'PENDING_REVIEW'} status
 * @property {number|null} resolved_at      unix ms
 * @property {string|null} resolution
 */

/**
 * @typedef {Object} DispatchRequestRow
 * @property {string} id                    PK is `id`, not `request_id`
 * @property {string} nl_intent
 * @property {string|null} parsed_intent
 * @property {string|null} context_keys
 * @property {string|null} generated_prompt
 * @property {string|null} target_agent
 * @property {'PENDING'|'CONFIRMED'|'REJECTED'|'FAILED'} status
 * @property {number} created_at            unix ms
 * @property {number|null} confirmed_at     unix ms; null for terminal-non-CONFIRMED
 * @property {string|null} task_id
 */

/**
 * @typedef {Object} ProjectSummary
 * @property {boolean} available             true if DB connected
 * @property {string|null} db_path           absolute path to the open DB file
 * @property {number} ts                     unix sec the snapshot was taken
 * @property {number} agents_active
 * @property {number} tasks_running
 * @property {number} tasks_blocked
 * @property {number} tasks_waiting_review
 * @property {number} blockers_open
 * @property {number} outcomes_failed        FAIL or TERMINAL_FAIL
 * @property {number} outcomes_pending       PENDING (waiting on evaluate)
 * @property {number} conflicts_open         OPEN or PENDING_REVIEW
 * @property {number} dispatches_recent_1h   created_at within last hour
 */

// ---------------------------------------------------------------------------
// Schema-presence helpers
// ---------------------------------------------------------------------------

/**
 * @param {import('better-sqlite3').Database|null} db
 * @returns {Set<string>} names of tables present in the DB
 */
function getTables(db) {
  if (!db) return new Set();
  try {
    return new Set(
      db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
        .all()
        .map(r => r.name)
    );
  } catch (_e) {
    return new Set();
  }
}

const SUMMARY_TARGET_TABLES = [
  'processes',
  'tasks',
  'blockers',
  'outcomes',
  'conflicts',
  'dispatch_requests',
];

/**
 * Per-table presence map, useful for surfacing "schema missing" UX.
 * @param {Set<string>} tables
 * @returns {Object<string, boolean>}
 */
function tablePresence(tables) {
  const out = {};
  for (const name of SUMMARY_TARGET_TABLES) out[name] = tables.has(name);
  return out;
}

// ---------------------------------------------------------------------------
// Project summary (Day 1 deliverable)
// ---------------------------------------------------------------------------

/**
 * Compute the 6-line project summary card. Each query is independent so
 * a single bad table doesn't break the whole snapshot.
 *
 * @param {import('better-sqlite3').Database|null} db
 * @param {Set<string>} tables
 * @param {string|null} dbPath  for echoing back to the renderer
 * @returns {ProjectSummary}
 */
function queryProjectSummary(db, tables, dbPath) {
  /** @type {ProjectSummary} */
  const empty = {
    available: false,
    db_path: dbPath,
    ts: Math.floor(Date.now() / 1000),
    agents_active: 0,
    tasks_running: 0,
    tasks_blocked: 0,
    tasks_waiting_review: 0,
    blockers_open: 0,
    outcomes_failed: 0,
    outcomes_pending: 0,
    conflicts_open: 0,
    dispatches_recent_1h: 0,
  };

  if (!db) return empty;

  /** @type {ProjectSummary} */
  const out = { ...empty, available: true };

  // processes — count ACTIVE only (IDLE/DEAD don't count as "running on this box")
  if (tables.has('processes')) {
    try {
      out.agents_active = db.prepare(
        `SELECT COUNT(*) AS c FROM processes WHERE status='ACTIVE'`
      ).get().c;
    } catch (_e) { /* graceful empty */ }
  }

  // tasks — three separate counts so the summary distinguishes states
  if (tables.has('tasks')) {
    try {
      const row = db.prepare(`
        SELECT
          SUM(CASE WHEN state='RUNNING' THEN 1 ELSE 0 END) AS running,
          SUM(CASE WHEN state='BLOCKED' THEN 1 ELSE 0 END) AS blocked,
          SUM(CASE WHEN state='WAITING_REVIEW' THEN 1 ELSE 0 END) AS waiting_review
        FROM tasks
      `).get();
      out.tasks_running = row.running || 0;
      out.tasks_blocked = row.blocked || 0;
      out.tasks_waiting_review = row.waiting_review || 0;
    } catch (_e) { /* graceful empty */ }
  }

  // blockers OPEN (uses `raised_at` as time anchor; for COUNT we don't need it,
  // but it's the column to remember when adding sort-based queries later)
  if (tables.has('blockers')) {
    try {
      out.blockers_open = db.prepare(
        `SELECT COUNT(*) AS c FROM blockers WHERE status='OPEN'`
      ).get().c;
    } catch (_e) { /* graceful empty */ }
  }

  // outcomes — split FAIL/TERMINAL_FAIL vs PENDING
  if (tables.has('outcomes')) {
    try {
      const row = db.prepare(`
        SELECT
          SUM(CASE WHEN status IN ('FAIL','TERMINAL_FAIL') THEN 1 ELSE 0 END) AS failed,
          SUM(CASE WHEN status='PENDING' THEN 1 ELSE 0 END) AS pending
        FROM outcomes
      `).get();
      out.outcomes_failed = row.failed || 0;
      out.outcomes_pending = row.pending || 0;
    } catch (_e) { /* graceful empty */ }
  }

  // conflicts — OPEN + PENDING_REVIEW both count as "needs attention"
  if (tables.has('conflicts')) {
    try {
      out.conflicts_open = db.prepare(
        `SELECT COUNT(*) AS c FROM conflicts WHERE status IN ('OPEN','PENDING_REVIEW')`
      ).get().c;
    } catch (_e) { /* graceful empty */ }
  }

  // dispatches in last hour — by created_at (terminal-state rows leave
  // confirmed_at NULL so created_at is the only universal time anchor)
  if (tables.has('dispatch_requests')) {
    try {
      const cutoff = Date.now() - 3600 * 1000;
      out.dispatches_recent_1h = db.prepare(
        `SELECT COUNT(*) AS c FROM dispatch_requests WHERE created_at >= ?`
      ).get(cutoff).c;
    } catch (_e) { /* graceful empty */ }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Day 2 — Tasks list, Task detail, Run Log low-fidelity
// ---------------------------------------------------------------------------

// State priority for ordering: surface "needs attention" rows first.
const TASK_STATE_PRIORITY = {
  FAILED:          1,
  BLOCKED:         2,
  WAITING_REVIEW:  3,
  RUNNING:         4,
  READY_TO_RESUME: 5,
  PENDING:         6,
  DONE:            7,
  CANCELLED:       8,
};

function _truncate(s, n) {
  if (s == null) return '';
  const str = String(s);
  return str.length > n ? str.slice(0, n) + '…' : str;
}

/**
 * Top-level task list for the Tasks tab. Ordered by state priority so
 * problem rows surface first, then by recency.
 *
 * @param {import('better-sqlite3').Database|null} db
 * @param {Set<string>} tables
 * @returns {TaskRow[]}
 */
function queryTasksList(db, tables) {
  if (!db || !tables.has('tasks')) return [];
  try {
    return db.prepare(`
      SELECT task_id, parent_task_id, state, intent,
             created_at, updated_at, created_by_agent_id, metadata_json
        FROM tasks
       ORDER BY
         CASE state
           WHEN 'FAILED'          THEN 1
           WHEN 'BLOCKED'          THEN 2
           WHEN 'WAITING_REVIEW'   THEN 3
           WHEN 'RUNNING'          THEN 4
           WHEN 'READY_TO_RESUME'  THEN 5
           WHEN 'PENDING'          THEN 6
           WHEN 'DONE'             THEN 7
           WHEN 'CANCELLED'        THEN 8
           ELSE 9
         END,
         updated_at DESC
       LIMIT 100
    `).all();
  } catch (_e) { return []; }
}

/**
 * Drill-down for a single task: task row + its blockers + its (single)
 * outcome. blockers ordered with OPEN first, then by raised_at DESC.
 *
 * @param {import('better-sqlite3').Database|null} db
 * @param {Set<string>} tables
 * @param {string} taskId
 * @returns {{
 *   task: TaskRow,
 *   blockers: BlockerRow[],
 *   blockers_open_count: number,
 *   blockers_answered_count: number,
 *   outcome: OutcomeRow|null,
 *   outcome_criteria_count: number,
 * } | null}
 */
function queryTaskDetail(db, tables, taskId) {
  if (!db || !tables.has('tasks') || !taskId) return null;
  try {
    const task = db.prepare(`
      SELECT task_id, parent_task_id, state, intent,
             created_at, updated_at, created_by_agent_id, metadata_json
        FROM tasks
       WHERE task_id = ?
    `).get(taskId);
    if (!task) return null;

    /** @type {BlockerRow[]} */
    let blockers = [];
    let blockers_open_count = 0;
    let blockers_answered_count = 0;
    if (tables.has('blockers')) {
      try {
        blockers = db.prepare(`
          SELECT blocker_id, task_id, question, context_keys, status,
                 raised_by, raised_at, answer, answered_by, answered_at,
                 metadata_json
            FROM blockers
           WHERE task_id = ?
           ORDER BY (CASE status WHEN 'OPEN' THEN 0 ELSE 1 END), raised_at DESC
        `).all(taskId);
        for (const b of blockers) {
          if (b.status === 'OPEN') blockers_open_count++;
          else if (b.status === 'ANSWERED') blockers_answered_count++;
        }
      } catch (_e) { blockers = []; }
    }

    /** @type {OutcomeRow|null} */
    let outcome = null;
    let outcome_criteria_count = 0;
    if (tables.has('outcomes')) {
      try {
        outcome = db.prepare(`
          SELECT outcome_id, task_id, criteria_json, status,
                 evaluated_at, evaluation_summary, grader_agent_id,
                 created_at, updated_at, metadata_json
            FROM outcomes
           WHERE task_id = ?
        `).get(taskId) || null;
        if (outcome && outcome.criteria_json) {
          try {
            const parsed = JSON.parse(outcome.criteria_json);
            if (Array.isArray(parsed)) outcome_criteria_count = parsed.length;
          } catch (_e) { /* leave 0 */ }
        }
      } catch (_e) { outcome = null; }
    }

    return {
      task,
      blockers,
      blockers_open_count,
      blockers_answered_count,
      outcome,
      outcome_criteria_count,
    };
  } catch (_e) { return null; }
}

/**
 * Run Log low-fidelity feed. 5 sources only:
 *   tasks / blockers / outcomes / conflicts / dispatch_requests
 *
 * processes / scratchpad / checkpoints are explicitly NOT included
 * (Day 2 boundary; see plan §7.4 + SCHEMA_NOTES.md). Heartbeats would
 * drown the log; subagent results are out of scope until Hardening.
 *
 * Each source projects onto a uniform event shape. We let SQLite do the
 * per-source LIMIT, then merge + sort + cap on the JS side. Per-source
 * LIMIT bounds work even if a table grows pathologically.
 *
 * @param {import('better-sqlite3').Database|null} db
 * @param {Set<string>} tables
 * @returns {Array<RunLogEvent>}
 */
function queryRunLogEvents(db, tables) {
  if (!db) return [];

  const PER_SOURCE_LIMIT = 200;
  const TOTAL_LIMIT = 200;
  /** @type {RunLogEvent[]} */
  const events = [];

  // ---- tasks ---------------------------------------------------------
  // One event per task row at updated_at. We don't synthesize a separate
  // "task.created" event when created_at == updated_at; the lifecycle
  // span is already visible from the most recent state change.
  if (tables.has('tasks')) {
    try {
      const rows = db.prepare(`
        SELECT task_id, state, intent, created_at, updated_at, created_by_agent_id
          FROM tasks
         ORDER BY updated_at DESC
         LIMIT ?
      `).all(PER_SOURCE_LIMIT);
      for (const r of rows) {
        const stateLower = String(r.state || '').toLowerCase();
        const severity =
          r.state === 'FAILED' ? 'error' :
          (r.state === 'BLOCKED' || r.state === 'WAITING_REVIEW') ? 'warn' :
          'info';
        events.push({
          ts: r.updated_at,
          severity,
          source: 'tasks',
          type: `task.${stateLower}`,
          agent_id: r.created_by_agent_id || null,
          task_id: r.task_id,
          target: r.task_id,
          message: _truncate(r.intent, 96),
        });
      }
    } catch (_e) { /* skip source */ }
  }

  // ---- blockers ------------------------------------------------------
  // Emit one event at raised_at, plus a second at answered_at for ANSWERED.
  if (tables.has('blockers')) {
    try {
      const rows = db.prepare(`
        SELECT blocker_id, task_id, question, status,
               raised_by, raised_at, answer, answered_by, answered_at
          FROM blockers
         ORDER BY COALESCE(answered_at, raised_at) DESC
         LIMIT ?
      `).all(PER_SOURCE_LIMIT);
      for (const r of rows) {
        events.push({
          ts: r.raised_at,
          severity: 'warn',
          source: 'blockers',
          type: 'blocker.opened',
          agent_id: r.raised_by || null,
          task_id: r.task_id,
          target: r.blocker_id,
          message: _truncate(r.question, 96),
        });
        if (r.answered_at != null) {
          events.push({
            ts: r.answered_at,
            severity: 'info',
            source: 'blockers',
            type: 'blocker.answered',
            agent_id: r.answered_by || null,
            task_id: r.task_id,
            target: r.blocker_id,
            message: _truncate(r.answer, 96),
          });
        }
      }
    } catch (_e) { /* skip source */ }
  }

  // ---- outcomes ------------------------------------------------------
  // Only emit on evaluated_at (skip PENDING-stage upserts which would be noise).
  if (tables.has('outcomes')) {
    try {
      const rows = db.prepare(`
        SELECT outcome_id, task_id, status, evaluated_at, evaluation_summary
          FROM outcomes
         WHERE evaluated_at IS NOT NULL
         ORDER BY evaluated_at DESC
         LIMIT ?
      `).all(PER_SOURCE_LIMIT);
      for (const r of rows) {
        const statusLower = String(r.status || '').toLowerCase();
        const severity =
          (r.status === 'FAIL' || r.status === 'TERMINAL_FAIL') ? 'error' :
          r.status === 'PASS' ? 'info' :
          'warn';
        events.push({
          ts: r.evaluated_at,
          severity,
          source: 'outcomes',
          type: `outcome.${statusLower}`,
          agent_id: null,
          task_id: r.task_id,
          target: r.outcome_id,
          message: _truncate(r.evaluation_summary, 96),
        });
      }
    } catch (_e) { /* skip source */ }
  }

  // ---- conflicts -----------------------------------------------------
  // Emit at detected_at; if resolved_at present also emit at resolved_at.
  if (tables.has('conflicts')) {
    try {
      const rows = db.prepare(`
        SELECT id, conflict_type, agent_a, agent_b, status,
               detected_at, resolved_at, summary
          FROM conflicts
         ORDER BY COALESCE(resolved_at, detected_at) DESC
         LIMIT ?
      `).all(PER_SOURCE_LIMIT);
      for (const r of rows) {
        events.push({
          ts: r.detected_at,
          severity: 'warn',
          source: 'conflicts',
          type: 'conflict.detected',
          agent_id: r.agent_a || null,
          task_id: null,
          target: r.id,
          message: _truncate(r.summary || `${r.conflict_type}: ${r.agent_a} ↔ ${r.agent_b || '?'}`, 96),
        });
        if (r.resolved_at != null) {
          events.push({
            ts: r.resolved_at,
            severity: 'info',
            source: 'conflicts',
            type: 'conflict.resolved',
            agent_id: r.agent_a || null,
            task_id: null,
            target: r.id,
            message: _truncate(r.summary || `${r.conflict_type} resolved`, 96),
          });
        }
      }
    } catch (_e) { /* skip source */ }
  }

  // ---- dispatch_requests --------------------------------------------
  // Use confirmed_at if present, else created_at. Terminal-state non-CONFIRMED
  // rows leave confirmed_at NULL — created_at is the only universal anchor.
  if (tables.has('dispatch_requests')) {
    try {
      const rows = db.prepare(`
        SELECT id, nl_intent, status, target_agent, task_id,
               created_at, confirmed_at
          FROM dispatch_requests
         ORDER BY COALESCE(confirmed_at, created_at) DESC
         LIMIT ?
      `).all(PER_SOURCE_LIMIT);
      for (const r of rows) {
        const statusLower = String(r.status || '').toLowerCase();
        const severity =
          r.status === 'FAILED' || r.status === 'REJECTED' ? 'error' :
          r.status === 'PENDING' ? 'warn' :
          'info';
        events.push({
          ts: r.confirmed_at || r.created_at,
          severity,
          source: 'dispatch',
          type: `dispatch.${statusLower}`,
          agent_id: r.target_agent || null,
          task_id: r.task_id || null,
          target: r.id,
          message: _truncate(r.nl_intent, 96),
        });
      }
    } catch (_e) { /* skip source */ }
  }

  // Merge: sort by ts DESC, then cap.
  events.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  if (events.length > TOTAL_LIMIT) events.length = TOTAL_LIMIT;
  return events;
}

/**
 * @typedef {Object} RunLogEvent
 * @property {number} ts                     unix ms
 * @property {'info'|'warn'|'error'} severity
 * @property {'tasks'|'blockers'|'outcomes'|'conflicts'|'dispatch'} source
 * @property {string} type                   e.g. 'task.failed' / 'blocker.opened'
 * @property {string|null} agent_id
 * @property {string|null} task_id
 * @property {string|null} target            id of the originating row
 * @property {string} message                short human-readable
 */

// ---------------------------------------------------------------------------
// Legacy queries (kept for inspector-legacy.html + preview.html pet sprite)
// ---------------------------------------------------------------------------
//
// These read older shape used by inspector-legacy.js (incl. lanes table)
// and the pet sprite renderer. They live here so main.cjs can stay slim,
// but their shape is frozen — don't extend them; new fields go through
// queryProjectSummary / new dedicated helpers.

function queryLegacyState(db, tables) {
  const empty = {
    available: false, agents_active: 0, conflicts_open: 0,
    lanes_held_for_human: 0, lanes_reverting: 0, dispatch_pending: 0,
    last_dispatch_status: null, last_dispatch_age_sec: null,
    newest_agent_age_sec: null, ts: Math.floor(Date.now() / 1000),
  };

  if (!db) return empty;

  try {
    let agents_active = 0, newest_agent_age_sec = null;
    if (tables.has('processes')) {
      agents_active = db.prepare(`SELECT COUNT(*) AS c FROM processes WHERE status='ACTIVE'`).get().c;
      const newest = db.prepare(`SELECT MAX(registered_at) AS t FROM processes`).get();
      if (newest && newest.t != null)
        newest_agent_age_sec = Math.round((Date.now() - newest.t) / 100) / 10;
    }

    let conflicts_open = 0;
    if (tables.has('conflicts'))
      conflicts_open = db.prepare(`SELECT COUNT(*) AS c FROM conflicts WHERE status='OPEN'`).get().c;

    let lanes_held_for_human = 0, lanes_reverting = 0;
    if (tables.has('lanes')) {
      lanes_held_for_human = db.prepare(`SELECT COUNT(*) AS c FROM lanes WHERE state='HELD_FOR_HUMAN'`).get().c;
      lanes_reverting = db.prepare(`SELECT COUNT(*) AS c FROM lanes WHERE state='REVERTING'`).get().c;
    }

    let last_dispatch_status = null, last_dispatch_age_sec = null, dispatch_pending = 0;
    if (tables.has('dispatch_requests')) {
      const row = db.prepare(
        `SELECT status, created_at FROM dispatch_requests ORDER BY created_at DESC LIMIT 1`
      ).get();
      if (row) {
        last_dispatch_status = row.status.toLowerCase();
        last_dispatch_age_sec = Math.round((Date.now() - row.created_at) / 100) / 10;
      }
      dispatch_pending = db.prepare(`SELECT COUNT(*) AS c FROM dispatch_requests WHERE status='PENDING'`).get().c;
    }

    return {
      available: true, agents_active, conflicts_open,
      lanes_held_for_human, lanes_reverting, dispatch_pending,
      last_dispatch_status, last_dispatch_age_sec,
      newest_agent_age_sec, ts: Math.floor(Date.now() / 1000),
    };
  } catch (_e) {
    return empty;
  }
}

function queryActiveAgents(db, tables) {
  if (!db || !tables.has('processes')) return [];
  try {
    return db.prepare(`SELECT * FROM processes WHERE status='ACTIVE'`).all();
  } catch (_e) { return []; }
}

function queryOpenConflicts(db, tables) {
  if (!db || !tables.has('conflicts')) return [];
  try {
    return db.prepare(`SELECT * FROM conflicts WHERE status='OPEN'`).all();
  } catch (_e) { return []; }
}

function queryRecentDispatches(db, tables) {
  if (!db || !tables.has('dispatch_requests')) return [];
  try {
    return db.prepare(`SELECT * FROM dispatch_requests ORDER BY created_at DESC LIMIT 20`).all();
  } catch (_e) { return []; }
}

function queryActiveLanes(db, tables) {
  if (!db || !tables.has('lanes')) return [];
  try {
    return db.prepare(
      `SELECT * FROM lanes WHERE state IN ('RECORDED','REVERTING','HELD_FOR_HUMAN','FAILED_RETRYABLE')`
    ).all();
  } catch (_e) { return []; }
}

module.exports = {
  // schema helpers
  getTables,
  tablePresence,
  SUMMARY_TARGET_TABLES,
  // Day 1
  queryProjectSummary,
  // Day 2 placeholders
  queryTasksList,
  queryTaskDetail,
  queryRunLogEvents,
  // legacy (inspector-legacy + pet sprite)
  queryLegacyState,
  queryActiveAgents,
  queryOpenConflicts,
  queryRecentDispatches,
  queryActiveLanes,
};
