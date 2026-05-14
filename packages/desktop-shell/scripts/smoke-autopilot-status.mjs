#!/usr/bin/env node
/**
 * smoke-autopilot-status.mjs — derive autopilot status from goal/agents/
 * escalations/progress/modeAPhase. Covers the Mode A v2 transient states
 * (SCOUT_PLANNING / AGENT_STARTING / PLAN_PENDING_REVIEW) added 2026-05-14
 * to fix CEO 鸭总's "panel says 空闲 but I just clicked Start" complaint.
 */

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const _realHome = os.homedir();
const _realProjectsJson = path.join(_realHome, '.cairn', 'projects.json');
const _tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-autopilot-smk-'));
process.env.HOME = _tmpDir;
process.env.USERPROFILE = _tmpDir;
const _mtimeBefore = fs.existsSync(_realProjectsJson) ? fs.statSync(_realProjectsJson).mtimeMs : null;
process.on('exit', () => {
  const _mtimeAfter = fs.existsSync(_realProjectsJson) ? fs.statSync(_realProjectsJson).mtimeMs : null;
  if (_mtimeBefore !== _mtimeAfter) {
    console.error('FATAL: smoke wrote to REAL ~/.cairn/projects.json');
    process.exit(3);
  }
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dsRoot = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const cs = require(path.join(dsRoot, 'cockpit-state.cjs'));

let asserts = 0, fails = 0;
const failures = [];
function ok(c, l) {
  asserts++;
  if (c) process.stdout.write(`  ok    ${l}\n`);
  else { fails++; failures.push(l); process.stdout.write(`  FAIL  ${l}\n`); }
}
function header(t) { process.stdout.write(`\n${'='.repeat(64)}\n${t}\n${'='.repeat(64)}\n`); }
function section(t) { process.stdout.write(`\n[${t}]\n`); }

const goal = { id: 'g1', title: 'x' };
const noGoal = null;
const ALIVE = [{ status: 'ACTIVE' }];
const DEAD = [];
const NO_TASKS = { tasks_running: 0, tasks_blocked: 0, tasks_waiting_review: 0 };
const TASKS_RUNNING = { tasks_running: 1, tasks_blocked: 0, tasks_waiting_review: 0 };

header('smoke-autopilot-status (Mode A v2 UX states)');

section('1 baseline contracts (regression — must still work)');
ok(cs.deriveAutopilotStatus({ goal: noGoal, agents: DEAD, escalationsPending: 0, progress: NO_TASKS }) === cs.AUTOPILOT_STATUS.NO_GOAL, 'no goal → NO_GOAL');
ok(cs.deriveAutopilotStatus({ goal, agents: DEAD, escalationsPending: 1, progress: NO_TASKS }) === cs.AUTOPILOT_STATUS.MENTOR_BLOCKED_NEED_USER, 'pending escalations → MENTOR_BLOCKED_NEED_USER');
ok(cs.deriveAutopilotStatus({ goal, agents: DEAD, escalationsPending: 0, progress: NO_TASKS }) === cs.AUTOPILOT_STATUS.AGENT_IDLE, 'no agents + no tasks → AGENT_IDLE');
ok(cs.deriveAutopilotStatus({ goal, agents: ALIVE, escalationsPending: 0, progress: NO_TASKS }) === cs.AUTOPILOT_STATUS.AGENT_IDLE, 'agents alive but no tasks → AGENT_IDLE (regression: must NOT be WORKING)');
ok(cs.deriveAutopilotStatus({ goal, agents: ALIVE, escalationsPending: 0, progress: TASKS_RUNNING }) === cs.AUTOPILOT_STATUS.AGENT_WORKING, 'agents alive + RUNNING task → AGENT_WORKING');
ok(cs.deriveAutopilotStatus({ goal, agents: DEAD, escalationsPending: 0, progress: TASKS_RUNNING }) === cs.AUTOPILOT_STATUS.AGENT_IDLE, 'RUNNING task but no live agents → AGENT_IDLE');

section('2 Mode A v2 transient: SCOUT_PLANNING');
{
  const s = cs.deriveAutopilotStatus({ goal, agents: DEAD, escalationsPending: 0, progress: NO_TASKS, modeAPhase: 'planning' });
  ok(s === cs.AUTOPILOT_STATUS.SCOUT_PLANNING, 'phase=planning → SCOUT_PLANNING');
}
{
  // even with running tasks, planning trumps (scout drafting a NEW plan)
  const s = cs.deriveAutopilotStatus({ goal, agents: ALIVE, escalationsPending: 0, progress: TASKS_RUNNING, modeAPhase: 'planning' });
  ok(s === cs.AUTOPILOT_STATUS.SCOUT_PLANNING, 'planning trumps running tasks');
}

section('3 Mode A v2 transient: PLAN_PENDING_REVIEW');
{
  const s = cs.deriveAutopilotStatus({ goal, agents: DEAD, escalationsPending: 0, progress: NO_TASKS, modeAPhase: 'plan_pending' });
  ok(s === cs.AUTOPILOT_STATUS.PLAN_PENDING_REVIEW, 'phase=plan_pending → PLAN_PENDING_REVIEW');
}

section('4 Mode A v2 transient: AGENT_STARTING — papers over the gap');
{
  // The CEO 鸭总 2026-05-14 scenario: clicked Start, phase=running,
  // CC spawned but hasn't called cairn.task.create yet → no tasks_running.
  // BEFORE this fix: said "agent 空闲". AFTER: AGENT_STARTING.
  const s = cs.deriveAutopilotStatus({ goal, agents: ALIVE, escalationsPending: 0, progress: NO_TASKS, modeAPhase: 'running' });
  ok(s === cs.AUTOPILOT_STATUS.AGENT_STARTING, 'phase=running + no live task → AGENT_STARTING (not AGENT_IDLE)');
}
{
  // Same gap window but pre-register placeholder hasn't materialized yet
  const s = cs.deriveAutopilotStatus({ goal, agents: DEAD, escalationsPending: 0, progress: NO_TASKS, modeAPhase: 'running' });
  ok(s === cs.AUTOPILOT_STATUS.AGENT_STARTING, 'phase=running + no agents yet → AGENT_STARTING');
}
{
  // After CC creates task → should flip to AGENT_WORKING
  const s = cs.deriveAutopilotStatus({ goal, agents: ALIVE, escalationsPending: 0, progress: TASKS_RUNNING, modeAPhase: 'running' });
  ok(s === cs.AUTOPILOT_STATUS.AGENT_WORKING, 'phase=running + RUNNING task → AGENT_WORKING (graduates from STARTING)');
}

section('5 Mode A v2: escalation still trumps transient states');
{
  const s = cs.deriveAutopilotStatus({ goal, agents: ALIVE, escalationsPending: 1, progress: NO_TASKS, modeAPhase: 'running' });
  ok(s === cs.AUTOPILOT_STATUS.MENTOR_BLOCKED_NEED_USER, 'escalation > transient (red beats amber)');
}

section('6 Mode A v2: paused / idle behave like vanilla (no transient state)');
{
  const s = cs.deriveAutopilotStatus({ goal, agents: DEAD, escalationsPending: 0, progress: NO_TASKS, modeAPhase: 'paused' });
  ok(s === cs.AUTOPILOT_STATUS.AGENT_IDLE, 'phase=paused + no tasks → AGENT_IDLE (no transient)');
}
{
  const s = cs.deriveAutopilotStatus({ goal, agents: DEAD, escalationsPending: 0, progress: NO_TASKS, modeAPhase: 'idle' });
  ok(s === cs.AUTOPILOT_STATUS.AGENT_IDLE, 'phase=idle → AGENT_IDLE');
}
{
  const s = cs.deriveAutopilotStatus({ goal, agents: DEAD, escalationsPending: 0, progress: NO_TASKS });
  ok(s === cs.AUTOPILOT_STATUS.AGENT_IDLE, 'no phase given (Mode B) → vanilla AGENT_IDLE');
}

header(`${asserts - fails}/${asserts} assertions passed (${fails} failed)`);
if (fails) {
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
  process.exit(1);
}
process.exit(0);
