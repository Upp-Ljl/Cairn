'use strict';

/**
 * mode-a-scout.cjs — Scout (Cairn-side mentor LLM) drafts a plan from
 * user goal + CAIRN.md guidance + project context. Uses MiniMax via
 * `llm-client.cjs::chatJson` (OpenAI-compatible). NOT a CC subprocess.
 *
 * CEO 鸭总 2026-05-14 corrections:
 *   "MiniMax 只是为了让 cairn 更智能一些，而不是代替 cc 的 agent 去执行任务。
 *    也就是 cairn 的 llm 只是作为 mentor 的角色，来润色这个计划，
 *    并按照这个计划来给 cc 交互。这也是我们区分 cc 的自身的 plan。"
 *
 * Layering (locked-in):
 *   - MiniMax (this module) = Cairn's mentor. Draws plan-level milestones,
 *     refines labels / rationale / order, flags needs_user_confirm.
 *   - CC (real `claude` via claude-stream-launcher) = execution agent.
 *     Picks up each plan step as a milestone and decides internally
 *     (via its own TodoWrite + Task tool) how to chop sub-steps and
 *     write code.
 *   - These are STRICTLY different LLM endpoints (MiniMax HTTP vs
 *     Anthropic via claude CLI). Sessions can't bleed.
 *
 * Output contract: scout's response text MUST contain a fenced JSON
 * block of shape:
 *     ```json
 *     {
 *       "plan_id": "scout_<8-hex>",
 *       "rationale": "1-3 sentence WHY",
 *       "steps": [
 *         { "label": "...", "rationale": "...", "needs_user_confirm": false }
 *       ]
 *     }
 *     ```
 * 3-12 steps. needs_user_confirm MUST be true for any step matching
 * CAIRN.md `## Plan Authority` entries (mentor prompted to enforce).
 *
 * Audit trail: per-call directory under
 * `~/.cairn/worker-runs/scout-<runId>/` with prompt.txt + response.txt
 * + run.json. Worker-runs is reused (panel widgets that list `wr_*`
 * filter on prefix; `scout-*` is distinct).
 *
 * Fallback policy: if Mentor LLM fails (keys missing / network /
 * non-JSON response), caller (`runScoutThenWritePlan`) falls back to
 * `mode-a-loop.planStepsFromGoal` (deterministic, 1:1 from
 * success_criteria). Either way the panel reaches `plan_pending` so
 * user has something to click Start on. The fallback plan gets
 * tagged `drafted_by:'deterministic_fallback'` so the panel renders
 * a yellow "Fallback" pill instead of the purple "Scout" pill.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const llmClient = require('./llm-client.cjs');
const cairnLog = require('./cairn-log.cjs');
const skillsLoader = require('./skills-loader.cjs');

// 5-line graceful-degrade fallback when both ~/.cairn/skills/plan-shape.md
// and skills-defaults/plan-shape.md are unreadable. Keeps Scout working
// with a minimal milestone-shape rule set. Matches the analysis §3.1
// "5 lines max — graceful degrade" requirement.
const PLAN_SHAPE_FALLBACK = [
  '## Hard rules (fallback — plan-shape skill not loadable)',
  '- 3-8 milestone steps, each 30min-2hr scope.',
  '- step.label = milestone (not specific file/line actions — that\'s CC\'s job).',
  '- Order steps by dependency. needs_user_confirm:true for anything in CAIRN.md Plan Authority.',
  '- Output a single fenced JSON block; minimal surrounding prose.',
].join('\n');

const SCOUT_PREFIX = 'scout-';
const DEFAULT_SCOUT_TIMEOUT_MS = parseInt(process.env.CAIRN_MODE_A_SCOUT_TIMEOUT_MS || '', 10) || 60_000;
const SCOUT_MAX_STEPS = 12;

function newRunId() {
  return SCOUT_PREFIX + crypto.randomBytes(6).toString('hex');
}

function homeBase(home) {
  return path.join(home || os.homedir(), '.cairn', 'worker-runs');
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
  } catch (_e) { cairnLog.warn('mode-a-scout', 'run_meta_write_failed', { message: (_e && _e.message) || String(_e) }); }
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
 * Optionally read a small slice of project context the LLM can use
 * without filesystem tools: README first 2 KB + top-level package.json
 * name/description if present. We deliberately keep this tiny —
 * Mentor is cheap + fast, not a full repo crawler.
 */
