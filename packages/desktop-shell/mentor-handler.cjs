'use strict';

/**
 * Mentor Handler — Mode A orchestrator.
 *
 * Flow per docs/mentor-layer-spec.md §4.3:
 *   A. collect signals (mentor-collect.cjs)
 *   B. deterministic skeleton (§6.2 4-tier ranking)
 *   C. LLM polish via the host worker (claude-code / codex / fixture)
 *      — uses the same launcher pipeline as Scout/Worker/Review
 *   D. schema validate (§3 + §3.5 invariants 1-5)
 *   E. history append + cache write
 *   F. return
 *
 * On LLM failure (§8 scenario 1): skip stage C; emit deterministic
 * skeleton with `why={}`, `confidence: null`, `fallback_used: true`.
 *
 * On sparse state (§8 scenario 2): no LLM call; return empty
 * `ranked_items` with `meta.reason: 'sparse_state'`.
 *
 * On refusal (§5 cases A-F): no LLM call, no history write of the
 * refused turn body (we DO write a refusal record so the user can
 * audit); return `{ ok: true, refused: true, refusal_reason }`.
 *
 * Cache: TTL 10 min (per task spec — overrides the doc's 5-min default
 * since the user-task asked 10), key = (projectId,
 * hash(user_question), signals.git_short). Invalidates on new HEAD.
 *
 * Hard product boundary (§5.1 enforced by mentor-prompt + schema
 * validation here):
 *   - Mentor recommends; humans hold terminal decisions.
 *   - askMentor returns plain advice; it NEVER calls accept/reject
 *     /push/merge handlers.
 */

const crypto = require('crypto');

const collect       = require('./mentor-collect.cjs');
const mentorPrompt  = require('./mentor-prompt.cjs');
const history       = require('./mentor-history.cjs');
const launcher      = require('./worker-launcher.cjs');
const mp            = require('./managed-project.cjs');
const iters         = require('./project-iterations.cjs');

const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 32;

/** @type {Map<string, { result, cached_at, signals_hash }>} */
const responseCache = new Map();

// ---------------------------------------------------------------------------
// Deterministic skeleton — §6.2 4-tier ranking
// ---------------------------------------------------------------------------
//
// T1 — blocking signals (OPEN blockers, FAILED tasks, WAITING_REVIEW tasks)
// T2 — pending decisions (REVIEWED candidates, BLOCKED tasks)
// T3 — ready to execute (PROPOSED candidates)
// T4 — inferred from signals (git patterns, doc gaps)
//
// Within tier: sort by updated_at DESC. Tie-breaks: candidate > task > doc-inference, then id alpha.

function _candStaleSort(a, b) {
  const dt = (b.updated_at || 0) - (a.updated_at || 0);
  if (dt !== 0) return dt;
  return String(a.id || '').localeCompare(String(b.id || ''));
}

