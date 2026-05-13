'use strict';

/**
 * Mode B Continuous Iteration — lane data layer (Cairn cockpit 2026-05-14).
 *
 * A "lane" is an ordered list of candidate task_ids the user authorized
 * to run as a chain. The lane auto-advances: when the current candidate
 * reaches WAITING_REVIEW state (per PRODUCT.md §1.3 #4a: chain stops at
 * REVIEWED), the lane bumps `current_idx` to the next candidate and the
 * agent (or another worker) picks it up.
 *
 * Strict reverse-definition守卫:
 *   - Lane NEVER auto-accepts a REVIEWED task. User must explicitly
 *     advance via cockpit-lane-advance after eyeballing the result.
 *   - Lane does NOT mutate task state directly — it composes existing
 *     primitives (tasks / outcomes / dispatch_requests). Each candidate
 *     runs through the standard W5 state machine.
 *   - Lane runs in scratchpad, NOT a new table. Zero schema migration.
 *     namespace: `lane/<project_id>/<lane_id>` value:
 *       { id, project_id, candidates: [task_id, ...], current_idx,
 *         state: 'PENDING'|'RUNNING'|'REVIEW'|'PAUSED'|'DONE',
 *         authorized_by, created_at, updated_at }
 *
 * v1 scope (this slice):
 *   - createLane(db, projectId, candidates, authorizedBy) — write the lane
 *     row + return id
 *   - queryLanes(db, projectId, opts) — list lanes for a project
 *   - advanceLane(db, projectId, laneId) — bump current_idx after user
 *     approves; transitions state by current candidate's task state
 *   - pauseLane(db, projectId, laneId) — set state='PAUSED' (mentor-tick
 *     skips PAUSED lanes when polling)
 *
 * v2 scope (later slice): cockpit-state read of lane progress, panel
 * "Mode B" UI strip, mentor-tick polling to auto-advance when current
 * task reaches WAITING_REVIEW.
 */

const crypto = require('node:crypto');

const ENC = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
let _lastUlidMs = 0;
function newUlid() {
  let t = Date.now();
  if (t <= _lastUlidMs) t = _lastUlidMs + 1;
  _lastUlidMs = t;
  let ts = '';
  let n = t;
  for (let i = 9; i >= 0; i--) { ts = ENC[n % 32] + ts; n = Math.floor(n / 32); }
  const rand = crypto.randomBytes(10);
  let randPart = '';
  for (let i = 0; i < 16; i++) randPart += ENC[rand[i % 10] % 32];
  return ts + randPart;
}

const VALID_STATES = ['PENDING', 'RUNNING', 'REVIEW', 'PAUSED', 'DONE'];

function laneKey(projectId, laneId) {
  return `lane/${projectId}/${laneId}`;
}

function parseLaneValue(raw) {
  if (!raw) return null;
  let body = null;
  try { body = JSON.parse(raw); } catch (_e) { return null; }
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (_e) { return null; }
  }
  if (!body || typeof body !== 'object') return null;
  return body;
}

/**
 * Create a new lane for the project.
 *
 * @param {Database} db          better-sqlite3 write handle
 * @param {string} projectId     project registry id
 * @param {string[]} candidates  ordered task_ids to chain through
 * @param {string} authorizedBy  agent_id or 'user'
 * @returns {{ok:true, id:string}|{ok:false, error:string}}
 */
function createLane(db, projectId, candidates, authorizedBy) {
  if (!db) return { ok: false, error: 'db_required' };
  if (!projectId || typeof projectId !== 'string') return { ok: false, error: 'project_id_required' };
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { ok: false, error: 'candidates_required' };
  }
  for (const c of candidates) {
    if (typeof c !== 'string' || !c) return { ok: false, error: 'candidate_invalid' };
  }
  const laneId = newUlid();
  const now = Date.now();
  const payload = {
    id: laneId,
    project_id: projectId,
    candidates: candidates.slice(),
    current_idx: 0,
    state: 'PENDING',
    authorized_by: authorizedBy || 'user',
    created_at: now,
    updated_at: now,
  };
  try {
    db.prepare(`
      INSERT INTO scratchpad
        (key, value_json, value_path, task_id, expires_at, created_at, updated_at)
      VALUES (?, ?, NULL, NULL, NULL, ?, ?)
    `).run(laneKey(projectId, laneId), JSON.stringify(payload), now, now);
  } catch (e) {
    return { ok: false, error: 'write_failed: ' + (e && e.message ? e.message : String(e)) };
  }
  return { ok: true, id: laneId, key: laneKey(projectId, laneId) };
}

