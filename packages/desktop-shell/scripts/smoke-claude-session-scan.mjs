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

// Deterministic clock for status derivation tests. Note: status no
// longer depends on `updatedAt` age — stale-by-age was removed when we
// realized Claude only refreshes `updatedAt` on activity, so a quiet
// pid-alive session is genuinely just busy/idle, not stale.
const NOW       = 1_800_000_000_000;
const FRESH_AT  = NOW - 10_000;      // 10 s ago
const OLD_AT    = NOW - 5 * 60_000;  // 5 min ago — exercises the "old but alive" path

const sessionsDir = uniqTmpDir('sessions');

// 1. busy inside project (fresh updatedAt)
const busyFile = writeSessionFile(sessionsDir, '11111.json', {
  pid: ALIVE_PID, sessionId: 'busy-uuid-aaaa-bbbb-cccc-dddd', cwd: projInside,
  startedAt: NOW - 60_000, version: '2.1.133', kind: 'interactive',
  entrypoint: 'cli', status: 'busy', updatedAt: FRESH_AT,
});

// 2. idle inside project (fresh updatedAt)
const idleFile = writeSessionFile(sessionsDir, '22222.json', {
  pid: ALIVE_PID, sessionId: 'idle-uuid-aaaa-bbbb-cccc-dddd', cwd: projInside,
  startedAt: NOW - 60_000, version: '2.1.133', kind: 'interactive',
  entrypoint: 'cli', status: 'idle', updatedAt: FRESH_AT,
});

// 3. alive pid + ancient updatedAt + status=idle.
//    Earlier draft promoted this to "stale". New rule: trust Claude's
//    status verbatim while pid is alive. This row must surface as IDLE,
//    not stale, so a user keeping a quiet Claude terminal open between
//    turns doesn't see the panel mark it stale.
const oldIdleFile = writeSessionFile(sessionsDir, '33333.json', {
  pid: ALIVE_PID, sessionId: 'oldid-uuid-aaaa-bbbb-cccc-dddd', cwd: projInside,
  startedAt: NOW - 60_000, version: '2.1.133', kind: 'interactive',
  entrypoint: 'cli', status: 'idle', updatedAt: OLD_AT,
});

// 3b. alive pid + ancient updatedAt + status=busy. Same rule — trust
//     Claude verbatim. (Real-world: a long-running tool call where Claude
//     wrote `busy` and hasn't refreshed updatedAt yet.)
const oldBusyFile = writeSessionFile(sessionsDir, '33334.json', {
  pid: ALIVE_PID, sessionId: 'oldbz-uuid-aaaa-bbbb-cccc-dddd', cwd: projInside,
  startedAt: NOW - 60_000, version: '2.1.133', kind: 'interactive',
  entrypoint: 'cli', status: 'busy', updatedAt: OLD_AT,
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

// Skip-not-crash: malformed file is parsed-then-dropped. We expect 6 valid
// rows (1, 2, 3, 3b, 4, 6); the malformed file (#5) silently disappears.
eq(rows.length, 6, 'malformed JSON is skipped silently → 6 valid rows');

const busy    = rows.find(r => r.session_id?.startsWith('busy'));
const idle    = rows.find(r => r.session_id?.startsWith('idle'));
const oldIdle = rows.find(r => r.session_id?.startsWith('oldid'));
const oldBusy = rows.find(r => r.session_id?.startsWith('oldbz'));
const dead    = rows.find(r => r.session_id?.startsWith('dead'));
const outside = rows.find(r => r.session_id?.startsWith('outsd'));

ok(!!busy,    'busy row present');
ok(!!idle,    'idle row present');
ok(!!oldIdle, 'old-idle row present');
ok(!!oldBusy, 'old-busy row present');
ok(!!dead,    'dead row present');
ok(!!outside, 'outside row present');

// ---- Status derivation: pid alive → preserve Claude's status verbatim ----
eq(busy?.status,  'busy',  'busy row → status=busy');
eq(idle?.status,  'idle',  'idle row → status=idle');
// THE FIX: alive pid + old updatedAt + idle → still idle (was 'stale' in v1)
eq(oldIdle?.status, 'idle', 'alive pid + old updatedAt + idle → status=idle (NOT stale)');
ok(!oldIdle?.stale_reason, 'old-idle has no stale_reason (pid is alive, status is recognized)');
ok(!oldIdle?.raw_status,   'old-idle does not set raw_status (no promotion happened)');
eq(oldBusy?.status, 'busy', 'alive pid + old updatedAt + busy → status=busy (NOT stale)');
ok(oldIdle?.age_ms > 60_000, 'old-idle still exposes age_ms (≈ 5min) for "last active" UI');
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
ok( adapter.attributeClaudeSessionToProject(oldIdle, projInsideObj), 'old-idle attributed to inside project');
ok( adapter.attributeClaudeSessionToProject(oldBusy, projInsideObj), 'old-busy attributed to inside project');
ok( adapter.attributeClaudeSessionToProject(dead,    projInsideObj), 'dead attributed to inside project (state ≠ attribution)');
ok(!adapter.attributeClaudeSessionToProject(outside, projInsideObj), 'outside NOT attributed to inside project');
ok(!adapter.attributeClaudeSessionToProject(busy,    projUnknown),   '"(unknown)" project root never matches');

// partition + unassigned helpers
const { matched, rest } = adapter.partitionByProject(rows, projInsideObj);
eq(matched.length, 5, 'partitionByProject: 5 rows match inside project (busy/idle/old-idle/old-busy/dead)');
eq(rest.length,    1, 'partitionByProject: 1 row remains (outside)');

const unattributed = adapter.unassignedClaudeSessions(rows, [projInsideObj]);
eq(unattributed.length, 1, 'unassignedClaudeSessions: just the outside row');
ok(unattributed[0].session_id.startsWith('outsd'), 'unassigned row is the outside one');

const unattributedBoth = adapter.unassignedClaudeSessions(rows, [projInsideObj, projOtherObj]);
eq(unattributedBoth.length, 0, 'with both projects registered, nothing is unassigned');

// ---- summarizeClaudeRows (powers L1 cards + tray tooltip) ----
const projSummary = adapter.summarizeClaudeRows(matched);
eq(projSummary.busy,  2, 'summarize: 2 busy rows attributed to inside project (busy + old-busy)');
eq(projSummary.idle,  2, 'summarize: 2 idle rows attributed to inside project (idle + old-idle)');
eq(projSummary.dead,  1, 'summarize: 1 dead row attributed to inside project');
eq(projSummary.total, 5, 'summarize: 5 total attributed rows');
ok(projSummary.last_activity_at >= FRESH_AT,
   'summarize: last_activity_at picks up the freshest row');
const emptySummary = adapter.summarizeClaudeRows([]);
eq(emptySummary.total, 0, 'summarize: empty input → all-zero summary');
eq(emptySummary.last_activity_at, 0, 'summarize: empty input → last_activity_at=0');
const messySummary = adapter.summarizeClaudeRows([null, undefined, { status: 'busy', updated_at: NOW }]);
eq(messySummary.busy, 1, 'summarize: tolerates null/undefined entries without throwing');

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