function _skeletonFromSignals(signals) {
  const items = [];
  const candidates = Array.isArray(signals.candidates) ? signals.candidates : [];
  const kernel     = signals.kernel || {};

  // T2 — REVIEWED candidates (pending user decision)
  const reviewed = candidates.filter(c => c.status === 'REVIEWED').sort(_candStaleSort);
  for (const c of reviewed) {
    items.push({
      tier: 2,
      descriptor: `Candidate ${c.id.slice(0, 12)} is REVIEWED — awaiting Accept/Reject/Roll back.`,
      candidate_kind: c.candidate_kind,
      next_action_hint: 'escalate to human review',
      evidence_refs: [
        { kind: 'candidate',  ref: c.id },
        c.review_iteration_id && { kind: 'iteration', ref: c.review_iteration_id },
      ].filter(Boolean),
      raw: c,
    });
  }

  // T3 — PROPOSED candidates (ready to pick)
  const proposed = candidates.filter(c => c.status === 'PROPOSED').sort(_candStaleSort);
  for (const c of proposed) {
    items.push({
      tier: 3,
      descriptor: `Candidate ${c.id.slice(0, 12)} (${c.candidate_kind}) is PROPOSED — pick to start Continuous Iteration.`,
      candidate_kind: c.candidate_kind,
      next_action_hint: 'pick to start Continuous Iteration',
      evidence_refs: [
        { kind: 'candidate', ref: c.id },
        c.source_iteration_id && { kind: 'iteration', ref: c.source_iteration_id },
      ].filter(Boolean),
      raw: c,
    });
  }

  // T1 — blocking signals from kernel (counts only here; the smoke + real
  // panel attach actual blocker/task ids when SQLite wiring exists).
  const blockersOpen = kernel.blockers_open || 0;
  if (blockersOpen > 0) {
    items.unshift({
      tier: 1,
      descriptor: `${blockersOpen} blocker${blockersOpen === 1 ? '' : 's'} OPEN — answer to unblock.`,
      candidate_kind: null,
      next_action_hint: 'answer blocker question',
      evidence_refs: [{ kind: 'blocker', ref: `pending(${blockersOpen})` }],
      raw: { kind: 'blocker_count', value: blockersOpen },
    });
  }
  const tasksFailed = kernel.tasks_failed || 0;
  if (tasksFailed > 0) {
    items.unshift({
      tier: 1,
      descriptor: `${tasksFailed} task${tasksFailed === 1 ? '' : 's'} FAILED — checkpoint then investigate.`,
      candidate_kind: null,
      next_action_hint: 'create checkpoint then investigate',
      evidence_refs: [{ kind: 'task', ref: `failed(${tasksFailed})` }],
      raw: { kind: 'failed_task_count', value: tasksFailed },
    });
  }

  // T4 — doc/git inference: if there are recent commits but no candidate
  // touches the same module, surface as low-priority advisory. v0 keeps
  // this minimal — just count commits with no recent candidate.
  const recentCommits = (signals.git && signals.git.commits) || [];
  if (recentCommits.length > 0 && candidates.length === 0) {
    items.push({
      tier: 4,
      descriptor: `${recentCommits.length} recent commit(s) but no candidates proposed yet — consider running Scout.`,
      candidate_kind: null,
      next_action_hint: 'propose candidate then pick',
      evidence_refs: recentCommits.slice(0, 3).map(c => ({ kind: 'commit', ref: c.hash })),
      raw: { kind: 'doc_inference', commit_count: recentCommits.length },
    });
  }

  // Stable sort: tier asc, then preserve push order (recency / tie-breaks).
  items.sort((a, b) => a.tier - b.tier);
  return items;
}

function _isSparseState(signals) {
  const candCount = (signals.candidates || []).length;
  const reportCount = (signals.reports || []).length;
  const iterCount = (signals.iterations || []).length;
  const commitCount = ((signals.git && signals.git.commits) || []).length;
  const docChars = ((signals.docs && signals.docs.files) || []).reduce((s, f) => s + (f.byte_count || 0), 0);
  return candCount === 0 && reportCount === 0 && iterCount === 0
      && commitCount <= 1 && docChars < 100;
}

// ---------------------------------------------------------------------------
// Refusal detection — §5.2 cases A-F (deterministic, never asks the LLM)
// ---------------------------------------------------------------------------

const REFUSAL_PATTERNS = [
  { code: 'A_sprint_velocity', rx: /\b(sprint|velocity|story\s*points?|burndown|capacity)\b/i,
    message: 'Mentor 不回答 sprint velocity / story point / 团队工单类问题——超出单项目 host-level 信号范围。请到 Linear / Jira 查看。' },
  { code: 'B_real_names', rx: /(让|让|please)\s*([一-龥]{2,4}|[A-Z][a-z]+\s+[A-Z][a-z]+)\s*(去|来|做|fix|implement)/i,
    message: 'Mentor 只推荐 work item 应分配给哪类 role/agent（worker-agent / reviewer 等），不引用或指派具体成员姓名。请在 Three-Stage Loop UI pick 起对应 candidate。' },
  { code: 'C_terminal_action', rx: /\b(merge\s+(?:pr|the\s*pr)|accept\s+candidate|push\s+to|直接\s*merge|直接\s*accept|直接\s*push)\b/i,
    message: 'Accept / merge / push 是终态决策，永远需要人按按钮——Mode B 安全边界硬约束。请在 Three-Stage Loop UI 找到候选后手动 Accept。' },
  { code: 'D_secret_probe', rx: /\.env\b|GITHUB_TOKEN|GH_TOKEN|API_KEY|secret\s+(?:key|token|value)|读.*\.env|cat\s+\.env/i,
    message: '读取 .env / 显示 API key 超出 Mentor 项目信号范围——只读 kernel 状态和 candidates 元数据。请直接在终端 cat .env 自查。' },
  { code: 'E_product_md_edit', rx: /(改|修改|删除|rewrite|edit)\s*(PRODUCT\.md|anti-?definition|反定义)/i,
    message: 'PRODUCT.md / 反定义条款是 governance 文档，Mentor 不提出修改建议——产品定位由用户主动决策并 commit。' },
  { code: 'F_auto_dispatch', rx: /(?:(?:直接|自动|帮我)[\s\S]{0,40}(?:跑|run|launch|dispatch|start)[\s\S]{0,80}(?:候选|candidate|top\s*\d))|(?:(?:候选|candidate|top\s*\d)[\s\S]{0,80}(?:直接|自动|帮我)[\s\S]{0,40}(?:跑|run|launch|dispatch|start))|auto[-_ ]?(?:run|dispatch|start)/i,
    message: '直接发起 candidate 执行需要在 Mode B Three-Stage Loop UI 给出显式授权——Mentor 是 advisor，不能在 chat 里 dispatch。' },
];

