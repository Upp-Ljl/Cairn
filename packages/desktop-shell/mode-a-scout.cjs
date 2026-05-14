'use strict';

/**
 * mode-a-scout.cjs — Scout CC: spawn a one-shot Claude Code subprocess
 * that reads goal + CAIRN.md (Plan Shape / Plan Hard Constraints / Plan
 * Authority sections) + project root, and outputs a JSON plan draft.
 *
 * CEO 鸭总 2026-05-14 product decision (Mode A v2):
 *   "plan 应该是根据我的 goal 或者是有引导的提问来由 cairn 结合 cc 之类
 *    工作的 claude 来给出的，而不是让用户去提出来做什么。否则就把 cairn
 *    变成一个提示词转换器。Scout 一定要是跟工作的 session 隔离的 session。"
 *
 * Strict isolation invariants (per CEO):
 *   1. Scout's session_id namespace = scratchpad key
 *      `mode_a_scout_session/<project_id>`. Execution session lives
 *      under `mode_a_session/...`. The two are NEVER cross-referenced;
 *      Phase 2's --resume lookup only reads the execution key.
 *   2. Worker-runs go under `~/.cairn/worker-runs/scout-<run_id>/`
 *      so panel widgets that list `wr_*` directories don't accidentally
 *      conflate scout activity with execution activity.
 *   3. Scout MUST exit before execution can spawn (state machine gate:
 *      phase=='planning' → Scout running; phase flips to 'plan_pending'
 *      ONLY after Scout exits and the plan JSON is parsed). The
 *      execution CC is spawned only on phase=='running'.
 *
 * Output contract: Scout's last assistant text MUST contain a fenced
 * JSON block of shape:
 *     ```json
 *     {
 *       "plan_id": "<ULID-ish>",
 *       "steps": [
 *         { "label": "...", "rationale": "..." }
 *       ]
 *     }
 *     ```
 * Anything else (free-form prose around the block) is ignored. Scout's
 * prompt explicitly requests this shape.
 *
 * Fallback policy: if Scout fails (no JSON block, timeout, crash, or
 * spawn refusal), the caller (mentor-tick / IPC handler) falls back to
 * `mode-a-loop.planStepsFromGoal` (the existing deterministic path).
 * Either way the phase transitions to 'plan_pending' so user has
 * something to click Start on.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { createNdjsonStream } = require('./ndjson-stream.cjs');
const mcpConfigBuilder = require('./claude-mcp-config.cjs');
const cairnLog = require('./cairn-log.cjs');

const SCOUT_WORKER_RUNS_DIR = 'worker-runs'; // under ~/.cairn/
const SCOUT_PREFIX = 'scout-';
const DEFAULT_SCOUT_TIMEOUT_MS = parseInt(process.env.CAIRN_MODE_A_SCOUT_TIMEOUT_MS || '', 10) || (5 * 60 * 1000);
const SCOUT_SESSION_KEY_PREFIX = 'mode_a_scout_session/';

function newRunId() {
  return SCOUT_PREFIX + crypto.randomBytes(6).toString('hex');
}

function homeBase(home) {
  return path.join(home || os.homedir(), '.cairn', SCOUT_WORKER_RUNS_DIR);
}

function runDir(runId, home) {
  return path.join(homeBase(home), runId);
}

function ensureRunDir(runId, home) {
  fs.mkdirSync(runDir(runId, home), { recursive: true });
}

function writeRunMeta(runId, meta, home) {
  try {
    fs.writeFileSync(path.join(runDir(runId, home), 'run.json'), JSON.stringify(meta, null, 2), 'utf8');
  } catch (_e) {}
}

/**
 * Resolve a command on PATH. Windows: prefer .cmd / .exe / .bat; never
 * resolve to the no-extension POSIX shim (which spawn() can't execute
 * on Windows — 2026-05-14 panel crash).
 */
function whichCommand(name) {
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', '.bat'] : [''];
  const sep = process.platform === 'win32' ? ';' : ':';
  const paths = (process.env.PATH || '').split(sep);
  for (const dir of paths) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      try {
        const st = fs.statSync(p);
        if (st.isFile()) return p;
      } catch (_e) {}
    }
  }
  return null;
}

/**
 * Extract the Plan Shape / Plan Hard Constraints / Plan Authority
 * sections from raw CAIRN.md text. Falls back to empty strings if
 * any section is missing. Header matching is case-insensitive and
 * trim-tolerant.
 */
