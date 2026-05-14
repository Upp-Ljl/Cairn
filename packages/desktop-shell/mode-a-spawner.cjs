'use strict';

/**
 * mode-a-spawner.cjs — Cairn spawns a CC subprocess for Mode A.
 *
 * CEO 鸭总 2026-05-14: "我现在就在 A，为什么不开始干？为什么还要我手点？
 * 你为什么不控制 cmd 的 Claude Code？"
 *
 * Prior Mode A could dispatch to an ACTIVE agent OR sit silent if there
 * wasn't one. Sitting silent means the user must manually open a CC
 * terminal in the project, type a wake message, and prompt CC to check
 * inbox. That's a prompt generator, not a daemon — explicit failure
 * per CEO memories:
 *   - "Cairn drives CC, not a prompt generator"
 *   - "Cairn is daemon-class app, not CLI"
 *   - "用户做中间人 = 设计失败"
 *
 * This module fills the gap: when mode-a-loop.decideNextDispatch
 * returns `no_agent`, the tick calls spawnModeAWorker which
 * `launchWorker`s a `claude --print` subprocess in the project root
 * with a boot prompt that tells the spawned agent to register itself
 * and process its inbox. The user does nothing.
 *
 * Design (subagent verdict 2026-05-14):
 *   - Pre-assign a `cairn-session-<12hex>` agent_id and pass it via
 *     `CAIRN_SESSION_AGENT_ID` env var. mcp-server's presence.ts
 *     already reads this env var and inserts its own ACTIVE process
 *     row at boot. No pre-insert needed from this side — let the
 *     spawned agent be the source of truth for its own row.
 *   - Cooldown: don't re-spawn within 60s per project (handles tick
 *     fire rate of 30s + bounds runaway-on-failure).
 *   - Live-run check via launcher.getWorkerRun: if a previous spawn
 *     is still `running` / `queued`, skip.
 *   - All decisions logged via cairn-log so panel "live run log" can
 *     surface spawn events alongside everything else.
 */

const crypto = require('node:crypto');
const launcher = require('./worker-launcher.cjs');
// 2026-05-14 Phase 1 stream-json: Mode A uses a dedicated launcher that
// owns its own I/O (stdin held open, NDJSON parsed from stdout, raw
// events → stream_events.jsonl, text-only → tail.log). Mode B continues
// to use worker-launcher with --print — unaffected.
const streamLauncher = require('./claude-stream-launcher.cjs');
// Phase 2 (2026-05-14): durable (project_id, plan_id) → session_id map
// for --resume. Lookup before spawn, persist on result event.
const sessionStore = require('./mode-a-session-store.cjs');
const cairnLog = require('./cairn-log.cjs');

const SPAWN_COOLDOWN_MS = 60_000;

/** project_id → { run_id, agent_id, spawned_at } */
const _spawnState = new Map();

function _newAgentId() {
  return 'cairn-session-' + crypto.randomBytes(6).toString('hex');
}

/**
 * Build the boot prompt that tells the spawned CC what to do.
 *
 * Keep it short and unambiguous. CC reads this from stdin under
 * `claude --print` mode — `--print` runs one turn, captures the
 * output, exits. So we need CC to do EVERYTHING in this single turn:
 * register, read inbox, create task, execute, evaluate.
 *
 * That's a lot for one turn. For the MVP we ask CC to at least
 * register + read inbox + start the first step. Long-form execution
 * across many turns is a follow-up (will need persistent CC
 * sessions, not --print one-shots).
 */
