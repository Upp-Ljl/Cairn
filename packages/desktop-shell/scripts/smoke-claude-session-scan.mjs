#!/usr/bin/env node
/**
 * Smoke for the Claude Code session-file adapter.
 *
 * Two halves:
 *
 *  Part A — synthetic fixture:
 *    Build a fake `~/.claude/sessions/` directory in os.tmpdir(), write
 *    six session files (busy / idle / stale / dead / malformed / outside),
 *    invoke scanClaudeSessions({ sessionsDir }), and assert each row's
 *    derived status + project attribution. The current node process pid
 *    is used as the "alive" pid; a deliberately-out-of-range pid stands
 *    in for "dead". Project attribution uses two fake project roots so
 *    we can test both the inside and outside case.
 *
 *  Part B — live, read-only:
 *    Call scanClaudeSessions() against the real ~/.claude/sessions, print
 *    a count + redacted summary of the first three rows. Never prints
 *    full sessionId, never reads transcript content, never writes
 *    anything anywhere.
 *
 * Also asserts:
 *    - SQLite mtime did not change while the smoke ran (we never opened
 *      the DB, but a guard catches accidental dependencies).
 *    - The adapter source files do not call .run/.exec or otherwise
 *      attempt to mutate Cairn state.
 *
 * No external deps. No commits. Run with:
 *   node packages/desktop-shell/scripts/smoke-claude-session-scan.mjs
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';

const require = createRequire(import.meta.url);
const adapter = require('../agent-adapters/claude-code-session-scan.cjs');

// ---------------------------------------------------------------------------
// Tiny assert helpers — keep the smoke self-contained, no test framework.
// ---------------------------------------------------------------------------

let asserts = 0;
let fails = 0;
const failures = [];

function ok(cond, label) {
  asserts++;
  if (cond) {
    console.log(`  ok    ${label}`);
  } else {
    fails++;
    failures.push(label);
    console.log(`  FAIL  ${label}`);
  }
}

function eq(actual, expected, label) {
  ok(actual === expected, `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

// ---------------------------------------------------------------------------
// Fixture builder
// ---------------------------------------------------------------------------

function uniqTmpDir(tag) {
  const base = path.join(os.tmpdir(), `cairn-claude-smoke-${tag}-${process.pid}-${Date.now()}`);
  fs.mkdirSync(base, { recursive: true });
  return base;
}

function writeSessionFile(dir, filename, payload) {
  const p = path.join(dir, filename);
  fs.writeFileSync(p, typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8');
  return p;
}

// Pids:
//   ALIVE_PID  = current node process — guaranteed alive on Windows + POSIX.
//   DEAD_PID   = a deliberately implausible 32-bit pid value. Even if some
//                kernel re-uses it, ESRCH at the moment of the test would
//                still fire from the test's perspective; we tolerate either.
const ALIVE_PID = process.pid;
const DEAD_PID  = 0x7FFFFFFF; // 2147483647 — far above any real Windows / Linux pid

// ---------------------------------------------------------------------------
// Part A — synthetic fixture
// ---------------------------------------------------------------------------

console.log('==> Part A: synthetic fixture');

const projInside  = process.platform === 'win32' ? 'C:\\fake\\projects\\cairn'  : '/fake/projects/cairn';
const projOther   = process.platform === 'win32' ? 'C:\\fake\\projects\\other'  : '/fake/projects/other';

// We pin a deterministic clock so the stale-by-age case is unambiguous.
const NOW       = 1_800_000_000_000; // arbitrary fixed wallclock for normalization
const FRESH_AT  = NOW - 10_000;      // 10 s ago
const STALE_AT  = NOW - 5 * 60_000;  // 5 min ago — well past STALE_THRESHOLD_MS

const sessionsDir = uniqTmpDir('sessions');

// 1. busy inside project
const busyFile = writeSessionFile(sessionsDir, '11111.json', {
  pid: ALIVE_PID, sessionId: 'busy-uuid-aaaa-bbbb-cccc-dddd', cwd: projInside,
  startedAt: NOW - 60_000, version: '2.1.133', kind: 'interactive',
  entrypoint: 'cli', status: 'busy', updatedAt: FRESH_AT,
});

// 2. idle inside project
const idleFile = writeSessionFile(sessionsDir, '22222.json', {
  pid: ALIVE_PID, sessionId: 'idle-uuid-aaaa-bbbb-cccc-dddd', cwd: projInside,
  startedAt: NOW - 60_000, version: '2.1.133', kind: 'interactive',
  entrypoint: 'cli', status: 'idle', updatedAt: FRESH_AT,
});

// 3. stale (alive pid, ancient updatedAt) inside project
const staleFile = writeSessionFile(sessionsDir, '33333.json', {
  pid: ALIVE_PID, sessionId: 'stale-uuid-aaaa-bbbb-cccc-dddd', cwd: projInside,
  startedAt: NOW - 60_000, version: '2.1.133', kind: 'interactive',
  entrypoint: 'cli', status: 'busy', updatedAt: STALE_AT,
});

// 4. dead pid (file says busy, but pid is gone)
const deadFile = writeSessionFile(sessionsDir, '44444.json', {
  pid: DEAD_PID, sessionId: 'dead-uuid-aaaa-bbbb-cccc-dddd', cwd: projInside,
  startedAt: NOW - 60_000, version: '2.1.133', kind: 'interactive',
  entrypoint: 'cli', status: 'busy', updatedAt: FRESH_AT,
});

// 5. malformed JSON (must be skipped, no crash)
const malformedFile = writeSessionFile(sessionsDir, '55555.json', '{ not json at all }');

// 6. outside any project (busy, alive, but cwd is in a different tree)
const outsideFile = writeSessionFile(sessionsDir, '66666.json', {
  pid: ALIVE_PID, sessionId: 'outsd-uuid-aaaa-bbbb-cccc-dddd', cwd: projOther,
  startedAt: NOW - 60_000, version: '2.1.133', kind: 'interactive',
  entrypoint: 'cli', status: 'busy', updatedAt: FRESH_AT,
});

const rows = adapter.scanClaudeSessions({ sessionsDir, now: NOW });
console.log(`  scanned ${rows.length} rows from ${sessionsDir}`);

// Skip-not-crash: malformed file is parsed-then-dropped. We expect 5 valid
// rows (1..4 + 6); the malformed file (#5) silently disappears.
eq(rows.length, 5, 'malformed JSON is skipped silently → 5 valid rows');

const byPid = new Map(rows.map(r => [r.pid, r]));
const busy   = byPid.get(ALIVE_PID) ? rows.find(r => r.session_id?.startsWith('busy'))   : null;
const idle   = rows.find(r => r.session_id?.startsWith('idle'));
const stale  = rows.find(r => r.session_id?.startsWith('stale'));
const dead   = rows.find(r => r.session_id?.startsWith('dead'));
const outside = rows.find(r => r.session_id?.startsWith('outsd'));

ok(!!busy,    'busy row present');
ok(!!idle,    'idle row present');
ok(!!stale,   'stale row present');
ok(!!dead,    'dead row present');
ok(!!outside, 'outside row present');

// ---- Status derivation ----
eq(busy?.status,  'busy',  'busy row → status=busy');
eq(idle?.status,  'idle',  'idle row → status=idle');
eq(stale?.status, 'stale', 'stale row → status=stale');
eq(stale?.stale_reason, 'updated_too_old', 'stale row → stale_reason=updated_too_old');
ok(stale?.raw_status === 'busy', 'stale row preserves raw_status="busy"');
eq(dead?.status,  'dead',  'dead row → status=dead');
eq(dead?.stale_reason,  'pid_not_alive', 'dead row → stale_reason=pid_not_alive');
eq(outside?.status, 'busy', 'outside row → status=busy (outside is independent of attribution)');

// ---- Source / confidence tag ----
ok(rows.every(r => r.source === 'claude-code/session-file'), 'every row tagged source=claude-code/session-file');
ok(rows.every(r => r.confidence === 'medium-high'), 'every row tagged confidence=medium-high');

// ---- Project attribution ----
const projInsideObj = { project_root: projInside };
const projOtherObj  = { project_root: projOther };
const projUnknown   = { project_root: '(unknown)' };

ok( adapter.attributeClaudeSessionToProject(busy,    projInsideObj), 'busy attributed to inside project');
ok( adapter.attributeClaudeSessionToProject(idle,    projInsideObj), 'idle attributed to inside project');
ok( adapter.attributeClaudeSessionToProject(stale,   projInsideObj), 'stale attributed to inside project');
ok( adapter.attributeClaudeSessionToProject(dead,    projInsideObj), 'dead attributed to inside project (state ≠ attribution)');
ok(!adapter.attributeClaudeSessionToProject(outside, projInsideObj), 'outside NOT attributed to inside project');
ok(!adapter.attributeClaudeSessionToProject(busy,    projUnknown),   '"(unknown)" project root never matches');

// partition + unassigned helpers
const { matched, rest } = adapter.partitionByProject(rows, projInsideObj);
eq(matched.length, 4, 'partitionByProject: 4 rows match inside project (busy/idle/stale/dead)');
eq(rest.length,    1, 'partitionByProject: 1 row remains (outside)');

const unattributed = adapter.unassignedClaudeSessions(rows, [projInsideObj]);
eq(unattributed.length, 1, 'unassignedClaudeSessions: just the outside row');
ok(unattributed[0].session_id.startsWith('outsd'), 'unassigned row is the outside one');

const unattributedBoth = adapter.unassignedClaudeSessions(rows, [projInsideObj, projOtherObj]);
eq(unattributedBoth.length, 0, 'with both projects registered, nothing is unassigned');

// ---- Path normalization edge: cwd inside subdir ----
const subdir = path.join(projInside, 'packages', 'daemon', 'src');
const subdirRow = adapter.normalizeRow(
  { pid: ALIVE_PID, sessionId: 'sub', cwd: subdir, status: 'busy', updatedAt: FRESH_AT },
  { file: '<inline>', now: NOW },
);
ok(adapter.attributeClaudeSessionToProject(subdirRow, projInsideObj),
   'subdir cwd attributes to project root');

// ---- Case-insensitive on Windows ----
if (process.platform === 'win32') {
  const upperRow = adapter.normalizeRow(
    { pid: ALIVE_PID, sessionId: 'up', cwd: projInside.toUpperCase(), status: 'busy', updatedAt: FRESH_AT },
    { file: '<inline>', now: NOW },
  );
  ok(adapter.attributeClaudeSessionToProject(upperRow, projInsideObj),
     'Windows: uppercased cwd attributes to lowercased project root');
}

// ---- defensive: missing fields don't crash ----
const missingPidRow = adapter.normalizeRow(
  { sessionId: 'no-pid', cwd: projInside, status: 'busy', updatedAt: FRESH_AT },
  { file: '<inline>', now: NOW },
);
eq(missingPidRow.status, 'unknown', 'no pid → status=unknown');
eq(missingPidRow.stale_reason, 'no_pid', 'no pid → stale_reason=no_pid');

const allMissingRow = adapter.normalizeRow({}, { file: '<inline>', now: NOW });
eq(allMissingRow.status, 'unknown', 'all-missing row → status=unknown without throwing');

// Empty / non-existent dir → []
const empty = adapter.scanClaudeSessions({ sessionsDir: path.join(sessionsDir, '__nope__'), now: NOW });
eq(empty.length, 0, 'missing sessions dir → empty array, no throw');

// ---------------------------------------------------------------------------
// Part B — live, read-only sweep of real ~/.claude/sessions
// ---------------------------------------------------------------------------

console.log('\n==> Part B: live read-only scan of ~/.claude/sessions');

const live = adapter.scanClaudeSessions(); // default sessionsDir
console.log(`  found ${live.length} live Claude session file(s)`);
ok(Array.isArray(live), 'live scan returns an array (never throws)');

// Print a redacted summary of up to 3 rows. Truncate sessionId; never
// touch transcript_path, prompts, or any user content.
function redactSessionId(s) {
  if (!s || typeof s !== 'string') return '(none)';
  return s.slice(0, 8) + '…';
}
function redactCwd(s) {
  if (!s || typeof s !== 'string') return '(none)';
  // Show only the last two segments — enough to recognize a project,
  // but doesn't reveal hierarchies above it.
  const norm = s.replace(/\\/g, '/').split('/').filter(Boolean);
  return norm.length <= 2 ? norm.join('/') : '…/' + norm.slice(-2).join('/');
}
const sample = live.slice(0, 3);
sample.forEach((r, i) => {
  console.log(
    `  [${i}] status=${String(r.status).padEnd(7)}` +
    ` pid=${String(r.pid).padEnd(6)}` +
    ` v=${r.version || '?'}` +
    ` sid=${redactSessionId(r.session_id)}` +
    ` cwd=${redactCwd(r.cwd)}`
  );
});

// ---------------------------------------------------------------------------
// Part C — read-only invariants
// ---------------------------------------------------------------------------

console.log('\n==> Part C: read-only invariants');

// SQLite untouched — the default cairn DB lives at ~/.cairn/cairn.db on
// this user. Compare mtime before+after a re-scan.
const cairnDb = path.join(os.homedir(), '.cairn', 'cairn.db');
let beforeMtime = null;
try { beforeMtime = fs.statSync(cairnDb).mtimeMs; } catch (_e) {}

// Re-scan again to be sure no lazy connection sneaks into the DB.
adapter.scanClaudeSessions();
adapter.scanClaudeSessions({ sessionsDir, now: NOW });

if (beforeMtime != null) {
  let afterMtime = null;
  try { afterMtime = fs.statSync(cairnDb).mtimeMs; } catch (_e) {}
  eq(afterMtime, beforeMtime, 'cairn.db mtime unchanged after smoke');
} else {
  console.log('  (cairn.db not present — skipping mtime check)');
}

// Source-level guarantee: the adapter file uses no .run/.exec/.prepare —
// pure fs reads + path manipulation only.
const adapterSrc = fs.readFileSync(
  path.join(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, '')),
            '..', 'agent-adapters', 'claude-code-session-scan.cjs'),
  'utf8',
);
ok(!/\.run\s*\(/.test(adapterSrc),     'adapter source has no .run(');
ok(!/\.exec\s*\(/.test(adapterSrc),    'adapter source has no .exec(');
ok(!/\.prepare\s*\(/.test(adapterSrc), 'adapter source has no .prepare(');
// Look for actual SQL mutation syntax (verb + INTO/FROM/SET), not the prose
// word "update" that may legitimately appear in docstrings (e.g. "last-update
// timestamp"). Word boundaries + a required SQL keyword pair after the verb.
ok(!/\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i.test(adapterSrc),
   'adapter source has no SQL mutation keywords');
ok(!/writeFileSync|writeFile\b|appendFile/.test(adapterSrc), 'adapter source does not write any files');

// Cleanup the synthetic fixture (best effort).
try { fs.rmSync(sessionsDir, { recursive: true, force: true }); } catch (_e) {}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

console.log(`\n==> ${asserts - fails}/${asserts} assertions passed`);
if (fails > 0) {
  console.error(`FAIL: ${fails} assertion(s) failed`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('PASS');