function extractPlanGuidance(cairnMdText) {
  if (typeof cairnMdText !== 'string' || !cairnMdText.trim()) {
    return { shape: '', constraints: '', authority: '', found_any: false };
  }
  const lines = cairnMdText.split(/\r?\n/);
  const sections = {};
  let curHeader = null;
  let curBody = [];
  for (const line of lines) {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m) {
      if (curHeader != null) {
        sections[curHeader] = curBody.join('\n').trim();
      }
      curHeader = m[1].toLowerCase().trim();
      curBody = [];
    } else if (curHeader != null) {
      curBody.push(line);
    }
  }
  if (curHeader != null) sections[curHeader] = curBody.join('\n').trim();

  const shape       = sections['plan shape']            || '';
  const constraints = sections['plan hard constraints'] || '';
  const authority   = sections['plan authority']        || '';
  return {
    shape,
    constraints,
    authority,
    found_any: !!(shape || constraints || authority),
  };
}

/**
 * Build the prompt that tells Scout exactly what to produce.
 *
 * Distinction from `mode-a-spawner.buildBootPrompt`:
 *   - Boot prompt = "you are working CC, here's the next step, go".
 *   - Scout prompt = "you are PLANNER, do not write code, output JSON".
 *
 * Scout is single-turn (one user message → one assistant reply →
 * exit). It uses the stream-json protocol so we can capture
 * session_id (for diagnostics + future grill turns), but it never
 * resumes a prior session.
 */
function buildScoutPrompt({ goal, projectRoot, projectId, guidance }) {
  const goalTitle = typeof goal === 'string' ? goal : (goal && goal.title) || '(no title)';
  const desiredOutcome = (goal && goal.desired_outcome) || '';
  const criteria = (goal && Array.isArray(goal.success_criteria)) ? goal.success_criteria.filter(s => typeof s === 'string' && s.trim()) : [];
  const nonGoals = (goal && Array.isArray(goal.non_goals)) ? goal.non_goals.filter(s => typeof s === 'string' && s.trim()) : [];

  const lines = [
    '# Cairn Mode A — Plan Scout',
    '',
    '你是 Cairn Mode A 的 plan scout。**你不写代码、不动文件、不调用任何修改类工具**。',
    '你的唯一任务：读 project 当前状态 + CAIRN.md 指导 + 用户 goal，',
    '输出一个 plan JSON，然后退出。',
    '',
    '## Project',
    '- project_id: `' + projectId + '`',
    '- project_root: `' + projectRoot + '`',
    '',
    '## User goal',
    '- title: ' + goalTitle,
  ];
  if (desiredOutcome) lines.push('- desired_outcome: ' + desiredOutcome);
  if (criteria.length > 0) {
    lines.push('- success_criteria:');
    for (const c of criteria) lines.push('  - ' + c);
  }
  if (nonGoals.length > 0) {
    lines.push('- non_goals:');
    for (const n of nonGoals) lines.push('  - ' + n);
  }
  lines.push('');

  if (guidance && guidance.found_any) {
    lines.push('## CAIRN.md guidance (read this carefully — it overrides your assumptions)');
    if (guidance.shape) {
      lines.push('');
      lines.push('### Plan Shape');
      lines.push(guidance.shape);
    }
    if (guidance.constraints) {
      lines.push('');
      lines.push('### Plan Hard Constraints (do NOT violate these)');
      lines.push(guidance.constraints);
    }
    if (guidance.authority) {
      lines.push('');
      lines.push('### Plan Authority (flag steps that need user before execution)');
      lines.push(guidance.authority);
      lines.push('  → For any step touching the items above, set `"needs_user_confirm": true` on it.');
    }
    lines.push('');
  } else {
    lines.push('## CAIRN.md guidance');
    lines.push('(No `## Plan Shape` / `## Plan Hard Constraints` / `## Plan Authority` sections found in CAIRN.md. Proceed with reasonable defaults but lean conservative.)');
    lines.push('');
  }

  lines.push(
    '## What you should do (single turn)',
    '',
    '1. Briefly explore the project (read README, key entry points, recent commits). Use Read / Glob / Grep tools — they are safe.',
    '2. Cross-reference user goal against CAIRN.md guidance above.',
    '3. Output ONE fenced JSON block in this exact shape:',
    '',
    '```json',
    '{',
    '  "plan_id": "scout_<8-hex>",',
    '  "drafted_by": "scout",',
    '  "rationale": "1-3 sentence summary of WHY this plan",',
    '  "steps": [',
    '    {',
    '      "label": "short imperative step name",',
    '      "rationale": "why this step, why now",',
    '      "needs_user_confirm": false',
    '    }',
    '  ]',
    '}',
    '```',
    '',
    '## Hard rules',
    '',
    '- **NO writes**: no Edit, no Write, no Bash with mutating commands. Read-only exploration only.',
    '- **NO sub-tasks via Task tool**: scout is single-turn; lead-CC will spawn subagents during execution.',
    '- **NO running tests / building / committing**.',
    '- 3 to 8 steps is the right scope. Each step should be 30min-2hr of execution work.',
    '- Steps must compose toward the user goal; do NOT re-state CAIRN.md constraints as steps (the lead-CC reads CAIRN.md too).',
    '- After the JSON block, write a one-line `<end-of-plan/>` token and exit.',
    '',
    '开始。',
  );
  return lines.join('\n');
}

