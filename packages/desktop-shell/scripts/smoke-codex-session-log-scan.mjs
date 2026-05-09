#!/usr/bin/env node
/**
 * Smoke for the Codex CLI / Codex Desktop session-log adapter.
 *
 * Three parts:
 *
 *   Part A — synthetic fixture:
 *     Build a fake `~/.codex/sessions/YYYY/MM/DD/` directory tree in
 *     os.tmpdir(), write rollout files with a deterministic mix of
 *     session_meta variants + mtime values, invoke
 *     scanCodexSessions({ sessionsDir, now, recentMs, daysBack }), and
 *     assert each row's status, attribution, and the row shape contract
 *     (no pid, source/confidence tags, started_at/updated_at/age_ms).
 *
 *   Part B — live, read-only:
 *     Call scanCodexSessions() against the real ~/.codex/sessions, print
 *     a count + redacted summary of the first three rows. We never
 *     print full sessionId, never read past the meta line, never write.
 *
 *   Part C — read-only invariants:
 *     - cairn.db mtime unchanged over the whole smoke
 *     - adapter source has no .run/.exec/.prepare/SQL mutation/file
 *       writes
 *     - adapter source has no readline / stream / JSON.parse loop that
 *       would suggest reading past the first line of a rollout file
 *
 * No external deps. No commits.
 *
 * Run:
 *   node packages/desktop-shell/scripts/smoke-codex-session-log-scan.mjs
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';

const require = createRequire(import.meta.url);
const adapter = require('../agent-adapters/codex-session-log-scan.cjs');

// ---------------------------------------------------------------------------
// Tiny assert helpers
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
  const base = path.join(os.tmpdir(), `cairn-codex-smoke-${tag}-${process.pid}-${Date.now()}`);
  fs.mkdirSync(base, { recursive: true });
  return base;
}

function pad2(n) { return n < 10 ? '0' + n : '' + n; }

function dateDir(sessionsDir, t) {
  const y = String(t.getUTCFullYear());
  const m = pad2(t.getUTCMonth() + 1);
  const d = pad2(t.getUTCDate());
  const dir = path.join(sessionsDir, y, m, d);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Write a rollout file with a session_meta first line and (optionally)
 * extra lines that we deliberately stuff with content the adapter must
 * never read. The mtime is then forced via fs.utimesSync so the smoke
 * doesn't depend on wall-clock when filesystem caches the write.
 */
function writeRolloutFile(dir, filename, payload, mtimeMs, extraLines) {
  const p = path.join(dir, filename);
  let body;
  if (typeof payload === 'string') {
    // Allow callers to pass a literal first-line string (for malformed
    // tests). No extra lines appended in that case.
    body = payload + '\n';
  } else if (payload === null) {
    // Empty file (zero-byte rollout) — exercises the no-meta path.
    body = '';
  } else {
    body = JSON.stringify(payload) + '\n';
    if (Array.isArray(extraLines)) {
      // These represent the per-event payloads (turn.started, command
      // output, model deltas, etc.) that the adapter MUST NOT read.
      // Stuffing them into the file is useful: if a regression starts
      // reading past line 1, our smoke will trip on the obvious marker
      // string we plant in there.
      for (const line of extraLines) body += line + '\n';
    }
  }
  fs.writeFileSync(p, body, 'utf8');
  if (Number.isFinite(mtimeMs)) {
    const sec = mtimeMs / 1000;
    fs.utimesSync(p, sec, sec);
  }
  return p;
}

// ---------------------------------------------------------------------------
// Part A — synthetic fixture
// ---------------------------------------------------------------------------

console.log('==> Part A: synthetic fixture');

const projInside = process.platform === 'win32' ? 'C:\\fake\\projects\\cairn'  : '/fake/projects/cairn';
const projOther  = process.platform === 'win32' ? 'C:\\fake\\projects\\other'  : '/fake/projects/other';

// Use a fixed "now" + recentMs so status derivation is deterministic.
// NOTE: we pick `now` matching the directory we'll create so our
// `recentDateDirs(...)` window always includes today's fixture dir.
const NOW       = Date.now();
const RECENT_MS = 60_000;
const FRESH_MTIME = NOW - 5_000;       // 5 s ago — recent
const OLD_MTIME   = NOW - 5 * 60_000;  // 5 min ago — inactive
const ANCIENT_MTIME = NOW - 6 * 24 * 60 * 60 * 1000; // 6 days ago — still in 7-day window

const sessionsDir = uniqTmpDir('sessions');
const todayDir = dateDir(sessionsDir, new Date(NOW));
// 6-days-ago dir for a row that should still be in the default 7-day
// scan window.
const oldDir = dateDir(sessionsDir, new Date(ANCIENT_MTIME));