function gatherProjectContext(projectRoot) {
  const ctx = { readme_excerpt: '', package_json: '' };
  if (!projectRoot || typeof projectRoot !== 'string') return ctx;
  try {
    for (const name of ['README.md', 'readme.md', 'README']) {
      const p = path.join(projectRoot, name);
      if (fs.existsSync(p)) {
        ctx.readme_excerpt = fs.readFileSync(p, 'utf8').slice(0, 2048);
        break;
      }
    }
  } catch (_e) { cairnLog.warn('mode-a-scout', 'readme_read_failed', { message: (_e && _e.message) || String(_e) }); }
  try {
    const pkgPath = path.join(projectRoot, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const raw = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      ctx.package_json = JSON.stringify({
        name: raw.name || null,
        description: raw.description || null,
        version: raw.version || null,
        scripts: raw.scripts ? Object.keys(raw.scripts).slice(0, 12) : null,
      });
    }
  } catch (_e) { cairnLog.warn('mode-a-scout', 'package_json_read_failed', { message: (_e && _e.message) || String(_e) }); }
  return ctx;
}

/**
 * Build the prompt that tells Scout exactly what to produce.
 *
 * Single-shot: one user message in, one assistant response out. No
 * tools, no follow-up turns. Mentor has NO filesystem access via the
 * LLM — we pre-load project context above and inject inline.
 */
function buildScoutPrompt({ goal, projectRoot, projectId, guidance, projectCtx, skillHome }) {
  const goalTitle = typeof goal === 'string' ? goal : (goal && goal.title) || '(no title)';
  const desiredOutcome = (goal && goal.desired_outcome) || '';
  const criteria = (goal && Array.isArray(goal.success_criteria)) ? goal.success_criteria.filter(s => typeof s === 'string' && s.trim()) : [];
  const nonGoals = (goal && Array.isArray(goal.non_goals)) ? goal.non_goals.filter(s => typeof s === 'string' && s.trim()) : [];

  const lines = [
    '# Cairn Mode A — Plan Mentor',
    '',
    '你是 Cairn 的 plan mentor。**你不是执行 agent，不写代码**。',
    '你的工作：根据用户 goal + CAIRN.md 指导 + 项目上下文，',
    '起草一个 milestone-level plan，让真正的执行 agent（Claude Code）',
    '后面按照这个 plan 干活。每个 step = 一个 milestone（30min-2hr 的执行体量），',
    'CC 拿到 step 之后会**自己拆 sub-task**，你不用替它想。',
    '',
    '## Project',
    '- project_id: `' + projectId + '`',
    '- project_root: `' + projectRoot + '`',
  ];
  if (projectCtx && projectCtx.package_json) {
    lines.push('- package.json: ' + projectCtx.package_json);
  }
  if (projectCtx && projectCtx.readme_excerpt) {
    lines.push('');
    lines.push('### README excerpt (first 2KB)');
    lines.push('```');
    lines.push(projectCtx.readme_excerpt.slice(0, 1800));
    lines.push('```');
  }
  lines.push('');
  lines.push('## User goal');
  lines.push('- title: ' + goalTitle);
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
    lines.push('## CAIRN.md guidance (project-owned plan-shaping)');
    if (guidance.shape) {
      lines.push('');
      lines.push('### Plan Shape');
      lines.push(guidance.shape);
    }
    if (guidance.constraints) {
      lines.push('');
      lines.push('### Plan Hard Constraints (do NOT violate)');
      lines.push(guidance.constraints);
    }
    if (guidance.authority) {
      lines.push('');
      lines.push('### Plan Authority (steps touching these MUST get needs_user_confirm:true)');
      lines.push(guidance.authority);
    }
    lines.push('');
  } else {
    lines.push('## CAIRN.md guidance');
    lines.push('(No `## Plan Shape` / `## Plan Hard Constraints` / `## Plan Authority` sections found. Use sensible defaults, lean conservative.)');
    lines.push('');
  }

  // Skill-loaded plan-shape rubric (editable at ~/.cairn/skills/plan-shape.md).
  // Failure → fall through to 5-line PLAN_SHAPE_FALLBACK.
  let planShapeBlock;
  try {
    const skill = skillsLoader.loadSkill('plan-shape', { home: skillHome });
    planShapeBlock = (skill && skill.ok && typeof skill.text === 'string' && skill.text.trim())
      ? skill.text
      : PLAN_SHAPE_FALLBACK;
  } catch (_e) {
    planShapeBlock = PLAN_SHAPE_FALLBACK;
  }

  lines.push(
    '## Output (JSON only)',
    '',
    '输出 **单个** fenced JSON block，schema：',
    '',
    '```json',
    '{',
    '  "plan_id": "scout_<8-hex>",',
    '  "drafted_by": "scout",',
    '  "rationale": "1-3 句 WHY 这个 plan",',
    '  "steps": [',
    '    {',
    '      "label": "短祈使句 milestone（不超过 60 字）",',
    '      "rationale": "为什么这步、为什么这个顺序",',
    '      "needs_user_confirm": false',
    '    }',
    '  ]',
    '}',
    '```',
    '',
    planShapeBlock,
    '',
    '开始。',
  );
  return lines.join('\n');
}

