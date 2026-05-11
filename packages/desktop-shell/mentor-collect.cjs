'use strict';

/**
 * mentor-collect.cjs — Signal aggregation for Mentor (Mode A).
 *
 * Gathers whitelisted project signals per mentor-layer-spec.md §2.1,
 * with per-source timeout + try/catch per §2.3.
 *
 * PRIVACY HARD WALL (spec §2.2):
 *   - Does NOT read .env / .env.* files.
 *   - Does NOT read files matching *secret* / *credentials* / *.key / *.pem.
 *   - Does NOT read paths outside ~/.cairn and <project_root>.
 *   - Does NOT include any process.env values in returned signals.
 *   - Does NOT read past line 1 of any agent transcript.
 *   - Reads only WHITELIST_DOC_FILES from project_root; never walks the tree.
 *
 * Safety:
 *   - No require('better-sqlite3').
 *   - No require('electron').
 *   - kernel signals default to zero; a caller (mentor-handler.cjs) that
 *     has a read-only SQLite handle can overlay real counts on top.
 *
 * Exports:
 *   WHITELIST_DOC_FILES        string[]
 *   DOC_READ_BYTES_CAP         number   (6144 — 6 KB per file)
 *   DEFAULT_SOURCE_TIMEOUT_MS  number   (2000)
 *   collectMentorSignals       async function
 */

const fs       = require('fs');
const path     = require('path');
const os       = require('os');
const { spawnSync } = require('child_process');

const candidates  = require('./project-candidates.cjs');
const iterations  = require('./project-iterations.cjs');
const workerReports = require('./worker-reports.cjs');

// ---------------------------------------------------------------------------
// Exported constants
// ---------------------------------------------------------------------------

/** Files we are allowed to read from project_root (spec §2.1). */
const WHITELIST_DOC_FILES = Object.freeze([
  'PRODUCT.md',
  'README.md',
  'README',
  'TODO.md',
  'CLAUDE.md',
  'ARCHITECTURE.md',
]);

/** Maximum bytes read per whitelisted doc (6 KB per spec §2.1). */
const DOC_READ_BYTES_CAP = 6 * 1024;

/** Default per-source timeout in ms (spec §2.3). */
const DEFAULT_SOURCE_TIMEOUT_MS = 2000;

// ---------------------------------------------------------------------------
// Private: Mentor-specific git argv whitelist
// ---------------------------------------------------------------------------
// Each entry is the EXACT argv array passed to git.  No user-supplied flags
// are ever appended.  Mirror of project-evidence.cjs ALLOWED_GIT_ARGS pattern.
const MENTOR_ALLOWED_GIT_ARGS = Object.freeze([
  ['rev-parse', 'HEAD'],
  ['rev-parse', '--abbrev-ref', 'HEAD'],
  ['status', '--short'],
  ['log', '--oneline', '-20'],
]);

function _isMentorAllowedGitArgs(args) {
  if (!Array.isArray(args)) return false;
  return MENTOR_ALLOWED_GIT_ARGS.some(
    allowed => allowed.length === args.length && allowed.every((v, i) => v === args[i])
  );
}

// ---------------------------------------------------------------------------
// Private: safe git runner (no shell, windowsHide: true, exact argv only)
// ---------------------------------------------------------------------------

const GIT_TIMEOUT_MS = 4000;   // generous; per-source timeout is layered on top

/**
 * Run a whitelisted git command synchronously from `cwd`.
 * Returns { ok: true, stdout } or { ok: false, error }.
 * Output is capped at 4 KB to prevent unbounded return.
 */