function buildBootPrompt(project, plan, agentId, profile) {
  const step = plan && Array.isArray(plan.steps) && plan.steps[plan.current_idx || 0];
  const stepLabel = step ? step.label : '(next plan step)';
  const projectRoot = project.project_root || project.path || '(unknown)';
  const lines = [
    '# Cairn Mode A — Auto-spawned worker',
    '',
    '你是 Cairn Mode A 自动 spawn 的 Claude Code worker。',
    '用户没有手动开 CC session — Cairn 主动起的，你直接干活。',
    '',
    '## Your identity',
    '- agent_id: `' + agentId + '`',
    '- 这个 id 已经通过 CAIRN_SESSION_AGENT_ID env 注入到 mcp-server 启动里',
    '- mcp-server 会自动在 processes 表注册你为 ACTIVE，不需要你手动调',
    '  cairn.process.register',
    '',
    '## Project context',
    '- project_root: `' + projectRoot + '`',
    '- project_id: `' + project.id + '`',
    '',
  ];
  // 2026-05-14 Q1 fix: inject CAIRN.md profile content so CC's single
  // turn actually uses the project charter. Each section is optional;
  // omitted entirely if the profile didn't load (no CAIRN.md present).
  if (profile && typeof profile === 'object') {
    if (typeof profile.whole_sentence === 'string' && profile.whole_sentence.trim()) {
      lines.push('## Project north star (CAIRN.md ## Whole)');
      lines.push('> ' + profile.whole_sentence.trim());
      lines.push('');
    }
    const constraints = Array.isArray(profile.constraints) ? profile.constraints.filter(s => typeof s === 'string' && s.trim()) : [];
    if (constraints.length > 0) {
      lines.push('## Hard constraints (CAIRN.md)');
      for (const c of constraints.slice(0, 8)) lines.push('- ' + c.trim());
      lines.push('');
    }
    const auth = profile.authority || {};
    const escalate = Array.isArray(auth.escalate) ? auth.escalate.filter(s => typeof s === 'string' && s.trim()) : [];
    if (escalate.length > 0) {
      lines.push('## Always escalate (CAIRN.md ## Authority)');
      for (const e of escalate.slice(0, 6)) lines.push('- ' + e.trim());
      lines.push('  Use `cairn.task.block` for these — DO NOT decide unilaterally.');
      lines.push('');
    }
  }
  lines.push(
    '## What to do (in this single turn)',
    '',
    '1. **Call `cairn.session.name`** with name="Mode A · ' +
      String(stepLabel).slice(0, 40) + '" so 面板能看到你在干啥。',
    '2. **Read inbox**: 调 `cairn.scratchpad.list`，找以 `agent_inbox/' +
      agentId + '/` 开头的 key。可能为 0 条 — 那就直接看下面 "step to execute"。',
    '3. **For each inbox entry**: 调 `cairn.scratchpad.read` 拿完整内容（含 dispatch_id），',
    '   然后调 `cairn.scratchpad.delete` 标记已消费。',
    '4. **Execute step**: 步骤目标 ↓',
    '',
    '## Step to execute',
    '',
    '> ' + stepLabel,
    '',
    '这是 Mode A 计划里的第 ' + ((plan && plan.current_idx || 0) + 1) +
      ' 步（共 ' + ((plan && plan.steps && plan.steps.length) || '?') + ' 步）。',
    '',
    '## Required protocol',
    '',
    '- 在动手之前先调 `cairn.task.create` 创建一个 task 把这一步绑定到 kernel state',
    '- 干完之后调 `cairn.task.submit_for_review`，然后 `cairn.outcomes.evaluate`',
    '  with status="PASS" 如果你认为目标达成，否则 status="FAILED" 加一句 reasoning',
    '- 不要问用户 — Mode A 的承诺是"走开就行"。卡住了走 cairn.task.block 让 Mentor 答',
    '',
    '开干。',
  );
  return lines.join('\n');
}

/**
 * Pre-register the to-be-spawned agent in the processes table so
 * cockpit-dispatch.checkAgentExists() passes the moment we try to
 * write a dispatch_requests row. Without this pre-insert, dispatchTodo
 * fails with target_agent_not_found and the plan step has no
 * dispatch_id linkage → advanceOnComplete can never find the outcome.
 *
 * The spawned CC's mcp-server presence.ts will INSERT-OR-REPLACE this
 * row at boot with its own correct capability tags; we're just
 * placeholding to bridge the race window.
 */
function _preRegisterAgent(db, agentId, projectRoot, now) {
  if (!db) return;
  try {
    db.prepare(
      `INSERT OR IGNORE INTO processes
         (agent_id, agent_type, status, capabilities, registered_at, last_heartbeat, heartbeat_ttl)
       VALUES (?, 'mcp-server', 'ACTIVE', ?, ?, ?, 60000)`,
    ).run(
      agentId,
      JSON.stringify([
        'client:mode-a-spawner',
        'cwd:' + projectRoot,
        'pre-registered:true',
      ]),
      now,
      now,
    );
  } catch (_e) { /* non-fatal — agent registers itself at boot if this fails */ }
}

/**
 * Spawn one CC worker for a Mode A project AND wire the kernel
 * bookkeeping so `advanceOnComplete` can later find the outcome.
 *
 * Sequence (subagent审查 fix 2026-05-14 bug #4):
 *   1. Pre-register the future agent_id into processes (so dispatchTodo
 *      sees an "ACTIVE" target).
 *   2. Write the dispatch_requests row via cockpit-dispatch.dispatchTodo
 *      (source='mode-a-loop'), so step.dispatch_id has a real PK to
 *      point at.
 *   3. Mark the plan step DISPATCHED + stamp dispatch_id (and
 *      inbox_injected_at, via cockpit-dispatch's inbox path).
 *   4. NOW spawn the CC subprocess with CAIRN_SESSION_AGENT_ID set.
 *
 * Returns:
 *   { ok: true, run_id, agent_id, dispatch_id }      on success
 *   { ok: false, error: 'cooldown', ms_remaining }   if cooldown active
 *   { ok: false, error: 'already_running', run_id }  if previous spawn still alive
 *   { ok: false, error: 'launch_failed', detail }    if worker-launcher rejected
 *   { ok: false, error: 'dispatch_failed', detail }  if cockpit-dispatch rejected
 *   { ok: false, error: '<other>' }                  for input / cwd issues
 */
