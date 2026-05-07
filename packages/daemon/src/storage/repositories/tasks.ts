import type { Database as DB } from 'better-sqlite3';
import { newId } from '../ids.js';
import { type TaskState, assertTransition } from '../tasks-state.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Raw row as stored in SQLite. metadata_json is a JSON string or null. */
interface TaskRowRaw {
  task_id: string;
  intent: string;
  state: string;
  parent_task_id: string | null;
  created_at: number;
  updated_at: number;
  created_by_agent_id: string | null;
  metadata_json: string | null;
}

/** Public-facing type with deserialized metadata. */
export interface TaskRow {
  task_id: string;
  intent: string;
  state: TaskState;
  parent_task_id: string | null;
  created_at: number;
  updated_at: number;
  created_by_agent_id: string | null;
  metadata: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toTaskRow(raw: TaskRowRaw): TaskRow {
  return {
    task_id: raw.task_id,
    intent: raw.intent,
    state: raw.state as TaskState,
    parent_task_id: raw.parent_task_id,
    created_at: raw.created_at,
    updated_at: raw.updated_at,
    created_by_agent_id: raw.created_by_agent_id,
    metadata: raw.metadata_json != null
      ? (JSON.parse(raw.metadata_json) as Record<string, unknown>)
      : null,
  };
}

/**
 * Module-private helper: within an existing transaction context, read existing
 * metadata_json for the task, deep-merge the patch, write back, and update
 * updated_at. Does NOT touch state.
 *
 * Caller is responsible for wrapping in a transaction (better-sqlite3 flattens
 * nested transactions to savepoints, so this is safe to call from inside
 * db.transaction()).
 */
function mergeMetadataInTx(db: DB, taskId: string, patch: Record<string, unknown>): void {
  const raw = db
    .prepare('SELECT metadata_json FROM tasks WHERE task_id = ?')
    .get(taskId) as { metadata_json: string | null } | undefined;

  if (raw === undefined) {
    throw new Error(`task not found: ${taskId}`);
  }

  const existing: Record<string, unknown> = raw.metadata_json != null
    ? (JSON.parse(raw.metadata_json) as Record<string, unknown>)
    : {};

  const merged = { ...existing, ...patch };
  const now = Date.now();

  db.prepare('UPDATE tasks SET metadata_json = ?, updated_at = ? WHERE task_id = ?')
    .run(JSON.stringify(merged), now, taskId);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a new task. Assigns a ULID task_id, sets state = 'PENDING',
 * created_at = updated_at = Date.now(). Returns the full TaskRow.
 */
export function createTask(
  db: DB,
  input: {
    intent: string;
    parent_task_id?: string;
    created_by_agent_id?: string;
    metadata?: Record<string, unknown>;
  },
): TaskRow {
  const task_id = newId();
  const now = Date.now();
  const metadata_json = input.metadata != null ? JSON.stringify(input.metadata) : null;

  db.prepare(`
    INSERT INTO tasks
      (task_id, intent, state, parent_task_id, created_at, updated_at,
       created_by_agent_id, metadata_json)
    VALUES
      (@task_id, @intent, @state, @parent_task_id, @created_at, @updated_at,
       @created_by_agent_id, @metadata_json)
  `).run({
    task_id,
    intent: input.intent,
    state: 'PENDING',
    parent_task_id: input.parent_task_id ?? null,
    created_at: now,
    updated_at: now,
    created_by_agent_id: input.created_by_agent_id ?? null,
    metadata_json,
  });

  return getTask(db, task_id)!;
}

/**
 * Get a single task by task_id. Returns null if not found.
 */
export function getTask(db: DB, taskId: string): TaskRow | null {
  const raw = db
    .prepare('SELECT * FROM tasks WHERE task_id = ?')
    .get(taskId) as TaskRowRaw | undefined;
  return raw != null ? toTaskRow(raw) : null;
}

/**
 * List tasks with optional filters.
 * - state: filter by one or more states
 * - parent_task_id: pass null to filter for root tasks (parent_task_id IS NULL);
 *   pass a string to filter for tasks with that specific parent
 * - limit: maximum number of results (ordered by created_at ASC)
 */
export function listTasks(
  db: DB,
  filter?: {
    state?: TaskState | TaskState[];
    parent_task_id?: string | null;
    limit?: number;
  },
): TaskRow[] {
  const where: string[] = [];
  const params: unknown[] = [];

  if (filter?.state !== undefined) {
    const states = Array.isArray(filter.state) ? filter.state : [filter.state];
    const placeholders = states.map(() => '?').join(', ');
    where.push(`state IN (${placeholders})`);
    params.push(...states);
  }

  if (filter?.parent_task_id !== undefined) {
    if (filter.parent_task_id === null) {
      where.push('parent_task_id IS NULL');
    } else {
      where.push('parent_task_id = ?');
      params.push(filter.parent_task_id);
    }
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const limitSql = filter?.limit !== undefined ? `LIMIT ${filter.limit}` : '';
  const sql = `SELECT * FROM tasks ${whereSql} ORDER BY created_at ASC ${limitSql}`.trim();

  const rows = db.prepare(sql).all(...params) as TaskRowRaw[];
  return rows.map(toTaskRow);
}

/**
 * Update a task's state. In a single transaction:
 * 1. Reads the current state.
 * 2. Calls assertTransition(old, to) — throws on illegal transition.
 * 3. Writes new state + updated_at.
 * Does NOT touch metadata. Returns the updated TaskRow.
 */
export function updateTaskState(db: DB, taskId: string, to: TaskState): TaskRow {
  const txn = db.transaction(() => {
    const raw = db
      .prepare('SELECT state FROM tasks WHERE task_id = ?')
      .get(taskId) as { state: string } | undefined;

    if (raw === undefined) {
      throw new Error(`task not found: ${taskId}`);
    }

    const from = raw.state as TaskState;
    assertTransition(from, to);

    const now = Date.now();
    db.prepare('UPDATE tasks SET state = ?, updated_at = ? WHERE task_id = ?')
      .run(to, now, taskId);

    return getTask(db, taskId)!;
  });

  return txn();
}

/**
 * Cancel a task. In a SINGLE transaction:
 * 1. Transitions state to CANCELLED (via assertTransition guard).
 * 2. Merges { cancel_reason, cancelled_at } into metadata.
 * If either step throws, both writes roll back atomically.
 * Returns the updated TaskRow.
 */
export function cancelTask(db: DB, taskId: string, reason?: string): TaskRow {
  const txn = db.transaction(() => {
    // Read current state for the transition guard
    const raw = db
      .prepare('SELECT state FROM tasks WHERE task_id = ?')
      .get(taskId) as { state: string } | undefined;

    if (raw === undefined) {
      throw new Error(`task not found: ${taskId}`);
    }

    const from = raw.state as TaskState;
    assertTransition(from, 'CANCELLED');

    const now = Date.now();
    db.prepare('UPDATE tasks SET state = ?, updated_at = ? WHERE task_id = ?')
      .run('CANCELLED', now, taskId);

    // Merge cancel metadata atomically within same transaction
    mergeMetadataInTx(db, taskId, {
      cancel_reason: reason ?? null,
      cancelled_at: Date.now(),
    });

    return getTask(db, taskId)!;
  });

  return txn();
}

/**
 * Get a task and all its descendants (BFS). Includes the root.
 * If root doesn't exist, returns empty array.
 */
export function getTaskTree(db: DB, rootTaskId: string): TaskRow[] {
  const root = getTask(db, rootTaskId);
  if (root === null) {
    return [];
  }

  const result: TaskRow[] = [root];
  const queue: string[] = [rootTaskId];

  while (queue.length > 0) {
    const parentId = queue.shift()!;
    const children = db
      .prepare('SELECT * FROM tasks WHERE parent_task_id = ?')
      .all(parentId) as TaskRowRaw[];

    for (const child of children) {
      const childRow = toTaskRow(child);
      result.push(childRow);
      queue.push(childRow.task_id);
    }
  }

  return result;
}