const POISON = '__SMOKE_POISON_LINE__/* if you see this in any output,'
             + ' the adapter read past the session_meta line, which is'
             + ' a privacy regression (RACR step 3) */';

// 1. recent + inside project
const recentInsideFile = writeRolloutFile(
  todayDir,
  'rollout-aaa-uuid-recent-inside.jsonl',
  {
    timestamp: new Date(NOW - 60_000).toISOString(),
    type: 'session_meta',
    payload: {
      id: 'aaa-recent-inside-uuid',
      timestamp: new Date(NOW - 90_000).toISOString(),
      cwd: projInside,
      originator: 'Codex Desktop',
      cli_version: '0.129.0-alpha.15',
      source: 'vscode',
    },
  },
  FRESH_MTIME,
  [
    JSON.stringify({ timestamp: '...', type: 'turn.started', payload: { user_input: POISON } }),
    JSON.stringify({ timestamp: '...', type: 'command_execution', payload: { cmd: POISON } }),
  ],
);

// 2. inactive + inside project (mtime old, but still in date window)
const inactiveInsideFile = writeRolloutFile(
  todayDir,
  'rollout-bbb-uuid-inactive-inside.jsonl',
  {
    timestamp: new Date(NOW - 6 * 60_000).toISOString(),
    type: 'session_meta',
    payload: {
      id: 'bbb-inactive-inside-uuid',
      timestamp: new Date(NOW - 7 * 60_000).toISOString(),
      cwd: projInside,
      originator: 'Codex Desktop',
      cli_version: '0.129.0-alpha.15',
      source: 'vscode',
    },
  },
  OLD_MTIME,
);

// 3. recent + inside project subdir (cwd nested under project_root)
const subdirCwd = path.join(projInside, 'packages', 'daemon');
const recentSubdirFile = writeRolloutFile(
  todayDir,
  'rollout-ccc-uuid-recent-subdir.jsonl',
  {
    timestamp: new Date(NOW - 8_000).toISOString(),
    type: 'session_meta',
    payload: {
      id: 'ccc-recent-subdir-uuid',
      timestamp: new Date(NOW - 30_000).toISOString(),
      cwd: subdirCwd,
      originator: 'Codex CLI',
      cli_version: '0.130.0',
      source: null,
    },
  },
  FRESH_MTIME,
);

// 4. recent + outside any project
const outsideFile = writeRolloutFile(
  todayDir,
  'rollout-ddd-uuid-recent-outside.jsonl',
  {
    timestamp: new Date(NOW - 5_000).toISOString(),
    type: 'session_meta',
    payload: {
      id: 'ddd-recent-outside-uuid',
      timestamp: new Date(NOW - 20_000).toISOString(),
      cwd: projOther,
      originator: 'Codex Desktop',
      cli_version: '0.129.0-alpha.15',
      source: 'vscode',
    },
  },
  FRESH_MTIME,
);

// 5. malformed first line — must surface as unknown (not crash)
const malformedFile = writeRolloutFile(
  todayDir,
  'rollout-eee-malformed.jsonl',
  '{ this is not json',
  FRESH_MTIME,
);

// 6. wrong type envelope (e.g. an old format that used `event` not `session_meta`)
const wrongTypeFile = writeRolloutFile(
  todayDir,
  'rollout-fff-wrong-type.jsonl',
  {
    timestamp: new Date(NOW).toISOString(),
    type: 'turn.started',
    payload: { id: 'wrong-shape', cwd: projInside },
  },
  FRESH_MTIME,
);

// 7. empty file
const emptyFile = writeRolloutFile(
  todayDir,
  'rollout-ggg-empty.jsonl',
  null,
  FRESH_MTIME,
);

// 8. inside project, mtime ANCIENT but still inside the 7-day window —
//    must surface as inactive (not dropped by the date window).
const ancientInsideFile = writeRolloutFile(
  oldDir,
  'rollout-hhh-uuid-ancient-inside.jsonl',
  {
    timestamp: new Date(ANCIENT_MTIME - 60_000).toISOString(),
    type: 'session_meta',
    payload: {
      id: 'hhh-ancient-inside-uuid',
      timestamp: new Date(ANCIENT_MTIME - 60_000).toISOString(),
      cwd: projInside,
      originator: 'Codex Desktop',
      cli_version: '0.128.0',
      source: 'vscode',
    },
  },
  ANCIENT_MTIME,
);