/**
 * Extract the first JSON object that looks like a plan from raw text.
 */
function extractPlanJson(text) {
  if (typeof text !== 'string' || !text) return null;
  const fenced = text.match(/```json\s*([\s\S]+?)```/i);
  if (fenced) {
    try {
      const obj = JSON.parse(fenced[1].trim());
      if (obj && Array.isArray(obj.steps)) return obj;
    } catch (_e) { cairnLog.warn('mode-a-scout', 'plan_fenced_json_parse_failed', { message: (_e && _e.message) || String(_e) }); }
  }
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
          } catch (_e) { /* probe-and-continue: expected for non-JSON substrings */ }
          break;
        }
      }
    }
  }
  return null;
}

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
 * Run scout via MiniMax (OpenAI-compatible chatJson). Async.
 *
 * @param {{ projectId, projectRoot, goal }} input
 * @param {{ home?, timeoutMs?, chatImpl?, keysFile? }} [opts]
 *   chatImpl is injected for tests (defaults to llmClient.chatJson).
 * @returns {Promise<{ ok: true, plan, run_id, response_text } | { ok: false, error, run_id?, response_text? }>}
 */
async function runScout(input, opts) {
  const o = opts || {};
  if (!input || !input.projectRoot || !input.projectId) {
    return { ok: false, error: 'projectRoot_and_projectId_required' };
  }
  if (!input.goal) {
    return { ok: false, error: 'goal_required' };
  }

  const runId = newRunId();
  const home = o.home;
  ensureRunDir(runId, home);

  let guidance = { shape: '', constraints: '', authority: '', found_any: false };
  try {
    const cairnMdPath = path.join(input.projectRoot, 'CAIRN.md');
    if (fs.existsSync(cairnMdPath)) {
      guidance = extractPlanGuidance(fs.readFileSync(cairnMdPath, 'utf8'));
    }
  } catch (_e) { cairnLog.warn('mode-a-scout', 'cairn_md_read_failed', { message: (_e && _e.message) || String(_e) }); }

  const projectCtx = gatherProjectContext(input.projectRoot);

  const prompt = buildScoutPrompt({
    goal: input.goal,
    projectRoot: input.projectRoot,
    projectId: input.projectId,
    guidance,
    projectCtx,
    skillHome: o.home,
  });

  const meta = {
    run_id: runId,
    provider: 'minimax-mentor',
    project_id: input.projectId,
    cwd: input.projectRoot,
    started_at: Date.now(),
    ended_at: null,
    status: 'queued',
    cairn_md_guidance_found: guidance.found_any,
    readme_loaded: !!projectCtx.readme_excerpt,
  };
  writeRunMeta(runId, meta, home);
  try { fs.writeFileSync(path.join(runDir(runId, home), 'prompt.txt'), prompt, 'utf8'); } catch (_e) { cairnLog.warn('mode-a-scout', 'prompt_write_failed', { message: (_e && _e.message) || String(_e) }); }

  cairnLog.info('mode-a-scout', 'request', {
    run_id: runId,
    project_id: input.projectId,
    cairn_md_guidance_found: guidance.found_any,
    readme_loaded: !!projectCtx.readme_excerpt,
  });

  const chatImpl = o.chatImpl || llmClient.chatJson;
  const chatRes = await chatImpl({
    messages: [
      { role: 'system', content: 'You are Cairn Mode A plan mentor. Output a fenced JSON block matching the requested schema. Be terse. Do NOT write code or attempt to execute anything.' },
      { role: 'user', content: prompt },
    ],
    temperature: 0.2,
  }, {
    timeoutMs: typeof o.timeoutMs === 'number' ? o.timeoutMs : DEFAULT_SCOUT_TIMEOUT_MS,
    keysFile: o.keysFile,
  });

  meta.ended_at = Date.now();
  meta.duration_ms = meta.ended_at - meta.started_at;
  meta.llm_model = chatRes.model || null;
  meta.llm_ok = !!chatRes.ok;

  if (!chatRes.ok) {
    meta.status = 'failed';
    meta.error = chatRes.error_code || 'unknown';
    if (chatRes.enabled === false) meta.error = 'llm_disabled:' + (chatRes.error_code || chatRes.reason || 'unknown');
    writeRunMeta(runId, meta, home);
    cairnLog.warn('mode-a-scout', 'request_failed', {
      run_id: runId,
      project_id: input.projectId,
      error_code: meta.error,
      duration_ms: meta.duration_ms,
    });
    return { ok: false, error: meta.error, run_id: runId };
  }

  const responseText = chatRes.text || '';
  try { fs.writeFileSync(path.join(runDir(runId, home), 'response.txt'), responseText, 'utf8'); } catch (_e) { cairnLog.warn('mode-a-scout', 'response_write_failed', { message: (_e && _e.message) || String(_e) }); }

  const rawPlan = extractPlanJson(responseText);
  const plan = normalizePlan(rawPlan, { goal: input.goal });
  if (!plan) {
    meta.status = 'failed';
    meta.error = 'plan_json_not_found';
    writeRunMeta(runId, meta, home);
    cairnLog.warn('mode-a-scout', 'plan_extraction_failed', {
      run_id: runId,
      project_id: input.projectId,
      response_preview: responseText.slice(0, 400),
      duration_ms: meta.duration_ms,
    });
    return { ok: false, error: 'plan_json_not_found', run_id: runId, response_text: responseText };
  }

  meta.status = 'exited';
  meta.plan_steps = plan.steps.length;
  writeRunMeta(runId, meta, home);
  cairnLog.info('mode-a-scout', 'plan_drafted', {
    run_id: runId,
    project_id: input.projectId,
    steps: plan.steps.length,
    duration_ms: meta.duration_ms,
    model: meta.llm_model,
  });

  return { ok: true, plan, run_id: runId, response_text: responseText };
}

