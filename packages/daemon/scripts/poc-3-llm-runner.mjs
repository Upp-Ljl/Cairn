/**
 * PoC-3 LLM Runner — MiniMax via OpenAI-compatible endpoint
 * Runs 20 NL prompts, collects raw responses, writes JSON output.
 * Does NOT score outputs — that is a separate scorer subagent task.
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

// ── 1. Load keys from keys.env ──────────────────────────────────────────────
const KEYS_FILE = resolve('D:/lll/cairn/.cairn-poc3-keys/keys.env');
const OUTPUT_FILE = resolve('D:/lll/cairn/.cairn-poc3-keys/poc3-minimax-raw.json');

function parseEnvFile(filePath) {
  const content = readFileSync(filePath, 'utf-8');
  const env = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    env[key] = value;
  }
  return env;
}

const env = parseEnvFile(KEYS_FILE);
const BASE_URL = env['MINIMAX_BASE_URL'];
const API_KEY = env['MINIMAX_API_KEY'];
const MODEL = env['MINIMAX_MODEL'];

if (!BASE_URL || !API_KEY || !MODEL) {
  console.error('ERROR: Missing required keys in keys.env (MINIMAX_BASE_URL / MINIMAX_API_KEY / MINIMAX_MODEL)');
  process.exit(1);
}

// ── 2. System instruction (Chinese version from §2 of poc-3-prep.md) ────────
const SYSTEM_INSTRUCTION = `你正在扮演 Cairn 的 Dispatch 模块。Cairn 是本机多 agent 协作的内核（Agent OS），
它不写代码，只把用户的自然语言需求翻译成 agent 能直接使用的 prompt。

每收到一条用户 NL 需求，你必须输出一个结构化 JSON：

{
  "intent": "简短意图标签，如 dispatch.refactor / dispatch.fix / dispatch.review / inspect.history / dispatch.newfeature",
  "agent_choice": "Claude Code | Cursor | Aider | None（说明原因）",
  "prompt_to_agent": "你要派给该 agent 的 prompt 全文（必须可以直接发给 agent 执行，不加废话）",
  "history_keywords": ["关键词1", "关键词2", "...（用于从 scratchpad / checkpoint 检索相关历史）"],
  "risks": ["需要 preview 的危险操作", "需要二次确认的不可逆动作", "...（如果没有风险可以是空数组）"],
  "uncertainty": "你拿不准的地方（如果没有则写 null）"
}

上下文假设：
- 当前活跃的 agent 是 Claude Code（已有当前 repo 的上下文），备选 Cursor。
- Cairn 已记录的 scratchpad / checkpoint 里有过去 1-7 天的开发历史（含需求记录、中间决策、文件改动记录）。
- 你不直接执行，只输出结构化派单决定，用户审查后才会转发给 agent。
- 如果用户 NL 模糊或者需要查历史才能解析，在 uncertainty 字段里明确说明。
- 严格按 JSON 格式输出，不加任何解释文字，不加 markdown 代码块标记。`;

// ── 3. 20 NL prompts (hardcoded from §3 of poc-3-prep.md) ───────────────────
const NL_PROMPTS = [
  // Category A: Simple dispatch
  {
    id: 'A.1',
    category: 'A',
    text: '把整个 repo 里 utils_v2 这个命名改成 string_helpers，含 import / 注释。改完跑一遍测试，挂了停下来问我。',
  },
  {
    id: 'A.2',
    category: 'A',
    text: '帮我写一个函数 formatBytes(n: number): string，把字节数转成人类可读字符串（例：1024 → \'1 KB\'），放在 src/utils/format.ts，然后写对应的单测。',
  },
  {
    id: 'A.3',
    category: 'A',
    text: 'review 一下 packages/mcp-server/src/index.ts 这个文件，找出潜在的类型不安全点和 error handling 遗漏，给我一份 review 意见，不要改代码。',
  },
  {
    id: 'A.4',
    category: 'A',
    text: '在 packages/daemon/src/storage/db.ts 顶部加一行注释：// Core database module – do not modify without migration。不用跑测试。',
  },
  {
    id: 'A.5',
    category: 'A',
    text: '把 src/config.ts 里的 DEFAULT_TIMEOUT 从 5000 改成 10000，然后搜一下整个 repo 有没有 hardcode 了 5000 这个数字的地方，有的话列出来但不要改。',
  },
  // Category B: Compound dispatch
  {
    id: 'B.1',
    category: 'B',
    text: '先把 auth 模块的测试跑一遍看看哪些挂了，挂了就让 Claude Code 修，修完再跑一遍确认。如果两次都挂同一个测试，停下来告诉我，不要继续。',
  },
  {
    id: 'B.2',
    category: 'B',
    text: '给 cairn 的 scratchpad.write 工具加一个参数校验：key 不能包含 / 开头和结尾的斜杠，否则报错。改完写测试，测试绿了再 commit，commit message 用 feat(scratchpad): validate key format。',
  },
  {
    id: 'B.3',
    category: 'B',
    text: '帮我做一个 end-to-end 检查：1）列出 packages/daemon/src/storage/migrations/ 下所有 migration 文件；2）看看 migrations/index.ts 里的 ALL_MIGRATIONS 数组顺序是否和文件名的数字前缀一致；3）如果不一致，告诉我哪条不对，不要自己改。',
  },
  {
    id: 'B.4',
    category: 'B',
    text: '把 mcp-server 的依赖都升到最新（npm update），升完跑全套测试，测试挂了就回滚（npm install 用旧的 package-lock），然后把哪个依赖升级导致测试挂告诉我。',
  },
  {
    id: 'B.5',
    category: 'B',
    text: '看一下最近 7 天 scratchpad 里所有 subagent/* 开头的 key，把内容整理成一份摘要 markdown，每个 key 一段，格式是 ### key \\n 摘要内容，最后保存到 docs/subagent-weekly-digest.md。',
  },
  // Category C: Ambiguous intent
  {
    id: 'C.1',
    category: 'C',
    text: 'auth 改的方向不对，和上周五我说的需求不一致，帮我找到对的 agent 重做这一块。',
  },
  {
    id: 'C.2',
    category: 'C',
    text: '上次那个 migration 还没测完，继续。',
  },
  {
    id: 'C.3',
    category: 'C',
    text: '昨天的 schema 设计和我脑子里想的不一样，改回去。',
  },
  {
    id: 'C.4',
    category: 'C',
    text: 'subagent B 的结果和 subagent A 的 schema 对不上，把 schema 那边让 CC 修一遍。',
  },
  {
    id: 'C.5',
    category: 'C',
    text: '之前让 CC 做的那个 hook，感觉性能不对，帮我看看。',
  },
  // Category D: Dangerous / edge cases
  {
    id: 'D.1',
    category: 'D',
    text: '把整个 src/ 目录下的 any 类型全部改掉，换成合适的类型，不要问我每个具体怎么改，你自己判断。',
  },
  {
    id: 'D.2',
    category: 'D',
    text: '清空 scratchpad 里所有超过 3 天的记录，包括 subagent 的结果。',
  },
  {
    id: 'D.3',
    category: 'D',
    text: '把所有 checkpoint 里标了 CORRUPTED 的记录都删了，数据库直接改。',
  },
  {
    id: 'D.4',
    category: 'D',
    text: '同时让三个 subagent 去改 shared/types.ts，每个负责一部分，改完合起来。',
  },
  {
    id: 'D.5',
    category: 'D',
    text: '帮我写一个脚本，把我们项目的所有 .ts 源文件打包成一个字符串发给 Claude API，让它做全局代码审查，结果存到 docs/global-review.md。',
  },
];

// ── 4. API call helper ───────────────────────────────────────────────────────
async function callChatCompletions(nlText) {
  const url = `${BASE_URL}/chat/completions`;
  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: SYSTEM_INSTRUCTION },
      { role: 'user', content: nlText },
    ],
    temperature: 0.3,
    max_tokens: 2048,
  };

  const startMs = Date.now();
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (fetchErr) {
    return {
      http_status: null,
      latency_ms: Date.now() - startMs,
      raw_response_text: null,
      parsed_json: null,
      parse_error: null,
      tokens_used: null,
      error: `fetch error: ${fetchErr.message}`,
    };
  }

  const latency_ms = Date.now() - startMs;
  const http_status = response.status;
  const responseText = await response.text();

  if (http_status < 200 || http_status >= 300) {
    return {
      http_status,
      latency_ms,
      raw_response_text: null,
      parsed_json: null,
      parse_error: null,
      tokens_used: null,
      error: `HTTP ${http_status}: ${responseText.slice(0, 500)}`,
    };
  }

  // Parse the outer response envelope
  let envelope;
  try {
    envelope = JSON.parse(responseText);
  } catch {
    return {
      http_status,
      latency_ms,
      raw_response_text: responseText,
      parsed_json: null,
      parse_error: 'envelope JSON parse failed',
      tokens_used: null,
      error: null,
    };
  }

  const rawContent = envelope?.choices?.[0]?.message?.content ?? null;
  const tokens_used = envelope?.usage
    ? {
        prompt_tokens: envelope.usage.prompt_tokens ?? 0,
        completion_tokens: envelope.usage.completion_tokens ?? 0,
        total_tokens: envelope.usage.total_tokens ?? 0,
      }
    : null;

  // Try to parse the model's JSON output
  // MiniMax-M2.7 is a reasoning model: output has <think>...</think> block before the JSON.
  // We strip the think block first, then strip optional markdown fences.
  let parsed_json = null;
  let parse_error = null;

  if (rawContent !== null) {
    let candidate = rawContent.trim();
    // Strip <think>...</think> (reasoning model preamble — may contain nested content)
    candidate = candidate.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    // Strip ```json ... ``` or ``` ... ```
    const fenceMatch = candidate.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
    if (fenceMatch) {
      candidate = fenceMatch[1].trim();
    }
    try {
      parsed_json = JSON.parse(candidate);
    } catch (e) {
      parse_error = e.message;
    }
  }

  return {
    http_status,
    latency_ms,
    raw_response_text: rawContent,
    parsed_json,
    parse_error,
    tokens_used,
    error: null,
  };
}

// ── 5. Sleep helper ──────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── 6. Main runner ───────────────────────────────────────────────────────────
async function main() {
  const endpoint = `${BASE_URL}/chat/completions`;
  console.log(`\nPoC-3 LLM Runner — MiniMax (${MODEL})`);
  console.log(`Endpoint: ${endpoint}`);
  console.log(`Running ${NL_PROMPTS.length} prompts...\n`);

  const startedAt = new Date().toISOString();
  const results = [];

  for (let i = 0; i < NL_PROMPTS.length; i++) {
    const prompt = NL_PROMPTS[i];
    process.stdout.write(`[${i + 1}/${NL_PROMPTS.length}] ${prompt.id} (${prompt.category}) ... `);

    let callResult = await callChatCompletions(prompt.text);

    // ── First-call gate ───────────────────────────────────────────────────
    if (i === 0) {
      if (callResult.http_status === 401 || callResult.http_status === 403) {
        console.log(`\nFATAL: Authentication failed (HTTP ${callResult.http_status}).`);
        console.log('Please check that MINIMAX_API_KEY in keys.env is valid and has not expired.');
        process.exit(1);
      }
      if (callResult.http_status === 404) {
        console.log(`\nFATAL: Endpoint not found (HTTP 404).`);
        console.log(`Tried: ${endpoint}`);
        console.log('Suggestion: Change MINIMAX_BASE_URL to https://api.minimax.chat/v1 (domestic endpoint) and re-run.');
        process.exit(1);
      }
      if (callResult.http_status === null && callResult.error) {
        console.log(`\nFATAL: ${callResult.error}`);
        process.exit(1);
      }
      if (callResult.http_status !== null && (callResult.http_status < 200 || callResult.http_status >= 300)) {
        // Not 401/403/404 — report and exit
        console.log(`\nFATAL: Unexpected HTTP ${callResult.http_status} on first call.`);
        console.log(`Response (first 500 chars): ${callResult.error?.slice(0, 500) ?? '(no body)'}`);
        process.exit(1);
      }
    }

    // ── 429 retry (single retry after 30s, only after first call passed) ──
    if (callResult.http_status === 429) {
      if (i === 0) {
        console.log('\nFATAL: Rate limit (429) on first call. Stopping.');
        process.exit(1);
      }
      console.log('429 rate limit — waiting 30s and retrying once...');
      await sleep(30000);
      callResult = await callChatCompletions(prompt.text);
      if (callResult.http_status === 429) {
        console.log(`\nFATAL: Rate limit hit again on prompt ${prompt.id}. Stopping run.`);
        process.exit(1);
      }
    }

    const result = {
      prompt_id: prompt.id,
      category: prompt.category,
      nl_text: prompt.text,
      http_status: callResult.http_status,
      latency_ms: callResult.latency_ms,
      raw_response_text: callResult.raw_response_text,
      parsed_json: callResult.parsed_json,
      parse_error: callResult.parse_error ?? null,
      tokens_used: callResult.tokens_used,
      error: callResult.error ?? null,
    };
    results.push(result);

    const ok = callResult.http_status === 200;
    const parsed = callResult.parsed_json !== null;
    console.log(`HTTP ${callResult.http_status ?? 'ERR'}, ${callResult.latency_ms}ms, parsed_json=${parsed}${callResult.error ? ', error=' + callResult.error.slice(0, 80) : ''}`);
  }

  const finishedAt = new Date().toISOString();

  // ── 7. Build output JSON ──────────────────────────────────────────────────
  const output = {
    provider: 'MiniMax',
    model: MODEL,
    endpoint,
    instruction_lang: 'zh',
    started_at: startedAt,
    finished_at: finishedAt,
    results,
  };

  writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), 'utf-8');

  // ── 8. Summary ────────────────────────────────────────────────────────────
  const http200Count = results.filter((r) => r.http_status === 200).length;
  const parsedCount = results.filter((r) => r.parsed_json !== null).length;
  const latencies = results.filter((r) => r.latency_ms != null).map((r) => r.latency_ms);
  const totalLatency = latencies.reduce((a, b) => a + b, 0);
  const avgLatency = latencies.length ? Math.round(totalLatency / latencies.length) : 0;
  const maxLatency = latencies.length ? Math.max(...latencies) : 0;

  const totalPromptTokens = results.reduce((s, r) => s + (r.tokens_used?.prompt_tokens ?? 0), 0);
  const totalCompletionTokens = results.reduce((s, r) => s + (r.tokens_used?.completion_tokens ?? 0), 0);
  const totalTokens = results.reduce((s, r) => s + (r.tokens_used?.total_tokens ?? 0), 0);

  // Elapsed wall time
  const elapsedMs = new Date(finishedAt) - new Date(startedAt);
  const elapsedSec = (elapsedMs / 1000).toFixed(1);

  console.log('\n══════════════════════════════════════════════════');
  console.log('  PoC-3 MiniMax Runner — SUMMARY');
  console.log('══════════════════════════════════════════════════');
  console.log(`  HTTP 200:       ${http200Count}/20`);
  console.log(`  JSON parsed:    ${parsedCount}/20`);
  console.log(`  Total elapsed:  ${elapsedSec}s`);
  console.log(`  Avg latency:    ${avgLatency}ms`);
  console.log(`  Max latency:    ${maxLatency}ms`);
  console.log(`  Tokens (P/C/T): ${totalPromptTokens} / ${totalCompletionTokens} / ${totalTokens}`);
  console.log(`  Output:         ${OUTPUT_FILE}`);

  // Flag anomalies for scorer
  const anomalies = [];
  for (const r of results) {
    if (r.http_status === 200 && r.parsed_json === null) {
      anomalies.push(`  [${r.prompt_id}] HTTP 200 but JSON parse failed: ${r.parse_error}`);
    }
    if (r.http_status !== 200 && r.error) {
      anomalies.push(`  [${r.prompt_id}] Non-200: ${r.error.slice(0, 120)}`);
    }
    // Detect markdown fence remnants in raw response
    if (r.raw_response_text && r.raw_response_text.trim().startsWith('```')) {
      anomalies.push(`  [${r.prompt_id}] Model wrapped output in markdown fence (stripped before parse)`);
    }
    // Flag unusually long outputs
    if (r.tokens_used && r.tokens_used.completion_tokens > 600) {
      anomalies.push(`  [${r.prompt_id}] Long output: ${r.tokens_used.completion_tokens} completion tokens`);
    }
  }

  if (anomalies.length > 0) {
    console.log('\n  ── Anomalies for scorer ──');
    for (const a of anomalies) console.log(a);
  } else {
    console.log('\n  No anomalies detected.');
  }

  console.log('══════════════════════════════════════════════════\n');
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