/**
 * Extract the first JSON object that looks like a plan from raw text.
 * Strategy:
 *   1. Look for ```json ... ``` fenced block.
 *   2. Otherwise look for the first { ... } that parses cleanly AND
 *      has a `steps` array.
 * Returns null if nothing parseable found.
 */
function extractPlanJson(text) {
  if (typeof text !== 'string' || !text) return null;

  // 1. Fenced code block
  const fenced = text.match(/```json\s*([\s\S]+?)```/i);
  if (fenced) {
    try {
      const obj = JSON.parse(fenced[1].trim());
      if (obj && Array.isArray(obj.steps)) return obj;
    } catch (_e) {}
  }

  // 2. First balanced { ... } that parses + has steps
  const startIndices = [];
  for (let i = 0; i < text.length; i++) if (text[i] === '{') startIndices.push(i);
  for (const start of startIndices) {
    let depth = 0;
    for (let j = start; j < text.length; j++) {
      if (text[j] === '{') depth++;
      else if (text[j] === '}') {
        depth--;
        if (depth === 0) {
          const candidate = text.slice(start, j + 1);
          try {
            const obj = JSON.parse(candidate);
            if (obj && Array.isArray(obj.steps)) return obj;
          } catch (_e) {}
          break;
        }
      }
    }
  }
  return null;
}

/**
 * Normalize a raw scout-output plan into the shape mode-a-loop expects.
 * Sanitizes step labels (strip empty / non-string), assigns idx, sets
 * state=PENDING. Caps step count to a reasonable bound so a runaway
 * scout doesn't write a 200-step plan.
 */
const SCOUT_MAX_STEPS = 12;
function normalizePlan(rawPlan, { goal, now } = {}) {
  if (!rawPlan || typeof rawPlan !== 'object') return null;
  const steps = Array.isArray(rawPlan.steps) ? rawPlan.steps : [];
  const normSteps = [];
  for (const s of steps) {
    if (!s || typeof s !== 'object') continue;
    const label = typeof s.label === 'string' ? s.label.trim() : '';
    if (!label) continue;
    normSteps.push({
      idx: normSteps.length,
      label,
      state: 'PENDING',
      rationale: typeof s.rationale === 'string' ? s.rationale.trim() : '',
      needs_user_confirm: s.needs_user_confirm === true,
    });
    if (normSteps.length >= SCOUT_MAX_STEPS) break;
  }
  if (normSteps.length === 0) return null;
  const ts = now || Date.now();
  return {
    plan_id: typeof rawPlan.plan_id === 'string' && rawPlan.plan_id ? rawPlan.plan_id : ('scout_' + crypto.randomBytes(8).toString('hex')),
    goal_id: (goal && typeof goal === 'object' && goal.id) || null,
    goal_title: typeof goal === 'string' ? goal : (goal && goal.title) || null,
    drafted_by: 'scout',
    rationale: typeof rawPlan.rationale === 'string' ? rawPlan.rationale.trim() : '',
    steps: normSteps,
    current_idx: 0,
    drafted_at: ts,
    updated_at: ts,
  };
}

/**
 * Persist Scout's session_id under the ISOLATED key prefix so the
 * Phase-2 execution --resume lookup CANNOT accidentally pick it up.
 */