/**
 * High-level orchestrator: scout → write plan to scratchpad → flip
 * Mode A phase to 'plan_pending'. Async. Fallback to deterministic
 * planStepsFromGoal on scout failure so user still has a plan to
 * Start.
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

  const scoutRes = await runScout({
    projectRoot,
    projectId: project.id,
    goal,
  }, {
    home: d.home,
    timeoutMs: d.timeoutMs,
    chatImpl: d.chatImpl,
  });

  let plan;
  let source;
  if (scoutRes.ok && scoutRes.plan) {
    plan = scoutRes.plan;
    source = 'scout';
  } else {
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
      rationale: 'Mentor LLM failed (' + (scoutRes.error || 'unknown') + '); fell back to success_criteria → steps mapping.',
      steps: fallbackSteps,
      current_idx: 0,
      drafted_at: now,
      updated_at: now,
    };
    source = 'fallback';
  }

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
      try { d.registry.saveRegistry(phaseRes.reg); } catch (_e) { cairnLog.warn('mode-a-scout', 'registry_save_failed', { message: (_e && _e.message) || String(_e) }); }
    }
  }

  return { ok: true, plan, source };
}

module.exports = {
  runScout,
  runScoutThenWritePlan,
  DEFAULT_SCOUT_TIMEOUT_MS,
  SCOUT_MAX_STEPS,
  // Exposed for tests
  _extractPlanGuidance: extractPlanGuidance,
  _extractPlanJson: extractPlanJson,
  _normalizePlan: normalizePlan,
  _buildScoutPrompt: buildScoutPrompt,
  _gatherProjectContext: gatherProjectContext,
};
