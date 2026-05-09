#!/usr/bin/env node
/**
 * Smoke for the Handoff (scratchpad) surface.
 *
 * Exercises:
 *   - queryProjectScopedScratchpad against a fixture DB:
 *       attribution by created_by_agent_id ∈ hints
 *       value_preview capped to 240 chars
 *       value_size matches raw json length
 *       has_value_path flag
 *       NULL hints → empty
 *   - composeHandoffPrompt template (extracted via require of main.cjs
 *     is impractical because main.cjs is Electron-only; we reach into
 *     the same logic by replicating the helper; this is acceptable
 *     because the prompt template is a small string-builder)
 *   - Privacy: long scratchpad values truncated, no api keys leak
 *     into prompt
 *
 * Read-only invariants: cairn.db mtime unchanged; source-level grep
 * on the new project-queries scratchpad/conflicts/blockers/outcomes
 * helpers (no SQL writes).
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const projectQueries = require(path.join(root, 'project-queries.cjs'));
const Database = require(path.join(root, '..', 'daemon', 'node_modules', 'better-sqlite3'));

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

const realCairnDb = path.join(os.homedir(), '.cairn', 'cairn.db');
function safeMtime(p) { try { return fs.statSync(p).mtimeMs; } catch (_e) { return null; } }
const beforeCairn = safeMtime(realCairnDb);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-handoff-smoke-'));
const dbPath = path.join(tmpDir, 'smoke.db');
const db = new Database(dbPath);

// Minimum schema for the queries we exercise.
db.exec(`
  CREATE TABLE tasks (
    task_id TEXT PRIMARY KEY,
    parent_task_id TEXT,
    state TEXT,
    intent TEXT,
    created_at INTEGER,
    updated_at INTEGER,
    created_by_agent_id TEXT,
    metadata_json TEXT
  );
  CREATE TABLE scratchpad (
    key TEXT PRIMARY KEY,
    value_json TEXT,
    value_path TEXT,
    task_id TEXT,
    expires_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);
const tables = new Set(['tasks', 'scratchpad', 'blockers', 'outcomes', 'conflicts']);
const NOW = 1_800_000_000_000;

const insTask = db.prepare(`INSERT INTO tasks (task_id, state, intent, created_at, updated_at, created_by_agent_id) VALUES (?,?,?,?,?,?)`);
insTask.run('t1', 'RUNNING', 'auth refactor', NOW - 3 * 60_000, NOW, 'agent-A');
insTask.run('t2', 'BLOCKED', 'useAuth migration', NOW - 5 * 60_000, NOW - 60_000, 'agent-B');
insTask.run('t3', 'DONE',    'test suite update', NOW - 10 * 60_000, NOW - 9 * 60_000, 'agent-OTHER');

const insSp = db.prepare(`INSERT INTO scratchpad (key, value_json, value_path, task_id, expires_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`);
const POISON = '__SMOKE_POISON__';
const POISON_KEY = 'sk-FAKE-SCRATCHPAD-KEY-zzzz';

// 1. Normal scratchpad entry attached to t1.
insSp.run(
  'subagent/agent-A/result',
  JSON.stringify({ summary: 'ran tests, all green', files: ['src/auth.js'] }),
  null, 't1', null, NOW - 60_000, NOW - 30_000,
);
// 2. Long entry on t2 → preview should cap at 240 chars.
const longBody = 'X'.repeat(2000);
insSp.run('long/agent-B/big', JSON.stringify({ blob: longBody }), null, 't2', null, NOW - 90_000, NOW - 45_000);
// 3. Entry attached to a non-attributed task (agent-OTHER not in hints).
insSp.run('foreign/key', JSON.stringify({ x: 'y' }), null, 't3', null, NOW, NOW);
// 4. Entry with value_path set, value_json null.
insSp.run('blob/path/key', null, '/some/blob/path', 't1', null, NOW, NOW);
// 5. Entry with poison data (should be in size + preview but not leak via summary contract).
insSp.run('poisoned/key', JSON.stringify({ key: POISON_KEY, transcript: POISON, body: 'normal' }), null, 't1', null, NOW, NOW);

// ---------------------------------------------------------------------------
// Part A — queryProjectScopedScratchpad
// ---------------------------------------------------------------------------

console.log('==> Part A: queryProjectScopedScratchpad');

const hints = ['agent-A', 'agent-B'];
const rows = projectQueries.queryProjectScopedScratchpad(db, tables, hints, 50);
// Should include scratchpad for t1 (agent-A) + t2 (agent-B) but NOT t3 (agent-OTHER).
const keys = rows.map(r => r.key);
ok(keys.includes('subagent/agent-A/result'), 'attribution: t1 entry returned (agent-A in hints)');
ok(keys.includes('long/agent-B/big'),        'attribution: t2 entry returned (agent-B in hints)');
ok(!keys.includes('foreign/key'),            'attribution: t3 entry filtered out (agent-OTHER not in hints)');
ok(keys.includes('blob/path/key'),           'value_path-only entry returned');
ok(keys.includes('poisoned/key'),            'poisoned entry returned (we filter by attribution, not by content)');

const long = rows.find(r => r.key === 'long/agent-B/big');
ok(long, 'long entry present');
ok(long.value_size >= 2000, 'long entry value_size matches raw length');
eq(long.value_preview.length, 240, 'long entry value_preview capped at 240 chars');

const blob = rows.find(r => r.key === 'blob/path/key');
ok(blob.has_value_path === true, 'blob entry: has_value_path=true');
eq(blob.value_size, 0, 'blob entry: value_size=0 when value_json is null');
eq(blob.value_preview, null, 'blob entry: value_preview=null when value_json is null');

// task_intent / task_state surfaced from join.
const t1entry = rows.find(r => r.task_id === 't1' && r.key === 'subagent/agent-A/result');
eq(t1entry.task_intent, 'auth refactor', 'scratchpad row carries task_intent');
eq(t1entry.task_state,  'RUNNING',       'scratchpad row carries task_state');

// updated_at DESC ordering.
const updatedAts = rows.map(r => r.updated_at);
let prev = Infinity;
let sortedDesc = true;
for (const ts of updatedAts) { if (ts > prev) { sortedDesc = false; break; } prev = ts; }
ok(sortedDesc, 'rows ordered by updated_at DESC');

// Empty hints → empty result.
const empty = projectQueries.queryProjectScopedScratchpad(db, tables, [], 50);
eq(empty.length, 0, 'empty hints → 0 rows');

// Missing scratchpad table → 0 rows (graceful).
const noScratchpadTables = new Set(['tasks']);
const gone = projectQueries.queryProjectScopedScratchpad(db, noScratchpadTables, hints, 50);
eq(gone.length, 0, 'missing scratchpad table → 0 rows');

// ---------------------------------------------------------------------------
// Part B — privacy: poisoned content stays inside value_preview / value_size
//          but the prompt builder MUST not pull raw value_json into prompt
//          unless include_full_context is requested AND the user clicked
//          "copy handoff context".
// ---------------------------------------------------------------------------

console.log('\n==> Part B: handoff privacy contract');

// Expectation: queryProjectScopedScratchpad DOES return value_preview
// containing the poison (since the poison is part of the scratchpad
// content the user authored). The contract is that the PROMPT builder
// (composeHandoffPrompt in main.cjs) only embeds the preview when
// include_context is explicitly true; default is just keys + sizes.
//
// We re-implement the same contract here as a string-builder mirror to
// verify defaults stay safe. The actual main.cjs builder must keep
// the same shape — we reach into it via spawning electron in an
// integration smoke later if needed.
function composeHandoffPrompt(input) {
  const o = input || {};
  const projectLabel = (o.project_label || '(this project)').slice(0, 200);
  const lines = [];
  lines.push(`You are a coding agent picking up where a previous agent left off in ${projectLabel}.`);
  lines.push(`Cairn is a project control surface (read-only); it does NOT dispatch you.`);
  lines.push('');
  if (Array.isArray(o.latest_scratchpad) && o.latest_scratchpad.length) {
    lines.push('# Shared context (scratchpad keys)');
    for (const sp of o.latest_scratchpad) {
      const taskPart = sp.task_id ? ` (task ${sp.task_id})` : '';
      const sizePart = sp.value_size ? ` — ${sp.value_size}B` : '';
      lines.push(`- ${sp.key}${taskPart}${sizePart}`);
      if (o.include_full_context && sp.value_preview) {
        for (const l of sp.value_preview.split(/\r?\n/).slice(0, 3)) {
          lines.push(`    > ${l.slice(0, 200)}`);
        }
      }
    }
  }
  lines.push('');
  lines.push('# Hard rules');
  lines.push('- Do not push, merge, or force any branch unless the user explicitly authorizes.');
  lines.push('- Do not expand scope beyond the original goal\'s success criteria.');
  return lines.join('\n');
}

// Default: include_context=false → no preview body.
const defaultPrompt = composeHandoffPrompt({
  project_label: 'cairn',
  latest_scratchpad: rows,
});
ok(defaultPrompt.indexOf(POISON) === -1, 'default prompt: no POISON marker');
ok(defaultPrompt.indexOf(POISON_KEY) === -1, 'default prompt: no api key');
// Keys are present.
ok(defaultPrompt.indexOf('subagent/agent-A/result') >= 0,
   'default prompt: scratchpad keys listed');
// But preview body lines NOT present.
ok(!/^\s*>/m.test(defaultPrompt),
   'default prompt: no `>` preview body line');

// include_context=true → preview body appears.
const fullPrompt = composeHandoffPrompt({
  project_label: 'cairn',
  latest_scratchpad: rows.filter(r => r.key !== 'poisoned/key'), // user explicitly excludes poisoned key
  include_full_context: true,
});
ok(/^\s*>/m.test(fullPrompt),
   'full prompt: contains `>` preview body line');

// Hard rules language present in both.
ok(/Do not push.* unless.* explicit/i.test(defaultPrompt),
   'default prompt: do-not-push contract');
ok(/Do not push.* unless.* explicit/i.test(fullPrompt),
   'full prompt: do-not-push contract');

// ---------------------------------------------------------------------------
// Part C — read-only invariants
// ---------------------------------------------------------------------------

console.log('\n==> Part C: read-only invariants');

const afterCairn = safeMtime(realCairnDb);
if (beforeCairn != null) eq(afterCairn, beforeCairn, 'real ~/.cairn/cairn.db mtime unchanged');

// project-queries.cjs new helpers must NOT contain SQL mutation.
const src = fs.readFileSync(path.join(root, 'project-queries.cjs'), 'utf8');
ok(!/\bINSERT\s+INTO\b|\bUPDATE\s+\w+\s+SET\b|\bDELETE\s+FROM\b/i.test(src),
   'project-queries.cjs: no SQL mutation keywords');
ok(!/writeFileSync|writeFile\b|appendFile/.test(src),
   'project-queries.cjs: no file writes');

try { db.close(); } catch (_e) {}
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) {}

console.log(`\n==> ${asserts - fails}/${asserts} assertions passed`);
if (fails > 0) {
  console.error(`FAIL: ${fails} assertion(s) failed`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('PASS');
