'use strict';

/**
 * mode-a-session-store.cjs — durable mapping (project_id, plan_id) →
 * Claude session_id, so Mode A can spawn `claude --resume <id>` across
 * plan steps without losing context.
 *
 * Phase 2 of the stream-json switch (2026-05-14). Goal: when the first
 * step of a plan emits a `result` event, we capture CC's session_id
 * and persist it. The next plan step's spawn passes `--resume <id>`,
 * so CC keeps its full context (files read, tool history, etc).
 *
 * Storage: scratchpad table, key shape:
 *   `mode_a_session/<project_id>/<plan_id>`
 * Value:
 *   { session_id: string, run_id: string, captured_at: number, plan_id: string }
 *
 * Plan supersession is handled implicitly: a new plan_id means a new
 * scratchpad key → no prior row → fresh spawn. The orphan scratchpad
 * row for the old plan_id is harmless (small + rarely written). A
 * future GC pass can prune them — Phase 2 leaves them.
 *
 * No MCP tool exposes this. Read/written from desktop-shell only.
 */

const PREFIX = 'mode_a_session/';

function _key(projectId, planId) {
  if (!projectId || !planId) return null;
  return PREFIX + projectId + '/' + planId;
}

/**
 * Look up the session_id for a (project, plan). Returns null if absent
 * or malformed. Read-only — never throws.
 */
function getSessionId(db, projectId, planId) {
  if (!db) return null;
  const key = _key(projectId, planId);
  if (!key) return null;
  try {
    const row = db.prepare('SELECT value_json FROM scratchpad WHERE key = ?').get(key);
    if (!row || !row.value_json) return null;
    const v = JSON.parse(row.value_json);
    if (v && typeof v.session_id === 'string' && v.session_id) return v.session_id;
    return null;
  } catch (_e) { return null; }
}

/**
 * Read the full session record (session_id + metadata) for diagnostics.
 */
function getSessionRecord(db, projectId, planId) {
  if (!db) return null;
  const key = _key(projectId, planId);
  if (!key) return null;
  try {
    const row = db.prepare('SELECT value_json, created_at, updated_at FROM scratchpad WHERE key = ?').get(key);
    if (!row || !row.value_json) return null;
    const v = JSON.parse(row.value_json);
    return Object.assign({}, v, {
      _row_created_at: row.created_at || null,
      _row_updated_at: row.updated_at || null,
    });
  } catch (_e) { return null; }
}

/**
 * Persist a session_id for (project, plan). Upsert semantics — replaces
 * any prior row. Returns { ok, key } | { ok:false, error }.
 *
 * Validates inputs strictly: session_id must be a non-empty string,
 * project_id + plan_id must both be strings. We want a loud failure
 * here, not a silent corrupted row.
 */
function setSessionId(db, projectId, planId, sessionId, runId, now) {
  if (!db) return { ok: false, error: 'db_required' };
  if (typeof projectId !== 'string' || !projectId) return { ok: false, error: 'project_id_required' };
  if (typeof planId !== 'string' || !planId) return { ok: false, error: 'plan_id_required' };
  if (typeof sessionId !== 'string' || !sessionId) return { ok: false, error: 'session_id_required' };

  const key = _key(projectId, planId);
  const ts = now || Date.now();
  const valueJson = JSON.stringify({
    session_id: sessionId,
    run_id: runId || null,
    plan_id: planId,
    captured_at: ts,
  });

  try {
    const existing = db.prepare('SELECT key FROM scratchpad WHERE key = ?').get(key);
    if (existing) {
      db.prepare('UPDATE scratchpad SET value_json = ?, updated_at = ? WHERE key = ?')
        .run(valueJson, ts, key);
    } else {
      db.prepare(`
        INSERT INTO scratchpad
          (key, value_json, value_path, task_id, expires_at, created_at, updated_at)
        VALUES
          (?, ?, NULL, NULL, NULL, ?, ?)
      `).run(key, valueJson, ts, ts);
    }
    return { ok: true, key };
  } catch (e) {
    return { ok: false, error: 'write_failed', detail: (e && e.message) || String(e) };
  }
}

/**
 * Delete the session record for (project, plan). Used when:
 *   - User explicitly cancels / supersedes the plan
 *   - A spawn with --resume returns an error indicating the session
 *     is gone on CC's side (Phase 2.5 — not wired yet)
 */
function clearSessionId(db, projectId, planId) {
  if (!db) return { ok: false, error: 'db_required' };
  const key = _key(projectId, planId);
  if (!key) return { ok: false, error: 'bad_key' };
  try {
    const info = db.prepare('DELETE FROM scratchpad WHERE key = ?').run(key);
    return { ok: true, deleted: info.changes };
  } catch (e) {
    return { ok: false, error: 'delete_failed', detail: (e && e.message) || String(e) };
  }
}

module.exports = {
  getSessionId,
  getSessionRecord,
  setSessionId,
  clearSessionId,
  _key,
  PREFIX,
};
