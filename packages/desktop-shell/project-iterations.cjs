'use strict';

/**
 * Managed Project Iterations v1 — append-only record of one
 * "Cairn-managed loop" round. Each iteration captures a goal-anchored
 * cycle: prompt → worker run → report → evidence → review.
 *
 * Storage: one JSONL file per project at
 *   ~/.cairn/project-iterations/<projectId>.jsonl
 *
 * Why JSONL (same reasoning as worker-reports.cjs):
 *   - Append-only writes survive partial failures.
 *   - One line per iteration; malformed lines skipped on read.
 *   - Per-project files keep growth isolated.
 *
 * Read/write boundary:
 *   - Writes: only the JSONL file under ~/.cairn/project-iterations/.
 *   - Does NOT write cairn.db / ~/.claude / ~/.codex.
 *   - Pure data — no agent invocation, no command execution.
 *
 * Iteration shape:
 *   {
 *     id, project_id, goal_id, started_at,
 *     status: planned | worker_prompted | reported | evidence_collected | reviewed,
 *     worker_prompt_id?,        // local opaque id; pack title for UI
 *     worker_prompt_title?,
 *     worker_report_id?,        // foreign id from worker-reports
 *     evidence_summary?,        // small object, not full evidence blob
 *     pre_pr_gate_summary?,     // status string + risk count
 *     review_status?,
 *     review_summary?,
 *     next_attention?: string[],
 *     created_at, updated_at
 *   }
 *
 * History is rebuilt by latest-update-wins per iteration id: when an
 * iteration is updated (e.g. attached a report), we APPEND a new line
 * with the same id and the current `updated_at`. Readers fold the
 * file by id, picking the newest timestamp. This keeps writes simple
 * and avoids in-place rewrites.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const ITER_DIRNAME = 'project-iterations';
const MAX_TAIL_LINES = 500;
const MAX_RETURN = 100;

const STATUS_VALUES = new Set([
  'planned',
  'worker_prompted',
  'reported',
  'evidence_collected',
  'reviewed',
  'archived',
]);

function iterDir(home) {
  return path.join((home || os.homedir()), '.cairn', ITER_DIRNAME);
}

function iterFile(projectId, home) {
  const safe = String(projectId || '').replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 64);
  return path.join(iterDir(home), safe + '.jsonl');
}

function ensureIterDir(home) {
  try { fs.mkdirSync(iterDir(home), { recursive: true }); } catch (_e) {}
}

function newIterationId() { return 'i_' + crypto.randomBytes(6).toString('hex'); }

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
  ensureIterDir(o.home);
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
  // is dropped from in-memory fold. Acceptable: latest state still
  // wins; ancient archived iterations are visible by reading the file
  // directly if needed.
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
function foldIterations(parsedLines) {
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start a new iteration. Returns the snapshot that was written.
 *
 * @param {string} projectId
 * @param {{ goal_id?:string, started_at?:number }} input
 * @param {{ home? }} [opts]
 */
function startIteration(projectId, input, opts) {
  if (!projectId) return { ok: false, error: 'project_id_required' };
  const o = opts || {};
  const i = input || {};
  const now = Date.now();
  const iter = {
    id: newIterationId(),
    project_id: projectId,
    goal_id: clip(i.goal_id, 80) || null,
    started_at: Number.isFinite(i.started_at) ? i.started_at : now,
    status: 'planned',
    worker_prompt_id: null,
    worker_prompt_title: null,
    worker_report_id: null,
    evidence_summary: null,
    pre_pr_gate_summary: null,
    review_status: null,
    review_summary: null,
    next_attention: [],
    created_at: now,
    updated_at: now,
  };
  const file = iterFile(projectId, o.home);
  const r = appendLine(file, iter, { home: o.home });
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, iteration: iter };
}

/**
 * Update an iteration by id. Reads the latest snapshot, merges the
 * patch, appends a new line. Status transitions are validated.
 */
