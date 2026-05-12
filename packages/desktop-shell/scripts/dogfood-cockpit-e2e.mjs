#!/usr/bin/env node
/**
 * dogfood-cockpit-e2e.mjs — Phase 7 of panel-cockpit-redesign.
 *
 * End-to-end exercise of all 7 phases' cockpit modules, against a real
 * disposable git repo + an in-memory SQLite seeded with realistic state.
 *
 * Boots NO Electron — calls the module-layer functions directly. The
 * actual panel.html rendering paths are exercised by smoke-electron-boot.
 *
 * Coverage:
 *   Phase 1 — cockpit-state payload shape + autopilot transitions
 *   Phase 2 — (UI; not testable headless beyond shape)
 *   Phase 3 — cockpit-steer inject + clipboard fallback
 *   Phase 4 — cockpit-rewind preview + perform
 *   Phase 5 — mentor-policy 5 rules + ackEscalation
 *   Phase 6 — registry cockpit settings + LLM helper prompts (gating only)
 *   Phase 7 — onboarding state derivation + goal-gate + activity sort
 *
 * Target: ≥40 substantive assertions. Goal: PASS without filler.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dsRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(dsRoot, '..', '..');

const Database = require(path.join(repoRoot, 'packages', 'daemon', 'node_modules', 'better-sqlite3'));
const cockpit = require(path.join(dsRoot, 'cockpit-state.cjs'));
const steer = require(path.join(dsRoot, 'cockpit-steer.cjs'));
const rewind = require(path.join(dsRoot, 'cockpit-rewind.cjs'));
const policy = require(path.join(dsRoot, 'mentor-policy.cjs'));
const llm = require(path.join(dsRoot, 'cockpit-llm-helpers.cjs'));
const registry = require(path.join(dsRoot, 'registry.cjs'));

let asserts = 0, fails = 0;
const failures = [];
function ok(c, l) {
  asserts++;
  if (c) process.stdout.write(`  ok    ${l}\n`);
  else   { fails++; failures.push(l); process.stdout.write(`  FAIL  ${l}\n`); }
}
function header(t) { process.stdout.write(`\n${'='.repeat(64)}\n${t}\n${'='.repeat(64)}\n`); }
function section(t) { process.stdout.write(`\n[${t}]\n`); }

header('dogfood-cockpit-e2e — Phase 7 (panel-cockpit-redesign)');

// ---------------------------------------------------------------------------
// Set up disposable git repo (for rewind tests)
// ---------------------------------------------------------------------------
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-cockpit-e2e-'));
function gitR(args) {
  return spawnSync('git', args, {
    cwd: tmpRoot, encoding: 'utf8', timeout: 15000,
    env: { ...process.env, GIT_AUTHOR_NAME: 'e2e', GIT_AUTHOR_EMAIL: 'e@e', GIT_COMMITTER_NAME: 'e2e', GIT_COMMITTER_EMAIL: 'e@e' },
  });
}
gitR(['init', '-q']);
gitR(['config', 'commit.gpgsign', 'false']);
fs.writeFileSync(path.join(tmpRoot, 'a.txt'), 'v1\n');
gitR(['add', '.']);
gitR(['commit', '-q', '-m', 'v1']);
const SHA1 = gitR(['rev-parse', 'HEAD']).stdout.trim();
fs.writeFileSync(path.join(tmpRoot, 'a.txt'), 'v2\n');
gitR(['commit', '-aq', '-m', 'v2']);
const SHA2 = gitR(['rev-parse', 'HEAD']).stdout.trim();

// ---------------------------------------------------------------------------
// Set up in-memory SQLite with full schema subset
// ---------------------------------------------------------------------------
const db = new Database(':memory:');
db.exec(`
  CREATE TABLE processes (
    agent_id TEXT PRIMARY KEY, agent_type TEXT, capabilities TEXT,
    status TEXT NOT NULL, registered_at INTEGER NOT NULL,
    last_heartbeat INTEGER NOT NULL, heartbeat_ttl INTEGER NOT NULL
  );
  CREATE TABLE tasks (
    task_id TEXT PRIMARY KEY, intent TEXT NOT NULL, state TEXT NOT NULL,
    parent_task_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    created_by_agent_id TEXT, metadata_json TEXT
  );
  CREATE TABLE blockers (
    blocker_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, question TEXT,
    status TEXT NOT NULL, raised_at INTEGER NOT NULL, answered_at INTEGER, answer TEXT
  );
  CREATE TABLE outcomes (
    task_id TEXT PRIMARY KEY, status TEXT NOT NULL, submitted_at INTEGER,
    evaluated_at INTEGER, criteria_json TEXT
  );
  CREATE TABLE conflicts (
    id TEXT PRIMARY KEY, detected_at INTEGER NOT NULL, conflict_type TEXT,
    agent_a TEXT, agent_b TEXT, paths_json TEXT, summary TEXT,
    status TEXT NOT NULL, resolved_at INTEGER, resolution TEXT
  );
  CREATE TABLE dispatch_requests (
    id TEXT PRIMARY KEY, status TEXT NOT NULL, target_agent TEXT,
    created_at INTEGER NOT NULL, decided_at INTEGER
  );
  CREATE TABLE checkpoints (
    id TEXT PRIMARY KEY, task_id TEXT, git_head TEXT,
    snapshot_status TEXT NOT NULL, created_at INTEGER NOT NULL, label TEXT
  );
  CREATE TABLE scratchpad (
    key TEXT PRIMARY KEY, value_json TEXT, value_path TEXT, task_id TEXT,
    expires_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
`);
const tables = new Set([
  'processes', 'tasks', 'blockers', 'outcomes',
  'conflicts', 'dispatch_requests', 'checkpoints', 'scratchpad',
]);

const PROJ = {
  id: 'p_e2e', label: 'cockpit e2e', project_root: tmpRoot,
  db_path: ':memory:', agent_id_hints: ['cairn-session-aaa', 'cairn-session-bbb'],
};
const AGENT_A = 'cairn-session-aaa';
const AGENT_B = 'cairn-session-bbb';
const NOW = Date.now();

// Seed processes + tasks + a checkpoint
db.prepare(`INSERT INTO processes (agent_id, agent_type, status, registered_at, last_heartbeat, heartbeat_ttl) VALUES (?, 'mcp-server', 'ACTIVE', ?, ?, 60000)`).run(AGENT_A, NOW - 300000, NOW - 1000);
db.prepare(`INSERT INTO processes (agent_id, agent_type, status, registered_at, last_heartbeat, heartbeat_ttl) VALUES (?, 'mcp-server', 'ACTIVE', ?, ?, 60000)`).run(AGENT_B, NOW - 200000, NOW - 2000);

db.prepare(`INSERT INTO tasks (task_id, intent, state, created_at, updated_at, created_by_agent_id) VALUES (?, ?, ?, ?, ?, ?)`).run('t_r1', 'running task', 'RUNNING', NOW - 100000, NOW - 5000, AGENT_A);
db.prepare(`INSERT INTO tasks (task_id, intent, state, created_at, updated_at, created_by_agent_id) VALUES (?, ?, ?, ?, ?, ?)`).run('t_d1', 'done task', 'DONE', NOW - 90000, NOW - 50000, AGENT_A);
db.prepare(`INSERT INTO tasks (task_id, intent, state, created_at, updated_at, created_by_agent_id) VALUES (?, ?, ?, ?, ?, ?)`).run('t_b1', 'blocked task', 'BLOCKED', NOW - 60000, NOW - 3000, AGENT_B);

db.prepare(`INSERT INTO checkpoints (id, task_id, git_head, snapshot_status, created_at, label) VALUES (?, ?, ?, 'READY', ?, ?)`).run('ck_e2e_1', 't_d1', SHA1, NOW - 80000, 'before v2');

// ---------------------------------------------------------------------------
// Phase 1 — cockpit-state shape + autopilot transitions
// ---------------------------------------------------------------------------
section('Phase 1 — cockpit-state');
const s_no_goal = cockpit.buildCockpitState(db, tables, PROJ, null, PROJ.agent_id_hints, {});
ok(s_no_goal.autopilot_status === 'NO_GOAL', 'no goal → NO_GOAL');

const s_working = cockpit.buildCockpitState(db, tables, PROJ, 'build poker arena', PROJ.agent_id_hints, {});
ok(s_working.autopilot_status === 'AGENT_WORKING', 'goal + agents → AGENT_WORKING');
ok(s_working.agents.length === 2, '2 agents surfaced');
ok(s_working.progress.tasks_total === 3, '3 tasks total');
ok(s_working.progress.tasks_running === 1, '1 running');
ok(s_working.progress.tasks_blocked === 1, '1 blocked');
ok(s_working.progress.tasks_done === 1, '1 done');
ok(s_working.current_task && s_working.current_task.task_id === 't_r1', 'current_task = t_r1');
ok(s_working.checkpoints.length === 1, '1 checkpoint surfaced');
ok(s_working.checkpoints[0].git_head === SHA1, 'checkpoint git_head matches');

// ---------------------------------------------------------------------------
// Phase 3 — cockpit-steer
// ---------------------------------------------------------------------------
section('Phase 3 — steer');
const clipboardLog = [];
const r_steer = steer.steerAgent(db, tables, {
  project_id: PROJ.id, agent_id: AGENT_A, message: 'try sanity check',
}, { copyToClipboard: (t) => clipboardLog.push(t) });
ok(r_steer.ok, 'steer ok');
ok(r_steer.delivered.includes('inject') && r_steer.delivered.includes('clipboard'), 'both delivery channels');
ok(clipboardLog.length === 1, 'clipboard wrote once');
ok(r_steer.scratchpad_key.startsWith(`agent_inbox/${AGENT_A}/`), 'inbox key prefix correct');

// Activity feed surfaces the steer
const s_after_steer = cockpit.buildCockpitState(db, tables, PROJ, 'build poker arena', PROJ.agent_id_hints, {});
const steerEvents = s_after_steer.activity.filter(e => e.kind === 'user_steer');
ok(steerEvents.length === 1, 'activity feed contains 1 user_steer event');

// ---------------------------------------------------------------------------
// Phase 4 — cockpit-rewind
// ---------------------------------------------------------------------------
section('Phase 4 — rewind');
const p_rew = rewind.previewRewind(db, tables, PROJ, 'ck_e2e_1');
ok(p_rew.ok, 'rewind preview ok');
ok(p_rew.git_head_reachable, 'git_head reachable in tmp repo');
ok(p_rew.working_tree.dirty === false, 'tmp repo clean before rewind');

const r_rew = rewind.performRewind(db, tables, PROJ, 'ck_e2e_1');
ok(r_rew.ok, 'rewind perform ok');
ok(r_rew.mode === 'checkout', 'rewind mode = checkout');
const fileContent = fs.readFileSync(path.join(tmpRoot, 'a.txt'), 'utf8').replace(/\r\n/g, '\n');
ok(fileContent === 'v1\n', 'file content restored to v1');

// ---------------------------------------------------------------------------
// Phase 5 — mentor-policy
// ---------------------------------------------------------------------------
section('Phase 5 — mentor-policy');
const taskBlocked = {
  task_id: 't_b1', intent: 'blocked task', state: 'BLOCKED',
  created_at: NOW - 60000, updated_at: NOW - 3000, created_by_agent_id: AGENT_B,
};
const p1 = policy.evaluatePolicy({
  db, project: PROJ, task: taskBlocked,
  openBlockers: [{ blocker_id: 'b1', question: 'use vitest or bun?', raised_at: NOW - 3000 }],
});
const dD = p1.decisions.find(d => d.rule === 'D');
ok(dD && dD.action === 'escalate', 'BLOCKED unknown q → escalate');

const taskAbort = { task_id: 't_r1', intent: 'plan', state: 'RUNNING', created_at: NOW - 100000, created_by_agent_id: AGENT_A };
const p2 = policy.evaluatePolicy({
  db, project: PROJ, task: taskAbort,
  recentAgentText: ['I will run rm -rf node_modules then continue'],
});
const dF = p2.decisions.find(d => d.rule === 'F');
ok(dF && dF.action === 'escalate', 'abort keyword → escalate');
const escId = dF.escalation.id;

const ack = policy.ackEscalation(db, PROJ.id, escId);
ok(ack.ok, 'escalation acked');
const ackRow = db.prepare(`SELECT value_json FROM scratchpad WHERE key = ?`).get(`escalation/${PROJ.id}/${escId}`);
const ackBody = JSON.parse(ackRow.value_json);
ok(ackBody.status === 'ACKED', 'ack flipped status to ACKED');

// After ack, autopilot status returns to AGENT_WORKING (other escalation is still PENDING — let's keep one for further tests)
// Actually we have rule-D escalation still PENDING from p1.
const s_after_ack = cockpit.buildCockpitState(db, tables, PROJ, 'build poker arena', PROJ.agent_id_hints, {});
ok(s_after_ack.autopilot_status === 'MENTOR_BLOCKED_NEED_USER', 'still PENDING escalation → MENTOR_BLOCKED_NEED_USER');

// ---------------------------------------------------------------------------
// Phase 6 — cockpit settings + LLM helper gating
// ---------------------------------------------------------------------------
section('Phase 6 — cockpit settings + LLM gating');
const reg0 = { projects: [{ id: PROJ.id, label: PROJ.label, project_root: PROJ.project_root, db_path: PROJ.db_path, agent_id_hints: PROJ.agent_id_hints }] };
const s_def = registry.getCockpitSettings(reg0, PROJ.id);
ok(s_def.leader === 'claude-code', 'default leader');
ok(s_def.llm_helpers.tail_summary_enabled === true, 'tail_summary default ON');
ok(s_def.llm_helpers.inbox_smart_sort_enabled === false, 'inbox_smart_sort default OFF');

const set1 = registry.setCockpitSettings(reg0, PROJ.id, { leader: 'cursor' });
ok(set1.settings.leader === 'cursor', 'leader update');

const r_dis = await llm.summarizeTail({ enabled: false, tail: 'log' });
ok(r_dis.reason === 'disabled', 'disabled tail summary short-circuits');

const r_no_input = await llm.explainConflict({ enabled: true });
ok(r_no_input.reason === 'no_input', 'no_input on conflict explainer');

// Prompt shapes
const ts = llm.tailSummaryPrompt('wr_x', 'log content');
ok(ts.system && ts.user, 'tail summary prompt has system+user');
const ip = llm.inboxSortPrompt({ items: [{ kind: 'task', body: 'b' }], goal: 'g' });
ok(/JSON/i.test(ip.system), 'inbox sort prompt asks for JSON');

// ---------------------------------------------------------------------------
// Phase 7 — onboarding state derivation (logic-level)
// ---------------------------------------------------------------------------
section('Phase 7 — onboarding states');
const empty = cockpit.emptyCockpitState(null, null, 'no_project');
ok(empty.project === null, 'empty state has null project');
ok(empty.autopilot_status === 'AGENT_IDLE', 'empty state → AGENT_IDLE');
const noProj = cockpit.buildCockpitState(null, null, null, null, [], {});
ok(noProj.project === null, 'no-project empty state shape');

// Activity feed sort invariant
const allEvents = s_after_ack.activity;
ok(allEvents.every((e, i) => i === 0 || e.ts <= allEvents[i-1].ts), 'activity sorted DESC by ts');

// Multiple kinds present
const kinds = new Set(allEvents.map(e => e.kind));
ok(kinds.has('user_steer'), 'feed includes user_steer');
ok(kinds.has('escalation_raised'), 'feed includes escalation_raised');
ok(kinds.has('checkpoint_created'), 'feed includes checkpoint_created');

// ---------------------------------------------------------------------------
// Top-level shape stability
// ---------------------------------------------------------------------------
section('Top-level shape contract');
const required = ['project', 'goal', 'leader', 'autopilot_status', 'agents', 'progress', 'current_task', 'latest_mentor_nudge', 'activity', 'checkpoints', 'escalations', 'ts'];
for (const k of required) {
  ok(Object.prototype.hasOwnProperty.call(s_after_ack, k), `payload key: ${k}`);
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
db.close();
try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_e) {}

header(`${asserts - fails}/${asserts} assertions passed (${fails} failed)`);
if (fails) {
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
  process.exit(1);
}
process.exit(0);
