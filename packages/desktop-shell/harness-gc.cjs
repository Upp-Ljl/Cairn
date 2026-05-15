'use strict';

/**
 * harness-gc.cjs — Process garbage collector + orphaned task recovery.
 *
 * Runs during mentor-tick (30s interval). Two independent operations:
 *
 *   reapStaleProcesses(db, opts)
 *     Mark ACTIVE processes as STALE if last_heartbeat is older than
 *     staleThresholdMs. Returns { reaped, agent_ids }.
 *
 *   recoverOrphanedTasks(db, opts)
 *     Find RUNNING tasks whose created_by_agent_id has no ACTIVE process
 *     row. Mark them FAILED with metadata.gc_reason = 'agent_dead'.
 *     Returns { recovered, task_ids }.
 *
 * Rules:
 *   - Pure module: only requires cairn-log.cjs for structured logging.
 *   - Does NOT import better-sqlite3 — receives db as a parameter.
 *   - All SQL in try/catch; cairnLog.warn on failure.
 *   - Idempotent: running twice with same state produces same result.
 *   - Does NOT touch tasks in states other than RUNNING.
 */

const cairnLog = require('./cairn-log.cjs');

const COMPONENT = 'harness-gc';

/** Default staleness threshold: 5 minutes. */
const DEFAULT_STALE_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * Mark ACTIVE processes as STALE when their last_heartbeat is older than
 * (nowFn() - staleThresholdMs).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ staleThresholdMs?: number, nowFn?: () => number }} [opts]
 * @returns {{ reaped: number, agent_ids: string[] }}
 */
function reapStaleProcesses(db, opts) {
  const { staleThresholdMs = DEFAULT_STALE_THRESHOLD_MS, nowFn = Date.now } = opts || {};

  if (!db) {
    cairnLog.warn(COMPONENT, 'reap_stale_processes_skipped', { reason: 'no_db' });
    return { reaped: 0, agent_ids: [] };
  }

  try {
    const cutoff = nowFn() - staleThresholdMs;

    // First, collect the agent_ids that will be reaped (for the return value).
    const staleRows = db
      .prepare(
        `SELECT agent_id FROM processes
         WHERE status = 'ACTIVE'
           AND last_heartbeat < ?`,
      )
      .all(cutoff);

    if (staleRows.length === 0) {
      return { reaped: 0, agent_ids: [] };
    }

    const agent_ids = staleRows.map((r) => r.agent_id);

    // Mark them STALE in one shot.
    const result = db
      .prepare(
        `UPDATE processes SET status = 'STALE'
         WHERE status = 'ACTIVE'
           AND last_heartbeat < ?`,
      )
      .run(cutoff);

    const reaped = result.changes;

    cairnLog.info(COMPONENT, 'reap_stale_processes', {
      reaped,
      cutoff_ms: cutoff,
      stale_threshold_ms: staleThresholdMs,
      agent_ids,
    });

    return { reaped, agent_ids };
  } catch (err) {
    cairnLog.warn(COMPONENT, 'reap_stale_processes_error', {
      error: String(err && err.message ? err.message : err),
    });
    return { reaped: 0, agent_ids: [] };
  }
}

/**
 * Find RUNNING tasks whose created_by_agent_id has no ACTIVE process row,
 * and mark them FAILED with metadata.gc_reason = 'agent_dead'.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ nowFn?: () => number }} [opts]
 * @returns {{ recovered: number, task_ids: string[] }}
 */
function recoverOrphanedTasks(db, opts) {
  const { nowFn = Date.now } = opts || {};

  if (!db) {
    cairnLog.warn(COMPONENT, 'recover_orphaned_tasks_skipped', { reason: 'no_db' });
    return { recovered: 0, task_ids: [] };
  }

  try {
    // Find RUNNING tasks whose agent has no ACTIVE process row.
    // Tasks with null created_by_agent_id are excluded — we can't tell
    // if that agent is alive or dead, so we leave them alone.
    const orphaned = db
      .prepare(
        `SELECT t.task_id, t.created_by_agent_id, t.metadata_json
         FROM tasks t
         LEFT JOIN processes p
           ON t.created_by_agent_id = p.agent_id
          AND p.status = 'ACTIVE'
         WHERE t.state = 'RUNNING'
           AND t.created_by_agent_id IS NOT NULL
           AND p.agent_id IS NULL`,
      )
      .all();

    if (orphaned.length === 0) {
      return { recovered: 0, task_ids: [] };
    }

    const now = nowFn();
    const task_ids = [];

    const updateStmt = db.prepare(
      `UPDATE tasks
       SET state = 'FAILED',
           updated_at = ?,
           metadata_json = json_set(
             COALESCE(metadata_json, '{}'),
             '$.gc_reason', 'agent_dead',
             '$.gc_at', ?
           )
       WHERE task_id = ?
         AND state = 'RUNNING'`,
    );

    // Run each update individually so we can count actual changes and
    // collect task_ids faithfully (the AND state='RUNNING' guard makes
    // this idempotent if called twice).
    const updateMany = db.transaction((rows) => {
      for (const row of rows) {
        const r = updateStmt.run(now, now, row.task_id);
        if (r.changes > 0) {
          task_ids.push(row.task_id);
        }
      }
    });

    updateMany(orphaned);

    const recovered = task_ids.length;

    cairnLog.info(COMPONENT, 'recover_orphaned_tasks', {
      recovered,
      task_ids,
    });

    return { recovered, task_ids };
  } catch (err) {
    cairnLog.warn(COMPONENT, 'recover_orphaned_tasks_error', {
      error: String(err && err.message ? err.message : err),
    });
    return { recovered: 0, task_ids: [] };
  }
}

module.exports = {
  reapStaleProcesses,
  recoverOrphanedTasks,
  DEFAULT_STALE_THRESHOLD_MS,
};
