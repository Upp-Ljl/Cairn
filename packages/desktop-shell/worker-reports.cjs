'use strict';

/**
 * Worker Report Protocol v1 — local, append-only, project-scoped.
 *
 * Worker reports are short structured updates — "what did I finish,
 * what's remaining, what's blocking, what's next" — that an agent or
 * subagent (or the user paraphrasing one) drops into Cairn so the
 * panel + LLM Interpretation layer have something to interpret.
 *
 * Storage: one JSONL file per project at
 *   ~/.cairn/project-reports/<projectId>.jsonl
 *
 * Why JSONL instead of expanding ~/.cairn/projects.json:
 *   - Reports can accumulate; keeping the registry lean preserves
 *     read-load for the panel's poll loop.
 *   - Append-only writes survive partial failures cleanly.
 *   - Per-project files keep one project's growth from affecting
 *     others' read latency.
 *   - One line per report — line N is broken => skip line N, read
 *     N-1 and N+1.
 *
 * What we ship:
 *   - addWorkerReport: append (writes one new line)
 *   - listWorkerReports: read tail, newest-first
 *   - clearWorkerReports: delete the file
 *   - parseReportText: best-effort markdown → structured fields
 *
 * Read/write boundary (Phase 3):
 *   - We DO write `~/.cairn/project-reports/`. New write surface,
 *     documented here, NOT cairn.db / ~/.claude / ~/.codex.
 *   - We do NOT extract content from running agent transcripts.
 *     Reports come from a user paste or an explicit IPC call from
 *     a friendly agent that already produced a structured summary.
 *
 * No I/O outside append/read/unlink on the JSONL file.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const REPORTS_DIRNAME = 'project-reports';
const MAX_TAIL_LINES  = 200;     // how many lines we read from the end
const MAX_RETURN      = 50;      // how many reports we'll return at most

const STR_TITLE_MAX        = 200;
const STR_BULLET_MAX       = 400;
const LIST_MAX             = 30;
const STR_SOURCE_APP_MAX   = 40;
const STR_AGENT_ID_MAX     = 80;
const STR_SESSION_ID_MAX   = 80;

function reportsDir(home) {
  const h = home || os.homedir();
  return path.join(h, '.cairn', REPORTS_DIRNAME);
}

function reportsFile(projectId, home) {
  // projectId is opaque (registry-issued), should be path-safe; we
  // still sanitize to avoid traversal.
  const safe = String(projectId || '').replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 64);
  return path.join(reportsDir(home), safe + '.jsonl');
}

function ensureReportsDir(home) {
  try { fs.mkdirSync(reportsDir(home), { recursive: true }); } catch (_e) {}
}

function newReportId() {
  return 'r_' + crypto.randomBytes(6).toString('hex');
}

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

/**
 * Coerce raw input into a normalized report. project_id and
 * created_at are required; the rest is best-effort.
 */
function normalizeReport(projectId, input) {
  const o = input || {};
  const now = Date.now();
  return {
    id:                o.id && typeof o.id === 'string' ? o.id : newReportId(),
    project_id:        String(projectId),
    source_app:        clip(o.source_app, STR_SOURCE_APP_MAX),
    session_id:        clip(o.session_id, STR_SESSION_ID_MAX) || null,
    agent_id:          clip(o.agent_id,   STR_AGENT_ID_MAX)   || null,
    title:             clip(o.title, STR_TITLE_MAX) || '(untitled)',
    completed:         clipList(o.completed,  LIST_MAX, STR_BULLET_MAX),
    remaining:         clipList(o.remaining,  LIST_MAX, STR_BULLET_MAX),
    blockers:          clipList(o.blockers,   LIST_MAX, STR_BULLET_MAX),
    next_steps:        clipList(o.next_steps, LIST_MAX, STR_BULLET_MAX),
    needs_human:       !!o.needs_human,
    related_task_ids:  clipList(o.related_task_ids, LIST_MAX, 80),
    created_at:        Number.isFinite(o.created_at) ? o.created_at : now,
  };
}

/**
 * Append one report to the project's JSONL file.
 *
 * @param {string} projectId
 * @param {object} input
 * @param {object} [opts] { home }
 * @returns {{ ok:boolean, report?:object, error?:string }}
 */
function addWorkerReport(projectId, input, opts) {
  if (!projectId || typeof projectId !== 'string') {
    return { ok: false, error: 'projectId_required' };
  }
  const o = opts || {};
  const report = normalizeReport(projectId, input);
  const file = reportsFile(projectId, o.home);
  ensureReportsDir(o.home);
  try {
    fs.appendFileSync(file, JSON.stringify(report) + '\n', 'utf8');
  } catch (e) {
    // Don't echo e.message — could leak file path or permissions.
    return { ok: false, error: 'append_failed' };
  }
  return { ok: true, report };
}

/**
 * Read the most recent N reports for one project, newest-first.
 *
 * Robust against a partially-corrupted file: malformed lines are
 * skipped silently (logged once via console for diagnosis if you
 * inspect, but not surfaced to callers — the user already has a
 * "clear reports" action).
 *
 * @param {string} projectId
 * @param {number} [limit]
 * @param {object} [opts] { home }
 * @returns {object[]}
 */
function listWorkerReports(projectId, limit, opts) {
  if (!projectId || typeof projectId !== 'string') return [];
  const o = opts || {};
  const file = reportsFile(projectId, o.home);
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (_e) { return []; }
  const lines = raw.split(/\r?\n/).filter(Boolean);
  // Take the tail to bound work even on huge files.
  const tail = lines.slice(-MAX_TAIL_LINES);
  /** @type {object[]} */
  const out = [];
  for (let i = tail.length - 1; i >= 0; i--) {
    let parsed;
    try { parsed = JSON.parse(tail[i]); } catch (_e) { continue; }
    if (parsed && typeof parsed === 'object' && parsed.project_id === projectId) {
      out.push(parsed);
    }
    if (out.length >= Math.min(limit || MAX_RETURN, MAX_RETURN)) break;
  }
  return out;
}

