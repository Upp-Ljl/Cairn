'use strict';

/**
 * Continuous Runs v1 — append-only JSONL tracker for Mode B
 * Continuous Iteration sessions. One file per project at
 *   ~/.cairn/continuous-runs/<projectId>.jsonl
 *
 * Why JSONL (same reasoning as project-iterations.cjs):
 *   - Append-only writes survive partial failures.
 *   - One line per run event; malformed lines silently skipped on read.
 *   - Per-project files keep growth isolated.
 *
 * Read/write boundary:
 *   - Writes: only the JSONL file under ~/.cairn/continuous-runs/.
 *   - Does NOT write cairn.db / ~/.claude / ~/.codex.
 *   - Pure data — no agent invocation, no command execution.
 *
 * Run shape:
 *   {
 *     id,                        // 'cr_' + 12 hex
 *     project_id,
 *     started_at,                // unix ms
 *     ended_at,                  // unix ms; set when status leaves 'running'
 *     status,                    // 'running' | 'finished' | 'stopped' | 'failed'
 *     stopped_reason,            // slug or null
 *     current_stage,             // human-readable ≤120 chars
 *     candidates_processed,      // count whose Worker round completed
 *     scout_run_id,              // worker_run_id of the scout
 *     scout_iteration_id,        // iteration id of the scout
 *     max_candidates,            // input cap copied for context
 *     scout_provider,            // recorded for trail
 *     worker_provider,
 *     review_provider,
 *     candidate_runs: [          // append-as-we-go list ≤50
 *       { candidate_id, worker_iteration_id, worker_run_id,
 *         review_iteration_id, review_run_id,
 *         verdict, reason, boundary_violations, status }
 *     ],
 *     errors: [string]           // inner handler error codes ≤20 entries
 *     created_at, updated_at
 *   }
 *
 * History is rebuilt by latest-update-wins per run id: when a run is
 * updated we APPEND a new line with the same id and current `updated_at`.
 * Readers fold the file by id, picking the newest timestamp.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const CR_DIRNAME = 'continuous-runs';
const MAX_TAIL_LINES = 500;
const MAX_RETURN = 100;
const MAX_CANDIDATE_RUNS = 50;
const MAX_ERRORS = 20;

const STATUS_VALUES = Object.freeze({
  running: 'running',
  finished: 'finished',
  stopped: 'stopped',
  failed: 'failed',
});

const STOPPED_REASONS = Object.freeze({
  completed: 'completed',
  max_reached: 'max_reached',
  no_candidates: 'no_candidates',
  worker_launch_failed: 'worker_launch_failed',
  review_launch_failed: 'review_launch_failed',
  inner_handler_failed: 'inner_handler_failed',
  user_stopped: 'user_stopped',
  timeout: 'timeout',
});

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function crDir(home) {
  return path.join((home || os.homedir()), '.cairn', CR_DIRNAME);
}

function crFile(projectId, home) {
  const safe = String(projectId || '').replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 64);
  return path.join(crDir(home), safe + '.jsonl');
}

function ensureCrDir(home) {
  try { fs.mkdirSync(crDir(home), { recursive: true }); } catch (_e) {}
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function newRunId() { return 'cr_' + crypto.randomBytes(6).toString('hex'); }

function clip(s, max) {
  if (typeof s !== 'string') return '';
  const t = s.trim();
  return t.length > max ? t.slice(0, max) : t;
}

function clipList(xs, maxItems, maxLen) {
  if (!Array.isArray(xs)) return [];
  const out = [];
  for (const x of xs) {
    if (out.length >= maxItems) break;
    const t = clip(x, maxLen);
    if (t) out.push(t);
  }
  return out;
}

function appendLine(file, obj, opts) {
  const o = opts || {};
  ensureCrDir(o.home);
  try {
    fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8');
    return { ok: true };
  } catch (_e) {
    return { ok: false, error: 'append_failed' };
  }
}

function readAllLines(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (_e) { return []; }
  const lines = raw.split(/\r?\n/).filter(Boolean);
  // Bound work even on huge files — older history beyond MAX_TAIL_LINES
  // is dropped from in-memory fold. Acceptable: latest state still wins;
  // ancient runs are visible by reading the file directly if needed.
  const tail = lines.slice(-MAX_TAIL_LINES);
  const out = [];
  for (const line of tail) {
    try { out.push(JSON.parse(line)); } catch (_e) { /* skip malformed */ }
  }
  return out;
}

/**
 * Fold append-only events into a per-id snapshot map. The newest line
 * for an id wins.
 */
function foldRuns(parsedLines) {
  const byId = new Map();
  for (const obj of parsedLines) {
    if (!obj || typeof obj !== 'object' || !obj.id) continue;
    const cur = byId.get(obj.id);
    if (!cur || (obj.updated_at || 0) >= (cur.updated_at || 0)) {
      byId.set(obj.id, obj);
    }
  }
  return byId;
}

