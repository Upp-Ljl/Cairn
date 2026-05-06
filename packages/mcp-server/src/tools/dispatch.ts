/**
 * cairn.dispatch.request + cairn.dispatch.confirm
 *
 * Implements §3.2.3 of personal-build.md:
 * - NL → LLM intent parsing (mock by default)
 * - 4 application-layer fallback rules (keyword-triggered, no LLM)
 * - State machine: PENDING → CONFIRMED via confirm tool
 * - confirm writes generated_prompt to scratchpad
 *
 * R5/R4b deferred to v0.2 (see PRODUCT.md TODO).
 */

import {
  createDispatchRequest,
  getDispatchRequest,
  confirmDispatchRequest,
  failDispatchRequest,
} from '../../../daemon/dist/storage/repositories/dispatch-requests.js';
import {
  listProcesses,
} from '../../../daemon/dist/storage/repositories/processes.js';
import {
  putScratch,
  getScratch,
} from '../../../daemon/dist/storage/repositories/scratchpad.js';
import {
  loadConfig,
  completionStrictJson,
} from '../../../daemon/dist/dispatch/llm-client.js';
import {
  ConfigNotFoundError,
  LlmHttpError,
  LlmTimeoutError,
  LlmParseError,
} from '../../../daemon/dist/dispatch/types.js';
import type { Workspace } from '../workspace.js';

// ---------------------------------------------------------------------------
// Arg types
// ---------------------------------------------------------------------------

export interface DispatchRequestArgs {
  nl_intent: string;
  task_id?: string;
  target_agent?: string;
}

export interface DispatchConfirmArgs {
  request_id: string;
}

// ---------------------------------------------------------------------------
// System prompt (hardcoded, compact version of PoC-3 prep §2)
// ---------------------------------------------------------------------------

const DISPATCH_SYSTEM_PROMPT = `你是 Cairn 派单路由器。根据用户的自然语言意图，输出一个 JSON 对象（不要包裹在 markdown 代码块里）。

字段要求：
- intent: string，简短描述任务意图（英文）
- agent_choice: string，推荐执行该任务的 agent 类型（如 "Claude Code"、"orchestrator"）
- prompt_to_agent: string，给目标 agent 的完整执行指令
- history_keywords: string[]，用于检索相关历史 scratchpad 的关键词（2-5 个）
- risks: string[]，潜在风险或注意事项（可为空数组）
- uncertainty: string | null，不确定因素说明

只输出 JSON，不要任何前缀或解释。`;

// ---------------------------------------------------------------------------
// Fallback rules
// ---------------------------------------------------------------------------

// R1: irreversible / destructive operations
const R1_KEYWORDS = [
  'rewind', '回滚', '回退', 'delete', '删除', '清空', 'drop', 'truncate', 'rm ',
];

// R2: external API / data exfiltration
const R2_KEYWORDS = [
  'external api', '外部 api', 'openai', 'anthropic', 'claude api',
  '上传', '发送', '云端', 'send to', 'upload',
];

// R4: direct SQLite manipulation
const R4_KEYWORDS = [
  'sqlite', 'sql', '数据库', '.db', 'drop table', 'alter table', 'vacuum',
];

function containsAny(text: string, keywords: string[]): boolean {
  return keywords.some((kw) => text.includes(kw));
}

/**
 * Apply application-layer fallback rules to a prompt draft.
 * Rules are keyword-triggered and independent — they can stack.
 *
 * @param promptDraft     - The LLM-generated prompt_to_agent string
 * @param nlIntentLower   - Original NL intent from user (already lowercased)
 * @param processCount    - Number of currently ACTIVE/IDLE agents
 * @param recentRewindMs  - Ms since last cairn.rewind.to, or null if no rewind ever
 * @returns { prompt: string; applied: string[] }
 */
