'use strict';

/**
 * Codex CLI / Codex Desktop session-log presence adapter
 * (Real Agent Presence step 3 — sibling to claude-code-session-scan.cjs).
 *
 * Codex writes one JSONL rollout file per session at:
 *
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
 *
 * The first line is a `session_meta` event whose payload carries the
 * stable identifying fields we surface (id, cwd, originator, cli_version,
 * started timestamp). Every subsequent line is a per-event entry — we do
 * NOT read those: prompts, tool args, stdout/stderr, model output. The
 * file's mtime is the only activity signal we use.
 *
 * Why a different status vocabulary than Claude (recent / inactive /
 * unknown vs busy / idle / stale / dead / unknown):
 *
 *   - The session_meta line does not carry a pid, so we cannot probe
 *     liveness on the host. A rollout file on disk doesn't tell us
 *     whether Codex Desktop is still running.
 *   - Codex doesn't publish a current "busy" / "idle" status field. The
 *     only signal we have is "mtime moved recently" (file was appended
 *     to) versus "mtime is older than the recent window" (no recent
 *     append).
 *
 * So we say what we can defend:
 *
 *   recent    — file mtime within the recent window (default 60 s).
 *               Some event was appended to the rollout file very
 *               recently; a session is plausibly active right now.
 *   inactive  — meta parsed, file mtime older than the recent window.
 *               Session log exists; we have no evidence it's currently
 *               doing anything. Could be a paused Codex Desktop window,
 *               could be a session whose process exited an hour ago.
 *   unknown   — cannot read or parse the session_meta line. Row is
 *               surfaced so the user notices, but no inference is made.
 *
 * Strict read-only contract:
 *
 *   - reads: the rollout file's first line (session_meta) + fs.statSync
 *     for mtime. Nothing past line 1 is read.
 *   - never reads: prompt content, tool args, model output, transcript
 *     bodies, command stdout/stderr.
 *   - writes: nothing, anywhere. Not ~/.codex, not ~/.cairn, not Cairn
 *     SQLite, not the registry.
 *
 * Scaling: ~/.codex/sessions/<year>/<month>/<day>/ can accumulate files
 * across years. We bound the scan to a sliding window (default 7 days)
 * by enumerating only date directories whose YYYY/MM/DD name falls in
 * the window. Each file is a single readSync of one short line.
 *
 * Schema-stability: this adapter writes nothing. The shape of its output
 * is the only public contract — see CodexSessionRow below.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const projectQueries = require('../project-queries.cjs');

const SOURCE = 'codex/session-log';
const CONFIDENCE = 'medium'; // weaker than Claude — no pid liveness probe.

const DEFAULT_RECENT_MS = 60_000;     // mtime within last 60 s → recent
const DEFAULT_DAYS_BACK = 7;          // scan window (today + N-1 prior days)

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} CodexSessionRow
 * @property {string} source         Always "codex/session-log"
 * @property {string} confidence     Always "medium" for this adapter
 * @property {null} pid              Codex meta carries no pid — kept null for shape parity.
 * @property {string|null} session_id  Codex's UUID (NOT a Cairn agent_id)
 * @property {string|null} cwd
 * @property {string|null} version   cli_version from session_meta
 * @property {string|null} originator e.g. "Codex Desktop", "Codex CLI"
 * @property {string|null} source_app e.g. "vscode" (when present in meta)
 * @property {'recent'|'inactive'|'unknown'} status
 * @property {number|null} started_at  unix ms (from session_meta payload.timestamp)
 * @property {number|null} updated_at  unix ms (from rollout file mtime)
 * @property {number|null} age_ms      now - updated_at; null if mtime missing
 * @property {string} [stale_reason]   set when status falls back to unknown
 * @property {string} [file]           Source file path (for diagnostics; not for UI)
 */

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function defaultSessionsDir(home) {
  const h = home || os.homedir();
  return path.join(h, '.codex', 'sessions');
}

/**
 * Two-digit zero-padded integer. UTC date math is enough for directory
 * naming; Codex itself names directories by start time in local-ish
 * format but the YYYY/MM/DD layout matches both UTC and any tz close to
 * UTC well enough that a 7-day sliding window catches edges either way.
 */
function pad2(n) { return n < 10 ? '0' + n : '' + n; }

/**
 * Enumerate YYYY/MM/DD subdir paths under `sessionsDir` for the last
 * `daysBack` days, ending at `now` (inclusive). Skips paths that don't
 * exist. Each entry is just a directory path; readers still have to
 * tolerate a missing or empty dir.
 */