function persistScoutSessionId(db, projectId, sessionId, runId, now) {
  if (!db || !projectId || !sessionId) return;
  const key = SCOUT_SESSION_KEY_PREFIX + projectId;
  const ts = now || Date.now();
  const valueJson = JSON.stringify({ session_id: sessionId, run_id: runId || null, captured_at: ts });
  try {
    const existing = db.prepare('SELECT key FROM scratchpad WHERE key = ?').get(key);
    if (existing) {
      db.prepare('UPDATE scratchpad SET value_json = ?, updated_at = ? WHERE key = ?').run(valueJson, ts, key);
    } else {
      db.prepare('INSERT INTO scratchpad (key, value_json, value_path, task_id, expires_at, created_at, updated_at) VALUES (?, ?, NULL, NULL, NULL, ?, ?)').run(key, valueJson, ts, ts);
    }
  } catch (_e) {}
}

/**
 * Run the scout end-to-end. Async. Returns a promise of
 * { ok, plan, run_id, session_id, mcp_config_path, raw_text? } |
 * { ok: false, error, run_id?, raw_text? }.
 *
 * Caller (panel IPC handler or mentor-tick async path) is responsible
 * for writing the plan back to scratchpad + flipping the phase state.
 */
function runScout(input, opts) {
  return new Promise((resolve) => {
    const o = opts || {};
    if (!input || !input.projectRoot || !input.projectId) {
      return resolve({ ok: false, error: 'projectRoot_and_projectId_required' });
    }
    if (!fs.existsSync(input.projectRoot)) {
      return resolve({ ok: false, error: 'project_root_not_found' });
    }

    const claudeExe = whichCommand('claude');
    if (!claudeExe) {
      return resolve({ ok: false, error: 'provider_unavailable' });
    }

    const runId = newRunId();
    const home = o.home;
    ensureRunDir(runId, home);

    // Build prompt
    let guidance = { shape: '', constraints: '', authority: '', found_any: false };
    try {
      const cairnMdPath = path.join(input.projectRoot, 'CAIRN.md');
      if (fs.existsSync(cairnMdPath)) {
        guidance = extractPlanGuidance(fs.readFileSync(cairnMdPath, 'utf8'));
      }
    } catch (_e) {}

    const prompt = buildScoutPrompt({
      goal: input.goal,
      projectRoot: input.projectRoot,
      projectId: input.projectId,
      guidance,
    });

    try {
      fs.writeFileSync(path.join(runDir(runId, home), 'prompt.txt'), prompt, 'utf8');
    } catch (_e) {}

    // Build per-spawn MCP config (Scout uses the same cairn-wedge
    // canonical entry so it COULD call cairn.scratchpad.write — but the
    // prompt forbids writes; cairn-wedge is mainly there so CC's read
    // tools work uniformly.).
    const mcpRes = mcpConfigBuilder.buildMcpConfigFile({
      projectRoot: input.projectRoot,
      runId,
      tmpDir: o.mcpConfigTmpDir,
    });
    if (!mcpRes.ok) {
      return resolve({ ok: false, error: 'mcp_config_failed', detail: mcpRes.error, run_id: runId });
    }

    const argv = [
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'bypassPermissions',  // scout is read-only by prompt; bypass keeps it consistent with execution session
      '--mcp-config', mcpRes.tempPath,
      '--strict-mcp-config',
    ];

    let exec = claudeExe;
    let execArgv = argv;
    if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(claudeExe)) {
      exec = process.env.ComSpec || 'cmd.exe';
      execArgv = ['/d', '/s', '/c', claudeExe, ...argv];
    }

    const meta = {
      run_id: runId,
      provider: 'claude-code-scout',
      cwd: input.projectRoot,
      project_id: input.projectId,
      started_at: Date.now(),
      ended_at: null,
      status: 'queued',
      session_id: null,
      mcp_config_path: mcpRes.tempPath,
      cairn_md_guidance_found: guidance.found_any,
    };
    writeRunMeta(runId, meta, home);

    let child;
    try {
      child = spawn(exec, execArgv, {
        cwd: input.projectRoot,
        env: Object.assign({}, process.env, { CAIRN_MODE_A_SCOUT: '1' }),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
      });
    } catch (e) {
      mcpRes.cleanup();
      return resolve({ ok: false, error: 'spawn_threw', detail: (e && e.message) || String(e), run_id: runId });
    }

    if (child.pid == null) {
      mcpRes.cleanup();
      return resolve({ ok: false, error: 'no_pid', run_id: runId });
    }

    meta.status = 'running';
    meta.pid = child.pid;
    writeRunMeta(runId, meta, home);

    cairnLog.info('mode-a-scout', 'spawned', { run_id: runId, project_id: input.projectId, cairn_md_guidance_found: guidance.found_any });

    // Send the prompt as one stream-json user-turn envelope, then close stdin
    // (scout is single-turn — no follow-up messages).
    try {
      child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } }) + '\n');
      child.stdin.end();
    } catch (_e) {}

    // Collect assistant text across events; capture session_id from result.
    let assistantText = '';
    let sessionId = null;
    const parser = createNdjsonStream(child.stdout);

    parser.on('event', (ev) => {
      try { fs.appendFileSync(path.join(runDir(runId, home), 'stream_events.jsonl'), JSON.stringify(ev) + '\n'); } catch (_e) {}
      if (ev && ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
        for (const block of ev.message.content) {
          if (block && block.type === 'text' && typeof block.text === 'string') {
            assistantText += block.text + '\n';
          }
        }
      }
      if (ev && ev.type === 'result' && typeof ev.session_id === 'string' && ev.session_id) {
        sessionId = ev.session_id;
      }
    });

    parser.on('error', (err, raw) => {
      cairnLog.warn('mode-a-scout', 'ndjson_parse_error', { run_id: runId, message: (err && err.message) || String(err), raw_preview: raw ? String(raw).slice(0, 200) : null });
    });

    const timeoutMs = typeof o.timeoutMs === 'number' ? o.timeoutMs : DEFAULT_SCOUT_TIMEOUT_MS;
    const timer = setTimeout(() => {
      cairnLog.warn('mode-a-scout', 'timeout', { run_id: runId, timeout_ms: timeoutMs });
      try { child.kill('SIGTERM'); } catch (_e) {}
      setTimeout(() => { try { child.kill('SIGKILL'); } catch (_e) {} }, 5000).unref();
    }, timeoutMs);
    if (timer.unref) timer.unref();

    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      try { mcpRes.cleanup(); } catch (_e) {}
      meta.ended_at = Date.now();
      meta.exit_code = code;
      meta.signal = signal || null;
      meta.session_id = sessionId;

      // Persist scout's session_id under the isolated key (so Phase 2
      // execution --resume lookup can NEVER pick it up).
      if (sessionId && o.db) {
        persistScoutSessionId(o.db, input.projectId, sessionId, runId, meta.ended_at);
      }

      // Parse plan JSON from assistant text.
      const rawPlan = extractPlanJson(assistantText);
      const plan = normalizePlan(rawPlan, { goal: input.goal });
      if (plan) {
        meta.status = 'exited';
        meta.plan_steps = plan.steps.length;
        writeRunMeta(runId, meta, home);
        cairnLog.info('mode-a-scout', 'plan_drafted', { run_id: runId, project_id: input.projectId, steps: plan.steps.length, session_id: sessionId });
        resolve({ ok: true, plan, run_id: runId, session_id: sessionId, mcp_config_path: mcpRes.tempPath, raw_text: assistantText });
      } else {
        meta.status = 'failed';
        meta.error = code === 0 ? 'plan_json_not_found' : ('exit_code:' + code);
        writeRunMeta(runId, meta, home);
        cairnLog.warn('mode-a-scout', 'plan_extraction_failed', { run_id: runId, project_id: input.projectId, exit_code: code, raw_preview: assistantText.slice(-500) });
        resolve({ ok: false, error: meta.error, run_id: runId, raw_text: assistantText });
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      try { mcpRes.cleanup(); } catch (_e) {}
      cairnLog.error('mode-a-scout', 'spawn_error', { run_id: runId, message: (err && err.message) || String(err) });
      resolve({ ok: false, error: 'spawn_error', detail: (err && err.message) || String(err), run_id: runId });
    });
  });
}

