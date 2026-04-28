import type { Database as DB } from 'better-sqlite3';
import { newId } from '../ids.js';
import type { CheckpointRow, CheckpointStatus } from '../types.js';

export interface NewCheckpoint {
  task_id?: string | null;
  label?: string | null;
  snapshot_dir: string;
}

export function createPendingCheckpoint(db: DB, input: NewCheckpoint): CheckpointRow {
  const now = Date.now();
  const row: CheckpointRow = {
    id: newId(),
    task_id: input.task_id ?? null,
    label: input.label ?? null,
    git_head: null,
    snapshot_dir: input.snapshot_dir,
    snapshot_status: 'PENDING',
    size_bytes: null,
    created_at: now,
    ready_at: null,
  };
  db.prepare(`
    INSERT INTO checkpoints
      (id, task_id, label, git_head, snapshot_dir, snapshot_status,
       size_bytes, created_at, ready_at)
    VALUES (@id, @task_id, @label, @git_head, @snapshot_dir, @snapshot_status,
            @size_bytes, @created_at, @ready_at)
  `).run(row);
  return row;
}

export function markCheckpointReady(
  db: DB,
  id: string,
  attrs: { size_bytes: number; git_head: string | null }
): void {
  db.prepare(`
    UPDATE checkpoints
       SET snapshot_status = 'READY',
           size_bytes = ?,
           git_head = ?,
           ready_at = ?
     WHERE id = ? AND snapshot_status = 'PENDING'
  `).run(attrs.size_bytes, attrs.git_head, Date.now(), id);
}

export function getCheckpointById(db: DB, id: string): CheckpointRow | null {
  const row = db.prepare('SELECT * FROM checkpoints WHERE id = ?').get(id) as CheckpointRow | undefined;
  return row ?? null;
}

export interface ListCheckpointsFilter {
  status?: CheckpointStatus;
  /**
   * If supplied, returns only checkpoints whose `task_id` matches exactly.
   * Pass an empty string `''` to match the literal empty-string task_id
   * (rare). Pass `null` to match rows where `task_id IS NULL` (the default
   * for checkpoints created without a task tag).
   */
  task_id?: string | null;
}

/**
 * @deprecated since adding the filter object form; use the object form
 * `listCheckpoints(db, { status, task_id })`. Kept for the existing
 * call sites that pass a bare status string.
 */
export function listCheckpoints(db: DB, status?: CheckpointStatus): CheckpointRow[];
export function listCheckpoints(db: DB, filter: ListCheckpointsFilter): CheckpointRow[];
export function listCheckpoints(
  db: DB,
  arg?: CheckpointStatus | ListCheckpointsFilter,
): CheckpointRow[] {
  // Normalize: legacy `status` string vs new filter object.
  const filter: ListCheckpointsFilter =
    typeof arg === 'string' ? { status: arg } : (arg ?? {});

  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.status !== undefined) {
    where.push('snapshot_status = ?');
    params.push(filter.status);
  }
  if (filter.task_id !== undefined) {
    if (filter.task_id === null) {
      where.push('task_id IS NULL');
    } else {
      where.push('task_id = ?');
      params.push(filter.task_id);
    }
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const sql = `SELECT * FROM checkpoints ${whereSql} ORDER BY created_at DESC, rowid DESC`;
  return db.prepare(sql).all(...params) as CheckpointRow[];
}