export function applyFallbackRules(
  promptDraft: string,
  nlIntentLower: string,
  processCount: number,
  recentRewindMs: number | null = null,
): { prompt: string; applied: string[] } {
  let prompt = promptDraft;
  const applied: string[] = [];

  // R1: irreversible / delete operations
  if (containsAny(nlIntentLower, R1_KEYWORDS)) {
    prompt +=
      '\n\n[FALLBACK R1] 这是一个不可逆 / 删除操作。执行前必须先调用 cairn.rewind.preview 或等价 dry-run 命令展示影响范围给用户确认；用户明确确认后再执行实际操作。';
    applied.push('R1');
  }

  // R2: external API / data leaving the machine
  if (containsAny(nlIntentLower, R2_KEYWORDS)) {
    prompt +=
      '\n\n[FALLBACK R2] 此任务涉及外部 API / 数据离机。执行前先告知用户：(a) 数据将发送到 [具体 endpoint]，(b) API key / 凭证管理风险，(c) token 费用预估；用户明确同意后再执行。';
    applied.push('R2');
  }

  // R3: multi-agent path overlap — v1 simplified: any >=2 active agents triggers this
  if (processCount >= 2) {
    prompt +=
      `\n\n[FALLBACK R3] 当前有 ${processCount} 个活跃 agent，目标路径有重叠风险。建议串行：先让一个 agent 完成此任务，确认提交后再开始下一个；或先用 cairn.conflict.list 查看现有冲突。`;
    applied.push('R3');
  }

  // R4: direct SQLite / DB manipulation
  if (containsAny(nlIntentLower, R4_KEYWORDS)) {
    prompt +=
      '\n\n[FALLBACK R4] 不要直接操作 SQLite 文件。所有数据库变更必须走 cairn 工具（cairn.scratchpad.* / cairn.checkpoint.* / cairn.rewind.* 等）；DDL 变更必须用 migration 而非 ALTER 现网。';
    applied.push('R4');
  }

  // R6: recent rewind — re-confirm intent
  if (recentRewindMs !== null && recentRewindMs <= 3000) {
    prompt +=
      '\n\n[FALLBACK R6] 检测到 3 秒内刚执行过 cairn.rewind.to。再次派单前请重新评估意图：rewind 已经回退了部分文件状态，原任务的前提可能已不成立。';
    applied.push('R6');
  }

  return { prompt, applied };
}

// ---------------------------------------------------------------------------
// Context key retrieval (deterministic SQL, keyword LIKE)
// ---------------------------------------------------------------------------

function fetchContextKeys(ws: Workspace, keywords: string[]): string[] {
  if (keywords.length === 0) return [];

  const MAX_KEYS = 5;
  const seen = new Set<string>();

  for (const kw of keywords) {
    if (seen.size >= MAX_KEYS) break;
    const rows = ws.db
      .prepare("SELECT key FROM scratchpad WHERE key LIKE ? LIMIT ?")
      .all(`%${kw}%`, MAX_KEYS) as { key: string }[];
    for (const r of rows) {
      seen.add(r.key);
      if (seen.size >= MAX_KEYS) break;
    }
  }

  return Array.from(seen);
}

// ---------------------------------------------------------------------------
// Target agent selection
// ---------------------------------------------------------------------------

/**
 * Determine target_agent:
 * 1. Explicit user override
 * 2. LLM-suggested agent_choice matched against active processes (case-insensitive contains)
 * 3. First active agent in process list
 * 4. 'default' if no processes registered
 */
function resolveTargetAgent(
  ws: Workspace,
  userOverride: string | undefined,
  llmChoice: string,
): { targetAgent: string; processCount: number } {
  if (userOverride) {
    // Still fetch processCount for R3 rule
    const procs = listProcesses(ws.db, { statuses: ['ACTIVE', 'IDLE'] });
    return { targetAgent: userOverride, processCount: procs.length };
  }

  const procs = listProcesses(ws.db, { statuses: ['ACTIVE', 'IDLE'] });

  if (procs.length === 0) {
    return { targetAgent: 'default', processCount: 0 };
  }

  // Try to match LLM suggestion against agent_id or agent_type
  const choiceLower = llmChoice.toLowerCase();
  const matched = procs.find(
    (p) =>
      p.agent_id.toLowerCase().includes(choiceLower) ||
      p.agent_type.toLowerCase().includes(choiceLower) ||
      choiceLower.includes(p.agent_id.toLowerCase()) ||
      choiceLower.includes(p.agent_type.toLowerCase()),
  );

  return {
    targetAgent: matched ? matched.agent_id : procs[0]!.agent_id,
    processCount: procs.length,
  };
}

// ---------------------------------------------------------------------------
// Tool: cairn.dispatch.request
// ---------------------------------------------------------------------------

