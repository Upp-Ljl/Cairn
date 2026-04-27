import type { Database as DB } from 'better-sqlite3';
import { writeBlobIfLarge, readBlob } from '../blobs.js';
import type { ScratchpadRow } from '../types.js';

/**
 * Input shape for {@link putScratch}. All fields except `key` and `value` are optional.
 *
 * @property key - Primary key for the scratchpad entry. Opaque string; the MCP layer uses the
 *   convention `<namespace>:<id>` (e.g. `mcp:agent-1:note-3`), but the repository does not
 *   enforce any format.
 * @property value - Any JSON-serializable value. Stored inline in `value_json` when
 *   `JSON.stringify(value)` is below the 128 KB blob threshold (defined in `../blobs.js`);
 *   spilled to `<blobRoot>/blobs/{ab}/{sha256}` and recorded in `value_path` otherwise.
 * @property task_id - Optional foreign key associating this entry with a task. Currently no
 *   FK constraint exists (planned for P3 migration 006). `null` means "not task-scoped".
 * @property expires_at - Expiry timestamp in unix milliseconds. `null` means the entry never
 *   expires. W1 has no GC sweep, so this field is metadata-only until P3 adds `gcExpiredScratch`.
 */
export interface PutScratchInput {
  key: string;
  value: unknown;
  task_id?: string | null;
  expires_at?: number | null;
}

/**
 * 写入或覆盖一条 scratchpad 记录（UPSERT 语义）。
 *
 * 若 `key` 已存在，则更新 `value`、`task_id`、`expires_at` 和 `updated_at`，
 * 同时保留原始的 `created_at`（即首次写入时间）。
 *
 * @param db - better-sqlite3 database handle.
 * @param blobRoot - 大值溢出目录（通常为 `~/.cairn`）。超过 128 KB 的值会被写入
 *   此目录下的 `blobs/{ab}/{sha256}` 文件，并将路径记录到 `value_path` 列。
 * @param input - 参见 {@link PutScratchInput}。
 *
 * @remarks
 * Side effect: 若 `input.value` 序列化后 ≥ 128 KB，会向磁盘写入 blob 文件。
 * `created_at` 在冲突更新时保留；`updated_at` 始终反映最近一次 put 的时间。
 */
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

/**
 * 读取一条 scratchpad 记录并返回反序列化后的值。
 *
 * @param db - better-sqlite3 database handle.
 * @param key - 要查询的主键（参见 {@link PutScratchInput.key}）。
 * @returns 反序列化后的 JSON 值；若该 key 不存在则返回 `null`。
 *   若值已溢出到 blob 文件（`value_path` 非空），则从磁盘透明读取，对调用方无感知。
 *
 * @remarks
 * 不检查 `expires_at`——调用方需自行处理 TTL 语义。
 * P3 计划新增 `gcExpiredScratch` 来清理过期记录。
 */
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

/**
 * 返回所有 scratchpad 记录的原始数据库行，按最近修改时间降序排列。
 *
 * @param db - better-sqlite3 database handle.
 * @returns `ScratchpadRow[]`（来自 `../types.js`）。排序为 `updated_at DESC, rowid DESC`，
 *   即最近写入的记录排在最前；毫秒内有多条更新时以 `rowid` 作为二级排序。
 *
 * @remarks
 * 返回的是原始行（包含 `value_json` / `value_path`），**不包含**反序列化后的值。
 * 如需读取具体值，请对每个 `key` 调用 {@link getScratch}。
 */
export function listAllScratch(db: DB): ScratchpadRow[] {
  return db.prepare(
    'SELECT * FROM scratchpad ORDER BY updated_at DESC, rowid DESC'
  ).all() as ScratchpadRow[];
}

/**
 * 删除指定 key 的 scratchpad 记录。幂等：key 不存在时静默返回，不抛错。
 *
 * @param db - better-sqlite3 database handle.
 * @param key - 要删除的主键。
 *
 * @remarks
 * 若该记录的值已溢出到 blob 文件，**不会**自动删除对应的磁盘文件（产生孤立 blob）。
 * Blob GC 由 P2 的 `runStartupRecovery` 负责，而非此函数。
 */
export function deleteScratch(db: DB, key: string): void {
  db.prepare('DELETE FROM scratchpad WHERE key = ?').run(key);
}
