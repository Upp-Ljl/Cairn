import type { Database as DB } from 'better-sqlite3';
import { newId } from '../ids.js';
import { writeBlobIfLarge } from '../blobs.js';
import type { CompensationRow } from '../types.js';

export interface NewCompensation {
  strategy: string;
  payload?: unknown;
  max_attempts?: number;
}

export function createCompensation(
  db: DB,
  blobRoot: string,
  opId: string,
  input: NewCompensation
): CompensationRow {
  const now = Date.now();
  const payload = input.payload !== undefined
    ? writeBlobIfLarge(input.payload, blobRoot) : {};
  const row: CompensationRow = {
    id: newId(),
    op_id: opId,
    strategy: input.strategy,
    payload_json: payload.json ?? null,
    payload_path: payload.path ?? null,
    status: 'PENDING',
    attempt: 0,
    max_attempts: input.max_attempts ?? 3,
    last_attempt_at: null,
    last_error: null,
    created_at: now,
    updated_at: now,
  };
  db.prepare(
    `INSERT INTO compensations
       (id, op_id, strategy, payload_json, payload_path,
        status, attempt, max_attempts, last_attempt_at, last_error,
        created_at, updated_at)
     VALUES
       (@id, @op_id, @strategy, @payload_json, @payload_path,
        @status, @attempt, @max_attempts, @last_attempt_at, @last_error,
        @created_at, @updated_at)`
  ).run(row);
  return row;
}

export function markCompensationInProgress(db: DB, id: string): void {
  const now = Date.now();
  db.prepare(
    `UPDATE compensations
       SET status = 'IN_PROGRESS',
           attempt = attempt + 1,
           last_attempt_at = ?,
           updated_at = ?
     WHERE id = ?`
  ).run(now, now, id);
}

export function markCompensationResult(
  db: DB,
  id: string,
  ok: boolean,
  err?: string
): void {
  const now = Date.now();
  db.prepare(
    `UPDATE compensations
       SET status = ?,
           last_error = ?,
           updated_at = ?
     WHERE id = ?`
  ).run(ok ? 'SUCCESS' : 'FAILED', ok ? null : (err ?? null), now, id);
}

export function listPendingCompensationsByLane(
  db: DB,
  laneId: string
): CompensationRow[] {
  return db.prepare(
    `SELECT c.*
       FROM compensations c
       JOIN ops o ON o.id = c.op_id
      WHERE o.lane_id = ?
        AND c.status IN ('PENDING','FAILED')
      ORDER BY o.seq ASC, c.created_at ASC`
  ).all(laneId) as CompensationRow[];
}