function isValidStatus(s) {
  return Object.prototype.hasOwnProperty.call(STATUS_VALUES, s);
}

function isValidProjectId(projectId) {
  return typeof projectId === 'string' && projectId.trim().length > 0;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start a new continuous run. Returns the snapshot that was written.
 *
 * @param {string} projectId
 * @param {{ max_candidates?:number, scout_provider?:string, worker_provider?:string, review_provider?:string, started_at?:number }} input
 * @param {{ home? }} [opts]
 */
function startContinuousRun(projectId, input, opts) {
  if (!isValidProjectId(projectId)) return { ok: false, error: 'project_id_required' };
  const o = opts || {};
  const i = input || {};
  const now = Date.now();
  const run = {
    id: newRunId(),
    project_id: projectId,
    started_at: Number.isFinite(i.started_at) ? i.started_at : now,
    ended_at: null,
    status: 'running',
    stopped_reason: null,
    current_stage: null,
    candidates_processed: 0,
    scout_run_id: null,
    scout_iteration_id: null,
    max_candidates: Number.isFinite(i.max_candidates) ? i.max_candidates : null,
    scout_provider: clip(i.scout_provider, 40) || null,
    worker_provider: clip(i.worker_provider, 40) || null,
    review_provider: clip(i.review_provider, 40) || null,
    candidate_runs: [],
    errors: [],
    created_at: now,
    updated_at: now,
  };
  const file = crFile(projectId, o.home);
  const r = appendLine(file, run, { home: o.home });
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, run };
}

/**
 * Update a run by id. Reads the latest snapshot, merges the patch,
 * appends a new line. Status transitions are validated.
 * When status transitions to non-'running', auto-sets ended_at if not supplied.
 *
 * @param {string} projectId
 * @param {string} runId
 * @param {object} patch
 * @param {{ home? }} [opts]
 */
function patchContinuousRun(projectId, runId, patch, opts) {
  if (!isValidProjectId(projectId) || !runId) {
    return { ok: false, error: 'project_id_or_run_id_required' };
  }
  const o = opts || {};
  const file = crFile(projectId, o.home);
  const all = readAllLines(file);
  const folded = foldRuns(all);
  const cur = folded.get(runId);
  if (!cur) return { ok: false, error: 'run_not_found' };

  const next = Object.assign({}, cur);
  // Preserve array references as copies
  next.candidate_runs = Array.isArray(cur.candidate_runs) ? cur.candidate_runs.slice() : [];
  next.errors = Array.isArray(cur.errors) ? cur.errors.slice() : [];

  if (patch.status !== undefined) {
    if (!isValidStatus(patch.status)) return { ok: false, error: 'invalid_status' };
    next.status = patch.status;
  }

  if (patch.stopped_reason !== undefined) {
    next.stopped_reason = patch.stopped_reason === null ? null : clip(patch.stopped_reason, 60) || null;
  }
  if (patch.current_stage !== undefined) {
    next.current_stage = patch.current_stage === null ? null : clip(patch.current_stage, 120) || null;
  }
  if (patch.candidates_processed !== undefined) {
    next.candidates_processed = Number.isFinite(patch.candidates_processed) ? patch.candidates_processed : cur.candidates_processed;
  }
  if (patch.scout_run_id !== undefined) {
    next.scout_run_id = patch.scout_run_id === null ? null : clip(patch.scout_run_id, 80) || null;
  }
  if (patch.scout_iteration_id !== undefined) {
    next.scout_iteration_id = patch.scout_iteration_id === null ? null : clip(patch.scout_iteration_id, 80) || null;
  }
  if (patch.max_candidates !== undefined) {
    next.max_candidates = Number.isFinite(patch.max_candidates) ? patch.max_candidates : null;
  }
  if (patch.scout_provider !== undefined) {
    next.scout_provider = patch.scout_provider === null ? null : clip(patch.scout_provider, 40) || null;
  }
  if (patch.worker_provider !== undefined) {
    next.worker_provider = patch.worker_provider === null ? null : clip(patch.worker_provider, 40) || null;
  }
  if (patch.review_provider !== undefined) {
    next.review_provider = patch.review_provider === null ? null : clip(patch.review_provider, 40) || null;
  }
  if (patch.ended_at !== undefined) {
    next.ended_at = Number.isFinite(patch.ended_at) ? patch.ended_at : null;
  }

  // Auto-set ended_at when leaving 'running' and patch didn't supply one
  if (next.status !== 'running' && next.ended_at === null) {
    next.ended_at = Date.now();
  }

  next.updated_at = Date.now();
  const r = appendLine(file, next, { home: o.home });
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, run: next };
}

/**
 * Push one entry to candidate_runs for a run.
 * Clips strings and caps boundary_violations to 50 × 240 chars.
 * Bumps candidates_processed if entry.status === 'REVIEWED'.
 *
 * @param {string} projectId
 * @param {string} runId
 * @param {object} candidateRun
 * @param {{ home? }} [opts]
 */