// 9. file dated outside the 7-day window — must NOT be scanned.
//    20 days ago.
const veryOldDir = dateDir(sessionsDir, new Date(NOW - 20 * 24 * 60 * 60 * 1000));
writeRolloutFile(
  veryOldDir,
  'rollout-iii-out-of-window.jsonl',
  {
    timestamp: new Date(NOW - 20 * 24 * 60 * 60 * 1000).toISOString(),
    type: 'session_meta',
    payload: {
      id: 'iii-out-of-window-uuid',
      timestamp: new Date(NOW - 20 * 24 * 60 * 60 * 1000).toISOString(),
      cwd: projInside,
      originator: 'Codex Desktop',
      cli_version: '0.128.0',
    },
  },
  NOW - 20 * 24 * 60 * 60 * 1000,
);

const rows = adapter.scanCodexSessions({ sessionsDir, now: NOW, recentMs: RECENT_MS, daysBack: 7 });
console.log(`  scanned ${rows.length} rows from ${sessionsDir}`);

// We expect 8 rows from the in-window dirs (today + 6-days-ago):
//   aaa, bbb, ccc, ddd, eee (malformed unknown), fff (wrong-type unknown),
//   ggg (empty unknown), hhh (ancient-but-in-window).
// The iii row is in a 20-days-ago dir → outside the 7-day default window
// → must NOT appear.
eq(rows.length, 8, 'in-window rows = 8 (out-of-window rollout dropped by daysBack=7)');

const recentInside  = rows.find(r => r.session_id === 'aaa-recent-inside-uuid');
const inactiveInside = rows.find(r => r.session_id === 'bbb-inactive-inside-uuid');
const recentSubdir  = rows.find(r => r.session_id === 'ccc-recent-subdir-uuid');
const outsideRow    = rows.find(r => r.session_id === 'ddd-recent-outside-uuid');
const malformedRow  = rows.find(r => r.file === malformedFile);
const wrongTypeRow  = rows.find(r => r.file === wrongTypeFile);
const emptyRow      = rows.find(r => r.file === emptyFile);
const ancientRow    = rows.find(r => r.session_id === 'hhh-ancient-inside-uuid');
const oowRow        = rows.find(r => r.session_id === 'iii-out-of-window-uuid');

ok(!!recentInside,   'aaa row present');
ok(!!inactiveInside, 'bbb row present');
ok(!!recentSubdir,   'ccc row present');
ok(!!outsideRow,     'ddd row present');
ok(!!malformedRow,   'eee row (malformed) present as unknown');
ok(!!wrongTypeRow,   'fff row (wrong type) present as unknown');
ok(!!emptyRow,       'ggg row (empty file) present as unknown');
ok(!!ancientRow,     'hhh row (ancient but in window) present');
ok(!oowRow,          'iii row (20 days ago) NOT scanned');

// ---- Status derivation ----
eq(recentInside?.status,   'recent',   'aaa: mtime <60s → recent');
eq(inactiveInside?.status, 'inactive', 'bbb: mtime >60s → inactive');
eq(recentSubdir?.status,   'recent',   'ccc: mtime <60s → recent');
eq(outsideRow?.status,     'recent',   'ddd: status independent of attribution');
eq(malformedRow?.status,   'unknown',  'eee: malformed JSON → unknown');
eq(malformedRow?.stale_reason, 'meta_missing', 'eee: stale_reason=meta_missing');
eq(wrongTypeRow?.status,   'unknown',  'fff: wrong-type envelope → unknown');
eq(wrongTypeRow?.stale_reason, 'meta_missing', 'fff: stale_reason=meta_missing');
eq(emptyRow?.status,       'unknown',  'ggg: empty file → unknown');
eq(ancientRow?.status,     'inactive', 'hhh: ancient mtime → inactive');

// Codex rows MUST NEVER fake busy/idle.
ok(rows.every(r => r.status !== 'busy' && r.status !== 'idle'),
   'no row uses busy/idle vocabulary (Codex must not impersonate Claude)');

// ---- Source / confidence / pid contract ----
ok(rows.every(r => r.source === 'codex/session-log'), 'every row tagged source=codex/session-log');
ok(rows.every(r => r.confidence === 'medium'),        'every row tagged confidence=medium');
ok(rows.every(r => r.pid === null),                   'no row carries a pid (Codex meta has none)');

// ---- Originator / cli_version / age_ms surfacing for known rows ----
eq(recentInside?.originator, 'Codex Desktop', 'aaa: originator surfaced');
eq(recentInside?.version,    '0.129.0-alpha.15', 'aaa: cli_version surfaced as version');
ok(recentInside?.age_ms != null && recentInside.age_ms < 60_000,
   'aaa: age_ms is the freshness signal (~5s)');