function _detectRefusal(userQuestion) {
  if (typeof userQuestion !== 'string') return null;
  for (const p of REFUSAL_PATTERNS) {
    if (p.rx.test(userQuestion)) return { code: p.code, message: p.message };
  }
  return null;
}

// ---------------------------------------------------------------------------
// LLM polish — drives a launcher run on the chosen provider
// ---------------------------------------------------------------------------
//
// We reuse the existing worker-launcher pipeline: write the prompt to
// run.json's prompt.txt, spawn the provider (claude-code / codex /
// fixture-mentor), poll until terminal, scan tail.log for the LAST
// `## Mentor Work Items` header followed by a JSON fence, parse, return.

const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS  = 4 * 60 * 1000;

async function _runPolishViaProvider(promptText, provider, opts) {
  const o = opts || {};
  // We use the launcher's launchWorker against a "virtual" cwd =
  // home tmp; the worker isn't supposed to touch a managed repo, this
  // is a pure prompt round. Some providers may require a cwd that
  // exists; pick the home dir as a safe neutral location.
  const cwd = o.cwd || (require('os').homedir());
  const launchRes = launcher.launchWorker({
    provider,
    cwd,
    prompt: promptText,
    iteration_id: 'mentor:' + (o.session_id || 'inline'),
    project_id:   'mentor:' + (o.project_id || ''),
  }, { home: o.home });
  if (!launchRes.ok) {
    return { ok: false, error: 'launch_failed', detail: launchRes.error };
  }
  const runId = launchRes.run_id;
  const t0 = Date.now();
  let run = null;
  while ((Date.now() - t0) < POLL_TIMEOUT_MS) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    run = launcher.getWorkerRun(runId, { home: o.home });
    if (!run) break;
    if (run.status !== 'running' && run.status !== 'queued') break;
  }
  if (run && (run.status === 'running' || run.status === 'queued')) {
    launcher.stopWorkerRun(runId, { home: o.home });
    return { ok: false, error: 'timeout', run_id: runId };
  }
  if (!run || run.status !== 'exited') {
    return { ok: false, error: 'provider_nonzero', run_id: runId, status: run && run.status };
  }
  const tail = launcher.tailRunLog(runId, 128 * 1024, o.home);
  const parsed = _parseWorkItemsFromTail(tail);
  if (!parsed.ok) return { ok: false, error: parsed.error, run_id: runId, tail_bytes: tail.length };
  return { ok: true, work_items: parsed.work_items, run_id: runId, model: run.model || null };
}

/**
 * Find the LAST `## Mentor Work Items` header followed by a JSON
 * fenced block; parse the work_items array. Returns one of:
 *   { ok: true, work_items: [...] }
 *   { ok: false, error: 'no_header' | 'no_fence' | 'json_parse' | 'no_work_items_field' }
 */
