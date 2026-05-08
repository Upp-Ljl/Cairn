#!/usr/bin/env node
'use strict';

/**
 * Cairn desktop-shell — Quick Slice Day 3 dogfood fixture.
 *
 * Modes (single flag):
 *   --setup    Insert the cairn-demo-* fixture rows, idempotently.
 *              (Runs --cleanup first so re-running --setup is safe.)
 *   --cleanup  Delete every row whose id / task_id / blocker_id /
 *              outcome_id / agent_id begins with "cairn-demo-".
 *   --status   Print fixture row counts per table.
 *
 * Constraints (PRODUCT.md v3 §12 D9 + plan):
 *   - Writes only into ~/.cairn/cairn.db, only into the 6 host-level
 *     state tables relevant to the Quick Slice panel.
 *   - Uses the real schema columns from packages/desktop-shell/SCHEMA_NOTES.md
 *     (e.g. tasks.task_id, blockers.raised_at, conflicts.id, etc.).
 *   - Every fixture id is namespaced with the prefix "cairn-demo-" so
 *     cleanup is a single LIKE filter and there is zero risk of
 *     deleting real data.
 *   - The Cairn agent / desktop UI never invokes this script
 *     automatically; it is for local dogfood only.
 *
 * Usage:
 *   node scripts/mvp-quick-slice-dogfood.mjs --setup
 *   node scripts/mvp-quick-slice-dogfood.mjs --status
 *   node scripts/mvp-quick-slice-dogfood.mjs --cleanup
 *
 * The script is intentionally NOT run as part of `npm test` or any
 * automated suite — invoke explicitly when dogfooding.
 */

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// Reuse the daemon's better-sqlite3 install — desktop-shell's own copy
// is rebuilt for Electron's Node ABI and won't load under plain Node.
// The daemon copy is plain-Node and works fine here.
const Database = require('../../daemon/node_modules/better-sqlite3');

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const MODES = ['--setup', '--cleanup', '--status'];
const mode = process.argv.slice(2).find(a => MODES.includes(a));
if (!mode) {
  console.error('usage: mvp-quick-slice-dogfood.mjs [--setup|--cleanup|--status]');
  process.exit(2);
}

const DB_PATH = path.join(os.homedir(), '.cairn', 'cairn.db');
if (!fs.existsSync(DB_PATH)) {
  console.error(`db not found at ${DB_PATH} — run \`cairn install\` first`);
  process.exit(2);
}

