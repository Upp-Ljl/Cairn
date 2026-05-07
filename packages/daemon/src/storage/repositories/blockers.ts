import type { Database as DB } from 'better-sqlite3';
import { newId } from '../ids.js';
import { assertTransition, type TaskState } from '../tasks-state.js';
import { getTask, type TaskRow } from './tasks.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BlockerStatus = 'OPEN' | 'ANSWERED' | 'SUPERSEDED';

/** Raw row as stored in SQLite (before JSON deserialization). */
interface BlockerRowRaw {
  blocker_id: string;
  task_id: string;
  question: string;
  context_keys: string | null;  // JSON array string
  status: string;
  raised_by: string | null;
  raised_at: number;
  answer: string | null;
  answered_by: string | null;
  answered_at: number | null;
  metadata_json: string | null;
}

/** Public-facing type with deserialized JSON fields. */
export interface BlockerRow {
  blocker_id: string;
  task_id: string;
  question: string;
  context_keys: string[] | null;            // deserialized from JSON
  status: BlockerStatus;
  raised_by: string | null;
  raised_at: number;
  answer: string | null;
  answered_by: string | null;
  answered_at: number | null;
  metadata: Record<string, unknown> | null; // deserialized from metadata_json
}

// ---------------------------------------------------------------------------
// Module-private helpers
// ---------------------------------------------------------------------------

function toBlockerRow(raw: BlockerRowRaw): BlockerRow {
  return {
    blocker_id: raw.blocker_id,
    task_id: raw.task_id,
    question: raw.question,
    context_keys: raw.context_keys != null
      ? (JSON.parse(raw.context_keys) as string[])
      : null,
    status: raw.status as BlockerStatus,
    raised_by: raw.raised_by,
    raised_at: raw.raised_at,
    answer: raw.answer,
    answered_by: raw.answered_by,
    answered_at: raw.answered_at,
    metadata: raw.metadata_json != null
      ? (JSON.parse(raw.metadata_json) as Record<string, unknown>)
      : null,
  };
}

/**
 * Module-private: within an existing transaction context, read current task
 * state, assert the transition is legal, write new state + updated_at, and
 * return the updated TaskRow.
 *
 * Caller MUST wrap this in a db.transaction(). Do NOT call from outside a
 * transaction — better-sqlite3 flattens nested transactions to savepoints,
 * but this helper is designed to run as part of a larger outer transaction.
 */
