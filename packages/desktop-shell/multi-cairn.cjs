'use strict';

/**
 * Multi-Cairn v0 — read-only sharing of published candidates via a
 * filesystem-shared JSONL outbox.
 *
 * Opt-in via two env vars. When CAIRN_SHARED_DIR is unset OR does
 * not exist on disk, every API in this module returns
 * `multi_cairn_not_enabled` and the single-machine flow is
 * unaffected.
 *
 *   CAIRN_SHARED_DIR  — path to a directory accessible by every
 *                       Cairn node that participates. Typically a
 *                       Dropbox / iCloud / SMB share.
 *   CAIRN_NODE_ID     — optional stable identifier for this node;
 *                       falls back to ~/.cairn/node-id.txt
 *                       (random 12-hex on first call, persisted).
 *
 * Shared outbox: {CAIRN_SHARED_DIR}/published-candidates.jsonl
 *
 * Append-only. Each line is one event:
 *   { event_version: 1,
 *     node_id, published_at,
 *     project_id, candidate_id,
 *     snapshot: { description, candidate_kind, status, kind_chip },
 *     source_iteration_id,
 *     tombstone?: true                  (for unpublish)
 *   }
 *
 * Fold semantics (mirrors project-candidates.cjs): newest line for
 * a given (node_id, candidate_id) wins; if the newest line is a
 * tombstone, the candidate is excluded from the list output.
 *
 * Hard product boundary:
 *   - No worker diff is ever published.
 *   - No prompt is ever published.
 *   - No secret env-var values are ever published.
 *   - snapshot.description is the same field already visible to any
 *     teammate looking at this user's candidate row in their own
 *     Inspector; nothing new becomes visible across nodes that wasn't
 *     already locally visible to this user.
 *
 * Failure mode: all reads are fail-safe (missing dir / corrupt line
 * → return [], never throw). Writes use atomic append + retry on
 * EBUSY.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const candidates = require('./project-candidates.cjs');

const OUTBOX_FILENAME = 'published-candidates.jsonl';
const EVENT_VERSION = 1;
const MAX_DESC_LEN = 240;
const MAX_PROJECT_LABEL_LEN = 80;
const MAX_RETURN = 200;
const MAX_TAIL_LINES = 2000;

// ---------------------------------------------------------------------------
// Node identity
// ---------------------------------------------------------------------------

function _nodeIdFile(home) {
  return path.join((home || os.homedir()), '.cairn', 'node-id.txt');
}

/**
 * Resolve this machine's node id. Priority:
 *   1. CAIRN_NODE_ID env var (caller-controlled; user can pin)
 *   2. ~/.cairn/node-id.txt (persisted random 12-hex)
 *   3. generate new + write the file
 *
 * Never throws. opts.home overrides the homedir for testing.
 */
function getNodeId(opts) {
  const o = opts || {};
  const env = (o.env || process.env).CAIRN_NODE_ID;
  if (typeof env === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(env.trim())) {
    return env.trim();
  }
  const file = _nodeIdFile(o.home);
  try {
    if (fs.existsSync(file)) {
      const txt = fs.readFileSync(file, 'utf8').trim();
      if (/^[a-zA-Z0-9_-]{1,64}$/.test(txt)) return txt;
    }
  } catch (_e) { /* fall through */ }
  const fresh = crypto.randomBytes(6).toString('hex');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, fresh + '\n', 'utf8');
  } catch (_e) { /* still return fresh — in-memory only */ }
  return fresh;
}

/**
 * Resolve the shared dir from env (or opts.sharedDir for tests).
 * Returns null when not configured or path missing on disk.
 */
function _resolveSharedDir(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const dir = (typeof o.sharedDir === 'string' && o.sharedDir) || env.CAIRN_SHARED_DIR;
  if (!dir || typeof dir !== 'string' || !dir.trim()) return null;
  try {
    if (!fs.existsSync(dir)) return null;
    if (!fs.statSync(dir).isDirectory()) return null;
  } catch (_e) { return null; }
  return dir;
}

