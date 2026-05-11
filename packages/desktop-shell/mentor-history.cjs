'use strict';

/**
 * Mentor Layer — Turn History (append-only JSONL).
 *
 * Persists each Mentor chat turn to:
 *   ~/.cairn/mentor-history/<projectId>.jsonl
 *
 * Design mirrors project-candidates.cjs:
 *   - Append-only writes survive partial failures.
 *   - Per-project files keep growth isolated.
 *   - Malformed lines silently skipped on read.
 *   - Latest-wins fold by turn_id (getMentorEntry scans for last
 *     occurrence, supporting future "followup patch" writes).
 *
 * Rotation (per spec §7.5):
 *   - Before each append, if estimated new size > MAX_FILE_BYTES (5 MB),
 *     drop oldest 25% of records, archive current file, write kept 75%,
 *     then append the new entry.
 *
 * Read/write boundary:
 *   - Writes ONLY ~/.cairn/mentor-history/<projectId>.jsonl.
 *   - Does NOT touch cairn.db / ~/.claude / ~/.codex.
 *   - No child_process, no electron, no better-sqlite3.
 */

const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Constants (exported per spec)
// ---------------------------------------------------------------------------

const HISTORY_DIRNAME = 'mentor-history';
const MAX_FILE_BYTES  = 5 * 1024 * 1024; // 5 MB per spec §7.5
const EVENT_VERSION   = 1;

// Internal read/return caps
const MAX_RETURN_DEFAULT = 50;

// Length caps (safety / spec §7.2)
const CAP_USER_QUESTION  = 2000;
const CAP_RANKED_ITEMS   = 20;
const CAP_ITEM_DESC      = 240;
const CAP_SESSION_ID     = 80;
const CAP_SIGNALS_HASH   = 80;

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function historyDir(home) {
  return path.join((home || os.homedir()), '.cairn', HISTORY_DIRNAME);
}

/**
 * Map a project_id to a JSONL file path. Same sanitization rule as
 * project-candidates.cjs: replace [^a-zA-Z0-9_\-] with _, slice to 64.
 */
function historyFile(projectId, home) {
  const safe = String(projectId || '').replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 64);
  return path.join(historyDir(home), safe + '.jsonl');
}

function ensureHistoryDir(home) {
  try { fs.mkdirSync(historyDir(home), { recursive: true }); } catch (_e) {}
}

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

