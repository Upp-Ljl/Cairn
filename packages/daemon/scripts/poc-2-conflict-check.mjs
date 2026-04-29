#!/usr/bin/env node
/**
 * PoC-2: git pre-commit hook conflict check (the actual hook).
 *
 * Usage (from .git/hooks/pre-commit):
 *   node packages/daemon/scripts/poc-2-conflict-check.mjs \
 *     --db /path/to/cairn.db \
 *     --paths "src/foo.ts,src/bar.ts" \
 *     [--task-id T1]
 *
 * Behavior:
 *   - Opens cairn DB read-only.
 *   - For each staged path, runs a query against checkpoints created in the
 *     last 60 minutes (proxy for "another agent touched this recently").
 *   - Prints warnings to stderr if any potential conflicts found.
 *   - **Always exits 0** — fail-open principle (per ADR-1, hook never blocks
 *     commit; it only informs).
 *   - If DB is missing/unreachable, prints a one-line note and exits 0.
 *
 * Pass criteria (from pre-impl-validation §3.2):
 *   - p99 wall-clock latency:
 *       small (< 100 staged files): < 200ms
 *       large (1000 staged files):  < 1s
 *   - DB-down case still exits 0 (hook does not block commit).
 */

const args = parseArgs(process.argv.slice(2));
const dbPath = args.db;
const paths = (args.paths || '').split(',').map((s) => s.trim()).filter(Boolean);
const myTaskId = args['task-id'] || null;

if (!dbPath) {
  console.error('cairn-hook: --db is required');
  process.exit(0); // fail-open, but log
}

const t0 = process.hrtime.bigint();

let db;
let openDatabase;
try {
  ({ openDatabase } = await import('../dist/index.js'));
  db = openDatabase(dbPath, { readonly: true });
} catch (err) {
  // DB missing, schema mismatch, or import failed — fail open.
  const t1 = process.hrtime.bigint();
  const ms = Number(t1 - t0) / 1e6;
  console.error(`cairn-hook: skipped (${err?.code || err?.message || 'unknown'}) in ${ms.toFixed(2)}ms`);
  process.exit(0);
}

const sinceMs = Date.now() - 60 * 60 * 1000;

// One prepared statement, reused across staged paths. This is the shape v0.1
// would use once a paths-per-checkpoint join table exists; for now we proxy
// path matching via LIKE on label (good enough to bench query cost shape).
const checkStmt = db.prepare(`
  SELECT id, task_id, label, created_at
    FROM checkpoints
   WHERE created_at >= ?
     AND snapshot_status = 'READY'
     AND (? IS NULL OR task_id IS NULL OR task_id != ?)
     AND (label LIKE ? OR snapshot_dir LIKE ?)
   LIMIT 5
`);

const conflicts = [];
for (const path of paths) {
  const pattern = `%${path}%`;
  const rows = checkStmt.all(sinceMs, myTaskId, myTaskId, pattern, pattern);
  for (const row of rows) {
    conflicts.push({
      path,
      checkpoint: row.id,
      otherTask: row.task_id,
      label: row.label,
      ageMs: Date.now() - row.created_at,
    });
  }
}

db.close();

const t1 = process.hrtime.bigint();
const totalMs = Number(t1 - t0) / 1e6;

if (conflicts.length > 0) {
  process.stderr.write(`cairn-hook: ${conflicts.length} potential conflict(s) detected on ${paths.length} staged paths\n`);
  for (const c of conflicts.slice(0, 5)) {
    const ageMin = Math.round(c.ageMs / 60000);
    process.stderr.write(`  - ${c.path} -> checkpoint ${c.checkpoint.slice(0, 10)}... (task ${c.otherTask || 'untagged'}, ${ageMin}m ago, label: ${c.label || 'n/a'})\n`);
  }
  if (conflicts.length > 5) {
    process.stderr.write(`  ... and ${conflicts.length - 5} more\n`);
  }
}

if (process.env.CAIRN_HOOK_TIMING) {
  process.stderr.write(`cairn-hook: ${paths.length} paths in ${totalMs.toFixed(2)}ms\n`);
}

process.exit(0);

// ────────────────────────────────────────────────────────────────────────────
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