function _parseWorkItemsFromTail(tail) {
  if (typeof tail !== 'string' || !tail) return { ok: false, error: 'no_log' };
  const matches = Array.from(tail.matchAll(/^##\s+Mentor\s+Work\s+Items\s*$/gim));
  if (!matches.length) return { ok: false, error: 'no_header' };
  const start = matches[matches.length - 1].index;
  const block = tail.slice(start);
  // Find the JSON fence (```json ... ```)
  const fenceMatch = block.match(/```(?:json)?\s*([\s\S]+?)```/);
  if (!fenceMatch) return { ok: false, error: 'no_fence' };
  let parsed;
  try { parsed = JSON.parse(fenceMatch[1]); }
  catch (_e) { return { ok: false, error: 'json_parse' }; }
  if (!parsed || !Array.isArray(parsed.work_items)) {
    return { ok: false, error: 'no_work_items_field' };
  }
  return { ok: true, work_items: parsed.work_items };
}

// ---------------------------------------------------------------------------
// Schema validation — §3 + §3.5 invariants 1-5
// ---------------------------------------------------------------------------

const ALLOWED_LMH = new Set(['L', 'M', 'H']);
const ALLOWED_STAKEHOLDER = new Set(['agent', 'human', 'either']);
const ALLOWED_NEXT_ACTIONS = new Set([
  'pick to start Continuous Iteration',
  'propose candidate then pick',
  'answer blocker question',
  'manual run via Codex CLI',
  'manual run via Claude Code',
  'create checkpoint then investigate',
  'defer / mark not-now',
  'escalate to human review',
]);
const ALLOWED_EVIDENCE_KINDS = new Set([
  'task', 'candidate', 'blocker', 'outcome', 'iteration', 'commit', 'doc',
]);
const TERMINAL_VERBS = /\b(merge|push|accept|reject|rollback)\b/i;

function _validateItem(item) {
  const errs = [];
  if (!item || typeof item !== 'object') return ['not_object'];
  if (typeof item.id !== 'string' || !/^m_[a-f0-9]{12}$/.test(item.id)) errs.push('bad_id');
  if (typeof item.description !== 'string' || item.description.length === 0) errs.push('no_description');
  if (typeof item.description === 'string' && item.description.length > 200) errs.push('description_over_200');
  if (!item.why || typeof item.why !== 'object') errs.push('no_why');
  else {
    if (typeof item.why.impact !== 'string') errs.push('no_impact');
    if (!ALLOWED_LMH.has(item.why.cost))    errs.push('bad_cost');
    if (!ALLOWED_LMH.has(item.why.risk))    errs.push('bad_risk');
    if (!ALLOWED_LMH.has(item.why.urgency)) errs.push('bad_urgency');
  }
  if (!item.stakeholders || typeof item.stakeholders !== 'object') errs.push('no_stakeholders');
  else {
    if (!ALLOWED_STAKEHOLDER.has(item.stakeholders.owner))    errs.push('bad_owner');
    if (!ALLOWED_STAKEHOLDER.has(item.stakeholders.reviewer)) errs.push('bad_reviewer');
    if (!Array.isArray(item.stakeholders.notify)) errs.push('bad_notify');
  }
  if (!ALLOWED_NEXT_ACTIONS.has(item.next_action)) errs.push('bad_next_action');
  // Invariant #5: terminal-decision verbs must be rewritten as escalate.
  if (typeof item.next_action === 'string'
      && TERMINAL_VERBS.test(item.next_action)
      && item.next_action !== 'escalate to human review') errs.push('terminal_verb_in_next_action');
  if (!Array.isArray(item.evidence_refs)) errs.push('bad_evidence_refs');
  else {
    for (const e of item.evidence_refs) {
      if (!e || !ALLOWED_EVIDENCE_KINDS.has(e.kind)) { errs.push('bad_evidence_kind'); break; }
    }
  }
  if (typeof item.confidence !== 'number' || !isFinite(item.confidence)
      || item.confidence < 0 || item.confidence > 1) errs.push('bad_confidence');
  // Invariant #1: description MUST NOT repeat evidence ref strings verbatim.
  if (typeof item.description === 'string' && Array.isArray(item.evidence_refs)) {
    for (const e of item.evidence_refs) {
      if (typeof e.ref === 'string' && e.ref.length > 8 && item.description.includes(e.ref)) {
        errs.push('redundant_id_in_description');
        break;
      }
    }
  }
  return errs;
}

function _enforceInvariants(items) {
  // Invariant #4: items with confidence < 0.5 must go to tail OR have
  // next_action='escalate to human review'. We reorder: stable
  // partition.
  const headLow  = items.filter(i => i.confidence < 0.5 && i.next_action !== 'escalate to human review');
  const escalate = items.filter(i => i.next_action === 'escalate to human review');
  const high     = items.filter(i => i.confidence >= 0.5 && i.next_action !== 'escalate to human review');
  return high.concat(escalate, headLow);
}

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

function _cacheKey(projectId, userQuestion, gitShort) {
  const h = crypto.createHash('sha256').update(String(userQuestion || '')).digest('hex').slice(0, 16);
  return `${projectId}::${h}::${gitShort || 'no_git'}`;
}

function _cacheGet(key) {
  const e = responseCache.get(key);
  if (!e) return null;
  if (Date.now() - e.cached_at > CACHE_TTL_MS) {
    responseCache.delete(key);
    return null;
  }
  return e;
}

function _cachePut(key, result, signals_hash) {
  if (responseCache.size >= CACHE_MAX_ENTRIES) {
    // drop oldest
    const oldest = [...responseCache.entries()].sort((a, b) => a[1].cached_at - b[1].cached_at)[0];
    if (oldest) responseCache.delete(oldest[0]);
  }
  responseCache.set(key, { result, cached_at: Date.now(), signals_hash });
}

function _signalsHash(signals) {
  const head = (signals.git && signals.git.head) || '';
  const ccount = (signals.candidates || []).length;
  const icount = (signals.iterations || []).length;
  const rcount = (signals.reports || []).length;
  return crypto.createHash('sha1')
    .update(`${head}::${ccount}:${icount}:${rcount}`)
    .digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Ask the Mentor for ranked work items.
 *
 * input: { user_question, provider, max_items?, skip_cache?, session_id?, previous_turns? }
 * opts:  { home, project_root, source_timeout_ms }
 *
 * Returns:
 *   on success: { ok: true, work_items: [...], meta: {...}, turn_id }
 *   on refusal: { ok: true, refused: true, refusal: {code, message}, turn_id }
 *   on hard error: { ok: false, error, detail? }
 */
async function askMentor(projectId, input, opts) {
  const o = opts || {};
  if (!projectId) return { ok: false, error: 'project_id_required' };
  const i = input || {};
  if (typeof i.user_question !== 'string' || !i.user_question.trim()) {
    return { ok: false, error: 'user_question_required' };
  }
  if (!i.provider) return { ok: false, error: 'provider_required' };

  // 0. Refusal detection (no LLM call, no history body — but we DO
  // append a refusal record so the user can audit what was asked).
  const refusal = _detectRefusal(i.user_question);
  if (refusal) {
    const turnId = history.newTurnId();
    history.appendMentorEntry(projectId, {
      turn_id: turnId,
      session_id: i.session_id || turnId,
      user_question: i.user_question,
      ranked_items: [],
      signals_summary: { refused: true, refusal_code: refusal.code },
      llm_meta: { host: 'refusal', model: null, tokens_in: 0, tokens_out: 0, latency_ms: 0, fallback_used: false },
    }, { home: o.home });
    return { ok: true, refused: true, refusal, turn_id: turnId };
  }

  // 1. Managed project record (for project_root resolution).
  const record = mp.readManagedProject(projectId, o.home);
  const projectRoot = o.project_root || (record && record.local_path) || null;

  // 2. Collect signals.
  const { signals, meta: collectMeta } = await collect.collectMentorSignals(projectId, {
    project_root: projectRoot,
    home: o.home,
    source_timeout_ms: o.source_timeout_ms,
  });
  const signalsHash = _signalsHash(signals);
  const gitShort = (signals.git && signals.git.head) || null;

  // 3. Cache check.
  const cacheKey = _cacheKey(projectId, i.user_question, gitShort);
  if (!i.skip_cache) {
    const cached = _cacheGet(cacheKey);
    if (cached && cached.signals_hash === signalsHash) {
      return Object.assign({}, cached.result, { meta: Object.assign({}, cached.result.meta, { cache_hit: true }) });
    }
  }

  // 4. Sparse state check.
  if (_isSparseState(signals)) {
    const turnId = history.newTurnId();
    history.appendMentorEntry(projectId, {
      turn_id: turnId,
      session_id: i.session_id || turnId,
      user_question: i.user_question,
      ranked_items: [],
      signals_hash: signalsHash,
      signals_summary: {
        candidates_count: (signals.candidates || []).length,
        tasks_count: 0,
        open_blockers: (signals.kernel && signals.kernel.blockers_open) || 0,
        failed_outcomes: (signals.kernel && signals.kernel.outcomes_failed) || 0,
        git_head: gitShort || null,
      },
      llm_meta: { host: 'sparse-state', model: null, tokens_in: 0, tokens_out: 0, latency_ms: 0, fallback_used: true },
    }, { home: o.home });
    return {
      ok: true,
      work_items: [],
      meta: { reason: 'sparse_state', collected_at: collectMeta.collected_at, failed_signals: collectMeta.failed_signals, signals_hash: signalsHash },
      turn_id: turnId,
    };
  }

  // 5. Deterministic skeleton.
  const skeleton = _skeletonFromSignals(signals);
  const maxItems = Math.min(Math.max(1, i.max_items || 5), 10);

  // 6. Compose prompt.
  let promptPack;
  try {
    promptPack = mentorPrompt.generateMentorPrompt({
      user_question: i.user_question,
      signals,
      ranked_skeleton: skeleton,
    }, { max_items: maxItems, previous_turns: i.previous_turns || [] });
  } catch (e) {
    return { ok: false, error: 'prompt_synthesis_failed', detail: String(e && e.message || e) };
  }

  // 7. LLM polish.
  const t0 = Date.now();
  const polishRes = await _runPolishViaProvider(promptPack.prompt_text, i.provider, {
    home: o.home, project_id: projectId, session_id: i.session_id,
  });
  const latencyMs = Date.now() - t0;

  let workItems = [];
  let fallbackUsed = false;
  if (polishRes.ok) {
    // Validate every item; drop the invalid ones (don't fail the whole call).
    const valid = [];
    const dropped = [];
    for (const item of polishRes.work_items) {
      const errs = _validateItem(item);
      if (errs.length) dropped.push({ id: item && item.id, errs });
      else valid.push(item);
    }
    workItems = _enforceInvariants(valid).slice(0, maxItems);
    if (dropped.length) collectMeta.failed_signals = (collectMeta.failed_signals || []).concat(dropped.map(d => ({ source: 'schema_validate', error: `dropped:${d.id}:${d.errs.join('+')}` })));
  } else {
    fallbackUsed = true;
    // Skeleton-only fallback (§8 scenario 1): emit deterministic items
    // with placeholder why / confidence:null. Each item gets a generated
    // id; next_action_hint maps to closed-set next_action.
    workItems = skeleton.slice(0, maxItems).map(s => ({
      id: 'm_' + crypto.randomBytes(6).toString('hex'),
      description: s.descriptor.slice(0, 200),
      why: { impact: '', cost: 'M', risk: 'M', urgency: 'M' },
      stakeholders: { owner: 'either', reviewer: 'human', notify: [] },
      next_action: s.next_action_hint,
      evidence_refs: s.evidence_refs,
      confidence: null,
    }));
  }

  // 8. History append.
  const turnId = history.newTurnId();
  history.appendMentorEntry(projectId, {
    turn_id: turnId,
    session_id: i.session_id || turnId,
    user_question: i.user_question,
    ranked_items: workItems,
    signals_hash: signalsHash,
    signals_summary: {
      candidates_count: (signals.candidates || []).length,
      tasks_count: 0,
      open_blockers: (signals.kernel && signals.kernel.blockers_open) || 0,
      failed_outcomes: (signals.kernel && signals.kernel.outcomes_failed) || 0,
      git_head: gitShort || null,
    },
    llm_meta: {
      host: i.provider,
      model: polishRes.model || null,
      tokens_in: 0, tokens_out: 0,
      latency_ms: latencyMs,
      fallback_used: fallbackUsed,
    },
  }, { home: o.home });

  // 9. Build result + cache.
  const result = {
    ok: true,
    work_items: workItems,
    meta: {
      fallback_used: fallbackUsed,
      polish_error: polishRes.ok ? null : polishRes.error,
      collected_at: collectMeta.collected_at,
      failed_signals: collectMeta.failed_signals,
      signals_hash: signalsHash,
      latency_ms: latencyMs,
      provider: i.provider,
    },
    turn_id: turnId,
  };
  if (!i.skip_cache) _cachePut(cacheKey, result, signalsHash);
  return result;
}

function listMentorHistoryHandler(projectId, limit, opts) {
  return history.listMentorHistory(projectId, limit || 50, { home: (opts && opts.home) || undefined });
}

function getMentorEntryHandler(projectId, turnId, opts) {
  return history.getMentorEntry(projectId, turnId, { home: (opts && opts.home) || undefined });
}

function _clearCacheForTesting() {
  responseCache.clear();
}

module.exports = {
  askMentor,
  listMentorHistory: listMentorHistoryHandler,
  getMentorEntry: getMentorEntryHandler,
  // exposed for smoke
  _skeletonFromSignals,
  _isSparseState,
  _detectRefusal,
  _parseWorkItemsFromTail,
  _validateItem,
  _enforceInvariants,
  _clearCacheForTesting,
  CACHE_TTL_MS,
};