/**
 * Read lanes for a project, newest first.
 *
 * @returns Array<Lane>
 */
function queryLanes(db, projectId, opts) {
  if (!db || !projectId) return [];
  const limit = (opts && opts.limit) || 20;
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT key, value_json, updated_at
      FROM scratchpad
      WHERE key LIKE 'lane/' || ? || '/%'
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(projectId, limit);
  } catch (_e) { return []; }
  const out = [];
  for (const r of rows) {
    const body = parseLaneValue(r.value_json);
    if (!body) continue;
    out.push(body);
  }
  return out;
}

function getLane(db, projectId, laneId) {
  if (!db || !projectId || !laneId) return null;
  let row = null;
  try {
    row = db.prepare('SELECT value_json FROM scratchpad WHERE key = ?').get(laneKey(projectId, laneId));
  } catch (_e) { return null; }
  if (!row) return null;
  return parseLaneValue(row.value_json);
}

function writeLane(db, lane) {
  const now = Date.now();
  lane.updated_at = now;
  try {
    db.prepare(`
      UPDATE scratchpad SET value_json = ?, updated_at = ?
      WHERE key = ?
    `).run(JSON.stringify(lane), now, laneKey(lane.project_id, lane.id));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: 'write_failed: ' + (e && e.message ? e.message : String(e)) };
  }
}

/**
 * Advance the lane to the next candidate after user approves the current
 * one's REVIEWED outcome. Idempotent — already-DONE lanes return ok with
 * a 'already_done' note.
 */
function advanceLane(db, projectId, laneId) {
  const lane = getLane(db, projectId, laneId);
  if (!lane) return { ok: false, error: 'lane_not_found' };
  if (lane.state === 'DONE') return { ok: true, note: 'already_done', lane };
  if (lane.state === 'PAUSED') return { ok: false, error: 'lane_paused' };

  const nextIdx = lane.current_idx + 1;
  if (nextIdx >= lane.candidates.length) {
    lane.state = 'DONE';
    lane.current_idx = lane.candidates.length;  // off-end sentinel
  } else {
    lane.state = 'RUNNING';
    lane.current_idx = nextIdx;
  }
  const w = writeLane(db, lane);
  if (!w.ok) return w;
  return { ok: true, lane };
}

/**
 * Pause the lane — mentor-tick (later slice) skips PAUSED lanes when
 * deciding to advance.
 */
function pauseLane(db, projectId, laneId) {
  const lane = getLane(db, projectId, laneId);
  if (!lane) return { ok: false, error: 'lane_not_found' };
  if (lane.state === 'DONE') return { ok: false, error: 'lane_already_done' };
  lane.state = 'PAUSED';
  const w = writeLane(db, lane);
  if (!w.ok) return w;
  return { ok: true, lane };
}

/**
 * Resume from PAUSED → RUNNING (or back to PENDING if never started).
 */
function resumeLane(db, projectId, laneId) {
  const lane = getLane(db, projectId, laneId);
  if (!lane) return { ok: false, error: 'lane_not_found' };
  if (lane.state !== 'PAUSED') return { ok: false, error: 'lane_not_paused' };
  lane.state = lane.current_idx === 0 ? 'PENDING' : 'RUNNING';
  const w = writeLane(db, lane);
  if (!w.ok) return w;
  return { ok: true, lane };
}

module.exports = {
  VALID_STATES,
  newUlid,
  laneKey,
  createLane,
  queryLanes,
  getLane,
  advanceLane,
  pauseLane,
  resumeLane,
};
