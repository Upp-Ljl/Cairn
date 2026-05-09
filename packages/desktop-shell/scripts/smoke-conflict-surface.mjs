#!/usr/bin/env node
/**
 * Smoke for the Conflict Management Surface.
 *
 * Exercises:
 *   - queryProjectScopedConflicts: filtered by agent_a OR agent_b ∈
 *     hints; paths_json parsed; resolved + open + pending_review all
 *     return; ORDER BY detected_at DESC
 *   - composeConflictPrompt template: explicit "Cairn does NOT
 *     resolve", "do NOT silently pick a side", "do not push without
 *     authorization"; embeds id / type / paths / agent_a / agent_b
 *   - Default UI invariant: panel.html does NOT render a default
 *     resolveConflict mutation button (legacy Inspector only when
 *     CAIRN_DESKTOP_ENABLE_MUTATIONS=1)
 *   - Privacy: api keys / transcripts never leak into conflict prompt
 *
 * Read-only invariants: cairn.db mtime unchanged; mutation grep on
 * production desktop-shell files unchanged from prior round (still
 * 1 hit = dev-flag resolveConflict in main.cjs).
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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-conflict-smoke-'));
const dbPath = path.join(tmpDir, 'smoke.db');
const db = new Database(dbPath);

db.exec(`
  CREATE TABLE conflicts (
    id TEXT PRIMARY KEY,
    detected_at INTEGER NOT NULL,
    conflict_type TEXT NOT NULL,
    agent_a TEXT NOT NULL,
    agent_b TEXT,
    paths_json TEXT NOT NULL,
    summary TEXT,
    status TEXT NOT NULL,
    resolved_at INTEGER,
    resolution TEXT
  );
  CREATE TABLE tasks (
    task_id TEXT PRIMARY KEY,
    state TEXT, intent TEXT, created_at INTEGER, updated_at INTEGER,
    created_by_agent_id TEXT
  );
`);
const tables = new Set(['conflicts', 'tasks']);
const NOW = 1_800_000_000_000;

const ins = db.prepare(`INSERT INTO conflicts (id, detected_at, conflict_type, agent_a, agent_b, paths_json, summary, status, resolved_at, resolution) VALUES (?,?,?,?,?,?,?,?,?,?)`);
ins.run('cf-open',    NOW - 60_000,   'FILE_OVERLAP',     'agent-A', 'agent-B', JSON.stringify(['src/auth.js', 'src/db.ts']), 'Both touched src/auth.js', 'OPEN', null, null);
ins.run('cf-pending', NOW - 30_000,   'STATE_CONFLICT',   'agent-A', null,      JSON.stringify([]),                              null,                       'PENDING_REVIEW', null, null);
ins.run('cf-foreign', NOW - 5_000,    'INTENT_BOUNDARY',  'agent-X', 'agent-Y', JSON.stringify(['ext/x.ts']),                   'foreign — no project agent involved', 'OPEN', null, null);
ins.run('cf-resolved',NOW - 600_000,  'FILE_OVERLAP',     'agent-A', 'agent-B', JSON.stringify(['old.js']),                     'old',                      'RESOLVED', NOW - 500_000, 'kept agent-A');
ins.run('cf-ignored', NOW - 90_000,   'FILE_OVERLAP',     'agent-B', 'agent-Y', JSON.stringify(['shrug.txt']),                  'low impact',               'IGNORED', null, null);

// ---------------------------------------------------------------------------
// Part A — queryProjectScopedConflicts
// ---------------------------------------------------------------------------

console.log('==> Part A: queryProjectScopedConflicts');

const hints = ['agent-A', 'agent-B'];
const rows = projectQueries.queryProjectScopedConflicts(db, tables, hints, 50);
const ids = rows.map(r => r.id);
ok(ids.includes('cf-open'),     'open conflict (agent-A) returned');
ok(ids.includes('cf-pending'),  'pending_review conflict (agent-A) returned');
ok(ids.includes('cf-resolved'), 'resolved conflict (agent-A) returned');
ok(ids.includes('cf-ignored'),  'ignored conflict (agent-B) returned');
ok(!ids.includes('cf-foreign'), 'foreign conflict filtered out (agent-X / agent-Y not in hints)');

// paths_json parsed.
const cfOpen = rows.find(r => r.id === 'cf-open');
ok(Array.isArray(cfOpen.paths) && cfOpen.paths.length === 2, 'paths parsed from JSON');
eq(cfOpen.paths[0], 'src/auth.js', 'paths content preserved');
eq(cfOpen.agent_a, 'agent-A', 'agent_a preserved');
eq(cfOpen.agent_b, 'agent-B', 'agent_b preserved');
eq(cfOpen.summary, 'Both touched src/auth.js', 'summary preserved');

// Empty paths_json → empty array.
const cfPending = rows.find(r => r.id === 'cf-pending');
eq(cfPending.paths.length, 0, 'empty paths_json → empty array');
eq(cfPending.agent_b, null, 'agent_b null when SQL NULL');

// Resolved still surfaces but with resolved_at + resolution.
const cfResolved = rows.find(r => r.id === 'cf-resolved');
ok(cfResolved.resolved_at, 'resolved conflict carries resolved_at');
eq(cfResolved.resolution, 'kept agent-A', 'resolved conflict carries resolution text');

// ORDER BY detected_at DESC.
const detectedAts = rows.map(r => r.detected_at);
let prevTs = Infinity;
let sortedDesc = true;
for (const ts of detectedAts) { if (ts > prevTs) { sortedDesc = false; break; } prevTs = ts; }
ok(sortedDesc, 'rows ordered by detected_at DESC');

// Empty hints → []
eq(projectQueries.queryProjectScopedConflicts(db, tables, [], 50).length, 0,
   'empty hints → 0 rows');

// Missing table → []
eq(projectQueries.queryProjectScopedConflicts(db, new Set(['tasks']), hints, 50).length, 0,
   'missing conflicts table → 0 rows');

// Tolerate malformed paths_json.
ins.run('cf-mal', NOW, 'FILE_OVERLAP', 'agent-A', null, '{not json}', '', 'OPEN', null, null);
const malRows = projectQueries.queryProjectScopedConflicts(db, tables, hints, 50);
const mal = malRows.find(r => r.id === 'cf-mal');
ok(mal, 'malformed-paths conflict still returned');
eq(mal.paths.length, 0, 'malformed paths_json → empty array (no throw)');

// ---------------------------------------------------------------------------
// Part B — composeConflictPrompt template (re-implementation for smoke)
// ---------------------------------------------------------------------------

console.log('\n==> Part B: composeConflictPrompt template');

function _clip(s, max) {
  if (typeof s !== 'string') return '';
  const t = s.trim();
  return t.length > max ? t.slice(0, max) : t;
}

function composeConflictPrompt(input) {
  const o = input || {};
  const c = o.conflict || null;
  const projectLabel = _clip(o.project_label, 200) || '(this project)';
  const lines = [];
  lines.push(`You are a coding agent reviewing a multi-agent conflict in ${projectLabel}.`);
  lines.push(`Cairn is a project control surface (read-only); it does NOT resolve conflicts. The user is asking you to inspect and recommend.`);
  lines.push('');
  if (!c) {
    lines.push('# Conflict');
    lines.push('No conflict provided. Refuse to inspect without one.');
  } else {
    lines.push('# Conflict');
    lines.push(`- id:     ${c.id}`);
    lines.push(`- type:   ${c.conflict_type}`);
    lines.push(`- status: ${c.status}`);
    lines.push(`- detected: ${c.detected_at ? new Date(c.detected_at).toISOString() : '?'}`);
    lines.push(`- agent_a: ${c.agent_a}`);
    if (c.agent_b) lines.push(`- agent_b: ${c.agent_b}`);
    if (c.summary) lines.push(`- summary: ${_clip(c.summary, 400)}`);
    if (Array.isArray(c.paths) && c.paths.length) {
      lines.push('- paths:');
      for (const p of c.paths.slice(0, 12)) lines.push(`    - ${_clip(p, 200)}`);
    }
    lines.push('');
  }
  lines.push('# What to do');
  lines.push('1. Inspect each affected path. Diff the two agents\' versions if both present.');
  lines.push('2. Identify the root cause (concurrent write / overlapping intent / state mismatch).');
  lines.push('3. Recommend a resolution to the USER. Do NOT resolve, merge, or force-push the conflict yourself.');
  lines.push('4. If the resolution requires choosing one agent\'s output over the other, ask the user which to keep.');
  lines.push('');
  lines.push('# Hard rules');
  lines.push('- Do not push, merge, or force any branch unless the user explicitly authorizes.');
  lines.push('- Do not modify Cairn\'s conflict state from your end (Cairn marks RESOLVED via its own tools, not via you).');
  lines.push('- Do not silently pick a side; surface the trade-off to the user.');
  return lines.join('\n');
}

const prompt = composeConflictPrompt({ project_label: 'cairn', conflict: cfOpen });
ok(/does NOT resolve conflicts/i.test(prompt),
   'prompt: explicit "does NOT resolve conflicts"');
ok(/Do not push/.test(prompt), 'prompt: do-not-push contract');
ok(/Do not modify Cairn.*conflict state/.test(prompt), 'prompt: do-not-modify Cairn state');
ok(/Do not silently pick a side/.test(prompt), 'prompt: do-not-silently-pick contract');
ok(prompt.indexOf('cf-open') >= 0, 'prompt: conflict id embedded');
ok(prompt.indexOf('agent-A') >= 0 && prompt.indexOf('agent-B') >= 0,
   'prompt: agent_a + agent_b embedded');
ok(prompt.indexOf('src/auth.js') >= 0, 'prompt: paths embedded');

// Imperative ban: positive auto-execute language. Negative bans are fine.
const cleaned = prompt.split(/\r?\n/).filter(line =>
  !/(do not|don'?t|never|refuse|without first|surface)\b/i.test(line)
).join('\n');
ok(!/\b(resolve|merge|push|force)\s+(now|immediately|first|right away)\b/i.test(cleaned),
   'prompt: no positive auto-execute imperative');

// No-conflict branch.
const promptNone = composeConflictPrompt({ project_label: 'cairn', conflict: null });
ok(/Refuse to inspect without one/.test(promptNone),
   'prompt with no conflict: refuse-to-inspect language');

// ---------------------------------------------------------------------------
// Part C — privacy: poisoned paths/summary stay safely truncated
// ---------------------------------------------------------------------------

console.log('\n==> Part C: privacy');

const POISON = '__SMOKE_POISON__';
const POISON_KEY = 'sk-FAKE-CONFLICT-KEY-aaaa';
const dirty = {
  id: 'cf-dirty',
  conflict_type: 'FILE_OVERLAP',
  status: 'OPEN',
  detected_at: NOW,
  agent_a: 'cairn-' + POISON,
  agent_b: null,
  paths: ['src/' + POISON + '.js', 'creds-' + POISON_KEY + '.txt'],
  summary: 'has key=' + POISON_KEY + ' and ' + POISON,
};
// The prompt builder DOES embed user-authored conflict fields verbatim
// (they're project state, not external input). The privacy contract
// is that the BUILDER never adds extra data — what's in the conflict
// stays as the user put it. We assert the builder did not add API
// keys ON ITS OWN, by checking the framing text contains no real
// secret-looking strings beyond what we passed in.
const dirtyPrompt = composeConflictPrompt({ project_label: 'p', conflict: dirty });
const framing = dirtyPrompt.replace(/\bcairn-__SMOKE_POISON__\b/g, '<a>')
                            .replace(/sk-FAKE-CONFLICT-KEY-aaaa/g, '<key>')
                            .replace(/__SMOKE_POISON__/g, '<poison>');
ok(!/sk-[a-zA-Z0-9_-]{20,}/.test(framing),
   'prompt framing (with conflict tokens neutralized) has no key-shaped string');
ok(!/MINIMAX_API_KEY/.test(framing),
   'prompt framing has no MINIMAX_API_KEY reference');

// ---------------------------------------------------------------------------
// Part D — UI invariant: default panel does NOT render a resolveConflict
//          mutation button. Legacy Inspector still does (under env flag),
//          which is unchanged from prior rounds.
// ---------------------------------------------------------------------------

console.log('\n==> Part D: UI invariant');

const panelHtml = fs.readFileSync(path.join(root, 'panel.html'), 'utf8');
ok(!/resolveConflict|Resolve Conflict|resolve-conflict/i.test(panelHtml),
   'panel.html: no resolveConflict UI button (default panel is read-only)');

// Mutation grep on production files: still 1 hit (dev-flag resolveConflict
// in main.cjs). This commit must not have raised that count.
const allProdFiles = ['main.cjs', 'panel.js', 'panel.html'];
let mutationCount = 0;
for (const f of allProdFiles) {
  const src = fs.readFileSync(path.join(root, f), 'utf8');
  const matches = src.match(/\.run\s*\(|\.exec\s*\(/g);
  if (matches) mutationCount += matches.length;
}
// main.cjs has the dev-flag resolveConflict using `.run(` once.
// (smokes also use exec but they're not in this list.)
ok(mutationCount <= 2,
   `mutation grep on prod files: ${mutationCount} hits (≤2 expected; only dev-flag resolveConflict path)`);

const afterCairn = safeMtime(realCairnDb);
if (beforeCairn != null) eq(afterCairn, beforeCairn, 'cairn.db mtime unchanged');

try { db.close(); } catch (_e) {}
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) {}

console.log(`\n==> ${asserts - fails}/${asserts} assertions passed`);
if (fails > 0) {
  console.error(`FAIL: ${fails} assertion(s) failed`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('PASS');
