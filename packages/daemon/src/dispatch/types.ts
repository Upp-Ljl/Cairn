/**
 * Dispatch module — LLM client types
 * Provider-agnostic OpenAI-compatible interface (ADR-4)
 */

export interface LlmClientConfig {
  /** Full endpoint URL, e.g. https://api.minimaxi.com/v1/chat/completions */
  endpoint: string;
  apiKey: string;
  model: string;
  temperature?: number;   // default 0.3
  maxTokens?: number;     // default 2048
  timeoutMs?: number;     // default 30000
  maxRetries?: number;    // default 3
  /**
   * 'mock': never hits real API, returns stub responses (DEFAULT — avoids accidental API spend)
   * 'real': calls the actual endpoint
   */
  mode?: 'real' | 'mock';
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompletionResult {
  /** Raw message.content from the API (includes <think>...</think> if present) */
  rawText: string;
  /** Stripped of think blocks and markdown fences */
  cleanedText: string;
  /** JSON.parse(cleanedText) — null if parse failed */
  parsedJson: unknown | null;
  /** Error message from JSON.parse, or null */
  parseError: string | null;
  latencyMs: number;
  tokensUsed: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  } | null;
  /** Actual retry count (0 = first attempt succeeded) */
  retries: number;
  /** true when mock mode was used */
  mocked: boolean;
}

// ── Custom error classes ─────────────────────────────────────────────────────

export class ConfigNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigNotFoundError';
  }
}

export class LlmHttpError extends Error {
  readonly httpStatus: number;
  readonly bodySnippet: string;

  constructor(httpStatus: number, bodySnippet: string) {
    super(`LLM HTTP error ${httpStatus}: ${bodySnippet.slice(0, 200)}`);
    this.name = 'LlmHttpError';
    this.httpStatus = httpStatus;
    this.bodySnippet = bodySnippet;
  }
}

export class LlmTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`LLM request timed out after ${timeoutMs}ms`);
    this.name = 'LlmTimeoutError';
  }
}

export class LlmParseError extends Error {
  readonly result: CompletionResult;

  constructor(message: string, result: CompletionResult) {
    super(message);
    this.name = 'LlmParseError';
    this.result = result;
  }
}