/**
 * High-level orchestrator: spawn scout, write plan to scratchpad, flip
 * Mode A phase to 'plan_pending'. Caller (IPC handler) calls this once
 * after transitioning phase to 'planning'. Async — returns a promise
 * that resolves when the plan is on disk (or fallback happened).
 *
 * Fallback: if scout fails, we draft a deterministic plan from
 * goal.success_criteria via `mode-a-loop.planStepsFromGoal` so the
 * user STILL gets a `plan_pending` to click Start on. The plan body
 * is tagged `drafted_by: 'deterministic_fallback'` so the panel can
 * surface that Scout didn't actually run.
 *
 * Inputs (deps):
 *   registry     — registry module (setModeAPhase + saveRegistry)
 *   modeALoop    — mode-a-loop module (writePlan + planStepsFromGoal)
 *   getReg()     — returns latest reg binding (panel re-assigns it)
 *   setReg(reg)  — caller's setter
 *   db           — writable db handle
 *   project      — project entry (must have id + project_root)
 *   goal         — current goal (must be present, called only when so)
 *   profile      — optional CAIRN.md profile
 *   nowFn()      — optional, defaults to Date.now
 *   home         — optional CAIRN_HOME override (for tests)
 *
 * @returns {Promise<{ ok: boolean, plan?: object, source: 'scout'|'fallback', error?: string }>}
 */