// Open RW. We do not take a separate read handle; better-sqlite3 + WAL
// is fine for the small ops here.
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Sanity check: target tables present?
const tables = new Set(
  db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(r => r.name)
);
const REQUIRED = ['processes', 'tasks', 'blockers', 'outcomes', 'conflicts', 'dispatch_requests'];
for (const t of REQUIRED) {
  if (!tables.has(t)) {
    console.error(`missing table: ${t} — DB is older than v0.1`);
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// Namespacing: every fixture id starts with this prefix
// ---------------------------------------------------------------------------

const P = 'cairn-demo-'; // prefix

const FIXTURE = {
  agents: [
    { agent_id: P + 'agent-cc',     agent_type: 'claude-code', capabilities: '["edit","spawn"]' },
    { agent_id: P + 'agent-cursor', agent_type: 'cursor',      capabilities: '["edit"]'         },
  ],
  tasks: [
    {
      task_id: P + 'task-blocked',
      intent: '[demo] auth refactor — blocked on deprecation flag question',
      state: 'BLOCKED',
      created_by_agent_id: P + 'agent-cc',
    },
    {
      task_id: P + 'task-failed',
      intent: '[demo] frontend useAuth refactor — outcome FAILED',
      state: 'FAILED',
      created_by_agent_id: P + 'agent-cursor',
    },
    {
      task_id: P + 'task-running',
      intent: '[demo] tests_pass criteria evaluation in progress',
      state: 'RUNNING',
      created_by_agent_id: P + 'agent-cc',
    },
  ],
  blocker: {
    blocker_id: P + 'blocker-1',
    task_id: P + 'task-blocked',
    question: '[demo] keep the legacy sync API behind a deprecation flag, or drop it now?',
    raised_by: P + 'agent-cc',
  },
  outcome: {
    outcome_id: P + 'outcome-1',
    task_id: P + 'task-failed',
    criteria_json: JSON.stringify([
      { primitive: 'tests_pass', args: { target: 'packages/web' } },
    ]),
    status: 'FAIL',
    evaluation_summary: '[demo] tests_pass: 12 failed (useAuth.spec.ts: TokenStatus mismatch)',
  },
  conflict: {
    id: P + 'conflict-1',
    conflict_type: 'FILE_OVERLAP',
    agent_a: P + 'agent-cc',
    agent_b: P + 'agent-cursor',
    paths_json: JSON.stringify(['shared/types.ts']),
    summary: '[demo] both agents touched shared/types.ts within 30s',
    status: 'OPEN',
  },
  dispatch: {
    id: P + 'dispatch-1',
    nl_intent: '[demo] please reconcile shared/types.ts naming with backend convention',
    status: 'PENDING',
    target_agent: P + 'agent-cc',
  },
};

// ---------------------------------------------------------------------------
// Cleanup (single LIKE per table)
// ---------------------------------------------------------------------------

function cleanupTx(d) {
  let total = 0;
  // Delete in dependency-friendly order (children first), though FKs
  // would CASCADE on tasks anyway.
  total += d.prepare(`DELETE FROM blockers          WHERE blocker_id LIKE ? OR task_id LIKE ?`)
    .run(P + '%', P + '%').changes;
  total += d.prepare(`DELETE FROM outcomes          WHERE outcome_id LIKE ? OR task_id LIKE ?`)
    .run(P + '%', P + '%').changes;
  total += d.prepare(`DELETE FROM conflicts         WHERE id LIKE ? OR agent_a LIKE ? OR agent_b LIKE ?`)
    .run(P + '%', P + '%', P + '%').changes;
  total += d.prepare(`DELETE FROM dispatch_requests WHERE id LIKE ? OR target_agent LIKE ? OR task_id LIKE ?`)
    .run(P + '%', P + '%', P + '%').changes;
  total += d.prepare(`DELETE FROM tasks             WHERE task_id LIKE ? OR created_by_agent_id LIKE ?`)
    .run(P + '%', P + '%').changes;
  total += d.prepare(`DELETE FROM processes         WHERE agent_id LIKE ?`)
    .run(P + '%').changes;
  return total;
}

function doCleanup() {
  const tx = db.transaction(cleanupTx);
  const total = tx(db);
  console.log(`cleanup: removed ${total} cairn-demo-* row(s)`);
}

// ---------------------------------------------------------------------------
// Setup (idempotent: cleans first, then inserts)
// ---------------------------------------------------------------------------

function setupTx(d) {
  const now = Date.now();

  // processes
  const insProc = d.prepare(`
    INSERT INTO processes
      (agent_id, agent_type, capabilities, status, registered_at, last_heartbeat, heartbeat_ttl)
    VALUES (?, ?, ?, 'ACTIVE', ?, ?, 60000)
  `);
  for (const a of FIXTURE.agents) {
    insProc.run(a.agent_id, a.agent_type, a.capabilities, now, now);
  }

  // tasks (rely on default for parent_task_id NULL; metadata_json NULL too)
  const insTask = d.prepare(`
    INSERT INTO tasks
      (task_id, intent, state, parent_task_id, created_at, updated_at, created_by_agent_id, metadata_json)
    VALUES (?, ?, ?, NULL, ?, ?, ?, NULL)
  `);
  for (const t of FIXTURE.tasks) {
    insTask.run(t.task_id, t.intent, t.state, now, now, t.created_by_agent_id);
  }

  // blocker (OPEN, on the BLOCKED task)
  const b = FIXTURE.blocker;
  d.prepare(`
    INSERT INTO blockers
      (blocker_id, task_id, question, context_keys, status, raised_by, raised_at)
    VALUES (?, ?, ?, NULL, 'OPEN', ?, ?)
  `).run(b.blocker_id, b.task_id, b.question, b.raised_by, now);

  // outcome (FAIL, on the FAILED task)
  const o = FIXTURE.outcome;
  d.prepare(`
    INSERT INTO outcomes
      (outcome_id, task_id, criteria_json, status, evaluated_at, evaluation_summary,
       grader_agent_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
  `).run(o.outcome_id, o.task_id, o.criteria_json, o.status, now, o.evaluation_summary, now, now);

  // conflict (OPEN)
  const c = FIXTURE.conflict;
  d.prepare(`
    INSERT INTO conflicts
      (id, detected_at, conflict_type, agent_a, agent_b, paths_json, summary, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'OPEN')
  `).run(c.id, now, c.conflict_type, c.agent_a, c.agent_b, c.paths_json, c.summary);

  // dispatch (PENDING)
  const dr = FIXTURE.dispatch;
  d.prepare(`
    INSERT INTO dispatch_requests
      (id, nl_intent, parsed_intent, context_keys, generated_prompt, target_agent,
       status, created_at, confirmed_at, task_id)
    VALUES (?, ?, NULL, NULL, NULL, ?, 'PENDING', ?, NULL, NULL)
  `).run(dr.id, dr.nl_intent, dr.target_agent, now);
}

function doSetup() {
  // Cleanup first → idempotent re-runs
  const tx = db.transaction(() => {
    cleanupTx(db);
    setupTx(db);
  });
  tx();
  console.log('setup: inserted fixtures');
  doStatus();
}

// ---------------------------------------------------------------------------
// Status (per-table fixture count)
// ---------------------------------------------------------------------------

function doStatus() {
  const counts = {};
  counts.processes         = db.prepare(`SELECT COUNT(*) AS c FROM processes         WHERE agent_id   LIKE ?`).get(P + '%').c;
  counts.tasks             = db.prepare(`SELECT COUNT(*) AS c FROM tasks             WHERE task_id    LIKE ?`).get(P + '%').c;
  counts.blockers          = db.prepare(`SELECT COUNT(*) AS c FROM blockers          WHERE blocker_id LIKE ?`).get(P + '%').c;
  counts.outcomes          = db.prepare(`SELECT COUNT(*) AS c FROM outcomes          WHERE outcome_id LIKE ?`).get(P + '%').c;
  counts.conflicts         = db.prepare(`SELECT COUNT(*) AS c FROM conflicts         WHERE id         LIKE ?`).get(P + '%').c;
  counts.dispatch_requests = db.prepare(`SELECT COUNT(*) AS c FROM dispatch_requests WHERE id         LIKE ?`).get(P + '%').c;

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`status: cairn-demo-* rows in ${DB_PATH}`);
  for (const [t, c] of Object.entries(counts)) {
    console.log(`  ${t.padEnd(20)} ${c}`);
  }
  console.log(`  ${'TOTAL'.padEnd(20)} ${total}`);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

try {
  if (mode === '--setup')   doSetup();
  if (mode === '--cleanup') doCleanup();
  if (mode === '--status')  doStatus();
} finally {
  db.close();
}
