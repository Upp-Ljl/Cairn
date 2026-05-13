/**
 * Kernel-side helper for writing session_timeline events to the scratchpad.
 *
 * Usage: call appendKernelTimelineEvent() just before returning success in each
 * task state-transition tool. Failures are non-fatal — the caller logs the
 * error and returns the original success response.
 *
 * Key format: `session_timeline/<agentId>/<ulid>`
 * Value shape: { ts, kind, label, agent_id, task_id?, parent_event_id?, source: 'kernel' }
 */

import type { Database as DB } from 'better-sqlite3';
import { newUlid } from './ulid.js';

export interface KernelTimelineEventOpts {
  task_id?: string | undefined;
  parent_event_id?: string | undefined;
  /** Override Date.now() for deterministic tests. */
  nowFn?: (() => number) | undefined;
}

export type AppendKernelTimelineResult =
  | { ok: true; key: string }
  | { ok: false; error: string };

/**
 * Write a `source:'kernel'` session_timeline event to the scratchpad table.
 *
 * @param db       - better-sqlite3 handle (must have migrations run)
 * @param agentId  - the session agent id (e.g. `cairn-session-<12hex>`)
 * @param kind     - event kind: 'start' | 'progress' | 'done' | 'blocked' | 'unblocked'
 * @param label    - ≤120-char human label
 * @param opts     - optional task_id / parent_event_id / nowFn
 *
 * @returns { ok: true, key } on success; { ok: false, error } if agentId is
 *   empty or if the DB write throws.
 */
export function appendKernelTimelineEvent(
  db: DB,
  agentId: string,
  kind: string,
  label: string,
  opts?: KernelTimelineEventOpts,
): AppendKernelTimelineResult {
  if (!agentId || agentId.trim() === '') {
    return { ok: false, error: 'agentId is required for kernel timeline event' };
  }

  try {
    const ulid = newUlid();
    const key = `session_timeline/${agentId}/${ulid}`;
    const now = opts?.nowFn != null ? opts.nowFn() : Date.now();

    // Build content object — omit optional fields when not provided
    const content: Record<string, unknown> = {
      ts: now,
      kind,
      label: label.slice(0, 120),
      agent_id: agentId,
      source: 'kernel',
    };
    if (opts?.task_id !== undefined) {
      content['task_id'] = opts.task_id;
    }
    if (opts?.parent_event_id !== undefined) {
      content['parent_event_id'] = opts.parent_event_id;
    }

    const valueJson = JSON.stringify(content);

    // Direct INSERT into scratchpad (UPSERT semantics to match putScratch contract)
    const nowMs = Date.now();
    db.prepare(`
      INSERT INTO scratchpad
        (key, value_json, value_path, task_id, expires_at, created_at, updated_at)
      VALUES (@key, @value_json, NULL, @task_id, NULL, @created_at, @updated_at)
      ON CONFLICT(key) DO UPDATE SET
        value_json = excluded.value_json,
        task_id    = excluded.task_id,
        updated_at = excluded.updated_at
    `).run({
      key,
      value_json: valueJson,
      task_id: opts?.task_id ?? null,
      created_at: nowMs,
      updated_at: nowMs,
    });

    return { ok: true, key };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}