function spawnModeAWorker(input, opts) {
  const o = opts || {};
  const { project, plan, db, tables } = input || {};
  if (!project || !project.id) return { ok: false, error: 'project_required' };
  const cwd = project.project_root || project.path;
  if (!cwd || cwd === '(unknown)') return { ok: false, error: 'project_root_missing' };

  const now = o.nowFn ? o.nowFn() : Date.now();

  // 2026-05-14 Q2b fix: cooldown key includes plan_id + current_idx so
  // a fresh step (e.g. step 0 → step 1 advance) can spawn immediately
  // without waiting for the prior step's cooldown. Without this, 15+
  // ACTIVE rows accumulated for one project because the per-project
  // cooldown only blocked re-spawns of the SAME step but every
  // stale-reset of the same step still passed (after 60s).
  const planId = plan && plan.plan_id ? plan.plan_id : 'no-plan';
  const stepIdx = plan && typeof plan.current_idx === 'number' ? plan.current_idx : 0;
  const cooldownKey = project.id + '/' + planId + '/' + stepIdx;

  // Idempotence: if previous spawn for this (project, plan, step) is
  // still alive or its cooldown is still active, skip. Different step
  // → new key → immediate spawn allowed.
  const existing = _spawnState.get(cooldownKey);
  if (existing) {
    try {
      // Use streamLauncher.getStreamRun (on-disk shape compatible with
      // worker-launcher's getWorkerRun — both read run.json).
      const run = streamLauncher.getStreamRun(existing.run_id, { home: o.home });
      if (run && (run.status === 'running' || run.status === 'queued')) {
        return { ok: false, error: 'already_running', run_id: existing.run_id };
      }
    } catch (_e) { /* if run lookup throws, fall through to cooldown */ }
    const sinceSpawn = now - existing.spawned_at;
    if (sinceSpawn < SPAWN_COOLDOWN_MS) {
      return { ok: false, error: 'cooldown', ms_remaining: SPAWN_COOLDOWN_MS - sinceSpawn };
    }
  }

  const agentId = _newAgentId();
  const prompt = buildBootPrompt(project, plan, agentId, input.profile);

  // ---- BOOKKEEPING FIRST (advanceOnComplete needs the linkage) ----
  // 1. Pre-register the agent_id so dispatchTodo's checkAgentExists
  //    finds an ACTIVE row.
  _preRegisterAgent(db, agentId, cwd, now);

  // 2. Write the dispatch_requests row + agent_inbox via the same
  //    code path used when an ACTIVE agent already exists.
  let dispatchId = null;
  const step = plan && Array.isArray(plan.steps) && plan.steps[plan.current_idx || 0];
  if (db && tables && step) {
    try {
      const cockpitDispatch = require('./cockpit-dispatch.cjs');
      const dr = cockpitDispatch.dispatchTodo(db, tables, {
        project_id: project.id,
        target_agent_id: agentId,
        label: step.label,
        source: 'mode-a-loop',
        todo_id: 'mode_a_step/' + (plan.plan_id || 'no-plan') + '/' + (plan.current_idx || 0),
        why: 'Mode A — auto-spawned worker',
      });
      if (dr && dr.ok && dr.dispatch_id) {
        dispatchId = dr.dispatch_id;
        // 3. Mark the plan step DISPATCHED so decideNextDispatch
        //    next tick returns 'waiting' (not 'no_agent' again) and
        //    advanceOnComplete has a dispatch_id to follow.
        try {
          const modeALoop = require('./mode-a-loop.cjs');
          modeALoop.markStepDispatched(db, project.id, plan.current_idx || 0, dispatchId, now);
        } catch (e) {
          cairnLog.warn('mode-a-spawner', 'mark_step_failed', {
            project_id: project.id, dispatch_id: dispatchId,
            message: (e && e.message) || String(e),
          });
        }
      } else {
        cairnLog.warn('mode-a-spawner', 'dispatch_pre_spawn_failed', {
          project_id: project.id,
          error: dr && dr.error,
        });
        // Without a dispatch row the plan can't advance. Bail
        // BEFORE spawning so we don't strand a CC subprocess
        // that has no way to update kernel state.
        return { ok: false, error: 'dispatch_failed', detail: dr && dr.error };
      }
    } catch (e) {
      cairnLog.error('mode-a-spawner', 'dispatch_pre_spawn_threw', {
        project_id: project.id,
        message: (e && e.message) || String(e),
      });
      return { ok: false, error: 'dispatch_threw', detail: (e && e.message) || String(e) };
    }
  }
  // ---- END BOOKKEEPING ----

  // Pass the pre-assigned agent_id via env var. mcp-server's
  // presence.ts reads CAIRN_SESSION_AGENT_ID at boot and inserts its
  // own ACTIVE process row + auto-names the session — overwriting
  // our pre-registered placeholder.
  const env = Object.assign({}, process.env, {
    CAIRN_SESSION_AGENT_ID: agentId,
    CAIRN_MODE_A_SPAWN: '1',
    CAIRN_MODE_A_PROJECT_ID: project.id,
  });

  // Phase 2: look up persisted session_id for (project, plan). If we
  // have one, the launcher will pass `--resume <id>` to claude so it
  // picks up the SAME conversation it had on the prior plan step.
  // First step of a plan: no row → fresh spawn, session_id captured
  // from the result event below and persisted then.
  const planIdForResume = plan && plan.plan_id ? plan.plan_id : null;
  const persistedSessionId = (db && planIdForResume)
    ? sessionStore.getSessionId(db, project.id, planIdForResume)
    : null;

  let launchRes;
  try {
    // Use the stream-json launcher (Phase 1 2026-05-14). Argv hardcoded
    // by streamLauncher: --output-format stream-json --input-format
    // stream-json --verbose --permission-mode bypassPermissions
    // --mcp-config <tmp> --strict-mcp-config [--resume <id>].
    launchRes = streamLauncher.launchStreamWorker({
      cwd,
      prompt,
      iteration_id: 'mode-a:' + project.id + ':' + (plan && plan.plan_id || 'no-plan'),
      project_id: project.id,
      env,
      resumeSessionId: persistedSessionId || undefined,
    }, {
      home: o.home,
      // Capture session_id from the first `result` event and persist
      // it so the NEXT plan step resumes the same CC session.
      onEvent: (ev) => {
        if (!ev || ev.type !== 'result') return;
        if (typeof ev.session_id !== 'string' || !ev.session_id) return;
        if (!db || !planIdForResume) return;
        // Skip if we already have the same one (idempotent — `result`
        // can fire more than once over a multi-turn session).
        const prior = sessionStore.getSessionId(db, project.id, planIdForResume);
        if (prior === ev.session_id) return;
        const res = sessionStore.setSessionId(
          db, project.id, planIdForResume, ev.session_id, launchRes && launchRes.run_id,
        );
        if (res && res.ok) {
          cairnLog.info('mode-a-spawner', 'session_id_persisted', {
            project_id: project.id,
            plan_id: planIdForResume,
            session_id: ev.session_id,
            was_resume: !!persistedSessionId,
          });
        } else {
          cairnLog.warn('mode-a-spawner', 'session_id_persist_failed', {
            project_id: project.id,
            plan_id: planIdForResume,
            error: res && res.error,
          });
        }
      },
    });
  } catch (e) {
    cairnLog.error('mode-a-spawner', 'launch_threw', {
      project_id: project.id,
      message: (e && e.message) || String(e),
    });
    return { ok: false, error: 'launch_threw', detail: (e && e.message) || String(e) };
  }

  if (!launchRes || !launchRes.ok) {
    cairnLog.warn('mode-a-spawner', 'launch_failed', {
      project_id: project.id,
      error: launchRes && launchRes.error,
      provider: launchRes && launchRes.provider,
    });
    return { ok: false, error: 'launch_failed', detail: launchRes && launchRes.error };
  }

  _spawnState.set(cooldownKey, {
    run_id: launchRes.run_id,
    agent_id: agentId,
    spawned_at: now,
    dispatch_id: dispatchId,
    plan_id: planId,
    step_idx: stepIdx,
  });
  cairnLog.info('mode-a-spawner', 'worker_spawned', {
    project_id: project.id,
    run_id: launchRes.run_id,
    agent_id: agentId,
    dispatch_id: dispatchId,
    cwd,
    step_label: (plan && plan.steps && plan.steps[plan.current_idx || 0] || {}).label || null,
    resume_session_id: persistedSessionId || null,
  });
  return {
    ok: true,
    run_id: launchRes.run_id,
    agent_id: agentId,
    dispatch_id: dispatchId,
    resume_session_id: persistedSessionId || null,
  };
}

module.exports = {
  spawnModeAWorker,
  buildBootPrompt,
  SPAWN_COOLDOWN_MS,
  // Exposed for tests; not for production use.
  _spawnState,
};