function _runMentorGit(args, cwd) {
  if (!_isMentorAllowedGitArgs(args)) {
    return { ok: false, error: 'argv_not_allowed' };
  }
  let res;
  try {
    res = spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (_e) {
    return { ok: false, error: 'spawn_failed' };
  }
  if (res.status === null) return { ok: false, error: 'timeout' };
  if (res.status !== 0)   return { ok: false, error: 'git_nonzero', stderr: (res.stderr || '').slice(0, 512) };
  const out = (res.stdout || '').slice(0, 4096);
  return { ok: true, stdout: out };
}

// ---------------------------------------------------------------------------
// Private: safe file read (caps bytes, catches EACCES / ENOENT)
// ---------------------------------------------------------------------------

/**
 * Read up to `maxBytes` bytes from `filePath`.
 * Returns the UTF-8 string or null on any error.
 *
 * SAFETY: never reads .env / .env.* / *secret* / *credentials* / *.key / *.pem.
 * Callers are responsible for passing only WHITELIST_DOC_FILES paths.
 */
function _safeReadFile(filePath, maxBytes) {
  let fd;
  try {
    // Allocate a fixed-size buffer and do a partial read — avoids loading
    // an unexpectedly large file into memory before slicing.
    const buf = Buffer.alloc(maxBytes);
    fd = fs.openSync(filePath, 'r');
    const bytesRead = fs.readSync(fd, buf, 0, maxBytes, 0);
    return buf.slice(0, bytesRead).toString('utf8');
  } catch (_e) {
    // ENOENT, EACCES, or anything else → null (graceful)
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_e2) { /* ignore */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Private: per-source timeout wrapper (spec §2.3 pattern)
// ---------------------------------------------------------------------------

/**
 * Race `promise` against a `ms`-millisecond timeout.
 * On timeout, rejects with Error(`timeout:<sourceName>`).
 * Always clears the timer regardless of outcome.
 */
async function withTimeout(promise, ms, sourceName) {
  let timer;
  try {
    const timeoutPromise = new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error(`timeout:${sourceName}`)), ms);
    });
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Private: individual signal collectors
// ---------------------------------------------------------------------------

/** Collect whitelisted doc files from project_root (spec §2.1 row 1). */
async function _collectDocs(projectRoot) {
  const files = [];
  let totalBytes = 0;
  for (const name of WHITELIST_DOC_FILES) {
    const filePath = path.join(projectRoot, name);
    const text = _safeReadFile(filePath, DOC_READ_BYTES_CAP);
    if (text === null) continue;   // file absent or unreadable — skip
    const byteCount = Buffer.byteLength(text, 'utf8');
    // Clip string representation to cap (it's already byte-capped from the read,
    // but ensure the returned field doesn't exceed the cap if encoding varies).
    const textClipped = text.slice(0, DOC_READ_BYTES_CAP);
    files.push({ path: name, byte_count: byteCount, text_clipped: textClipped });
    totalBytes += byteCount;
  }
  return { files, total_bytes: totalBytes };
}

/** Collect git signals from project_root (spec §2.1 rows 2-3). */
async function _collectGit(projectRoot) {
  // Per spec §8 scenario 6: a missing / unreadable project_root must
  // surface as a failure (recorded into meta.failed_signals by the
  // caller's try/catch), not as a silent empty signal.
  if (!projectRoot || !fs.existsSync(projectRoot)) {
    throw new Error('git:project_root_missing');
  }
  const headResult   = _runMentorGit(['rev-parse', 'HEAD'], projectRoot);
  const branchResult = _runMentorGit(['rev-parse', '--abbrev-ref', 'HEAD'], projectRoot);
  const statusResult = _runMentorGit(['status', '--short'], projectRoot);
  const logResult    = _runMentorGit(['log', '--oneline', '-20'], projectRoot);

  // If every probe failed, the dir exists but isn't a git repo — also
  // a hard failure (not a "git happened to be empty" success).
  if (!headResult.ok && !branchResult.ok && !statusResult.ok && !logResult.ok) {
    throw new Error('git:all_probes_failed');
  }

  const head          = headResult.ok   ? headResult.stdout.trim().slice(0, 40)   : '';
  const branch        = branchResult.ok ? branchResult.stdout.trim().slice(0, 200) : '';
  // status_short capped at 4 KB per spec length-cap section
  const statusShort   = statusResult.ok ? statusResult.stdout.slice(0, 4096)      : '';

  // Parse log: each line is "<7hex> <subject>" (--oneline format)
  const commits = [];
  if (logResult.ok) {
    const lines = logResult.stdout.split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      const spaceIdx = line.indexOf(' ');
      if (spaceIdx < 0) continue;
      const hash    = line.slice(0, spaceIdx).slice(0, 40);
      // subject capped at 200 chars per spec
      const subject = line.slice(spaceIdx + 1).slice(0, 200);
      commits.push({ hash, subject });
      if (commits.length >= 20) break;
    }
  }

  return {
    head: head.slice(0, 12),     // short sha
    branch,
    status_short: statusShort,
    commits,
  };
}

/** Collect candidate rows (spec §2.1 row 4). */
async function _collectCandidates(projectId, home) {
  return candidates.listCandidates(projectId, 100, { home });
}

