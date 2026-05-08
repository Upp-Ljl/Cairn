'use strict';

/**
 * Claude Code session-file presence adapter (Real Agent Presence step 2).
 *
 * Reads `~/.claude/sessions/<pid>.json` files written by Claude Code 2.1+.
 * Each file is a small JSON snapshot the CLI maintains for the lifetime of
 * one interactive session:
 *
 *   {
 *     "pid": 19452,
 *     "sessionId": "7f5bf59f-...",
 *     "cwd": "D:\\lll\\cairn",
 *     "startedAt": 1778242617458,
 *     "version": "2.1.133",
 *     "kind": "interactive",
 *     "entrypoint": "cli",
 *     "status": "busy",                <-- "busy" | "idle"
 *     "updatedAt": 1778243025239
 *   }
 *
 * This adapter is strictly read-only. It does not write to ~/.claude, does
 * not install hooks, does not read transcript jsonl. Bad JSON, missing
 * fields, dead pids — none of these may crash the caller; the row is
 * either skipped or marked DEAD/UNKNOWN.
 *
 * Project attribution is left to the caller: pass a project_root and the
 * adapter tells you whether a row's `cwd` is inside it (Windows-aware
 * path normalization is delegated to project-queries.cjs to keep one
 * canonical implementation). Rows that match no registered project are
 * Unassigned — same model as Cairn MCP rows.
 *
 * Confidence band: medium-high.
 *   - We can see: pid, sessionId, cwd, busy/idle, last-update timestamp.
 *   - We cannot see: current tool, prompt content, subagent topology.
 *     For those, the next step is the hooks adapter (writes to
 *     ~/.claude/settings.json — opt-in, deferred).
 *
 * Schema-stability: this adapter writes nothing. Cairn SQLite is not
 * touched. ~/.cairn/projects.json registry is not touched. The shape of
 * its output is the only public contract — see ClaudeSessionRow below.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const projectQueries = require('../project-queries.cjs');

// ---------------------------------------------------------------------------
// Status semantics (no tunables — Claude updatedAt is "last activity",
// not a heartbeat, so age does NOT promote a row to stale)
// ---------------------------------------------------------------------------
//
// Earlier draft promoted any row with `now - updatedAt > 90s` to `stale`.
// That was wrong: Claude only refreshes updatedAt on actual session
// activity (turn / tool use). An idle terminal that the user is keeping
// open between turns will go quiet for minutes at a time and is not
// stale in any user-meaningful sense — its pid is alive and the file's
// `status` (busy/idle) reflects what Claude wants the user to see.
//
// Current rule:
//   1. no pid                           → unknown
//   2. pid does not exist on this box   → dead
//   3. pid alive + recognized status    → busy / idle verbatim
//   4. pid alive + unknown status       → unknown
//
// `'stale'` is kept in the status union as a reserved value for a future
// explicit rule (e.g. "Claude updatedAt is older than the file's own mtime
// by N hours" → file is wedged). It is never produced today.
//
// The user-facing "last active" timeline is rendered from `updated_at` /
// `age_ms` in the UI — those fields are still emitted so the panel can
// say "BUSY · last active 8m ago" without lying about the row's state.

const SOURCE = 'claude-code/session-file';
const CONFIDENCE = 'medium-high';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} ClaudeSessionRow
 * @property {string} source           Always "claude-code/session-file"
 * @property {string} confidence       Always "medium-high" for this adapter
 * @property {number|null} pid
 * @property {string|null} session_id  Claude's UUID (NOT a Cairn agent_id)
 * @property {string|null} cwd
 * @property {string|null} version
 * @property {'busy'|'idle'|'stale'|'dead'|'unknown'} status
 * @property {number|null} started_at  unix ms
 * @property {number|null} updated_at  unix ms
 * @property {number|null} age_ms      now - updated_at; null if updated_at missing
 * @property {string} [stale_reason]   Set when status was promoted to stale/dead
 * @property {string} [raw_status]     Original Claude-side "busy"|"idle" before promotion
 * @property {string} [file]           Source file path (for diagnostics; not for UI)
 */

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Default sessions directory. Tests pass `sessionsDir` explicitly to keep
 * the host filesystem out of the picture.
 */
function defaultSessionsDir(home) {
  const h = home || os.homedir();
  return path.join(h, '.claude', 'sessions');
}

// ---------------------------------------------------------------------------
// PID liveness
// ---------------------------------------------------------------------------

