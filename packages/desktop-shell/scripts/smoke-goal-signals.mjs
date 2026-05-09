#!/usr/bin/env node
/**
 * Smoke for the Project Pulse / Goal-Signals derivation layer.
 *
 * Exercises every documented signal kind from goal-signals.cjs
 * (deriveProjectPulse + deriveRegistryPulse) against synthetic
 * summary + activity inputs. Asserts:
 *   - severity → pulse_level promotion (attention > watch > ok)
 *   - signal kinds fire for the expected conditions
 *   - ok evidence only emits when nothing above triggered AND we
 *     have fresh activity
 *   - next_attention sorts by severity, capped at 3
 *
 * Read-only invariants:
 *   - Cairn SQLite mtime unchanged
 *   - ~/.claude / ~/.codex mtime unchanged
 *   - goal-signals.cjs source has no .run / .exec / SQL mutation /
 *     file write
 *
 * No external deps. No commits.
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

const goalSignals = require(path.join(root, 'goal-signals.cjs'));

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
function hasKind(signals, kind) {
  return signals && signals.some(s => s.kind === kind);
}

// Snapshot off-limits paths.
const realCairnDb = path.join(os.homedir(), '.cairn', 'cairn.db');
const realClaude  = path.join(os.homedir(), '.claude');
const realCodex   = path.join(os.homedir(), '.codex');
function safeMtime(p) { try { return fs.statSync(p).mtimeMs; } catch (_e) { return null; } }
const beforeCairn  = safeMtime(realCairnDb);
const beforeClaude = safeMtime(realClaude);
const beforeCodex  = safeMtime(realCodex);

const NOW = 1_800_000_000_000;

function summary(extra) {
  return Object.assign({
    available: true, db_path: '/tmp/x.db', ts: NOW / 1000,
    agents_active: 0, agents_stale: 0,
    tasks_running: 0, tasks_blocked: 0, tasks_waiting_review: 0, tasks_failed: 0,
    blockers_open: 0, outcomes_failed: 0, outcomes_pending: 0,
    conflicts_open: 0, dispatches_recent_1h: 0,
    last_activity_at: 0,
    health: 'idle',
    agent_activity: { total: 0, by_family: { live:0, recent:0, inactive:0, dead:0, unknown:0 }, by_app: { mcp:0, 'claude-code':0, codex:0 }, last_activity_at: 0 },
  }, extra || {});
}
function actLive() {
  return { app: 'mcp', state: 'active', state_family: 'live' };
}
function actRecent() {
  return { app: 'codex', state: 'recent', state_family: 'recent' };
}

// ---------------------------------------------------------------------------
// Part A — null / unavailable summaries
// ---------------------------------------------------------------------------

console.log('==> Part A: null / unavailable summaries');

const empty = goalSignals.deriveProjectPulse(null, [], { now: NOW });
eq(empty.pulse_level, 'ok', 'null summary → pulse_level=ok');
eq(empty.signals.length, 0, 'null summary → no signals');

const unavail = goalSignals.deriveProjectPulse(summary({ available: false }), [], { now: NOW });
eq(unavail.pulse_level, 'ok', 'unavailable summary → pulse_level=ok');
eq(unavail.signals.length, 0, 'unavailable summary → no signals');

// ---------------------------------------------------------------------------
// Part B — attention signals
// ---------------------------------------------------------------------------

console.log('\n==> Part B: attention signals');

const blocker = goalSignals.deriveProjectPulse(
  summary({ blockers_open: 2, last_activity_at: NOW - 5000 }), [actLive()], { now: NOW });
eq(blocker.pulse_level, 'attention', 'blockers_open>0 → pulse=attention');
ok(hasKind(blocker.signals, 'open_blocker'), 'open_blocker signal fires');
ok(blocker.next_attention[0].kind === 'open_blocker', 'open_blocker is the top signal');

const failed = goalSignals.deriveProjectPulse(
  summary({ outcomes_failed: 1, last_activity_at: NOW }), [actLive()], { now: NOW });
eq(failed.pulse_level, 'attention', 'outcomes_failed>0 → pulse=attention');
ok(hasKind(failed.signals, 'failed_outcome'), 'failed_outcome signal fires');

const failedTask = goalSignals.deriveProjectPulse(
  summary({ tasks_failed: 1, last_activity_at: NOW }), [], { now: NOW });
ok(hasKind(failedTask.signals, 'failed_task'), 'failed_task signal fires');
eq(failedTask.pulse_level, 'attention', 'tasks_failed>0 → pulse=attention');

const conflict = goalSignals.deriveProjectPulse(
  summary({ conflicts_open: 1 }), [], { now: NOW });
ok(hasKind(conflict.signals, 'open_conflict'), 'open_conflict signal fires');
eq(conflict.pulse_level, 'attention', 'conflicts_open>0 → pulse=attention');

// Multiple attention signals at once → still pulse=attention, sorted to next_attention.
const stacked = goalSignals.deriveProjectPulse(
  summary({ blockers_open: 1, outcomes_failed: 1, conflicts_open: 1, tasks_failed: 1 }), [], { now: NOW });
eq(stacked.pulse_level, 'attention', 'multiple attention causes → pulse=attention');
ok(stacked.signals.filter(s => s.severity === 'attention').length >= 4,
   '4 attention signals stack');
eq(stacked.next_attention.length, 3, 'next_attention capped at 3');

// ---------------------------------------------------------------------------
// Part C — watch signals
// ---------------------------------------------------------------------------

console.log('\n==> Part C: watch signals');

// Live agent + 0 active task.
const liveSummary = summary({
  last_activity_at: NOW - 10_000,
  agent_activity: { total: 2, by_family: { live: 2, recent: 0, inactive: 0, dead: 0, unknown: 0 }, by_app: { mcp: 1, 'claude-code': 1, codex: 0 }, last_activity_at: NOW - 10_000 },
});
const liveNoTask = goalSignals.deriveProjectPulse(liveSummary, [actLive(), actLive()], { now: NOW });
eq(liveNoTask.pulse_level, 'watch', 'live agent + 0 task → pulse=watch');
ok(hasKind(liveNoTask.signals, 'live_agents_no_active_task'), 'live_agents_no_active_task signal fires');

// Live agent + active task → no live_agents_no_active_task signal.
const liveWithTask = goalSignals.deriveProjectPulse(
  summary({ tasks_running: 1, last_activity_at: NOW - 10_000,
    agent_activity: { total: 1, by_family: { live: 1, recent: 0, inactive: 0, dead: 0, unknown: 0 }, by_app: { mcp: 1, 'claude-code': 0, codex: 0 }, last_activity_at: NOW - 10_000 },
  }), [actLive()], { now: NOW });
ok(!hasKind(liveWithTask.signals, 'live_agents_no_active_task'),
   'live_agents_no_active_task suppressed when a task is running');

// In-flight task with old activity → inflight_no_recent_activity (watch).
const stale = goalSignals.deriveProjectPulse(
  summary({ tasks_running: 1, last_activity_at: NOW - 60 * 60 * 1000 }),
  [actLive()],
  { now: NOW, staleActivityMs: 30 * 60 * 1000 },
);
eq(stale.pulse_level, 'watch', 'inflight task + 60min idle → pulse=watch');
ok(hasKind(stale.signals, 'inflight_no_recent_activity'),
   'inflight_no_recent_activity signal fires');

// In-flight task with recent activity → no inflight stale signal.
const fresh = goalSignals.deriveProjectPulse(
  summary({ tasks_running: 1, last_activity_at: NOW - 60_000 }),
  [actLive()],
  { now: NOW, staleActivityMs: 30 * 60 * 1000 },
);
ok(!hasKind(fresh.signals, 'inflight_no_recent_activity'),
   'inflight_no_recent_activity suppressed when activity is fresh');

// Tasks waiting review.
const review = goalSignals.deriveProjectPulse(
  summary({ tasks_waiting_review: 2, last_activity_at: NOW - 5000,
    agent_activity: { total: 1, by_family: { live: 1, recent: 0, inactive: 0, dead: 0, unknown: 0 }, by_app: { mcp: 1, 'claude-code': 0, codex: 0 }, last_activity_at: NOW - 5000 },
  }), [actLive()], { now: NOW });
ok(hasKind(review.signals, 'waiting_review'), 'waiting_review signal fires');
eq(review.pulse_level, 'watch', 'waiting_review → pulse=watch');

// Stale heartbeat.
const staleHeart = goalSignals.deriveProjectPulse(
  summary({ agents_stale: 1, last_activity_at: NOW - 5000 }),
  [actLive()], { now: NOW });
ok(hasKind(staleHeart.signals, 'stale_heartbeat'), 'stale_heartbeat signal fires');
eq(staleHeart.pulse_level, 'watch', 'stale_heartbeat → pulse=watch');

// Attention beats watch in pulse_level.
const both = goalSignals.deriveProjectPulse(
  summary({ blockers_open: 1, agents_stale: 1, last_activity_at: NOW - 5000 }),
  [actLive()], { now: NOW });
eq(both.pulse_level, 'attention', 'blocker + stale → pulse=attention (attention dominates)');
eq(both.next_attention[0].severity, 'attention',
   'next_attention[0] is the attention signal, not the watch');

// ---------------------------------------------------------------------------
// Part D — ok evidence
// ---------------------------------------------------------------------------

console.log('\n==> Part D: ok evidence');

// "Healthy active project" + recent live activity → ok with
// recently_active info. Must include tasks_running > 0 so the
// "live agents but no active task" watch signal does NOT fire.
const quietRecent = goalSignals.deriveProjectPulse(
  summary({
    tasks_running: 1,
    last_activity_at: NOW - 10_000,
    agent_activity: { total: 1, by_family: { live: 1, recent: 0, inactive: 0, dead: 0, unknown: 0 }, by_app: { mcp: 1, 'claude-code': 0, codex: 0 }, last_activity_at: NOW - 10_000 },
  }),
  [actLive()],
  { now: NOW, recentActivityMs: 60_000 },
);
eq(quietRecent.pulse_level, 'ok', 'healthy active project + recent activity → pulse=ok');
ok(hasKind(quietRecent.signals, 'recently_active'), 'recently_active info signal fires');

// Same shape but old activity → ok with no info signal (no positive
// freshness to surface; absence of warnings alone isn't ok-evidence).
// staleActivityMs is bumped above 5 min so the inflight watch doesn't
// fire either.
const quietOld = goalSignals.deriveProjectPulse(
  summary({
    tasks_running: 1,
    last_activity_at: NOW - 5 * 60 * 1000,
    agent_activity: { total: 1, by_family: { live: 1, recent: 0, inactive: 0, dead: 0, unknown: 0 }, by_app: { mcp: 1, 'claude-code': 0, codex: 0 }, last_activity_at: NOW - 5 * 60 * 1000 },
  }),
  [actLive()],
  { now: NOW, staleActivityMs: 30 * 60 * 1000, recentActivityMs: 60_000 },
);
eq(quietOld.pulse_level, 'ok', 'healthy active project + old activity → pulse=ok');
ok(!hasKind(quietOld.signals, 'recently_active'),
   'recently_active suppressed when activity is older than recentActivityMs');

// ok evidence is suppressed when watch/attention exists.
const watchOverridesOk = goalSignals.deriveProjectPulse(
  summary({
    last_activity_at: NOW - 10_000,
    agents_stale: 1,
    agent_activity: { total: 1, by_family: { live: 1, recent: 0, inactive: 0, dead: 0, unknown: 0 }, by_app: { mcp: 1, 'claude-code': 0, codex: 0 }, last_activity_at: NOW - 10_000 },
  }),
  [actLive()],
  { now: NOW },
);
ok(!hasKind(watchOverridesOk.signals, 'recently_active'),
   'recently_active suppressed when a watch signal also fires');

// ---------------------------------------------------------------------------
// Part E — registry-wide pulse (Unassigned active agents)
// ---------------------------------------------------------------------------

console.log('\n==> Part E: registry pulse');

const noUnassigned = goalSignals.deriveRegistryPulse([
  { state_family: 'inactive' }, { state_family: 'dead' },
]);
eq(noUnassigned.signals.length, 0,
   'registry pulse: no live/recent unassigned → no signal');

const someUnassigned = goalSignals.deriveRegistryPulse([
  { state_family: 'live' }, { state_family: 'recent' }, { state_family: 'inactive' },
]);
ok(hasKind(someUnassigned.signals, 'unassigned_active_agent'),
   'registry pulse: unassigned_active_agent fires when ≥1 live/recent unassigned');
eq(someUnassigned.signals[0].severity, 'watch',
   'unassigned_active_agent severity=watch');

const messy = goalSignals.deriveRegistryPulse([null, undefined, {}]);
eq(messy.signals.length, 0, 'registry pulse: tolerates messy input without throwing');

// ---------------------------------------------------------------------------
// Part F — read-only invariants
// ---------------------------------------------------------------------------

console.log('\n==> Part F: read-only invariants');

const afterCairn  = safeMtime(realCairnDb);
const afterClaude = safeMtime(realClaude);
const afterCodex  = safeMtime(realCodex);
if (beforeCairn != null)  eq(afterCairn,  beforeCairn,  '~/.cairn/cairn.db mtime unchanged');
if (beforeClaude != null) eq(afterClaude, beforeClaude, '~/.claude mtime unchanged');
if (beforeCodex != null)  eq(afterCodex,  beforeCodex,  '~/.codex mtime unchanged');

const src = fs.readFileSync(path.join(root, 'goal-signals.cjs'), 'utf8');
ok(!/\.run\s*\(/.test(src),     'goal-signals.cjs has no .run(');
ok(!/\.exec\s*\(/.test(src),    'goal-signals.cjs has no .exec(');
ok(!/\.prepare\s*\(/.test(src), 'goal-signals.cjs has no .prepare(');
ok(!/\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i.test(src),
   'goal-signals.cjs has no SQL mutation keywords');
ok(!/writeFileSync|writeFile\b|appendFile/.test(src),
   'goal-signals.cjs writes no files');
ok(!/require\(['"]child_process['"]\)/.test(src),
   'goal-signals.cjs does not require child_process');

console.log(`\n==> ${asserts - fails}/${asserts} assertions passed`);
if (fails > 0) {
  console.error(`FAIL: ${fails} assertion(s) failed`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('PASS');