function isMultiCairnEnabled(opts) {
  return !!_resolveSharedDir(opts);
}

function _outboxFile(opts) {
  const dir = _resolveSharedDir(opts);
  if (!dir) return null;
  return path.join(dir, OUTBOX_FILENAME);
}

// ---------------------------------------------------------------------------
// Snapshot construction — strictly the locally-visible candidate
// fields. Never touches run.json / tail.log / cairn.db / env.
// ---------------------------------------------------------------------------

function _clip(s, max) {
  if (typeof s !== 'string') return '';
  const t = s.trim();
  return t.length > max ? t.slice(0, max) : t;
}

function _snapshotFromCandidate(c) {
  return {
    description:    _clip(c.description, MAX_DESC_LEN),
    candidate_kind: _clip(c.candidate_kind, 32) || 'other',
    status:         _clip(c.status, 24),
    kind_chip:      _clip(c.candidate_kind, 32) || 'other',
  };
}

// ---------------------------------------------------------------------------
// JSONL read + fold
// ---------------------------------------------------------------------------

function _readAllLines(file) {
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
 * Fold the outbox into one snapshot per (node_id, candidate_id).
 * Newest published_at wins. Tombstones replace the snapshot with
 * { tombstone: true } so the caller can drop them.
 */
function _foldOutbox(events) {
  const byKey = new Map();
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    if (!ev.node_id || !ev.candidate_id) continue;
    const key = ev.node_id + '::' + ev.candidate_id;
    const cur = byKey.get(key);
    if (!cur || (ev.published_at || 0) >= (cur.published_at || 0)) {
      byKey.set(key, ev);
    }
  }
  return byKey;
}

function _appendEvent(file, event) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch (_e) {}
  // atomic append: writeSync with O_APPEND is what fs.appendFileSync
  // uses internally; this is the simplest correct approach for a
  // shared JSONL outbox (no rename needed because we never overwrite
  // existing bytes).
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.appendFileSync(file, JSON.stringify(event) + '\n', 'utf8');
      return { ok: true };
    } catch (e) {
      lastErr = e;
      if (e && (e.code === 'EBUSY' || e.code === 'EAGAIN')) {
        // brief backoff — shared dirs over a sync engine occasionally
        // see transient EBUSY (Dropbox indexer, OneDrive scan).
        const wait = Date.now() + 50 * (attempt + 1);
        while (Date.now() < wait) { /* tight wait — fine for ≤150ms */ }
        continue;
      }
      break;
    }
  }
  return { ok: false, error: 'append_failed', detail: lastErr && lastErr.code || null };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Publish (or re-publish, e.g. after status changed) one candidate
 * to the shared outbox.
 *
 * Returns { ok, published_at, node_id, snapshot } on success or
 * { ok: false, error } with one of:
 *   multi_cairn_not_enabled / project_id_required / candidate_id_required
 *   / candidate_not_found / project_id_mismatch / append_failed
 */
function publishCandidate(projectId, candidateId, opts) {
  const o = opts || {};
  if (!isMultiCairnEnabled(o)) return { ok: false, error: 'multi_cairn_not_enabled' };
  if (!projectId) return { ok: false, error: 'project_id_required' };
  if (!candidateId) return { ok: false, error: 'candidate_id_required' };

  const cand = candidates.getCandidate(projectId, candidateId, { home: o.home });
  if (!cand) return { ok: false, error: 'candidate_not_found' };
  if (cand.project_id && cand.project_id !== projectId) {
    return { ok: false, error: 'project_id_mismatch' };
  }

  const nodeId = getNodeId(o);
  const publishedAt = Date.now();
  const snapshot = _snapshotFromCandidate(cand);
  const event = {
    event_version: EVENT_VERSION,
    node_id: nodeId,
    published_at: publishedAt,
    project_id: projectId,
    candidate_id: candidateId,
    snapshot,
    source_iteration_id: cand.source_iteration_id || null,
  };
  const file = _outboxFile(o);
  const r = _appendEvent(file, event);
  if (!r.ok) return r;
  return { ok: true, published_at: publishedAt, node_id: nodeId, snapshot };
}