function newTurnId() {
  return 'h_' + crypto.randomBytes(6).toString('hex');
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function clip(s, max) {
  if (typeof s !== 'string') return '';
  const t = s.trim();
  return t.length > max ? t.slice(0, max) : t;
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a raw entry object before writing to disk.
 *
 * - Assigns turn_id if missing.
 * - Clips user_question to 2000 chars.
 * - Clips ranked_items to 20 entries; clips each item's description to 240.
 * - Defaults signals_summary fields if missing.
 * - Defaults llm_meta if missing.
 * - ts = Date.now() if missing.
 * - session_id = turn_id if missing (single-turn fallback).
 */
function normalizeEntry(projectId, input) {
  const i = (input && typeof input === 'object') ? input : {};
  const turn_id = clip(i.turn_id, 80) || newTurnId();

  // session_id: fallback to turn_id if absent/empty
  const raw_session = clip(i.session_id, CAP_SESSION_ID);
  const session_id  = raw_session || turn_id;

  // user_question
  const user_question = clip(
    typeof i.user_question === 'string' ? i.user_question : '',
    CAP_USER_QUESTION
  );

  // signals_hash
  const signals_hash = clip(
    typeof i.signals_hash === 'string' ? i.signals_hash : '',
    CAP_SIGNALS_HASH
  );

  // signals_summary — fill defaults for each known field
  const raw_ss = (i.signals_summary && typeof i.signals_summary === 'object')
    ? i.signals_summary : {};
  const signals_summary = {
    candidates_count: (typeof raw_ss.candidates_count === 'number') ? raw_ss.candidates_count : 0,
    tasks_count:      (typeof raw_ss.tasks_count      === 'number') ? raw_ss.tasks_count      : 0,
    open_blockers:    (typeof raw_ss.open_blockers     === 'number') ? raw_ss.open_blockers    : 0,
    failed_outcomes:  (typeof raw_ss.failed_outcomes   === 'number') ? raw_ss.failed_outcomes  : 0,
    git_head:         (typeof raw_ss.git_head === 'string' && raw_ss.git_head)
                        ? raw_ss.git_head.slice(0, 7) : null,
  };

  // ranked_items — cap count + clip each description
  const raw_items = Array.isArray(i.ranked_items) ? i.ranked_items : [];
  const ranked_items = raw_items.slice(0, CAP_RANKED_ITEMS).map(item => {
    if (!item || typeof item !== 'object') return item;
    const out = Object.assign({}, item);
    if (typeof out.description === 'string') {
      out.description = clip(out.description, CAP_ITEM_DESC) || out.description.slice(0, CAP_ITEM_DESC);
    }
    return out;
  });

  // llm_meta defaults
  const raw_lm = (i.llm_meta && typeof i.llm_meta === 'object') ? i.llm_meta : {};
  const llm_meta = {
    host:          (typeof raw_lm.host  === 'string') ? raw_lm.host  : null,
    model:         (typeof raw_lm.model === 'string') ? raw_lm.model : null,
    tokens_in:     (typeof raw_lm.tokens_in  === 'number') ? raw_lm.tokens_in  : 0,
    tokens_out:    (typeof raw_lm.tokens_out === 'number') ? raw_lm.tokens_out : 0,
    latency_ms:    (typeof raw_lm.latency_ms === 'number') ? raw_lm.latency_ms : 0,
    fallback_used: (typeof raw_lm.fallback_used === 'boolean') ? raw_lm.fallback_used : false,
  };

  const ts = (typeof i.ts === 'number' && i.ts > 0) ? i.ts : Date.now();

  // user_followup_actions: pass through if present, otherwise empty
  const user_followup_actions = Array.isArray(i.user_followup_actions)
    ? i.user_followup_actions : [];

  return {
    event_version: EVENT_VERSION,
    turn_id,
    ts,
    project_id: String(projectId || ''),
    session_id,
    user_question,
    signals_hash,
    signals_summary,
    ranked_items,
    llm_meta,
    user_followup_actions,
  };
}

// ---------------------------------------------------------------------------
// Raw JSONL read
// ---------------------------------------------------------------------------

function readAllLines(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (_e) { return []; }
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const out = [];
  for (const line of lines) {
    try { out.push(JSON.parse(line)); } catch (_e) { /* skip malformed */ }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rotation (per spec §7.5)
// ---------------------------------------------------------------------------

/**
 * Rotate the active JSONL file:
 *   1. Read all current parsed lines.
 *   2. Sort by ts ascending; keep newest 75%, drop oldest 25%.
 *   3. Rename current file to <safe>.<unix_ts>.jsonl (archive).
 *   4. Write kept lines to a tmp file, then rename to active path.
 *
 * Returns the archive filename (basename only) so appendMentorEntry can
 * include it in the result.
 */
function rotateFile(file) {
  const lines = readAllLines(file);
  // Sort by ts ascending (oldest first)
  lines.sort((a, b) => ((a && a.ts) || 0) - ((b && b.ts) || 0));
  const keep = Math.max(1, Math.ceil(lines.length * 0.75));
  const kept  = lines.slice(lines.length - keep); // newest 75%

  const archiveName = path.basename(file).replace(/\.jsonl$/, '') + '.' + Date.now() + '.jsonl';
  const archivePath = path.join(path.dirname(file), archiveName);

  // Archive current file (atomic rename)
  fs.renameSync(file, archivePath);

  // Write kept lines to tmp, then rename to active path (avoid corruption)
  const tmpPath = file + '.tmp';
  const content = kept.map(obj => JSON.stringify(obj)).join('\n') + (kept.length ? '\n' : '');
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, file);

  return archiveName;
}

/**
 * Check whether appending ~estimatedBytes to file would exceed MAX_FILE_BYTES.
 * Returns current file size (or 0 if not found).
 */
function currentFileSize(file) {
  try { return fs.statSync(file).size; } catch (_e) { return 0; }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Append a normalized Mentor turn entry to the project's history file.
 *
 * @param {string} projectId
 * @param {object} entry  — raw (pre-normalization) entry; normalizeEntry is called here.
 * @param {{ home?: string }} [opts]
 * @returns {{ ok: boolean, turn_id: string, file: string, rotated_to?: string, error?: string }}
 */
function appendMentorEntry(projectId, entry, opts) {
  if (!projectId) return { ok: false, turn_id: null, file: null, error: 'project_id_required' };
  const o = opts || {};
  ensureHistoryDir(o.home);

  const normalized = normalizeEntry(projectId, entry);
  const line       = JSON.stringify(normalized) + '\n';
  const file       = historyFile(projectId, o.home);

  // Rotation check
  const estimatedNewSize = currentFileSize(file) + Buffer.byteLength(line, 'utf8');
  let rotated_to;
  if (estimatedNewSize > MAX_FILE_BYTES) {
    try {
      rotated_to = rotateFile(file);
    } catch (_e) {
      // Rotation failed — still attempt append on best-effort basis
    }
  }

  try {
    fs.appendFileSync(file, line, 'utf8');
  } catch (_e) {
    return { ok: false, turn_id: normalized.turn_id, file, error: 'append_failed' };
  }

  const result = { ok: true, turn_id: normalized.turn_id, file };
  if (rotated_to !== undefined) result.rotated_to = rotated_to;
  return result;
}

/**
 * List Mentor turns for a project, newest first.
 *
 * @param {string} projectId
 * @param {number} [limit=50]
 * @param {{ home?: string }} [opts]
 * @returns {object[]}
 */
function listMentorHistory(projectId, limit, opts) {
  if (!projectId) return [];
  const o    = opts || {};
  const rows = readAllLines(historyFile(projectId, o.home));
  // Newest first
  rows.sort((a, b) => ((b && b.ts) || 0) - ((a && a.ts) || 0));
  const cap = Math.min(limit || MAX_RETURN_DEFAULT, MAX_RETURN_DEFAULT * 10); // no hard ceiling on list
  return rows.slice(0, cap);
}

/**
 * Retrieve a single turn by turn_id.
 * Scans all lines and returns the LAST occurrence (latest-wins, supports
 * future followup-patch writes with the same turn_id).
 *
 * @param {string} projectId
 * @param {string} turnId
 * @param {{ home?: string }} [opts]
 * @returns {object|null}
 */
function getMentorEntry(projectId, turnId, opts) {
  if (!projectId || !turnId) return null;
  const o    = opts || {};
  const rows = readAllLines(historyFile(projectId, o.home));
  let last = null;
  for (const row of rows) {
    if (row && row.turn_id === turnId) last = row;
  }
  return last;
}

/**
 * Return the most recent Mentor turn for a project, or null if none.
 *
 * @param {string} projectId
 * @param {{ home?: string }} [opts]
 * @returns {object|null}
 */
function latestMentorEntry(projectId, opts) {
  const rows = listMentorHistory(projectId, 1, opts);
  return rows.length > 0 ? rows[0] : null;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  HISTORY_DIRNAME,
  MAX_FILE_BYTES,
  EVENT_VERSION,
  historyDir,
  historyFile,
  newTurnId,
  normalizeEntry,
  appendMentorEntry,
  listMentorHistory,
  getMentorEntry,
  latestMentorEntry,
};
