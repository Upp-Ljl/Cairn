'use strict';

/**
 * Three-Stage Loop — Candidates Registry (Day 1).
 *
 * Cairn's Scout-Worker-Review mode produces *candidate improvements*
 * during a Scout run, the user picks one, a Worker run implements it,
 * and a Review run gives a verdict. Each stage is one user click;
 * Cairn coordinates state, external agents do the work.
 *
 * This module is the data layer only — no Scout prompt, no handler
 * wiring, no UI. Day 2-6 add those layers on top.
 *
 * Storage: one JSONL file per project at
 *   ~/.cairn/project-candidates/<projectId>.jsonl
 *
 * Why JSONL (mirrors project-iterations.cjs / worker-reports.cjs):
 *   - Append-only writes survive partial failures.
 *   - Per-project files keep growth isolated.
 *   - Latest-update-wins fold by id; status updates append a new line
 *     rather than rewriting in place.
 *   - Malformed lines silently skipped on read.
 *
 * Read/write boundary:
 *   - Writes: ONLY ~/.cairn/project-candidates/<projectId>.jsonl.
 *   - Does NOT write cairn.db / ~/.claude / ~/.codex.
 *   - Pure data — no agent invocation, no command execution.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const CAND_DIRNAME = 'project-candidates';
const MAX_TAIL_LINES = 500;
const MAX_RETURN = 100;

const STR_DESC_MAX = 240;
const STR_KIND_MAX = 32;
const STR_ID_MAX   = 80;

// Status set + transition graph. Single source of truth — exported so
// the Day 2-3 handlers can validate without re-encoding the graph.
//
// Terminal states: ACCEPTED, REJECTED, ROLLED_BACK. Once a candidate
// reaches one of these, no further transitions are legal — that's
// what "terminal" means here. The state machine is intentionally
// linear except for REJECTED which any non-terminal node can reach
// (the user is allowed to abandon a candidate at any point).
const STATUS_VALUES = Object.freeze([
  'PROPOSED',
  'PICKED',
  'WORKING',
  'REVIEWED',
  'ACCEPTED',
  'REJECTED',
  'ROLLED_BACK',
]);
const STATUS_SET = new Set(STATUS_VALUES);
const TERMINAL_STATES = new Set(['ACCEPTED', 'REJECTED', 'ROLLED_BACK']);

const VALID_TRANSITIONS = Object.freeze({
  PROPOSED:    new Set(['PICKED', 'REJECTED']),
  PICKED:      new Set(['WORKING', 'REJECTED']),
  WORKING:     new Set(['REVIEWED', 'REJECTED']),
  REVIEWED:    new Set(['ACCEPTED', 'REJECTED', 'ROLLED_BACK']),
  ACCEPTED:    new Set(),
  REJECTED:    new Set(),
  ROLLED_BACK: new Set(),
});

const KNOWN_KINDS = new Set([
  'missing_test', 'refactor', 'doc', 'bug_fix', 'other',
]);

function candDir(home) {
  return path.join((home || os.homedir()), '.cairn', CAND_DIRNAME);
}

/**
 * Map a project_id to a JSONL file path. Path traversal characters
 * (`..`, `/`, `\`) are replaced with `_` — same sanitization rule as
 * iterFile in project-iterations.cjs so the two registries can't be
 * tricked into writing to the other's directory.
 */
function candFile(projectId, home) {
  const safe = String(projectId || '').replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 64);
  return path.join(candDir(home), safe + '.jsonl');
}

function ensureCandDir(home) {
  try { fs.mkdirSync(candDir(home), { recursive: true }); } catch (_e) {}
}

function newCandidateId() { return 'c_' + crypto.randomBytes(6).toString('hex'); }

function clip(s, max) {
  if (typeof s !== 'string') return '';
  const t = s.trim();
  return t.length > max ? t.slice(0, max) : t;
}

function appendLine(file, obj, opts) {
  const o = opts || {};
  ensureCandDir(o.home);
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
  const tail = lines.slice(-MAX_TAIL_LINES);
  const out = [];
  for (const line of tail) {
    try { out.push(JSON.parse(line)); } catch (_e) { /* skip malformed */ }
  }
  return out;
}

/**
 * Fold append-only events into one snapshot per id. Newest
 * `updated_at` wins. Mirrors project-iterations.cjs::foldIterations.
 */
