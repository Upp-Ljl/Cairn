/**
 * Dispatch LLM client — provider-agnostic OpenAI-compatible HTTP client
 *
 * Design principles (ADR-4):
 * - Default mode='mock' to avoid accidental API spend
 * - No external dependencies — uses Node built-in fetch + AbortController
 * - Exponential backoff retry for 5xx / 429 / timeout / network errors
 * - Strips <think>...</think> reasoning blocks and markdown fences (PoC-3 verified)
 */

import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { resolve, join } from 'path';

import {
  LlmClientConfig,
  ChatMessage,
  CompletionResult,
  ConfigNotFoundError,
  LlmHttpError,
  LlmTimeoutError,
  LlmParseError,
} from './types.js';

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_TEMPERATURE = 0.3;
const DEFAULT_MAX_TOKENS = 2048;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_MODE: 'real' | 'mock' = 'mock';

/** Stub config used when mode=mock and no real config is found */
const STUB_CONFIG: LlmClientConfig = {
  endpoint: 'mock://',
  apiKey: 'mock',
  model: 'mock-model',
  temperature: DEFAULT_TEMPERATURE,
  maxTokens: DEFAULT_MAX_TOKENS,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  maxRetries: DEFAULT_MAX_RETRIES,
  mode: 'mock',
};

// ── Config loading ───────────────────────────────────────────────────────────

/**
 * Parse a simple KEY=VALUE env file (same format as PoC-3 keys.env).
 * Lines starting with # or blank lines are ignored.
 */
function parseEnvFile(filePath: string): Record<string, string> {
  const content = readFileSync(filePath, 'utf-8');
  const env: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (key) env[key] = value;
  }
  return env;
}

/**
 * Load LLM client configuration.
 *
 * Priority order:
 * 1. opts.configPath  — explicit JSON config file
 * 2. Environment variables (CAIRN_LLM_BASE_URL / CAIRN_LLM_API_KEY / CAIRN_LLM_MODEL / CAIRN_LLM_MODE)
 * 3. ~/.cairn/config.json
 * 4. <repo-root>/.cairn-poc3-keys/keys.env (dev convenience fallback, warns)
 *
 * If none found and mode='real' → throws ConfigNotFoundError
 * If none found and mode='mock' (default) → returns stub config, no error
 */
