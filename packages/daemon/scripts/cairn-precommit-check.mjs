#!/usr/bin/env node
/**
 * cairn-precommit-check.mjs — v2 git pre-commit hook backend.
 *
 * Usage (invoked by the hook script installed via `cairn install`):
 *   node cairn-precommit-check.mjs --staged-files "src/foo.ts\nsrc/bar.ts"
 *
 * Behavior:
 *   - Opens ~/.cairn/cairn.db read-write (WAL + busy_timeout 2000).
 *     Fail-open: missing/unreachable → exit 0.
 *   - Queries the `conflicts` table for records detected in the last N minutes
 *     (default: 30) whose paths_json contains any of the staged paths and
 *     status = 'OPEN'.
 *   - If matches found: prints a warning to stderr, then exits 0 (never blocks
 *     commit — ADR-1 fail-open principle).
 *   - Additionally, when any matching conflict involves a second agent
 *     (agent_b !== null), inserts a new conflict row with status 'PENDING_REVIEW'
 *     so the desktop pet can surface a review-pending indicator. Insert errors
 *     are swallowed (fail-open).
 *   - Any exception → exit 0 (fail-open).
 *
 * The query uses a simple JSON LIKE match against paths_json (v1 — may produce
 * false positives for path substrings; acceptable per §8.2 "conservative
 * strategy"). The conflicts table requires migration-006 to be applied.
 *
 * Node cold-start ~70ms (per PoC-2); SQLite per-path query ~45µs.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Look-back window for recent conflicts (ms). */
const LOOKBACK_MS = 30 * 60 * 1000; // 30 minutes

/** Maximum number of conflict records to report. */
const MAX_REPORT = 5;

// ---------------------------------------------------------------------------
// Inline ULID generator (no external deps)
// Uses Crockford Base32, monotonic within same millisecond via random increment.
// ---------------------------------------------------------------------------

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeTime(now, len) {
  let str = '';
  for (let i = len - 1; i >= 0; i--) {
    str = ENCODING[now % 32] + str;
    now = Math.floor(now / 32);
  }
  return str;
}

function encodeRandom(len) {
  const bytes = randomBytes(Math.ceil(len * 5 / 8));
  let num = BigInt('0x' + bytes.toString('hex'));
  let str = '';
  for (let i = 0; i < len; i++) {
    str = ENCODING[Number(num % 32n)] + str;
    num >>= 5n;
  }
  return str;
}

function newUlid() {
  return encodeTime(Date.now(), 10) + encodeRandom(16);
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) {
        out[k] = true;
      } else {
        out[k] = v;
        i++;
      }
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

// --staged-files can be a newline- or space-separated list of paths.
const rawPaths = typeof args['staged-files'] === 'string' ? args['staged-files'] : '';
const stagedPaths = rawPaths
  .split(/[\n\r]+/)
  .flatMap((p) => p.split(' '))
  .map((p) => p.trim())
  .filter(Boolean);

// ---------------------------------------------------------------------------
// Locate DB
// ---------------------------------------------------------------------------

const dbPath = join(homedir(), '.cairn', 'cairn.db');

if (!existsSync(dbPath) || stagedPaths.length === 0) {
  // Nothing to check or DB not initialised yet — fail-open.
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Open DB and query conflicts
// ---------------------------------------------------------------------------

let db;
try {
  // Dynamic import so the script still exits 0 if better-sqlite3 is not built.
  const { default: Database } = await import('better-sqlite3');
  // Open read-write so we can INSERT PENDING_REVIEW rows.
  db = new Database(dbPath, { fileMustExist: true });
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 2000');
} catch (err) {
  // DB unavailable or binary not built — fail-open.
  if (process.env.CAIRN_HOOK_DEBUG) {
    process.stderr.write(
      `cairn-hook: skipped (${err?.code ?? err?.message ?? 'unknown'})\n`,
    );
  }
  process.exit(0);
}

// Check that the conflicts table exists (migration-004+ may not have been applied yet).
let tableExists = false;
try {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='conflicts'")
    .get();
  tableExists = row != null;
} catch {
  // Ignore — table check failed, exit safely.
}

if (!tableExists) {
  db.close();
  process.exit(0);
}

const sinceMs = Date.now() - LOOKBACK_MS;

/**
 * For each staged path, run a LIKE query against paths_json.
 * paths_json stores a JSON array, e.g. ["src/foo.ts","src/bar.ts"].
 * We use '%"<path>"%' — this will match when the exact path appears
 * as a quoted JSON string element, avoiding most prefix collisions.
 */
let stmt;
try {
  stmt = db.prepare(`
    SELECT id, detected_at, conflict_type, agent_a, agent_b, paths_json, summary, status
      FROM conflicts
     WHERE detected_at >= ?
       AND status = 'OPEN'
       AND paths_json LIKE ?
     ORDER BY detected_at DESC
     LIMIT ${MAX_REPORT}
  `);
} catch {
  db.close();
  process.exit(0);
}

/** @type {Array<{path: string, id: string, ageMin: number, conflictType: string, agentA: string, agentB: string|null, summary: string|null}>} */
const hits = [];

for (const path of stagedPaths) {
  // Use JSON-quoted path to reduce false positives from substring matches.
  const pattern = `%"${path}"%`;
  try {
    const rows = stmt.all(sinceMs, pattern);
    for (const row of rows) {
      hits.push({
        path,
        id: row.id,
        ageMin: Math.round((Date.now() - row.detected_at) / 60000),
        conflictType: row.conflict_type,
        agentA: row.agent_a,
        agentB: row.agent_b,
        summary: row.summary,
      });
      if (hits.length >= MAX_REPORT) break;
    }
  } catch {
    // Query failed for this path — skip, stay fail-open.
  }
  if (hits.length >= MAX_REPORT) break;
}

// ---------------------------------------------------------------------------
// Insert PENDING_REVIEW row when real cross-agent conflicts detected
// ---------------------------------------------------------------------------

const crossAgentHits = hits.filter((h) => h.agentB !== null);
if (crossAgentHits.length > 0) {
  try {
    const agentA =
      process.env['CAIRN_SESSION_AGENT_ID'] ?? 'precommit-anon';
    const id = newUlid();
    const summary = `pre-commit detected ${hits.length} recent conflicts in staged files; awaiting user review`;
    db.prepare(`
      INSERT INTO conflicts
        (id, detected_at, conflict_type, agent_a, agent_b,
         paths_json, summary, status, resolved_at, resolution)
      VALUES
        (?, ?, 'FILE_OVERLAP', ?, NULL, ?, ?, 'PENDING_REVIEW', NULL, NULL)
    `).run(
      id,
      Date.now(),
      agentA,
      JSON.stringify(stagedPaths),
      summary,
    );
  } catch {
    // Insert failed — fail-open, don't block commit.
  }
}

try {
  db.close();
} catch {
  // Ignore close errors.
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

if (hits.length > 0) {
  process.stderr.write(
    `\ncairn: ⚠️  Cairn 检测到这些路径最近有冲突记录，请 review 后再 commit\n`,
  );
  for (const h of hits) {
    const agents = h.agentB ? `${h.agentA} ↔ ${h.agentB}` : h.agentA;
    const note = h.summary ? ` — ${h.summary}` : '';
    process.stderr.write(
      `  • ${h.path}  [${h.conflictType}, ${h.ageMin}m ago, agents: ${agents}${note}]\n`,
    );
  }
  process.stderr.write(
    `  Run \`cairn conflict list\` to see full history.\n\n`,
  );
}

// Always exit 0 — hook never blocks commit.
process.exit(0);
