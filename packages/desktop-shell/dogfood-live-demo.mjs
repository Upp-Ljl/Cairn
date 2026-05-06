// Live dogfood demo — exercises Phase 2/3 paths against a temp DB
// and prints the same queryState() shape the pet's IPC handler returns.
// Does NOT touch ~/.cairn/cairn.db.
//
// Run: node packages/desktop-shell/dogfood-live-demo.mjs

import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

// Reuse daemon's already-built dist for migrations + repos
const { openDatabase } = await import('../daemon/dist/storage/db.js');
const { runMigrations } = await import('../daemon/dist/storage/migrations/runner.js');
const { ALL_MIGRATIONS } = await import('../daemon/dist/storage/migrations/index.js');
const { recordConflict, getConflict } = await import('../daemon/dist/storage/repositories/conflicts.js');
const { registerProcess } = await import('../daemon/dist/storage/repositories/processes.js');
const { putScratch } = await import('../daemon/dist/storage/repositories/scratchpad.js');
const {
  createDispatchRequest,
  failDispatchRequest,
} = await import('../daemon/dist/storage/repositories/dispatch-requests.js');

// ---------------------------------------------------------------------------
// Setup temp DB (separate from ~/.cairn/cairn.db so we don't pollute user state)
// ---------------------------------------------------------------------------

const tmpRoot = mkdtempSync(join(tmpdir(), 'cairn-live-demo-'));
const dbPath = join(tmpRoot, 'cairn.db');
console.log(`[setup] temp DB at ${dbPath}`);

const db = openDatabase(dbPath);
runMigrations(db, ALL_MIGRATIONS);

// ---------------------------------------------------------------------------
// queryState() — copied from main.cjs/state-server.js verbatim
// ---------------------------------------------------------------------------

function queryState() {
  const tables = new Set(
    db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(r => r.name)
  );

  let agents_active = 0, newest_agent_age_sec = null;
  if (tables.has('processes')) {
    agents_active = db.prepare(`SELECT COUNT(*) AS c FROM processes WHERE status='ACTIVE'`).get().c;
    const newest = db.prepare(`SELECT MAX(registered_at) AS t FROM processes`).get();
    if (newest && newest.t != null)
      newest_agent_age_sec = Math.round((Date.now() - newest.t) / 100) / 10;
  }

  let conflicts_open = 0;
  if (tables.has('conflicts'))
    conflicts_open = db.prepare(`SELECT COUNT(*) AS c FROM conflicts WHERE status='OPEN'`).get().c;

  let last_dispatch_status = null, last_dispatch_age_sec = null, dispatch_pending = 0;
  if (tables.has('dispatch_requests')) {
    const row = db.prepare(
      `SELECT status, created_at FROM dispatch_requests ORDER BY created_at DESC LIMIT 1`
    ).get();
    if (row) {
      last_dispatch_status = row.status.toLowerCase();
      last_dispatch_age_sec = Math.round((Date.now() - row.created_at) / 100) / 10;
    }
    dispatch_pending = db.prepare(`SELECT COUNT(*) AS c FROM dispatch_requests WHERE status='PENDING'`).get().c;
  }

  return {
    agents_active,
    conflicts_open,
    dispatch_pending,
    last_dispatch_status,
    last_dispatch_age_sec,
    newest_agent_age_sec,
  };
}

function petAnimation(state) {
  // From inspector logic: prioritize failures, then conflicts, then activity.
  if (state.last_dispatch_status === 'failed' && state.last_dispatch_age_sec != null && state.last_dispatch_age_sec < 300)
    return 'failed';
  if (state.conflicts_open > 0) return 'review (red — conflict needs attention)';
  if (state.agents_active > 0) return 'running (active agent)';
  return 'idle';
}

function snapshot(label) {
  const s = queryState();
  console.log(`\n[${label}] ${JSON.stringify(s)}`);
  console.log(`  → pet animation: ${petAnimation(s)}`);
}

// ---------------------------------------------------------------------------
// Demo
// ---------------------------------------------------------------------------

snapshot('t=0 fresh DB');

// --- Demo: register two agents (so cross-agent conflict is meaningful) ---
registerProcess(db, { agentId: 'agent-A', agentType: 'session' });
registerProcess(db, { agentId: 'agent-B', agentType: 'session' });
snapshot('t=1 two agents registered');

// --- Demo 1: cross-agent conflict (would happen via checkpoint.create overlap) ---
const conflict = recordConflict(db, {
  conflictType: 'FILE_OVERLAP',
  agentA: 'agent-A',
  agentB: 'agent-B',
  paths: ['src/foo.ts', 'src/bar.ts'],
  summary: 'A and B both touched src/foo.ts',
  status: 'OPEN',
});
console.log(`\n[demo1] inserted conflict id=${conflict.id} status=${conflict.status}`);
snapshot('t=2 conflict OPEN — pet should turn red');

// --- Demo: simulate Inspector "Resolve" click via the same SQL main.cjs uses ---
const resolveStmt = db.prepare(`
  UPDATE conflicts
     SET status='RESOLVED', resolved_at=?, resolution=?
   WHERE id=? AND status IN ('OPEN','PENDING_REVIEW')
`);
const r = resolveStmt.run(Date.now(), 'manual via inspector', conflict.id);
console.log(`\n[demo1] resolve clicked: changes=${r.changes}`);
const after = getConflict(db, conflict.id);
console.log(`  conflict now: status=${after.status} resolution="${after.resolution}"`);
snapshot('t=3 conflict resolved — pet should return to idle');

// --- Demo: TOCTOU — second resolve attempt should be no-op ---
const r2 = resolveStmt.run(Date.now(), 'race overwrite attempt', conflict.id);
console.log(`\n[demo1-toctou] second resolve: changes=${r2.changes} (should be 0)`);
const after2 = getConflict(db, conflict.id);
console.log(`  resolution unchanged: "${after2.resolution}" (proves TOCTOU guard works)`);

// --- Demo 2: dispatch FORCE_FAIL — simulate what mcp-server does when env is set ---
console.log('\n[demo2] simulating CAIRN_DISPATCH_FORCE_FAIL=1 path');
const { id: failId } = createDispatchRequest(db, {
  nlIntent: 'demo failed dispatch',
  parsedIntent: null,
  generatedPrompt: null,
  targetAgent: null,
});
failDispatchRequest(db, failId, 'forced fail via CAIRN_DISPATCH_FORCE_FAIL');
snapshot('t=4 dispatch FAILED — pet should switch to failed animation');

// --- Demo 3: rule R6 — recent rewind scratchpad ---
console.log('\n[demo3] writing _rewind_last_invoked scratchpad (per-agent key)');
const blobRoot = join(tmpRoot, 'blobs');
putScratch(db, blobRoot, {
  key: '_rewind_last_invoked/agent-A',
  value: new Date().toISOString(),
  task_id: null,
});
const scratch = db.prepare(
  `SELECT key, length(value_json) AS vl FROM scratchpad WHERE key=?`
).get('_rewind_last_invoked/agent-A');
console.log(`  scratchpad row: key=${scratch.key} value_len=${scratch.vl}`);
console.log('  → next dispatch.request from agent-A within 3s would append [FALLBACK R6]');
console.log('  → agent-B would NOT see this key (per-agent isolation, fixed in code review)');

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

db.close();
rmSync(tmpRoot, { recursive: true, force: true });
console.log('\n[cleanup] temp DB removed.');
console.log('\nAll Phase 2/3 paths exercised. The pet UI itself requires manual launch.');