function patchIteration(projectId, iterationId, patch, opts) {
  if (!projectId || !iterationId) return { ok: false, error: 'project_id_or_iteration_required' };
  const o = opts || {};
  const file = iterFile(projectId, o.home);
  const all = readAllLines(file);
  const folded = foldIterations(all);
  const cur = folded.get(iterationId);
  if (!cur) return { ok: false, error: 'iteration_not_found' };
  const next = Object.assign({}, cur);
  if (patch.status) {
    if (!STATUS_VALUES.has(patch.status)) return { ok: false, error: 'invalid_status' };
    next.status = patch.status;
  }
  if (patch.worker_prompt_id !== undefined)    next.worker_prompt_id    = clip(patch.worker_prompt_id, 80) || null;
  if (patch.worker_prompt_title !== undefined) next.worker_prompt_title = clip(patch.worker_prompt_title, 200) || null;
  if (patch.worker_report_id !== undefined)    next.worker_report_id    = clip(patch.worker_report_id, 80) || null;
  if (patch.evidence_summary !== undefined)    next.evidence_summary    = patch.evidence_summary || null;
  if (patch.pre_pr_gate_summary !== undefined) next.pre_pr_gate_summary = patch.pre_pr_gate_summary || null;
  if (patch.review_status !== undefined)       next.review_status       = clip(patch.review_status, 40) || null;
  if (patch.review_summary !== undefined)      next.review_summary      = clip(patch.review_summary, 1200) || null;
  if (patch.next_attention !== undefined)      next.next_attention      = clipList(patch.next_attention, 10, 300);
  next.updated_at = Date.now();
  const r = appendLine(file, next, { home: o.home });
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, iteration: next };
}

function attachWorkerPrompt(projectId, iterationId, prompt, opts) {
  return patchIteration(projectId, iterationId, {
    status: 'worker_prompted',
    worker_prompt_id: prompt && prompt.id || ('p_' + crypto.randomBytes(4).toString('hex')),
    worker_prompt_title: prompt && prompt.title || null,
  }, opts);
}

function attachWorkerReport(projectId, iterationId, reportId, opts) {
  return patchIteration(projectId, iterationId, {
    status: 'reported',
    worker_report_id: reportId,
  }, opts);
}

function attachEvidence(projectId, iterationId, summary, opts) {
  return patchIteration(projectId, iterationId, {
    status: 'evidence_collected',
    evidence_summary: summary,
  }, opts);
}

function completeIterationReview(projectId, iterationId, gateSummary, reviewStatus, reviewSummary, nextAttention, opts) {
  return patchIteration(projectId, iterationId, {
    status: 'reviewed',
    pre_pr_gate_summary: gateSummary || null,
    review_status: reviewStatus,
    review_summary: reviewSummary,
    next_attention: nextAttention || [],
  }, opts);
}

/**
 * List iterations for a project, newest-first by `updated_at`. Each
 * entry is the latest snapshot of that iteration id.
 */
function listIterations(projectId, limit, opts) {
  if (!projectId) return [];
  const o = opts || {};
  const file = iterFile(projectId, o.home);
  const all = readAllLines(file);
  const folded = foldIterations(all);
  const arr = Array.from(folded.values());
  arr.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
  return arr.slice(0, Math.min(limit || MAX_RETURN, MAX_RETURN));
}

function getIteration(projectId, iterationId, opts) {
  if (!projectId || !iterationId) return null;
  const o = opts || {};
  const file = iterFile(projectId, o.home);
  const all = readAllLines(file);
  const folded = foldIterations(all);
  return folded.get(iterationId) || null;
}

function latestIteration(projectId, opts) {
  const xs = listIterations(projectId, 1, opts);
  return xs[0] || null;
}

module.exports = {
  STATUS_VALUES,
  iterDir,
  iterFile,
  startIteration,
  patchIteration,
  attachWorkerPrompt,
  attachWorkerReport,
  attachEvidence,
  completeIterationReview,
  listIterations,
  getIteration,
  latestIteration,
};