/**
 * Cross-platform "is this pid alive on the local box?" check.
 *
 * `process.kill(pid, 0)` is documented to work on Windows for liveness
 * probing; it never delivers a signal, just validates the handle.
 *   - returns true on success → pid is alive.
 *   - throws ESRCH → pid does not exist → dead.
 *   - throws EPERM → pid exists but we lack the privilege to query it
 *     (different user; common on Windows for elevated processes).
 *     Treat as alive: we have positive evidence the pid is in use.
 *   - any other throw (rare) → conservative "unknown" → caller maps to
 *     dead since the file's claim is no longer verifiable.
 *
 * @param {number|null|undefined} pid
 * @returns {'alive'|'dead'|'unknown'}
 */
function probePidLiveness(pid) {
  if (pid == null || !Number.isInteger(pid) || pid <= 0) return 'unknown';
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (e) {
    if (e && e.code === 'ESRCH') return 'dead';
    if (e && e.code === 'EPERM') return 'alive';
    return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// Single-file parse
// ---------------------------------------------------------------------------

/**
 * Parse one ~/.claude/sessions/<pid>.json file into a ClaudeSessionRow.
 * Returns null when the file cannot be parsed at all (missing, unreadable,
 * non-JSON, non-object). Callers MUST treat null as "skip this file" and
 * keep going — never crash.
 *
 * @param {string} filePath
 * @param {number} now            Injectable clock (smoke tests use a fixed value).
 * @returns {ClaudeSessionRow|null}
 */
function readSessionFile(filePath, now) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (_e) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_e) {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  return normalizeRow(parsed, { file: filePath, now });
}

/**
 * Apply field coercion + status derivation rules to a parsed JSON object.
 * Split out so the adapter is unit-testable without touching the disk.
 *
 * Status precedence (highest first):
 *   1. unknown — pid field missing / not an integer
 *   2. dead    — pid does not exist on this box (process.kill(pid,0) ESRCH)
 *   3. busy / idle — verbatim from the file
 *   4. unknown — pid alive but status is not "busy" or "idle"
 *
 * `updated_at` does NOT influence status — Claude only refreshes it on
 * activity, so a quiet pid-alive session is genuinely just busy/idle, not
 * stale. We surface `updated_at` + `age_ms` separately so the UI can say
 * "BUSY · last active 12m ago".
 *
 * `stale_reason` is now only set for the non-busy/idle paths
 * (`no_pid` for case 1, `pid_not_alive` for case 2). Field reserved on
 * the row type so a future explicit-stale rule has a place to land.
 *
 * @param {object} parsed
 * @param {{file:string, now:number}} ctx
 * @returns {ClaudeSessionRow}
 */
function normalizeRow(parsed, ctx) {
  const pid       = Number.isInteger(parsed.pid) ? parsed.pid : null;
  const sessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId : null;
  const cwd       = typeof parsed.cwd === 'string' ? parsed.cwd : null;
  const version   = typeof parsed.version === 'string' ? parsed.version : null;
  const startedAt = Number.isFinite(parsed.startedAt) ? parsed.startedAt : null;
  const updatedAt = Number.isFinite(parsed.updatedAt) ? parsed.updatedAt : null;
  const rawStatus = typeof parsed.status === 'string' ? parsed.status : null;

  const ageMs = updatedAt ? Math.max(0, ctx.now - updatedAt) : null;

  let status;
  let staleReason;

  if (pid == null) {
    status = 'unknown';
    staleReason = 'no_pid';
  } else {
    const liveness = probePidLiveness(pid);
    if (liveness === 'dead') {
      status = 'dead';
      staleReason = 'pid_not_alive';
    } else if (rawStatus === 'busy' || rawStatus === 'idle') {
      // Pid alive + Claude wrote a value we recognize → trust it
      // verbatim, regardless of how long ago `updatedAt` was. Claude
      // updates that field only on activity, so an old `updatedAt`
      // is information about cadence, not state.
      status = rawStatus;
    } else {
      // Pid alive but Claude wrote a new status string we don't model
      // yet (e.g. some future "compacting"). Surface as unknown so the
      // user sees the row but no inference is implied.
      status = 'unknown';
    }
  }

  /** @type {ClaudeSessionRow} */
  const row = {
    source: SOURCE,
    confidence: CONFIDENCE,
    pid,
    session_id: sessionId,
    cwd,
    version,
    status,
    started_at: startedAt,
    updated_at: updatedAt,
    age_ms: ageMs,
    file: ctx.file,
  };
  if (staleReason) row.stale_reason = staleReason;
  if (rawStatus && rawStatus !== status) row.raw_status = rawStatus;
  return row;
}

// ---------------------------------------------------------------------------
// Directory scan
// ---------------------------------------------------------------------------

/**
 * List every `*.json` (one level, no recursion) in `dir`. Returns [] for
 * any error so the caller never has to special-case the missing-dir path.
 */
function listSessionFiles(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_e) {
    return [];
  }
  /** @type {string[]} */
  const out = [];
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    if (!ent.name.endsWith('.json')) continue;
    out.push(path.join(dir, ent.name));
  }
  return out;
}