ok(inactiveInside?.age_ms > 60_000, 'bbb: age_ms reflects 5min mtime');

// ---- Project attribution ----
const projInsideObj = { project_root: projInside };
const projOtherObj  = { project_root: projOther };
const projUnknown   = { project_root: '(unknown)' };

ok( adapter.attributeCodexSessionToProject(recentInside,   projInsideObj), 'aaa attributed to inside project');
ok( adapter.attributeCodexSessionToProject(inactiveInside, projInsideObj), 'bbb attributed to inside project');
ok( adapter.attributeCodexSessionToProject(recentSubdir,   projInsideObj), 'ccc attributed via subdir cwd');
ok(!adapter.attributeCodexSessionToProject(outsideRow,     projInsideObj), 'ddd NOT attributed to inside project');
ok( adapter.attributeCodexSessionToProject(ancientRow,     projInsideObj), 'hhh attributed to inside project (status ≠ attribution)');
ok(!adapter.attributeCodexSessionToProject(recentInside,   projUnknown),   '"(unknown)" project root never matches');
ok(!adapter.attributeCodexSessionToProject(malformedRow,   projInsideObj), 'unknown row with no cwd → not attributed');

// partition + unassigned helpers
const { matched, rest } = adapter.partitionByProject(rows, projInsideObj);
// matched: aaa, bbb, ccc, hhh = 4. rest: ddd, eee, fff, ggg = 4.
eq(matched.length, 4, 'partitionByProject: 4 rows match inside project');
eq(rest.length,    4, 'partitionByProject: 4 rows remain (outside + 3 with no cwd)');

const unattributed = adapter.unassignedCodexSessions(rows, [projInsideObj]);
// All non-inside rows: outside + 3 no-cwd unknowns.
eq(unattributed.length, 4, 'unassignedCodexSessions: outside + unknowns');
ok(unattributed.some(r => r.session_id === 'ddd-recent-outside-uuid'),
   'unassigned includes the outside row');

const unattributedBoth = adapter.unassignedCodexSessions(rows, [projInsideObj, projOtherObj]);
// With projOther registered, outside attributes there. Unknown rows with
// no cwd still don't attribute anywhere → still 3 left.
eq(unattributedBoth.length, 3,
   'with both projects registered: unknown rows with no cwd still unassigned');

// ---- summarizeCodexRows (powers L1 cards + tray tooltip) ----
const projSummary = adapter.summarizeCodexRows(matched);
// matched is aaa(recent) + bbb(inactive) + ccc(recent) + hhh(inactive).
eq(projSummary.recent,   2, 'summarize: 2 recent rows attributed to inside project');
eq(projSummary.inactive, 2, 'summarize: 2 inactive rows attributed');
eq(projSummary.unknown,  0, 'summarize: no unknown rows in the matched set');
eq(projSummary.total,    4, 'summarize: 4 total attributed rows');
ok(projSummary.last_activity_at >= FRESH_MTIME,
   'summarize: last_activity_at picks up the freshest mtime');

const emptySummary = adapter.summarizeCodexRows([]);
eq(emptySummary.total, 0, 'summarize: empty input → all-zero summary');
eq(emptySummary.last_activity_at, 0, 'summarize: empty input → last_activity_at=0');

const messySummary = adapter.summarizeCodexRows([null, undefined, { status: 'recent', updated_at: NOW }]);
eq(messySummary.recent, 1, 'summarize: tolerates null/undefined entries without throwing');

// ---- normalizeRow defensive behavior (no I/O paths) ----
const noMeta = adapter.normalizeRow(null, { file: '<inline>', mtimeMs: NOW, now: NOW, recentMs: RECENT_MS });
eq(noMeta.status, 'unknown', 'normalizeRow: null meta → unknown');
eq(noMeta.stale_reason, 'meta_missing', 'normalizeRow: null meta → stale_reason=meta_missing');

const oldMeta = adapter.normalizeRow(
  { type: 'session_meta', payload: { id: 'x', cwd: projInside, cli_version: '0.1' } },
  { file: '<inline>', mtimeMs: NOW - 120_000, now: NOW, recentMs: RECENT_MS },
);
eq(oldMeta.status, 'inactive', 'normalizeRow: old mtime + valid meta → inactive');
ok(!oldMeta.stale_reason, 'normalizeRow: inactive row has no stale_reason');