function recentDateDirs(sessionsDir, now, daysBack) {
  const out = [];
  const ms = 24 * 60 * 60 * 1000;
  for (let i = 0; i < daysBack; i++) {
    const t = new Date(now - i * ms);
    const y = String(t.getUTCFullYear());
    const m = pad2(t.getUTCMonth() + 1);
    const d = pad2(t.getUTCDate());
    out.push(path.join(sessionsDir, y, m, d));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Single-file parse
// ---------------------------------------------------------------------------

/**
 * Read at most the first line of a rollout file and parse it as JSON.
 * Returns the parsed object on success, or null if the file is missing,
 * unreadable, empty, or the first line isn't a JSON object.
 *
 * We deliberately do not stream the whole file. The per-event payloads
 * past line 1 contain user prompts, model output, tool args, stdout —
 * the privacy story for this adapter depends on never touching them.
 *
 * Implementation note: rollout files start with the session_meta line
 * within the first ~4 KB on every sample we've seen. We read up to 64 KB
 * to be robust against an unusually large meta line, then split on the
 * first newline. Anything past the first newline is discarded by the
 * parser.
 */
function readFirstLineJson(filePath) {
  let fd = -1;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    if (n <= 0) return null;
    const slice = buf.slice(0, n).toString('utf8');
    const nlIdx = slice.indexOf('\n');
    const firstLine = nlIdx >= 0 ? slice.slice(0, nlIdx) : slice;
    const trimmed = firstLine.trim();
    if (!trimmed) return null;
    let parsed;
    try { parsed = JSON.parse(trimmed); } catch (_e) { return null; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch (_e) {
    return null;
  } finally {
    if (fd >= 0) {
      try { fs.closeSync(fd); } catch (_e) {}
    }
  }
}

/**
 * Parse one rollout-*.jsonl file into a CodexSessionRow. Returns null
 * when even the file's metadata is unreadable; callers MUST treat null
 * as "skip this file" and never crash.
 */
function readSessionFile(filePath, now, recentMs) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (_e) {
    return null;
  }
  const meta = readFirstLineJson(filePath);
  return normalizeRow(meta, {
    file: filePath,
    mtimeMs: stat.mtimeMs,
    now,
    recentMs,
  });
}

/**
 * Convert a (possibly-null) parsed session_meta line + file stats into
 * a CodexSessionRow. Pure function — no I/O, no clock — so unit tests
 * can fully cover the status logic.
 *
 * Recognized meta shape (subset; missing fields fall through to null):
 *   {
 *     "type": "session_meta",
 *     "payload": {
 *       "id":          "<uuid>",
 *       "timestamp":   "ISO8601",
 *       "cwd":         "<abs path>",
 *       "originator":  "Codex Desktop",
 *       "cli_version": "0.129.0-alpha.15",
 *       "source":      "vscode"
 *     }
 *   }
 *
 * Status precedence (highest first):
 *   1. unknown — meta line missing or not a session_meta envelope
 *   2. recent  — mtime within `recentMs` of now
 *   3. inactive — otherwise
 */
function normalizeRow(meta, ctx) {
  const file = ctx && ctx.file;
  const now = Number.isFinite(ctx && ctx.now) ? ctx.now : Date.now();
  const recentMs = Number.isFinite(ctx && ctx.recentMs) ? ctx.recentMs : DEFAULT_RECENT_MS;
  const mtimeMs = Number.isFinite(ctx && ctx.mtimeMs) ? ctx.mtimeMs : null;

  const isMetaEnvelope = !!(meta
    && typeof meta === 'object'
    && meta.type === 'session_meta'
    && meta.payload && typeof meta.payload === 'object');
  const payload = isMetaEnvelope ? meta.payload : {};

  const sessionId   = typeof payload.id === 'string' ? payload.id : null;
  const cwd         = typeof payload.cwd === 'string' ? payload.cwd : null;
  const version     = typeof payload.cli_version === 'string' ? payload.cli_version : null;
  const originator  = typeof payload.originator === 'string' ? payload.originator : null;
  const sourceApp   = typeof payload.source === 'string' ? payload.source : null;
  const startedAt   = parseIsoMs(payload.timestamp);

  const updatedAt = mtimeMs;
  const ageMs = (Number.isFinite(updatedAt) && Number.isFinite(now))
    ? Math.max(0, now - updatedAt) : null;

  let status;
  let staleReason;
  if (!isMetaEnvelope) {
    status = 'unknown';
    staleReason = 'meta_missing';
  } else if (ageMs != null && ageMs <= recentMs) {
    status = 'recent';
  } else {
    status = 'inactive';
  }

  /** @type {CodexSessionRow} */
  const row = {
    source: SOURCE,
    confidence: CONFIDENCE,
    pid: null,
    session_id: sessionId,
    cwd,
    version,
    originator,
    source_app: sourceApp,
    status,
    started_at: startedAt,
    updated_at: updatedAt,
    age_ms: ageMs,
    file: file || null,
  };
  if (staleReason) row.stale_reason = staleReason;
  return row;
}

/**
 * Parse an ISO 8601 timestamp string into unix ms, or null if the input
 * isn't a string we can interpret. Codex writes RFC 3339 with `Z` or
 * fractional seconds; Date.parse handles both.
 */
function parseIsoMs(s) {
  if (typeof s !== 'string' || !s) return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

// ---------------------------------------------------------------------------
// Directory scan
// ---------------------------------------------------------------------------

/**
 * List every `rollout-*.jsonl` (one level, no recursion) in `dir`.
 * Returns [] for any error so callers never have to special-case missing
 * directories — yesterday's directory may not exist if the user didn't
 * use Codex yesterday.
 */
function listRolloutFilesInDir(dir) {
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
    if (!ent.name.endsWith('.jsonl')) continue;
    if (!ent.name.startsWith('rollout-')) continue;
    out.push(path.join(dir, ent.name));
  }
  return out;
}

/**
 * Scan the Codex sessions directory and return one row per parseable
 * rollout file in the recent window. Bad / missing files are skipped
 * silently — no throw.
 *
 * @param {Object} [opts]
 * @param {string} [opts.sessionsDir]  Override sessions dir (smoke tests).
 * @param {string} [opts.home]         Override homedir (alternative to sessionsDir).
 * @param {number} [opts.now]          Inject clock for deterministic tests.
 * @param {number} [opts.recentMs]     Window for `recent` status (default 60_000).
 * @param {number} [opts.daysBack]     How many date subdirs to walk (default 7).
 * @returns {CodexSessionRow[]}
 */
function scanCodexSessions(opts) {
  const o = opts || {};
  const sessionsDir = o.sessionsDir || defaultSessionsDir(o.home);
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const recentMs = Number.isFinite(o.recentMs) ? o.recentMs : DEFAULT_RECENT_MS;
  const daysBack = Number.isFinite(o.daysBack) && o.daysBack > 0 ? o.daysBack : DEFAULT_DAYS_BACK;

  /** @type {CodexSessionRow[]} */
  const rows = [];
  const dirs = recentDateDirs(sessionsDir, now, daysBack);
  for (const d of dirs) {
    const files = listRolloutFilesInDir(d);
    for (const f of files) {
      const r = readSessionFile(f, now, recentMs);
      if (r) rows.push(r);
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Project attribution (parallel to Claude adapter)
// ---------------------------------------------------------------------------

function attributeCodexSessionToProject(row, project) {
  if (!row || !project) return false;
  if (!row.cwd) return false;
  if (!project.project_root || project.project_root === '(unknown)') return false;
  return projectQueries.pathInsideOrEqual(row.cwd, project.project_root);
}

function partitionByProject(rows, project) {
  const matched = [];
  const rest = [];
  for (const r of rows) {
    if (attributeCodexSessionToProject(r, project)) matched.push(r);
    else rest.push(r);
  }
  return { matched, rest };
}

function unassignedCodexSessions(rows, projects) {
  const projs = Array.isArray(projects) ? projects : [];
  return rows.filter(r => {
    for (const p of projs) {
      if (attributeCodexSessionToProject(r, p)) return false;
    }
    return true;
  });
}

/**
 * Bucket Codex rows by status. Returns plain ints (zeros included) so
 * callers can freely add to existing summary fields without null checks.
 *
 * `total` is the sum across all buckets. `last_activity_at` is the
 * freshest `updated_at` (file mtime) seen in `rows`, used so L1 cards
 * can advertise a "last activity 8m ago" line that incorporates Codex
 * activity alongside MCP heartbeat times.
 *
 * @param {CodexSessionRow[]} rows
 * @returns {{recent:number, inactive:number, unknown:number, total:number, last_activity_at:number}}
 */
function summarizeCodexRows(rows) {
  const out = { recent: 0, inactive: 0, unknown: 0, total: 0, last_activity_at: 0 };
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
  DEFAULT_RECENT_MS,
  DEFAULT_DAYS_BACK,
  defaultSessionsDir,
  recentDateDirs,
  readFirstLineJson,
  readSessionFile,
  normalizeRow,
  scanCodexSessions,
  attributeCodexSessionToProject,
  partitionByProject,
  unassignedCodexSessions,
  summarizeCodexRows,
};