/**
 * Scan the Claude Code sessions directory and return one row per parseable
 * file. Bad JSON / unreadable files are skipped silently — no throw.
 *
 * @param {Object} [opts]
 * @param {string} [opts.sessionsDir]  Override the directory (smoke tests).
 * @param {string} [opts.home]         Override homedir (alternative to sessionsDir).
 * @param {number} [opts.now]          Inject clock for deterministic tests.
 * @returns {ClaudeSessionRow[]}
 */
function scanClaudeSessions(opts) {
  const o = opts || {};
  const dir = o.sessionsDir || defaultSessionsDir(o.home);
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const files = listSessionFiles(dir);
  /** @type {ClaudeSessionRow[]} */
  const rows = [];
  for (const f of files) {
    const r = readSessionFile(f, now);
    if (r) rows.push(r);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Project attribution
// ---------------------------------------------------------------------------

/**
 * Decide whether a Claude session row belongs to a registered project.
 * Pure function over normalized paths — no I/O, no DB.
 *
 * Rule: row.cwd is inside (or equal to) project.project_root, using the
 * same normalizer the MCP capability-tag matcher uses (forward slashes,
 * lowercased on Windows). This keeps the rule "if the user typed
 * `claude` from inside this project's tree, it counts" — same as a Cairn
 * agent registering with `cwd:<...>` capability.
 *
 * Notes:
 *   - We do NOT consult agent_id_hints. Claude session files don't carry
 *     a Cairn agent_id, so hint matching is structurally inapplicable.
 *   - project_root === '(unknown)' (legacy bootstrap entry) never matches.
 *
 * @param {ClaudeSessionRow} row
 * @param {{project_root:string}} project
 * @returns {boolean}
 */
function attributeClaudeSessionToProject(row, project) {
  if (!row || !project) return false;
  if (!row.cwd) return false;
  if (!project.project_root || project.project_root === '(unknown)') return false;
  return projectQueries.pathInsideOrEqual(row.cwd, project.project_root);
}

/**
 * Partition a flat list of Claude rows into (matched-by-this-project,
 * everything-else). Convenience for main.cjs which needs both halves
 * (project sessions + Unassigned bucket).
 *
 * @param {ClaudeSessionRow[]} rows
 * @param {{project_root:string}} project
 * @returns {{ matched: ClaudeSessionRow[], rest: ClaudeSessionRow[] }}
 */
function partitionByProject(rows, project) {
  const matched = [];
  const rest = [];
  for (const r of rows) {
    if (attributeClaudeSessionToProject(r, project)) matched.push(r);
    else rest.push(r);
  }
  return { matched, rest };
}

/**
 * Filter a flat list down to rows that match NO registered project's
 * project_root. Used for the global Unassigned drill-down.
 *
 * @param {ClaudeSessionRow[]} rows
 * @param {Array<{project_root:string}>} projects
 * @returns {ClaudeSessionRow[]}
 */
function unassignedClaudeSessions(rows, projects) {
  const projs = Array.isArray(projects) ? projects : [];
  return rows.filter(r => {
    for (const p of projs) {
      if (attributeClaudeSessionToProject(r, p)) return false;
    }
    return true;
  });
}

/**
 * Bucket a row list by status. Used by L1 project cards + tray to fold
 * Claude rows into the per-project / global summary without reaching into
 * row internals at the renderer level. Returns plain ints (zeros included)
 * so callers can safely do arithmetic.
 *
 * Keys mirror the status union: busy / idle / dead / unknown / stale.
 * `total` is the sum across all buckets.
 *
 * @param {ClaudeSessionRow[]} rows
 * @returns {{busy:number, idle:number, dead:number, unknown:number, stale:number, total:number, last_activity_at:number}}
 */
function summarizeClaudeRows(rows) {
  const out = { busy: 0, idle: 0, dead: 0, unknown: 0, stale: 0, total: 0, last_activity_at: 0 };
  if (!Array.isArray(rows)) return out;
  for (const r of rows) {
    const s = (r && r.status) || 'unknown';
    if (s in out) out[s]++;
    out.total++;
    if (Number.isFinite(r && r.updated_at) && r.updated_at > out.last_activity_at) {
      out.last_activity_at = r.updated_at;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  SOURCE,
  CONFIDENCE,
  // Path helpers (exposed for smoke).
  defaultSessionsDir,
  // Core (the public surface).
  scanClaudeSessions,
  // Pure helpers, for unit-style tests + main.cjs orchestration.
  normalizeRow,
  readSessionFile,
  probePidLiveness,
  attributeClaudeSessionToProject,
  partitionByProject,
  unassignedClaudeSessions,
  summarizeClaudeRows,
};
