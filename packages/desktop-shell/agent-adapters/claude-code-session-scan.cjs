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
// Tunables (no UI; live in code so the adapter has one knob to grep for)
// ---------------------------------------------------------------------------

/**
 * STALE threshold. If `now - updatedAt > STALE_THRESHOLD_MS` we override
 * the file's `status` with `stale`, regardless of whether Claude wrote
 * "busy" or "idle". Picked at 90s (≈ Cairn MCP heartbeat ttl × 1.5);
 * tunable here, not exposed to UI per scope rules.
 */
const STALE_THRESHOLD_MS = 90 * 1000;

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
 *   1. dead   — pid does not exist on this box (process.kill(pid,0) ESRCH)
 *   2. stale  — updatedAt is older than STALE_THRESHOLD_MS
 *   3. busy / idle — verbatim from the file
 *   4. unknown— file did not provide a recognizable status string
 *
 * Even when we promote to dead/stale we preserve the original Claude-side
 * value as `raw_status`, so callers can render "stale (was busy)" if
 * useful. `stale_reason` is a short tag explaining why we promoted —
 * "pid_not_alive" / "updated_too_old" / "no_pid".
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
    } else if (ageMs != null && ageMs > STALE_THRESHOLD_MS) {
      status = 'stale';
      staleReason = 'updated_too_old';
    } else if (rawStatus === 'busy' || rawStatus === 'idle') {
      status = rawStatus;
    } else {
      // Unknown raw status (Claude introduced a new state we don't model
      // yet) but pid is alive — render as idle so the row still surfaces
      // without panicking the user.
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

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Constants (testing exposes these so smoke can build deterministic
  // updated_at timestamps relative to the threshold).
  STALE_THRESHOLD_MS,
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
};
