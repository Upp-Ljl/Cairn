#!/usr/bin/env node
/**
 * Dogfood: cairn.session.name — end-to-end session naming flow.
 *
 * Exercises the full pipeline:
 *   1. Open a real Cairn DB in a temp dir.
 *   2. Write a session name via toolSetSessionName (simulating what
 *      cairn.session.name MCP call does).
 *   3. Build an activityFromMcpRow with the same DB handle passed in opts.db.
 *   4. Assert display_name == the human name (not hex).
 *   5. Assert fallback still works when no session name is set.
 *   6. Cleanup.
 *
 * Strict read-only w.r.t. the real ~/.cairn/cairn.db — we use a temp DB.
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const daemonRoot = path.resolve(root, '..', 'daemon');

// We open the DB via better-sqlite3 directly so this dogfood doesn't
// depend on the mcp-server being built.  The toolSetSessionName logic
// (putScratch) is replicated inline to keep the dogfood self-contained.
const Database = require(path.join(daemonRoot, 'node_modules', 'better-sqlite3'));
const activity = require(path.join(root, 'agent-activity.cjs'));

let asserts = 0, fails = 0;
const failures = [];
function ok(cond, label) {
  asserts++;
  if (cond) console.log(`  ok    ${label}`);
  else { fails++; failures.push(label); console.log(`  FAIL  ${label}`); }
}
function eq(a, b, label) {
  ok(a === b, `${label} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);
}

// ---------------------------------------------------------------------------
// Setup: temp DB with migrations
// ---------------------------------------------------------------------------

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-dogfood-session-naming-'));
const dbPath = path.join(tmpDir, 'cairn.db');

// Build the mcp-server dist path (required for openDatabase / runMigrations).
// We expect the daemon to be built already (tests pass ⟹ it is).
let db;
try {
  // Open DB and run migrations via the daemon's built modules.
  // Use pathToFileURL so Windows absolute paths become valid file:// URLs.
  const { openDatabase } = await import(
    pathToFileURL(path.join(daemonRoot, 'dist', 'storage', 'db.js')).href
  );
  const { runMigrations } = await import(
    pathToFileURL(path.join(daemonRoot, 'dist', 'storage', 'migrations', 'runner.js')).href
  );
  const { ALL_MIGRATIONS } = await import(
    pathToFileURL(path.join(daemonRoot, 'dist', 'storage', 'migrations', 'index.js')).href
  );
  db = openDatabase(dbPath);
  runMigrations(db, ALL_MIGRATIONS);
} catch (e) {
  console.error(`SKIP: could not open daemon DB (${e.message}) — is daemon built?`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(0);
}

const SESSION_NAME_KEY_PREFIX = 'session_name/';
const AGENT_ID = 'cairn-session-dogfood01';
const HUMAN_NAME = 'dogfood: session naming e2e test';

// ---------------------------------------------------------------------------
// Step 1: Write session name to scratchpad (simulates cairn.session.name)
// ---------------------------------------------------------------------------

console.log('\n==> Step 1: write session name to scratchpad');

const key = SESSION_NAME_KEY_PREFIX + AGENT_ID;
const value = JSON.stringify({ name: HUMAN_NAME, set_at: Date.now(), set_by: 'agent' });
const now = Date.now();
db.prepare(
  "INSERT OR REPLACE INTO scratchpad (key, value_json, created_at, updated_at) VALUES (?, ?, ?, ?)"
).run(key, value, now, now);

// Verify it's there.
const row = db.prepare("SELECT value_json FROM scratchpad WHERE key = ?").get(key);
ok(row != null, 'scratchpad row inserted');
const parsed = row ? JSON.parse(row.value_json) : null;
eq(parsed && parsed.name, HUMAN_NAME, 'scratchpad value_json.name matches');

// ---------------------------------------------------------------------------
// Step 2: activityFromMcpRow with db — display_name is human name
// ---------------------------------------------------------------------------

console.log('\n==> Step 2: activityFromMcpRow with db → human name');

const mcpRow = {
  agent_id: AGENT_ID,
  agent_type: 'mcp-server',
  status: 'ACTIVE',
  computed_state: 'ACTIVE',
  last_heartbeat: Date.now() - 2000,
  heartbeat_ttl: 60000,
  registered_at: Date.now() - 10000,
  capabilities: ['cwd:/fake/dogfood', 'git_root:/fake/dogfood', 'pid:12345', 'session:dogfood01'],
  owns_tasks: null,
};

const namedActivity = activity.activityFromMcpRow(mcpRow, null, { attribution: null, db });
eq(namedActivity.display_name, HUMAN_NAME,
   'activityFromMcpRow with db: display_name is human name');
ok(!namedActivity.display_name.includes('dogfood01'),
   'activityFromMcpRow with db: display_name has no hex agent_id fragment');

// ---------------------------------------------------------------------------
// Step 3: activityFromMcpRow without db — falls back to hex truncation
// ---------------------------------------------------------------------------

console.log('\n==> Step 3: activityFromMcpRow without db → hex fallback');

const fallbackActivity = activity.activityFromMcpRow(mcpRow, null, { attribution: null });
ok(fallbackActivity.display_name !== HUMAN_NAME,
   'fallback: display_name is NOT the human name');
// AGENT_ID = 'cairn-session-dogfood01' (22 chars) → truncated to 18: 'cairn-session-dogf'
ok(fallbackActivity.display_name.startsWith('cairn-session-'),
   `fallback: display_name starts with cairn-session- (got: ${fallbackActivity.display_name})`);

// ---------------------------------------------------------------------------
// Step 4: deriveDisplayName direct
// ---------------------------------------------------------------------------

console.log('\n==> Step 4: deriveDisplayName');

eq(activity.deriveDisplayName(db, AGENT_ID), HUMAN_NAME,
   'deriveDisplayName returns human name');
eq(activity.deriveDisplayName(db, 'cairn-session-unknown'), null,
   'deriveDisplayName returns null for unknown agent');
eq(activity.deriveDisplayName(null, AGENT_ID), null,
   'deriveDisplayName returns null when db is null');

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

db.close();
fs.rmSync(tmpDir, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n==> ${asserts - fails}/${asserts} assertions passed`);
if (fails > 0) {
  console.error(`FAIL: ${fails} assertion(s) failed`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('PASS');