export function loadConfig(opts?: { configPath?: string }): LlmClientConfig {
  // Determine mode early so we can decide whether to throw or stub
  const modeFromEnv = process.env['CAIRN_LLM_MODE'] as 'real' | 'mock' | undefined;
  const effectiveMode: 'real' | 'mock' = modeFromEnv ?? DEFAULT_MODE;

  // 1. Explicit JSON config file
  if (opts?.configPath) {
    const raw = readFileSync(opts.configPath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<LlmClientConfig>;
    return applyDefaults(parsed, effectiveMode);
  }

  // 2. Environment variables
  const baseUrl = process.env['CAIRN_LLM_BASE_URL'];
  const apiKey = process.env['CAIRN_LLM_API_KEY'];
  const model = process.env['CAIRN_LLM_MODEL'];

  if (baseUrl && apiKey && model) {
    return applyDefaults(
      { endpoint: baseUrl, apiKey, model, mode: effectiveMode },
      effectiveMode,
    );
  }

  // 3. ~/.cairn/config.json
  const homeConfigPath = join(homedir(), '.cairn', 'config.json');
  if (existsSync(homeConfigPath)) {
    const raw = readFileSync(homeConfigPath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<LlmClientConfig>;
    // env mode overrides file mode
    return applyDefaults({ ...parsed, mode: effectiveMode }, effectiveMode);
  }

  // 4. Dev fallback: .cairn-poc3-keys/keys.env (repo-root relative)
  const repoRoot = findRepoRoot();
  if (repoRoot) {
    const keysEnvPath = resolve(repoRoot, '.cairn-poc3-keys', 'keys.env');
    if (existsSync(keysEnvPath)) {
      console.warn(
        '[cairn/llm-client] WARNING: loading config from dev fallback ' +
          keysEnvPath +
          '. Set CAIRN_LLM_BASE_URL/API_KEY/MODEL or ~/.cairn/config.json for production use.',
      );
      const env = parseEnvFile(keysEnvPath);
      const rawEndpoint = env['MINIMAX_BASE_URL'];
      const rawApiKey = env['MINIMAX_API_KEY'];
      const rawModel = env['MINIMAX_MODEL'];
      if (rawEndpoint && rawApiKey && rawModel) {
        return applyDefaults(
          { endpoint: rawEndpoint + '/chat/completions', apiKey: rawApiKey, model: rawModel, mode: effectiveMode },
          effectiveMode,
        );
      }
    }
  }

  // Nothing found
  if (effectiveMode === 'real') {
    throw new ConfigNotFoundError(
      'No LLM config found. Set CAIRN_LLM_BASE_URL, CAIRN_LLM_API_KEY, CAIRN_LLM_MODEL ' +
        '(and CAIRN_LLM_MODE=real), or create ~/.cairn/config.json.',
    );
  }

  // mode=mock: return stub config, no error
  return { ...STUB_CONFIG };
}

function applyDefaults(
  partial: Partial<LlmClientConfig>,
  resolvedMode: 'real' | 'mock',
): LlmClientConfig {
  return {
    endpoint: partial.endpoint ?? '',
    apiKey: partial.apiKey ?? '',
    model: partial.model ?? '',
    temperature: partial.temperature ?? DEFAULT_TEMPERATURE,
    maxTokens: partial.maxTokens ?? DEFAULT_MAX_TOKENS,
    timeoutMs: partial.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxRetries: partial.maxRetries ?? DEFAULT_MAX_RETRIES,
    mode: partial.mode ?? resolvedMode,
  };
}

/** Walk up the directory tree to find the repo root (contains package.json with "workspaces" or ".git"). */
function findRepoRoot(): string | null {
  // In tests and production we look from process.cwd() upward
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (
      existsSync(join(dir, '.git')) ||
      existsSync(join(dir, '.cairn-poc3-keys'))
    ) {
      return dir;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// ── Text cleaning (ported from poc-3-llm-runner.mjs) ────────────────────────

/**
 * Strip <think>...</think> reasoning blocks and markdown fences from LLM output.
 * Verified against MiniMax-M2.7 in PoC-3.
 */
export function cleanLlmText(raw: string): string {
  let candidate = raw.trim();
  // Strip <think>...</think> (may contain nested content)
  candidate = candidate.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  // Strip ```json ... ``` or ``` ... ```
  const fenceMatch = candidate.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenceMatch?.[1] !== undefined) {
    candidate = fenceMatch[1].trim();
  }
  return candidate;
}

// ── Mock stub ────────────────────────────────────────────────────────────────

/**
 * Stable mock stub JSON (matches the Dispatch output schema from PoC-3).
 * The prompt_to_agent includes the first 80 chars of the first user message.
 */
function buildMockStub(messages: ChatMessage[]): CompletionResult {
  const firstUser = messages.find((m) => m.role === 'user');
  const preview = firstUser ? firstUser.content.slice(0, 80) : '';
  const stubObj = {
    intent: 'stub.intent',
    agent_choice: 'Claude Code',
    prompt_to_agent: '[mock] ' + preview,
    history_keywords: [] as string[],
    risks: [] as string[],
    uncertainty: null,
  };
  const cleanedText = JSON.stringify(stubObj);
  return {
    rawText: cleanedText,
    cleanedText,
    parsedJson: stubObj,
    parseError: null,
    latencyMs: Math.floor(Math.random() * 151) + 50, // 50-200
    tokensUsed: null,
    retries: 0,
    mocked: true,
  };
}

// ── Real HTTP call ───────────────────────────────────────────────────────────

/**
 * Determine whether an HTTP status should trigger a retry.
 * 5xx and 429 are transient. 4xx (except 429) are permanent.
 */
function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

async function doFetch(
  messages: ChatMessage[],
  config: Required<LlmClientConfig>,
  signal: AbortSignal,
): Promise<{ rawText: string; tokensUsed: CompletionResult['tokensUsed'] }> {
  const body = {
    model: config.model,
    messages,
    temperature: config.temperature,
    max_tokens: config.maxTokens,
  };

  const response = await fetch(config.endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  });

  const responseText = await response.text();

  if (!response.ok) {
    throw new LlmHttpError(response.status, responseText);
  }

  let envelope: unknown;
  try {
    envelope = JSON.parse(responseText);
  } catch {
    throw new LlmHttpError(200, 'Envelope JSON parse failed: ' + responseText.slice(0, 200));
  }

  const env = envelope as Record<string, unknown>;
  const choices = env['choices'] as Array<Record<string, unknown>> | undefined;
  const message = choices?.[0]?.['message'] as Record<string, unknown> | undefined;
  const rawText = (message?.['content'] as string | undefined) ?? '';

  const usage = env['usage'] as Record<string, unknown> | undefined;
  const tokensUsed = usage
    ? {
        promptTokens: (usage['prompt_tokens'] as number | undefined) ?? 0,
        completionTokens: (usage['completion_tokens'] as number | undefined) ?? 0,
        totalTokens: (usage['total_tokens'] as number | undefined) ?? 0,
      }
    : null;

  return { rawText, tokensUsed };
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Call the LLM with retry logic.
 *
 * In mock mode: returns a stub response without any network I/O.
 * In real mode: calls the endpoint with exponential backoff (1s / 2s / 4s).
 */
export async function completionWithRetry(
  messages: ChatMessage[],
  config: LlmClientConfig,
): Promise<CompletionResult> {
  const resolved: Required<LlmClientConfig> = {
    endpoint: config.endpoint,
    apiKey: config.apiKey,
    model: config.model,
    temperature: config.temperature ?? DEFAULT_TEMPERATURE,
    maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
    mode: config.mode ?? DEFAULT_MODE,
  };

  // ── mock path ──
  if (resolved.mode === 'mock') {
    return buildMockStub(messages);
  }

  // ── real path ──
  const startMs = Date.now();
  let retries = 0;
  let lastError: unknown;

  for (let attempt = 0; attempt <= resolved.maxRetries; attempt++) {
    if (attempt > 0) {
      // Exponential backoff: 1s, 2s, 4s
      const backoffMs = Math.pow(2, attempt - 1) * 1000;
      await sleep(backoffMs);
      retries = attempt;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), resolved.timeoutMs);

    try {
      const { rawText, tokensUsed } = await doFetch(messages, resolved, controller.signal);
      clearTimeout(timer);

      const cleanedText = cleanLlmText(rawText);

      let parsedJson: unknown = null;
      let parseError: string | null = null;
      try {
        parsedJson = JSON.parse(cleanedText);
      } catch (e) {
        parseError = (e as Error).message;
      }

      return {
        rawText,
        cleanedText,
        parsedJson,
        parseError,
        latencyMs: Date.now() - startMs,
        tokensUsed,
        retries,
        mocked: false,
      };
    } catch (err) {
      clearTimeout(timer);

      if (err instanceof LlmHttpError) {
        if (!isRetryableStatus(err.httpStatus)) {
          // 4xx (except 429) — do not retry
          throw err;
        }
        lastError = err;
      } else if (
        err instanceof Error &&
        (err.name === 'AbortError' || err.message.includes('abort'))
      ) {
        lastError = new LlmTimeoutError(resolved.timeoutMs);
      } else {
        // Network error (fetch throws)
        lastError = err;
      }

      // Will retry on next iteration if attempt < maxRetries
    }
  }

  // All retries exhausted
  if (lastError instanceof LlmTimeoutError) {
    throw lastError;
  }
  if (lastError instanceof LlmHttpError) {
    throw lastError;
  }
  throw new Error(`LLM call failed after ${resolved.maxRetries} retries: ${String(lastError)}`);
}

/**
 * Like completionWithRetry, but asserts the result is a plain JSON object.
 * Throws LlmParseError if parsedJson is null, an array, or a primitive.
 */
export async function completionStrictJson(
  messages: ChatMessage[],
  config: LlmClientConfig,
): Promise<{ json: Record<string, unknown>; result: CompletionResult }> {
  const result = await completionWithRetry(messages, config);

  if (
    result.parsedJson === null ||
    typeof result.parsedJson !== 'object' ||
    Array.isArray(result.parsedJson)
  ) {
    throw new LlmParseError(
      `Expected JSON object but got: ${result.parsedJson === null ? 'null (parse error: ' + (result.parseError ?? 'unknown') + ')' : JSON.stringify(result.parsedJson).slice(0, 100)}`,
      result,
    );
  }

  return { json: result.parsedJson as Record<string, unknown>, result };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