function appendCandidateRun(projectId, runId, candidateRun, opts) {
  if (!isValidProjectId(projectId) || !runId) {
    return { ok: false, error: 'project_id_or_run_id_required' };
  }
  const o = opts || {};
  const file = crFile(projectId, o.home);
  const all = readAllLines(file);
  const folded = foldRuns(all);
  const cur = folded.get(runId);
  if (!cur) return { ok: false, error: 'run_not_found' };

  const next = Object.assign({}, cur);
  next.candidate_runs = Array.isArray(cur.candidate_runs) ? cur.candidate_runs.slice() : [];
  next.errors = Array.isArray(cur.errors) ? cur.errors.slice() : [];

  if (next.candidate_runs.length >= MAX_CANDIDATE_RUNS) {
    return { ok: false, error: 'candidate_runs_full' };
  }

  const cr = candidateRun || {};
  const entry = {
    candidate_id: clip(cr.candidate_id, 80) || null,
    worker_iteration_id: clip(cr.worker_iteration_id, 80) || null,
    worker_run_id: clip(cr.worker_run_id, 80) || null,
    review_iteration_id: clip(cr.review_iteration_id, 80) || null,
    review_run_id: clip(cr.review_run_id, 80) || null,
    verdict: clip(cr.verdict, 20) || null,
    reason: clip(cr.reason, 200) || null,
    boundary_violations: clipList(cr.boundary_violations, 50, 240),
    status: clip(cr.status, 40) || null,
  };

  next.candidate_runs.push(entry);

  // Bump candidates_processed when a full Worker+Review round is complete
  if (entry.status === 'REVIEWED') {
    next.candidates_processed = (Number.isFinite(cur.candidates_processed) ? cur.candidates_processed : 0) + 1;
  }

  next.updated_at = Date.now();
  const r = appendLine(file, next, { home: o.home });
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, run: next };
}

/**
 * Push an error string to errors[] for a run. Capped at MAX_ERRORS,
 * deduped (exact string equality).
 *
 * @param {string} projectId
 * @param {string} runId
 * @param {string} errorString
 * @param {{ home? }} [opts]
 */
function appendError(projectId, runId, errorString, opts) {
  if (!isValidProjectId(projectId) || !runId) {
    return { ok: false, error: 'project_id_or_run_id_required' };
  }
  const o = opts || {};
  const file = crFile(projectId, o.home);
  const all = readAllLines(file);
  const folded = foldRuns(all);
  const cur = folded.get(runId);
  if (!cur) return { ok: false, error: 'run_not_found' };

  const next = Object.assign({}, cur);
  next.candidate_runs = Array.isArray(cur.candidate_runs) ? cur.candidate_runs.slice() : [];
  next.errors = Array.isArray(cur.errors) ? cur.errors.slice() : [];

  const clipped = clip(errorString, 200);
  if (!clipped) return { ok: true, run: cur }; // nothing to add
  if (next.errors.includes(clipped)) return { ok: true, run: cur }; // dedup
  if (next.errors.length >= MAX_ERRORS) return { ok: true, run: cur }; // cap

  next.errors.push(clipped);
  next.updated_at = Date.now();
  const r = appendLine(file, next, { home: o.home });
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, run: next };
}

/**
 * Get a single run by id.
 *
 * @param {string} projectId
 * @param {string} runId
 * @param {{ home? }} [opts]
 * @returns {object|null}
 */
function getContinuousRun(projectId, runId, opts) {
  if (!isValidProjectId(projectId) || !runId) return null;
  const o = opts || {};
  const file = crFile(projectId, o.home);
  const all = readAllLines(file);
  const folded = foldRuns(all);
  return folded.get(runId) || null;
}

/**
 * List runs for a project, newest-first by `updated_at`. Each entry is
 * the latest snapshot of that run id.
 *
 * @param {string} projectId
 * @param {number} [limit]
 * @param {{ home? }} [opts]
 */
function listContinuousRuns(projectId, limit, opts) {
  if (!isValidProjectId(projectId)) return [];
  const o = opts || {};
  const file = crFile(projectId, o.home);
  const all = readAllLines(file);
  const folded = foldRuns(all);
  const arr = Array.from(folded.values());
  arr.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
  return arr.slice(0, Math.min(limit || MAX_RETURN, MAX_RETURN));
}

/**
 * Return the most-recently-updated run for a project, or null.
 *
 * @param {string} projectId
 * @param {{ home? }} [opts]
 */
function latestContinuousRun(projectId, opts) {
  const xs = listContinuousRuns(projectId, 1, opts);
  return xs[0] || null;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  STATUS_VALUES,
  STOPPED_REASONS,
  crDir,
  crFile,
  startContinuousRun,
  patchContinuousRun,
  appendCandidateRun,
  appendError,
  getContinuousRun,
  listContinuousRuns,
  latestContinuousRun,
};