/**
 * Delete the JSONL file (effectively clears all reports). Returns
 * { cleared: true } when the file existed and was removed.
 */
function clearWorkerReports(projectId, opts) {
  if (!projectId || typeof projectId !== 'string') return { cleared: false };
  const o = opts || {};
  const file = reportsFile(projectId, o.home);
  try {
    fs.unlinkSync(file);
    return { cleared: true };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { cleared: false };
    return { cleared: false, error: 'unlink_failed' };
  }
}

// ---------------------------------------------------------------------------
// parseReportText — best-effort markdown → structured fields
// ---------------------------------------------------------------------------
//
// Recognized sections (case-insensitive, with optional `## ` prefix):
//
//   completed / done
//   remaining / todo / in progress
//   blockers / blocked
//   next steps / next
//
// Anything before the first section header is treated as the title
// (first non-empty line). `needs_human: yes/true/1` anywhere in the
// body sets the flag. `source: <app>` / `session: <id>` /
// `agent: <id>` lines are recognized as metadata.
//
// Free-form text without sections still produces a report — the first
// non-empty line is the title. The user's intent is to drop a quick
// summary into Cairn; we don't want to enforce a strict schema.

const SECTION_KEYS = [
  { key: 'completed',  patterns: [/^completed$/i, /^done$/i] },
  { key: 'remaining',  patterns: [/^remaining$/i, /^todo$/i, /^in[ -]progress$/i] },
  { key: 'blockers',   patterns: [/^blockers?$/i, /^blocked$/i] },
  { key: 'next_steps', patterns: [/^next[ -]?steps?$/i, /^next$/i] },
];

function matchSectionHeader(line) {
  if (typeof line !== 'string') return null;
  // Strip leading hashes + spaces.
  const m = line.match(/^\s*(#{1,6})\s+(.+?)\s*$/);
  const header = m ? m[2].trim() : null;
  if (!header) return null;
  const cmp = header.toLowerCase();
  for (const sec of SECTION_KEYS) {
    if (sec.patterns.some(p => p.test(cmp))) return sec.key;
  }
  return null;
}

function isBulletLine(line) {
  return /^\s*[-*•]\s+/.test(line) || /^\s*\d+\.\s+/.test(line);
}

function stripBullet(line) {
  return line.replace(/^\s*[-*•]\s+/, '').replace(/^\s*\d+\.\s+/, '').trim();
}

/**
 * Parse free-form markdown / structured text into a report shape.
 * Returns the raw fields (caller usually passes through normalizeReport
 * so length caps are applied).
 */
function parseReportText(text) {
  const out = {
    title: '',
    completed: [],
    remaining: [],
    blockers: [],
    next_steps: [],
    source_app: null,
    session_id: null,
    agent_id: null,
    needs_human: false,
    related_task_ids: [],
  };
  if (typeof text !== 'string' || !text.trim()) return out;
  const lines = text.split(/\r?\n/);

  let currentSection = null;
  let titleSet = false;
  for (const lineRaw of lines) {
    const line = lineRaw;
    const trimmed = line.trim();
    if (!trimmed) continue;

    const section = matchSectionHeader(trimmed);
    if (section) {
      currentSection = section;
      continue;
    }
    // Any other heading (## / ### / ...) terminates the current
    // section — bullets after it are unrelated to the prior section.
    // Plain "# Title" at the top is also handled here as the title
    // when no title has been set yet.
    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      currentSection = null;
      if (heading[1].length === 1 && !titleSet) {
        out.title = heading[2].trim();
        titleSet = true;
      }
      continue;
    }

    // Inline metadata "source: claude-code" etc.
    const meta = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.+)$/);
    if (meta && !isBulletLine(line)) {
      const k = meta[1].toLowerCase();
      const v = meta[2].trim();
      if (k === 'source' || k === 'source_app')     { out.source_app = v; continue; }
      if (k === 'session' || k === 'session_id')    { out.session_id = v; continue; }
      if (k === 'agent'   || k === 'agent_id')      { out.agent_id   = v; continue; }
      if (k === 'needs_human' || k === 'needs-human') {
        out.needs_human = /^(yes|true|1|y)$/i.test(v); continue;
      }
      if (k === 'task' || k === 'task_id' || k === 'related_task') {
        out.related_task_ids.push(v); continue;
      }
      // Unknown metadata — treat as title fallback if no title yet.
      if (!titleSet) { out.title = trimmed; titleSet = true; continue; }
    }

    if (currentSection) {
      // Inside a section: collect bullets (or non-empty lines).
      const item = isBulletLine(line) ? stripBullet(line) : trimmed;
      if (item) out[currentSection].push(item);
      continue;
    }

    // No section yet, no title yet → first non-empty line is title.
    if (!titleSet) {
      out.title = trimmed;
      titleSet = true;
      continue;
    }
    // Otherwise, content before any section: ignored (we already have
    // a title; adding to "completed" by default would be a guess).
  }

  return out;
}

module.exports = {
  reportsDir,
  reportsFile,
  newReportId,
  normalizeReport,
  addWorkerReport,
  listWorkerReports,
  clearWorkerReports,
  parseReportText,
  matchSectionHeader,
  // exposed for smoke
  STR_TITLE_MAX,
  LIST_MAX,
  MAX_TAIL_LINES,
  MAX_RETURN,
};