/** Collect iteration rows (spec §2.1 row 5). */
async function _collectIterations(projectId, home) {
  return iterations.listIterations(projectId, 100, { home });
}

/**
 * Collect worker report rows — structured fields only, never raw
 * stdout/stderr (spec §2.1 row 6 + §2.2).
 *
 * We strip raw_output / stdout / stderr / tool_response fields that
 * might carry unstructured agent transcript content.
 */
async function _collectReports(projectId, home) {
  const raw = workerReports.listWorkerReports(projectId, 50, { home });
  return raw.map(r => {
    // Return only the known structured fields; drop any field that might
    // carry raw agent transcript text.
    return {
      id:          r.id,
      project_id:  r.project_id,
      created_at:  r.created_at,
      agent_id:    r.agent_id,
      session_id:  r.session_id,
      source_app:  r.source_app,
      title:       typeof r.title === 'string'       ? r.title.slice(0, 200)  : undefined,
      finished:    Array.isArray(r.finished)         ? r.finished.slice(0, 30).map(s => typeof s === 'string' ? s.slice(0, 400) : s) : undefined,
      remaining:   Array.isArray(r.remaining)        ? r.remaining.slice(0, 30).map(s => typeof s === 'string' ? s.slice(0, 400) : s) : undefined,
      blockers:    Array.isArray(r.blockers)         ? r.blockers.slice(0, 30).map(s => typeof s === 'string' ? s.slice(0, 400) : s) : undefined,
      next_steps:  Array.isArray(r.next_steps)       ? r.next_steps.slice(0, 30).map(s => typeof s === 'string' ? s.slice(0, 400) : s) : undefined,
      status:      r.status,
      confidence:  r.confidence,
      // raw_output / stdout / stderr intentionally omitted (spec §2.2 non-input)
    };
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Collect all whitelisted Mentor signals for a project.
 *
 * Each signal source is wrapped in try/catch + withTimeout so a single
 * failure never kills the whole call (spec §2.3 / §8 scenario 6).
 *
 * @param {string} projectId
 * @param {{
 *   project_root?:       string,
 *   home?:               string,
 *   source_timeout_ms?:  number,
 *   signal_overrides?:   {
 *     docs?:       boolean,
 *     git?:        boolean,
 *     candidates?: boolean,
 *     iterations?: boolean,
 *     reports?:    boolean,
 *     history?:    boolean,
 *   }
 * }} [opts]
 * @returns {Promise<{
 *   signals: {
 *     docs:       { files: Array<{path:string,byte_count:number,text_clipped:string}>, total_bytes:number },
 *     git:        { head:string, branch:string, status_short:string, commits:Array<{hash:string,subject:string}> },
 *     candidates: object[],
 *     iterations: object[],
 *     reports:    object[],
 *     kernel:     { tasks_running:number, tasks_blocked:number, tasks_failed:number,
 *                   tasks_waiting_review:number, outcomes_failed:number,
 *                   outcomes_pending:number, blockers_open:number }
 *   },
 *   meta: {
 *     collected_at:   number,
 *     source_count:   number,
 *     failed_signals: Array<{source:string,error:string}>,
 *     elapsed_ms:     number,
 *   }
 * }>}
 */
async function collectMentorSignals(projectId, opts) {
  const startMs = Date.now();
  const o = opts || {};
  const timeoutMs = (typeof o.source_timeout_ms === 'number' && o.source_timeout_ms > 0)
    ? o.source_timeout_ms
    : DEFAULT_SOURCE_TIMEOUT_MS;
  const overrides  = o.signal_overrides || {};
  const projectRoot = o.project_root || null;
  const home        = o.home || os.homedir();

  const failedSignals = [];

  // ------------------------------------------------------------------
  // Default empty shapes — populated per-source below
  // ------------------------------------------------------------------
  const docsDefault = { files: [], total_bytes: 0 };
  const gitDefault  = { head: '', branch: '', status_short: '', commits: [] };

  // ------------------------------------------------------------------
  // Helper: run a source with timeout + catch, fallback on failure
  // ------------------------------------------------------------------
  async function runSource(name, enabled, promise, fallback) {
    if (enabled === false) {
      // Explicitly disabled by caller via signal_overrides
      return fallback;
    }
    try {
      return await withTimeout(promise, timeoutMs, name);
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      failedSignals.push({ source: name, error: msg });
      return fallback;
    }
  }

  // ------------------------------------------------------------------
  // Source: docs (requires project_root)
  // ------------------------------------------------------------------
  const docsEnabled = overrides.docs !== false;
  let docsSignal = docsDefault;
  if (docsEnabled) {
    if (!projectRoot) {
      failedSignals.push({ source: 'docs', error: 'project_root_not_provided' });
    } else {
      docsSignal = await runSource(
        'docs',
        true,
        _collectDocs(projectRoot),
        docsDefault
      );
    }
  }

  // ------------------------------------------------------------------
  // Source: git (requires project_root)
  // ------------------------------------------------------------------
  const gitEnabled = overrides.git !== false;
  let gitSignal = gitDefault;
  if (gitEnabled) {
    if (!projectRoot) {
      failedSignals.push({ source: 'git', error: 'project_root_not_provided' });
    } else {
      gitSignal = await runSource(
        'git',
        true,
        _collectGit(projectRoot),
        gitDefault
      );
    }
  }

  // ------------------------------------------------------------------
  // Source: candidates
  // ------------------------------------------------------------------
  const candidatesSignal = await runSource(
    'candidates',
    overrides.candidates !== false,
    _collectCandidates(projectId, home),
    []
  );

  // ------------------------------------------------------------------
  // Source: iterations
  // ------------------------------------------------------------------
  const iterationsSignal = await runSource(
    'iterations',
    overrides.iterations !== false,
    _collectIterations(projectId, home),
    []
  );

  // ------------------------------------------------------------------
  // Source: reports
  // ------------------------------------------------------------------
  const reportsSignal = await runSource(
    'reports',
    overrides.reports !== false,
    _collectReports(projectId, home),
    []
  );

  // ------------------------------------------------------------------
  // Source: kernel (SQLite counts)
  //
  // TODO: mentor-handler.cjs, which holds the read-only SQLite handle
  // from project-queries.cjs, should call collectMentorSignals() and
  // then overlay real values here.  Expected query pattern:
  //
  //   SELECT
  //     SUM(CASE WHEN status='RUNNING'        THEN 1 ELSE 0 END) AS tasks_running,
  //     SUM(CASE WHEN status='BLOCKED'        THEN 1 ELSE 0 END) AS tasks_blocked,
  //     SUM(CASE WHEN status='FAILED'         THEN 1 ELSE 0 END) AS tasks_failed,
  //     SUM(CASE WHEN status='WAITING_REVIEW' THEN 1 ELSE 0 END) AS tasks_waiting_review
  //   FROM tasks WHERE project_id = ?;
  //
  //   SELECT
  //     SUM(CASE WHEN status='FAILED'  THEN 1 ELSE 0 END) AS outcomes_failed,
  //     SUM(CASE WHEN status='PENDING' THEN 1 ELSE 0 END) AS outcomes_pending
  //   FROM outcomes WHERE project_id = ?;
  //
  //   SELECT COUNT(*) AS blockers_open FROM blockers
  //   WHERE project_id = ? AND status = 'OPEN';
  //
  // This file intentionally does NOT open a SQLite connection (spec §10
  // scaffold note: "scaffold doesn't open it; leave wired-by-handler").
  // ------------------------------------------------------------------
  const kernelSignal = {
    tasks_running:        0,
    tasks_blocked:        0,
    tasks_failed:         0,
    tasks_waiting_review: 0,
    outcomes_failed:      0,
    outcomes_pending:     0,
    blockers_open:        0,
  };

  // ------------------------------------------------------------------
  // Assemble result
  // ------------------------------------------------------------------
  const signals = {
    docs:       docsSignal,
    git:        gitSignal,
    candidates: Array.isArray(candidatesSignal) ? candidatesSignal : [],
    iterations: Array.isArray(iterationsSignal) ? iterationsSignal : [],
    reports:    Array.isArray(reportsSignal)    ? reportsSignal    : [],
    kernel:     kernelSignal,
  };

  // source_count = number of sources attempted (regardless of failure)
  // We track: docs, git, candidates, iterations, reports (5 file/spawn sources).
  // kernel is scaffolded as zero-default, not "attempted" in the same sense.
  const sourceCount = 5;

  const meta = {
    collected_at:   startMs,
    source_count:   sourceCount,
    failed_signals: failedSignals,
    elapsed_ms:     Date.now() - startMs,
  };

  return { signals, meta };
}

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------

module.exports = {
  WHITELIST_DOC_FILES,
  DOC_READ_BYTES_CAP,
  DEFAULT_SOURCE_TIMEOUT_MS,
  collectMentorSignals,
};
