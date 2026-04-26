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

export function listCheckpoints(db: DB, status?: CheckpointStatus): CheckpointRow[] {
  if (status) {
    return db.prepare(
      'SELECT * FROM checkpoints WHERE snapshot_status = ? ORDER BY created_at DESC, rowid DESC'
    ).all(status) as CheckpointRow[];
  }
  return db.prepare(
    'SELECT * FROM checkpoints ORDER BY created_at DESC, rowid DESC'
  ).all() as CheckpointRow[];
}
