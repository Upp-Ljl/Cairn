import type { Database as DB } from 'better-sqlite3';
import { writeBlobIfLarge, readBlob } from '../blobs.js';
import type { ScratchpadRow } from '../types.js';

export interface PutScratchInput {
  key: string;
  value: unknown;
  task_id?: string | null;
  expires_at?: number | null;
}

export function putScratch(db: DB, blobRoot: string, input: PutScratchInput): void {
  const now = Date.now();
  const ref = writeBlobIfLarge(input.value, blobRoot);
  db.prepare(`
    INSERT INTO scratchpad
      (key, value_json, value_path, task_id, expires_at, created_at, updated_at)
    VALUES (@key, @value_json, @value_path, @task_id, @expires_at, @created_at, @updated_at)
    ON CONFLICT(key) DO UPDATE SET
      value_json = excluded.value_json,
      value_path = excluded.value_path,
      task_id    = excluded.task_id,
      expires_at = excluded.expires_at,
      updated_at = excluded.updated_at
  `).run({
    key: input.key,
    value_json: ref.json ?? null,
    value_path: ref.path ?? null,
    task_id: input.task_id ?? null,
    expires_at: input.expires_at ?? null,
    created_at: now,
    updated_at: now,
  });
}

export function getScratch(db: DB, key: string): unknown | null {
  const row = db.prepare(
    'SELECT value_json, value_path FROM scratchpad WHERE key = ?'
  ).get(key) as { value_json: string | null; value_path: string | null } | undefined;
  if (!row) return null;
  return readBlob({
    ...(row.value_json !== null ? { json: row.value_json } : {}),
    ...(row.value_path !== null ? { path: row.value_path } : {}),
  });
}

export function listAllScratch(db: DB): ScratchpadRow[] {
  return db.prepare(
    'SELECT * FROM scratchpad ORDER BY updated_at DESC, rowid DESC'
  ).all() as ScratchpadRow[];
}

export function deleteScratch(db: DB, key: string): void {
  db.prepare('DELETE FROM scratchpad WHERE key = ?').run(key);
}