function foldCandidates(parsedLines) {
  const byId = new Map();
  for (const obj of parsedLines) {
    if (!obj || typeof obj !== 'object' || !obj.id) continue;
    // Forward-compat: older JSONL rows (pre-Day-6) lack boundary_violations.
    // Default to [] on read so consumers don't have to special-case.
    if (!Array.isArray(obj.boundary_violations)) obj.boundary_violations = [];
    const cur = byId.get(obj.id);
    if (!cur || (obj.updated_at || 0) >= (cur.updated_at || 0)) {
      byId.set(obj.id, obj);
    }
  }
  return byId;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Append a new PROPOSED candidate. Returns the persisted snapshot.
 *
 * @param {string} projectId
 * @param {{ description, candidate_kind?, source_iteration_id?, source_run_id? }} input
 * @param {{ home? }} [opts]
 */
function proposeCandidate(projectId, input, opts) {
  if (!projectId) return { ok: false, error: 'project_id_required' };
  const o = opts || {};
  const i = input || {};
  const description = clip(i.description, STR_DESC_MAX);
  if (!description) return { ok: false, error: 'description_required' };
  const kind = clip(i.candidate_kind, STR_KIND_MAX);
  const candidate_kind = (kind && KNOWN_KINDS.has(kind)) ? kind : 'other';
  const now = Date.now();
  const cand = {
    id: newCandidateId(),
    project_id: projectId,
    source_iteration_id: clip(i.source_iteration_id, STR_ID_MAX) || null,
    source_run_id:       clip(i.source_run_id,       STR_ID_MAX) || null,
    description,
    candidate_kind,
    status: 'PROPOSED',
    worker_iteration_id: null,
    review_iteration_id: null,
    boundary_violations: [],
    created_at: now,
    updated_at: now,
  };
  const r = appendLine(candFile(projectId, o.home), cand, { home: o.home });
  if (!r.ok) return r;
  return { ok: true, candidate: cand };
}

/**
 * Internal helper: read latest snapshot of candidateId, merge patch,
 * append a new JSONL line. Status transitions are validated against
 * VALID_TRANSITIONS and rejected (non-throwing) if illegal.
 */
function patchCandidate(projectId, candidateId, patch, opts) {
  if (!projectId || !candidateId) return { ok: false, error: 'project_id_or_candidate_required' };
  const o = opts || {};
  const file = candFile(projectId, o.home);
  const all = readAllLines(file);
  const folded = foldCandidates(all);
  const cur = folded.get(candidateId);
  if (!cur) return { ok: false, error: 'candidate_not_found' };
  const next = Object.assign({}, cur);
  if (patch.status !== undefined) {
    if (!STATUS_SET.has(patch.status)) return { ok: false, error: 'invalid_status' };
    if (patch.status !== cur.status) {
      const allowed = VALID_TRANSITIONS[cur.status] || new Set();
      if (!allowed.has(patch.status)) {
        return { ok: false, error: 'invalid_transition' };
      }
    }
    next.status = patch.status;
  }
  if (patch.description !== undefined)         next.description         = clip(patch.description, STR_DESC_MAX) || cur.description;
  if (patch.candidate_kind !== undefined) {
    const k = clip(patch.candidate_kind, STR_KIND_MAX);
    next.candidate_kind = (k && KNOWN_KINDS.has(k)) ? k : cur.candidate_kind;
  }
  if (patch.worker_iteration_id !== undefined) next.worker_iteration_id = clip(patch.worker_iteration_id, STR_ID_MAX) || null;
  if (patch.review_iteration_id !== undefined) next.review_iteration_id = clip(patch.review_iteration_id, STR_ID_MAX) || null;
  if (patch.boundary_violations !== undefined) {
    // Overwrite semantics — verify can re-run idempotently. Coerce to
    // string[] of bounded length so a hostile patch can't blow the
    // JSONL line up.
    if (!Array.isArray(patch.boundary_violations)) {
      next.boundary_violations = [];
    } else {
      next.boundary_violations = patch.boundary_violations
        .filter(s => typeof s === 'string')
        .map(s => clip(s, 240))
        .filter(Boolean)
        .slice(0, 50);
    }
  }
  next.updated_at = Date.now();
  const r = appendLine(file, next, { home: o.home });
  if (!r.ok) return r;
  return { ok: true, candidate: next };
}

/**
 * Set status with transition validation. `extra` lets the caller
 * also patch worker_iteration_id / review_iteration_id atomically
 * with the same transition (the bind* helpers below use this).
 */
function setCandidateStatus(projectId, candidateId, newStatus, extra, opts) {
  return patchCandidate(projectId, candidateId,
    Object.assign({}, extra || {}, { status: newStatus }),
    opts);
}

/**
 * PICKED → WORKING + record the worker iteration id in one append.
 * Caller is the handler that just launched a worker run and wants
 * the candidate to point at the iteration the launch was bound to.
 */
function bindWorkerIteration(projectId, candidateId, workerIterationId, opts) {
  if (!workerIterationId) return { ok: false, error: 'worker_iteration_id_required' };
  return setCandidateStatus(projectId, candidateId, 'WORKING',
    { worker_iteration_id: workerIterationId },
    opts);
}

/**
 * WORKING → REVIEWED + record the review iteration id. Symmetric
 * to bindWorkerIteration; the review run produced its own iteration
 * record.
 */
function bindReviewIteration(projectId, candidateId, reviewIterationId, opts) {
  if (!reviewIterationId) return { ok: false, error: 'review_iteration_id_required' };
  return setCandidateStatus(projectId, candidateId, 'REVIEWED',
    { review_iteration_id: reviewIterationId },
    opts);
}

function getCandidate(projectId, candidateId, opts) {
  if (!projectId || !candidateId) return null;
  const o = opts || {};
  const folded = foldCandidates(readAllLines(candFile(projectId, o.home)));
  return folded.get(candidateId) || null;
}

function listCandidates(projectId, limit, opts) {
  if (!projectId) return [];
  const o = opts || {};
  const folded = foldCandidates(readAllLines(candFile(projectId, o.home)));
  const arr = Array.from(folded.values());
  arr.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
  return arr.slice(0, Math.min(limit || MAX_RETURN, MAX_RETURN));
}

function listCandidatesByStatus(projectId, status, opts) {
  if (!projectId || !status) return [];
  const all = listCandidates(projectId, MAX_RETURN, opts);
  return all.filter(c => c.status === status);
}

module.exports = {
  STATUS_VALUES,
  TERMINAL_STATES,
  VALID_TRANSITIONS,
  KNOWN_KINDS,
  candDir,
  candFile,
  proposeCandidate,
  patchCandidate,
  setCandidateStatus,
  bindWorkerIteration,
  bindReviewIteration,
  getCandidate,
  listCandidates,
  listCandidatesByStatus,
};