/**
 * Append a tombstone event so future folds drop this candidate.
 * Same key (node_id, candidate_id) so the tombstone wins if newer.
 *
 * Only the node that originally published can effectively "unpublish"
 * because tombstone events carry the publishing node's id (other nodes
 * could write a forged tombstone with the same id, but Multi-Cairn v0
 * deliberately does NOT defend against malicious peers — see hard
 * boundary in the file header).
 */
function unpublishCandidate(projectId, candidateId, opts) {
  const o = opts || {};
  if (!isMultiCairnEnabled(o)) return { ok: false, error: 'multi_cairn_not_enabled' };
  if (!projectId) return { ok: false, error: 'project_id_required' };
  if (!candidateId) return { ok: false, error: 'candidate_id_required' };

  const nodeId = getNodeId(o);
  const event = {
    event_version: EVENT_VERSION,
    node_id: nodeId,
    published_at: Date.now(),
    project_id: projectId,
    candidate_id: candidateId,
    tombstone: true,
  };
  const file = _outboxFile(o);
  const r = _appendEvent(file, event);
  if (!r.ok) return r;
  return { ok: true, node_id: nodeId };
}

/**
 * List candidates published by OTHER nodes for this project. Folded
 * by (node_id, candidate_id); tombstoned entries dropped; sorted by
 * published_at desc.
 *
 * Returns [] when multi-Cairn isn't enabled (NOT an error — the
 * Inspector's poll loop calls this every second; failing softly is
 * the right thing to do).
 */
function listPublishedCandidates(projectId, opts) {
  const o = opts || {};
  if (!isMultiCairnEnabled(o)) return [];
  if (!projectId) return [];
  const file = _outboxFile(o);
  if (!file) return [];
  const events = _readAllLines(file);
  const folded = _foldOutbox(events);
  const myNodeId = getNodeId(o);
  const out = [];
  for (const ev of folded.values()) {
    if (ev.tombstone) continue;
    if (ev.project_id !== projectId) continue;
    if (ev.node_id === myNodeId) continue;  // self-filter
    out.push({
      node_id:             ev.node_id,
      published_at:        ev.published_at,
      candidate_id:        ev.candidate_id,
      snapshot:            ev.snapshot || {},
      source_iteration_id: ev.source_iteration_id || null,
    });
  }
  out.sort((a, b) => (b.published_at || 0) - (a.published_at || 0));
  return out.slice(0, MAX_RETURN);
}

/**
 * Status summary for the Inspector header. Always safe to call —
 * returns the disabled shape when not configured.
 */
function getMultiCairnStatus(opts) {
  const o = opts || {};
  const enabled = isMultiCairnEnabled(o);
  if (!enabled) {
    return { enabled: false, node_id: null, shared_dir: null };
  }
  return {
    enabled: true,
    node_id: getNodeId(o),
    shared_dir: _resolveSharedDir(o),
  };
}

/**
 * Inspect "what has THIS node published?" — derived from the same
 * outbox, filtered to events where node_id === my node. Used by the
 * Inspector to show the "Unpublish" button on candidates the user
 * has already shared.
 */
function listMyPublishedCandidateIds(projectId, opts) {
  const o = opts || {};
  if (!isMultiCairnEnabled(o)) return new Set();
  if (!projectId) return new Set();
  const file = _outboxFile(o);
  if (!file) return new Set();
  const events = _readAllLines(file);
  const folded = _foldOutbox(events);
  const myNodeId = getNodeId(o);
  const ids = new Set();
  for (const ev of folded.values()) {
    if (ev.tombstone) continue;
    if (ev.project_id !== projectId) continue;
    if (ev.node_id !== myNodeId) continue;
    ids.add(ev.candidate_id);
  }
  return ids;
}

module.exports = {
  OUTBOX_FILENAME,
  EVENT_VERSION,
  getNodeId,
  isMultiCairnEnabled,
  publishCandidate,
  unpublishCandidate,
  listPublishedCandidates,
  listMyPublishedCandidateIds,
  getMultiCairnStatus,
};
