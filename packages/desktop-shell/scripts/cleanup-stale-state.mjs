#!/usr/bin/env node
/**
 * cleanup-stale-state.mjs — one-shot reaper for ghost rows that pollute
 * Mode A diagnosis. Surfaced by subagent审查 2026-05-14 when 鸭总 hit
 * "70 IDLE ACTIVE processes + 2 zombie worker-runs" on full test.
 *
 * Does TWO things, both idempotent:
 *
 * 1. **Stale ACTIVE processes** — a row is `status='ACTIVE'` but its
 *    `last_heartbeat` is older than `2 × heartbeat_ttl`. The kernel
 *    auto-marks IDLE on certain queries but the panel's read-mostly
 *    surface doesn't trigger it. We flip those rows to `IDLE`
 *    (NOT `DEAD` — that's reserved for explicit shutdown) so
 *    `decideNextDispatch` stops picking dead sessions.
 *
 * 2. **Zombie worker-runs** — `run.json.status === 'running'` but the
 *    PID is no longer alive. Worker crashed before flushing the
 *    exit handler. We patch the file to `status='failed'` with
 *    `signal='ghost-reaped'` so panel "in-flight" widgets stop
 *    counting them.
 *
 * Run anytime. Read-only on registry / scratchpad / dispatch_requests
 * (only writes to `processes` table + worker-runs `run.json` files).
 *
 * Usage:
 *   node packages/desktop-shell/scripts/cleanup-stale-state.mjs
 *   node packages/desktop-shell/scripts/cleanup-stale-state.mjs --dry-run
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// Use daemon's better-sqlite3 binding (Node 24 compatible).
const dsRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..');
const repoRoot = path.resolve(dsRoot, '..', '..');
const Database = require(path.join(repoRoot, 'packages', 'daemon', 'node_modules', 'better-sqlite3'));

const dryRun = process.argv.includes('--dry-run');
const HOME = process.env.HOME || os.homedir();
const dbPath = path.join(HOME, '.cairn', 'cairn.db');
const workerRunsDir = path.join(HOME, '.cairn', 'worker-runs');

function isPidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0); // signal 0 = check existence without killing
    return true;
  } catch (e) {
    if (e.code === 'EPERM') return true; // exists but not ours
    return false;                         // ESRCH = no such process
  }
}

console.log(`HOME=${HOME}`);
console.log(`db_path=${dbPath}`);
console.log(`worker-runs=${workerRunsDir}`);
console.log(`mode=${dryRun ? 'DRY RUN' : 'LIVE'}`);
console.log('');

// ---------------------------------------------------------------------------
// Part 1: Stale ACTIVE processes
// ---------------------------------------------------------------------------
console.log('=== Part 1: Stale ACTIVE processes ===');

if (!fs.existsSync(dbPath)) {
  console.log(`SKIP — DB not found at ${dbPath}`);
} else {
  const db = new Database(dbPath, { readonly: dryRun });
  const now = Date.now();
  const rows = db.prepare(`
    SELECT agent_id, status, last_heartbeat, heartbeat_ttl,
           (? - last_heartbeat) AS age_ms
      FROM processes
     WHERE status = 'ACTIVE'
       AND last_heartbeat IS NOT NULL
       AND heartbeat_ttl IS NOT NULL
       AND (? - last_heartbeat) > (heartbeat_ttl * 2)
  `).all(now, now);

  console.log(`Found ${rows.length} ACTIVE rows with stale heartbeat (> 2× TTL)`);
  for (const r of rows.slice(0, 5)) {
    console.log(`  ${r.agent_id}  age=${Math.round(r.age_ms / 1000)}s  ttl=${Math.round(r.heartbeat_ttl / 1000)}s`);
  }
  if (rows.length > 5) console.log(`  ...and ${rows.length - 5} more`);

  if (!dryRun && rows.length > 0) {
    const info = db.prepare(`
      UPDATE processes
         SET status = 'IDLE'
       WHERE status = 'ACTIVE'
         AND last_heartbeat IS NOT NULL
         AND heartbeat_ttl IS NOT NULL
         AND (? - last_heartbeat) > (heartbeat_ttl * 2)
    `).run(now);
    console.log(`Flipped ${info.changes} rows ACTIVE → IDLE`);
  } else if (dryRun) {
    console.log('(dry run — no changes)');
  } else {
    console.log('Nothing to do.');
  }
  db.close();
}

console.log('');

// ---------------------------------------------------------------------------
// Part 2: Zombie worker-runs (status running but PID dead)
// ---------------------------------------------------------------------------
console.log('=== Part 2: Zombie worker-runs ===');

if (!fs.existsSync(workerRunsDir)) {
  console.log(`SKIP — worker-runs dir not found at ${workerRunsDir}`);
} else {
  const runDirs = fs.readdirSync(workerRunsDir).filter(d => d.startsWith('wr_'));
  let zombies = 0;
  let patched = 0;
  for (const d of runDirs) {
    const p = path.join(workerRunsDir, d, 'run.json');
    if (!fs.existsSync(p)) continue;
    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (_e) { continue; }
    if (meta.status === 'running' || meta.status === 'queued') {
      const alive = isPidAlive(meta.pid);
      if (!alive) {
        zombies++;
        console.log(`  zombie ${d}  pid=${meta.pid}  status=${meta.status}`);
        if (!dryRun) {
          meta.status = 'failed';
          meta.exit_code = meta.exit_code == null ? -1 : meta.exit_code;
          meta.ended_at = meta.ended_at || Date.now();
          meta.signal = meta.signal || 'ghost-reaped';
          if (!meta.error) meta.error = 'reaped by cleanup-stale-state.mjs (pid no longer alive)';
          try {
            fs.writeFileSync(p, JSON.stringify(meta, null, 2), 'utf8');
            patched++;
          } catch (e) {
            console.log(`    FAILED to write: ${(e && e.message) || e}`);
          }
        }
      }
    }
  }
  console.log(`Found ${zombies} zombie worker-runs${dryRun ? ' (dry run)' : `; patched ${patched}`}`);
}

console.log('');
console.log('Done.');