function transitionTaskInTx(db: DB, taskId: string, to: TaskState): TaskRow {
  const raw = db
    .prepare('SELECT state FROM tasks WHERE task_id = ?')
    .get(taskId) as { state: string } | undefined;

  if (raw === undefined) {
    throw new Error(`TASK_NOT_FOUND: ${taskId}`);
  }

  const from = raw.state as TaskState;
  assertTransition(from, to);

  const now = Date.now();
  db.prepare('UPDATE tasks SET state = ?, updated_at = ? WHERE task_id = ?')
    .run(to, now, taskId);

  return getTask(db, taskId)!;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Record a new blocker for a task. In a single transaction:
 * 1. assertTransition(currentTaskState, 'BLOCKED') — throws if task not RUNNING.
 * 2. transitionTaskInTx(db, task_id, 'BLOCKED') — writes new state + updated_at.
 * 3. INSERT blocker (status='OPEN', raised_at=Date.now()).
 *
 * Any throw in steps 1/2/3 rolls back BOTH the state write and the blocker insert.
 *
 * Errors:
 *   - task not found → throws 'TASK_NOT_FOUND: ...'
 *   - task not in RUNNING → assertTransition throws 'Invalid task state transition: <from> -> BLOCKED'
 *   - INSERT violates a constraint → SQL throws (e.g. question NOT NULL)
 */
export function recordBlocker(
  db: DB,
  input: {
    task_id: string;
    question: string;
    context_keys?: string[];
    raised_by?: string;
  },
): { blocker: BlockerRow; task: TaskRow } {
  const txn = db.transaction(() => {
    // Step 1+2: assert + transition (throws on illegal state or missing task)
    const task = transitionTaskInTx(db, input.task_id, 'BLOCKED');

    // Step 3: INSERT blocker — must happen after state transition so any
    // constraint error (e.g. question NOT NULL) rolls back the state write too.
    const blocker_id = newId();
    const now = Date.now();
    const context_keys_json = input.context_keys != null
      ? JSON.stringify(input.context_keys)
      : null;

    db.prepare(`
      INSERT INTO blockers
        (blocker_id, task_id, question, context_keys, status, raised_by, raised_at,
         answer, answered_by, answered_at, metadata_json)
      VALUES
        (?, ?, ?, ?, 'OPEN', ?, ?, NULL, NULL, NULL, NULL)
    `).run(
      blocker_id,
      input.task_id,
      input.question,
      context_keys_json,
      input.raised_by ?? null,
      now,
    );

    const blocker = getBlocker(db, blocker_id)!;
    return { blocker, task };
  });

  return txn();
}

/**
 * Mark a blocker as answered. In a single transaction:
 * 1. Read blocker; throw 'BLOCKER_NOT_FOUND' if null.
 * 2. Assert blocker.status === 'OPEN'; else throw 'BLOCKER_ALREADY_ANSWERED'.
 * 3. UPDATE blocker SET status='ANSWERED', answer, answered_by, answered_at=Date.now().
 * 4. SELECT COUNT(*) FROM blockers WHERE task_id=? AND status='OPEN'.
 * 5. if count == 0: assertTransition(currentTaskState, 'READY_TO_RESUME') + transitionTaskInTx.
 *    if count > 0: task stays in BLOCKED, return current task row unchanged.
 *
 * Multi-blocker counting (LD-7): task only advances to READY_TO_RESUME when
 * ALL open blockers have been answered.
 *
 * Returns final blocker + task rows.
 */
export function markAnswered(
  db: DB,
  blocker_id: string,
  input: {
    answer: string;
    answered_by: string;
  },
): { blocker: BlockerRow; task: TaskRow } {
  const txn = db.transaction(() => {
    // Step 1: read blocker
    const existing = getBlocker(db, blocker_id);
    if (existing === null) {
      throw new Error(`BLOCKER_NOT_FOUND: ${blocker_id}`);
    }

    // Step 2: assert OPEN
    if (existing.status !== 'OPEN') {
      throw new Error(`BLOCKER_ALREADY_ANSWERED: ${blocker_id}`);
    }

    // Step 3: mark answered
    const now = Date.now();
    db.prepare(`
      UPDATE blockers
      SET status = 'ANSWERED', answer = ?, answered_by = ?, answered_at = ?
      WHERE blocker_id = ?
    `).run(input.answer, input.answered_by, now, blocker_id);

    // Step 4: count remaining OPEN blockers for this task
    const countRow = db
      .prepare("SELECT COUNT(*) as cnt FROM blockers WHERE task_id = ? AND status = 'OPEN'")
      .get(existing.task_id) as { cnt: number };

    let task: TaskRow;

    // Step 5: upgrade task state only if no more open blockers
    if (countRow.cnt === 0) {
      task = transitionTaskInTx(db, existing.task_id, 'READY_TO_RESUME');
    } else {
      // Task stays BLOCKED — return current task row unchanged
      task = getTask(db, existing.task_id)!;
    }

    const blocker = getBlocker(db, blocker_id)!;
    return { blocker, task };
  });

  return txn();
}

/**
 * List blockers for a task, ordered by raised_at ASC.
 * Optionally filter by one or more statuses.
 *
 * Public so mcp-server's assembleResumePacket can import. NOT registered as
 * MCP tool (LD-8); all external access goes through resume_packet aggregate.
 */
export function listBlockersByTask(
  db: DB,
  task_id: string,
  filter?: {
    status?: BlockerStatus | BlockerStatus[];
  },
): BlockerRow[] {
  const params: unknown[] = [task_id];
  let statusClause = '';

  if (filter?.status !== undefined) {
    const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
    const placeholders = statuses.map(() => '?').join(', ');
    statusClause = ` AND status IN (${placeholders})`;
    params.push(...statuses);
  }

  const sql = `
    SELECT * FROM blockers
    WHERE task_id = ?${statusClause}
    ORDER BY raised_at ASC
  `;

  const rows = db.prepare(sql).all(...params) as BlockerRowRaw[];
  return rows.map(toBlockerRow);
}

/**
 * Get a single blocker by blocker_id. Returns null if not found.
 *
 * Used by markAnswered + tests. NOT registered as MCP tool (LD-8).
 */
export function getBlocker(db: DB, blocker_id: string): BlockerRow | null {
  const raw = db
    .prepare('SELECT * FROM blockers WHERE blocker_id = ?')
    .get(blocker_id) as BlockerRowRaw | undefined;
  return raw != null ? toBlockerRow(raw) : null;
}