// Empty / non-existent dir → []
const empty = adapter.scanCodexSessions({
  sessionsDir: path.join(sessionsDir, '__nope__'),
  now: NOW,
  recentMs: RECENT_MS,
});
eq(empty.length, 0, 'missing sessions dir → empty array, no throw');

// ---------------------------------------------------------------------------
// Part B — live, read-only sweep of real ~/.codex/sessions
// ---------------------------------------------------------------------------

console.log('\n==> Part B: live read-only scan of ~/.codex/sessions');

const live = adapter.scanCodexSessions(); // default sessionsDir
console.log(`  found ${live.length} live Codex session file(s) in last ${adapter.DEFAULT_DAYS_BACK} day(s)`);
ok(Array.isArray(live), 'live scan returns an array (never throws)');

function redactSessionId(s) {
  if (!s || typeof s !== 'string') return '(none)';
  return s.slice(0, 8) + '…';
}
function redactCwd(s) {
  if (!s || typeof s !== 'string') return '(none)';
  const norm = s.replace(/\\/g, '/').split('/').filter(Boolean);
  return norm.length <= 2 ? norm.join('/') : '…/' + norm.slice(-2).join('/');
}
const sample = live.slice(0, 3);
sample.forEach((r, i) => {
  console.log(
    `  [${i}] status=${String(r.status).padEnd(8)}` +
    ` orig=${(r.originator || '?').padEnd(14)}` +
    ` v=${r.version || '?'}` +
    ` sid=${redactSessionId(r.session_id)}` +
    ` cwd=${redactCwd(r.cwd)}` +
    ` age=${r.age_ms != null ? Math.round(r.age_ms / 1000) + 's' : '?'}`
  );
});

// ---------------------------------------------------------------------------
// Part C — read-only invariants
// ---------------------------------------------------------------------------

console.log('\n==> Part C: read-only invariants');

// SQLite untouched.
const cairnDb = path.join(os.homedir(), '.cairn', 'cairn.db');
let beforeMtime = null;
try { beforeMtime = fs.statSync(cairnDb).mtimeMs; } catch (_e) {}

adapter.scanCodexSessions();
adapter.scanCodexSessions({ sessionsDir, now: NOW });

if (beforeMtime != null) {
  let afterMtime = null;
  try { afterMtime = fs.statSync(cairnDb).mtimeMs; } catch (_e) {}
  eq(afterMtime, beforeMtime, 'cairn.db mtime unchanged after smoke');
} else {
  console.log('  (cairn.db not present — skipping mtime check)');
}

// ~/.codex untouched (any mtime change in ~/.codex/sessions/today's dir
// while the smoke ran would mean a stray write — guard against it).
const todayLive = path.join(os.homedir(), '.codex', 'sessions');
let codexBeforeMtime = null;
try { codexBeforeMtime = fs.statSync(todayLive).mtimeMs; } catch (_e) {}
adapter.scanCodexSessions();
if (codexBeforeMtime != null) {
  let codexAfterMtime = null;
  try { codexAfterMtime = fs.statSync(todayLive).mtimeMs; } catch (_e) {}
  eq(codexAfterMtime, codexBeforeMtime, '~/.codex/sessions mtime unchanged after smoke');
}

// Source-level guarantees.
const adapterSrcPath = path.join(
  import.meta.dirname || path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, '')),
  '..', 'agent-adapters', 'codex-session-log-scan.cjs',
);
const adapterSrc = fs.readFileSync(adapterSrcPath, 'utf8');
ok(!/\.run\s*\(/.test(adapterSrc),     'adapter source has no .run(');
ok(!/\.exec\s*\(/.test(adapterSrc),    'adapter source has no .exec(');
ok(!/\.prepare\s*\(/.test(adapterSrc), 'adapter source has no .prepare(');
ok(!/\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i.test(adapterSrc),
   'adapter source has no SQL mutation keywords');
ok(!/writeFileSync|writeFile\b|appendFile/.test(adapterSrc),
   'adapter source does not write any files');
// Privacy guards: must NOT use streaming readers / readlines that would
// invite slurping the entire rollout transcript past line 1.
ok(!/createReadStream|readline\b|readFileSync/.test(adapterSrc),
   'adapter source uses neither createReadStream/readline/readFileSync (forces single-line read)');

// Make sure we never accidentally wrote the POISON marker into anything
// the adapter returns (it lives only in the rollout file's later lines).
ok(rows.every(r => JSON.stringify(r).indexOf(POISON) === -1),
   'no row carries the POISON line — adapter did not read past line 1');
ok(JSON.stringify(live).indexOf(POISON) === -1,
   'live rows likewise do not carry POISON (sanity)');

// Cleanup the synthetic fixture.
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