export async function toolDispatchRequest(ws: Workspace, args: DispatchRequestArgs) {
  const { nl_intent, task_id, target_agent } = args;

  // Basic validation
  if (!nl_intent || nl_intent.trim().length < 5) {
    return { ok: false, error: 'nl_intent must be at least 5 characters' };
  }

  // CAIRN_DISPATCH_FORCE_FAIL: bypass LLM, write FAILED record, return error
  const forceFailVal = process.env['CAIRN_DISPATCH_FORCE_FAIL'];
  if (forceFailVal === '1' || forceFailVal === 'true' || forceFailVal === 'yes') {
    const { id: request_id } = createDispatchRequest(ws.db, {
      nlIntent: nl_intent,
      parsedIntent: null,
      generatedPrompt: null,
      targetAgent: target_agent ?? null,
    });
    failDispatchRequest(ws.db, request_id, 'forced fail via CAIRN_DISPATCH_FORCE_FAIL');
    return {
      ok: false,
      error: 'dispatch forced to fail (CAIRN_DISPATCH_FORCE_FAIL)',
      request_id,
      status: 'FAILED',
    };
  }

  // 1. Load LLM config
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigNotFoundError) {
      return {
        ok: false,
        error: 'LLM config missing; set env or run in mock mode',
      };
    }
    throw err;
  }

  // 2. Build chat messages
  const messages = [
    { role: 'system' as const, content: DISPATCH_SYSTEM_PROMPT },
    { role: 'user' as const, content: nl_intent },
  ];

  // 3. Call LLM (mock by default)
  let parsedJson: Record<string, unknown>;
  let requestId: string | undefined;

  try {
    const { json } = await completionStrictJson(messages, config);
    parsedJson = json;
  } catch (err) {
    // LlmParseError — write FAILED record and return error
    if (err instanceof LlmParseError) {
      const { id } = createDispatchRequest(ws.db, {
        nlIntent: nl_intent,
        parsedIntent: null,
        generatedPrompt: null,
        targetAgent: target_agent ?? null,
      });
      failDispatchRequest(ws.db, id, 'LLM response was not a JSON object');
      return {
        ok: false,
        error: 'LLM response was not a valid JSON object',
        request_id: id,
        status: 'FAILED',
      };
    }
    if (err instanceof LlmHttpError || err instanceof LlmTimeoutError) {
      const { id } = createDispatchRequest(ws.db, {
        nlIntent: nl_intent,
        parsedIntent: null,
        generatedPrompt: null,
        targetAgent: target_agent ?? null,
      });
      failDispatchRequest(ws.db, id, String(err));
      return {
        ok: false,
        error: (err as Error).message,
        request_id: id,
        status: 'FAILED',
      };
    }
    throw err;
  }

  // 4. Extract fields from parsed JSON
  const intent = (parsedJson['intent'] as string | undefined) ?? '';
  const agentChoice = (parsedJson['agent_choice'] as string | undefined) ?? '';
  const promptToAgent = (parsedJson['prompt_to_agent'] as string | undefined) ?? nl_intent;
  const historyKeywords = Array.isArray(parsedJson['history_keywords'])
    ? (parsedJson['history_keywords'] as string[])
    : [];
  const risks = Array.isArray(parsedJson['risks'])
    ? (parsedJson['risks'] as string[])
    : [];

  // 5. Deterministic SQL context retrieval
  const contextKeys = fetchContextKeys(ws, historyKeywords);

  // 6. Resolve target agent + process count
  const { targetAgent, processCount } = resolveTargetAgent(ws, target_agent, agentChoice);

  // 7. Compute recentRewindMs from scratchpad (agent-scoped key prevents cross-agent R6 crosstalk)
  let recentRewindMs: number | null = null;
  try {
    const lastRewound = getScratch(ws.db, `_rewind_last_invoked/${ws.agentId}`);
    if (typeof lastRewound === 'string' && lastRewound.length > 0) {
      const ts = Date.parse(lastRewound);
      if (!isNaN(ts)) {
        recentRewindMs = Date.now() - ts;
      }
    }
  } catch {
    // fail-open: ignore read errors
  }

  // 8. Apply fallback rules (R1-R4, R6)
  const nlLower = nl_intent.toLowerCase();
  const { prompt: generatedPrompt, applied: fallbackRulesApplied } = applyFallbackRules(
    promptToAgent,
    nlLower,
    processCount,
    recentRewindMs,
  );

  // 9. Write dispatch request (PENDING)
  const { id } = createDispatchRequest(ws.db, {
    nlIntent: nl_intent,
    parsedIntent: parsedJson,
    contextKeys,
    generatedPrompt,
    targetAgent,
  });
  requestId = id;

  // 10. Build warnings
  const warnings: string[] = [];
  if (risks.length > 0) {
    warnings.push(...risks.map((r) => `[LLM risk] ${r}`));
  }

  return {
    ok: true,
    request_id: requestId,
    intent,
    target_agent: targetAgent,
    generated_prompt: generatedPrompt,
    context_keys: contextKeys,
    fallback_rules_applied: fallbackRulesApplied,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Tool: cairn.dispatch.confirm
// ---------------------------------------------------------------------------

export function toolDispatchConfirm(ws: Workspace, args: DispatchConfirmArgs) {
  const { request_id } = args;

  // 1. Fetch the request
  const req = getDispatchRequest(ws.db, request_id);
  if (!req) {
    return { ok: false, error: `dispatch request not found: ${request_id}` };
  }

  // 2. Validate status
  if (req.status !== 'PENDING') {
    return {
      ok: false,
      error: `cannot confirm: status is ${req.status}`,
      current_status: req.status,
    };
  }

  // 3. Confirm (PENDING → CONFIRMED)
  const confirmed = confirmDispatchRequest(ws.db, request_id);

  // 4. Write generated_prompt to scratchpad
  const scratchpadKey = `dispatch/${request_id}/prompt`;
  putScratch(ws.db, ws.blobRoot, {
    key: scratchpadKey,
    value: confirmed.generated_prompt ?? '',
    task_id: null,
  });

  return {
    ok: true,
    scratchpad_key: scratchpadKey,
    target_agent: confirmed.target_agent,
    dispatched_at_iso: new Date(confirmed.confirmed_at!).toISOString(),
    request_id,
  };
}