async function runScoutThenWritePlan(deps) {
  const d = deps || {};
  const { project, goal } = d;
  if (!project || !project.id) return { ok: false, error: 'project_required', source: 'fallback' };
  if (!goal) return { ok: false, error: 'goal_required', source: 'fallback' };
  const projectRoot = project.project_root || project.path;
  if (!projectRoot || projectRoot === '(unknown)') {
    return { ok: false, error: 'project_root_missing', source: 'fallback' };
  }

  const now = d.nowFn ? d.nowFn() : Date.now();

  // 1. Spawn scout
  const scoutRes = await runScout({
    projectRoot,
    projectId: project.id,
    goal,
  }, {
    db: d.db,
    home: d.home,
    mcpConfigTmpDir: d.mcpConfigTmpDir,
    timeoutMs: d.timeoutMs,
  });

  // 2. Determine plan body (scout success or deterministic fallback)
  let plan;
  let source;
  if (scoutRes.ok && scoutRes.plan) {
    plan = scoutRes.plan;
    source = 'scout';
  } else {
    // Deterministic fallback. We require mode-a-loop.planStepsFromGoal.
    const modeALoop = d.modeALoop || require('./mode-a-loop.cjs');
    const fallbackSteps = modeALoop.planStepsFromGoal(goal);
    if (!fallbackSteps || fallbackSteps.length === 0) {
      cairnLog.warn('mode-a-scout', 'fallback_empty_plan', {
        project_id: project.id,
        scout_error: scoutRes.error,
      });
      return { ok: false, error: scoutRes.error || 'fallback_empty_plan', source: 'fallback' };
    }
    plan = {
      plan_id: 'fallback_' + crypto.randomBytes(6).toString('hex'),
      goal_id: (typeof goal === 'object' && goal && goal.id) || null,
      goal_title: typeof goal === 'string' ? goal : (goal && goal.title) || null,
      drafted_by: 'deterministic_fallback',
      rationale: 'Scout failed (' + (scoutRes.error || 'unknown') + '); fell back to success_criteria → steps mapping.',
      steps: fallbackSteps,
      current_idx: 0,
      drafted_at: now,
      updated_at: now,
    };
    source = 'fallback';
  }

  // 3. Write plan to scratchpad
  try {
    const modeALoop = d.modeALoop || require('./mode-a-loop.cjs');
    modeALoop.writePlan(d.db, project.id, plan, now);
  } catch (e) {
    cairnLog.error('mode-a-scout', 'write_plan_failed', {
      project_id: project.id,
      message: (e && e.message) || String(e),
    });
    return { ok: false, error: 'write_plan_failed', source };
  }

  // 4. Flip phase → plan_pending
  if (d.registry && typeof d.getReg === 'function' && typeof d.setReg === 'function') {
    const curReg = d.getReg();
    const phaseRes = d.registry.setModeAPhase(curReg, project.id, 'plan_pending');
    if (phaseRes.error) {
      cairnLog.warn('mode-a-scout', 'phase_flip_failed', {
        project_id: project.id,
        from: 'planning',
        to: 'plan_pending',
        error: phaseRes.error,
      });
    } else {
      d.setReg(phaseRes.reg);
      try { d.registry.saveRegistry(phaseRes.reg); } catch (_e) {}
    }
  }

  return { ok: true, plan, source };
}

module.exports = {
  runScout,
  runScoutThenWritePlan,
  SCOUT_SESSION_KEY_PREFIX,
  DEFAULT_SCOUT_TIMEOUT_MS,
  // Exposed for tests
  _extractPlanGuidance: extractPlanGuidance,
  _extractPlanJson: extractPlanJson,
  _normalizePlan: normalizePlan,
  _buildScoutPrompt: buildScoutPrompt,
  _whichCommand: whichCommand,
};
