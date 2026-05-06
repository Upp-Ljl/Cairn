// Live pet demo — writes tagged rows into ~/.cairn/cairn.db so the running
// Electron pet animates each state in turn. All rows are tagged with
// id/agent_id prefixes that are cleaned up at exit.
//
// Run while the pet is running:
//   node packages/desktop-shell/dogfood-live-pet-demo.mjs

import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// desktop-shell's better-sqlite3 is compiled for Electron's Node ABI (128),
// but plain `node` here is ABI 137. Resolve from daemon's node_modules instead,
// which is built for the system Node version.
const daemonAnchor = pathToFileURL(
  join(process.cwd().includes('cairn') ? '' : '', 'D:/lll/cairn/packages/daemon/package.json')
).href;
const require = createRequire(daemonAnchor);
const Database = require('better-sqlite3');

const DB = join(homedir(), '.cairn', 'cairn.db');
const TAG = 'cairn-demo-';

const db = new Database(DB);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function cleanup() {
  // Be aggressive on cleanup so we never leave demo rows behind.
  try { db.prepare(`DELETE FROM scratchpad WHERE key LIKE ?`).run(TAG + '%'); } catch {}
  try { db.prepare(`DELETE FROM dispatch_requests WHERE id LIKE ?`).run(TAG + '%'); } catch {}
  try { db.prepare(`DELETE FROM conflicts WHERE id LIKE ? OR agent_a LIKE ? OR agent_b LIKE ?`)
        .run(TAG + '%', TAG + '%', TAG + '%'); } catch {}
  try { db.prepare(`DELETE FROM processes WHERE agent_id LIKE ?`).run(TAG + '%'); } catch {}
}

process.on('SIGINT', () => { console.log('\n[abort] cleaning up...'); cleanup(); db.close(); process.exit(130); });

// Always clean any leftovers from a prior run before starting.
cleanup();

console.log('==========================================');
console.log('  CAIRN PET LIVE DEMO');
console.log('  Watch the pet in the lower-right of your screen.');
console.log('  All demo rows are tagged with prefix:', TAG);
console.log('==========================================\n');

// ---------------------------------------------------------------------------
// Step 1 — baseline (5s)
// ---------------------------------------------------------------------------
console.log('[step 1/5] BASELINE (5s) — pet should be in its current resting state.');
console.log('           (whatever animation is showing right now is your starting point)');
await sleep(5000);

// ---------------------------------------------------------------------------
// Step 2 — OPEN conflict → REVIEW animation (red)
// ---------------------------------------------------------------------------
console.log('\n[step 2/5] INSERT OPEN conflict → pet should turn RED (review animation, 8s)');
const conflictId = TAG + 'conflict-1';
db.prepare(`
  INSERT INTO conflicts (id, detected_at, conflict_type, agent_a, agent_b, paths_json, summary, status)
  VALUES (?, ?, 'FILE_OVERLAP', ?, ?, ?, ?, 'OPEN')
`).run(
  conflictId,
  Date.now(),
  TAG + 'agent-A',
  TAG + 'agent-B',
  JSON.stringify(['demo/foo.ts', 'demo/bar.ts']),
  'Live demo: simulated cross-agent overlap',
);
console.log('           inserted conflict id=' + conflictId);
await sleep(8000);

// ---------------------------------------------------------------------------
// Step 3 — UPDATE conflict to RESOLVED → review clears
// ---------------------------------------------------------------------------
console.log('\n[step 3/5] RESOLVE the conflict (Inspector "Resolve" simulation, 6s)');
console.log('           pet should leave review animation and fall to idle/running.');
const r = db.prepare(`
  UPDATE conflicts
     SET status='RESOLVED', resolved_at=?, resolution=?
   WHERE id=? AND status IN ('OPEN','PENDING_REVIEW')
`).run(Date.now(), 'live demo manual resolve', conflictId);
console.log('           UPDATE changes=' + r.changes + ' (1 = resolved)');
await sleep(6000);

// ---------------------------------------------------------------------------
// Step 4 — FAILED dispatch → FAILED animation (5s window)
// ---------------------------------------------------------------------------
console.log('\n[step 4/5] INSERT FAILED dispatch_request → pet should switch to FAILED animation');
console.log('           (animation auto-fades after 5s — watch closely)');
const failId = TAG + 'disp-fail';
db.prepare(`
  INSERT INTO dispatch_requests (id, nl_intent, parsed_intent, context_keys,
    generated_prompt, target_agent, status, created_at, confirmed_at)
  VALUES (?, ?, NULL, NULL, NULL, NULL, 'FAILED', ?, NULL)
`).run(
  failId,
  'live demo: forced failed dispatch',
  Date.now(),
);
console.log('           inserted dispatch id=' + failId + ' status=FAILED');
await sleep(6000);

// ---------------------------------------------------------------------------
// Step 5 — CONFIRMED dispatch → JUMPING (one-shot)
// ---------------------------------------------------------------------------
console.log('\n[step 5/5] INSERT CONFIRMED dispatch_request → pet should JUMP (one-shot, 5s)');
const confirmId = TAG + 'disp-ok';
db.prepare(`
  INSERT INTO dispatch_requests (id, nl_intent, parsed_intent, context_keys,
    generated_prompt, target_agent, status, created_at, confirmed_at)
  VALUES (?, ?, NULL, NULL, ?, NULL, 'CONFIRMED', ?, ?)
`).run(
  confirmId,
  'live demo: simulated confirm',
  'demo prompt',
  Date.now(),
  Date.now(),
);
console.log('           inserted dispatch id=' + confirmId + ' status=CONFIRMED');
await sleep(5000);

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
console.log('\n[cleanup] removing all demo-tagged rows from your real DB...');
cleanup();
db.close();
console.log('[done] pet should return to its baseline resting state.');
console.log('       Run `cairn.conflict.list` / `cairn.dispatch.*` later to confirm DB is clean.');
