/**
 * LLM client unit tests
 * All real-mode tests mock global.fetch — no actual API calls are made.
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from 'vitest';
import { loadConfig, completionWithRetry, completionStrictJson, cleanLlmText } from '../../src/dispatch/llm-client.js';
import {
  ConfigNotFoundError,
  LlmHttpError,
  LlmTimeoutError,
  LlmParseError,
  type ChatMessage,
  type LlmClientConfig,
} from '../../src/dispatch/types.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

const REAL_CONFIG: LlmClientConfig = {
  endpoint: 'https://example.com/v1/chat/completions',
  apiKey: 'test-key',
  model: 'test-model',
  temperature: 0.3,
  maxTokens: 2048,
  timeoutMs: 5000,
  maxRetries: 3,
  mode: 'real',
};

const MOCK_CONFIG: LlmClientConfig = {
  ...REAL_CONFIG,
  mode: 'mock',
};

const MESSAGES: ChatMessage[] = [
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'user', content: 'Hello, world! This is a test message.' },
];

/** Build a fake fetch Response that returns the given OpenAI-compat body */
function fakeOkResponse(content: string, usage?: object): Response {
  const body = {
    choices: [{ message: { content } }],
    usage: usage ?? { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  };
  return {
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

/** Build a fake fetch Response that returns an HTTP error */
function fakeErrorResponse(status: number, body = 'error'): Response {
  return {
    ok: false,
    status,
    text: () => Promise.resolve(body),
  } as unknown as Response;
}

// ── loadConfig unit tests ────────────────────────────────────────────────────

describe('loadConfig — env vars', () => {
  beforeEach(() => {
    // Clean env
    delete process.env['CAIRN_LLM_BASE_URL'];
    delete process.env['CAIRN_LLM_API_KEY'];
    delete process.env['CAIRN_LLM_MODEL'];
    delete process.env['CAIRN_LLM_MODE'];
  });

  afterEach(() => {
    delete process.env['CAIRN_LLM_BASE_URL'];
    delete process.env['CAIRN_LLM_API_KEY'];
    delete process.env['CAIRN_LLM_MODEL'];
    delete process.env['CAIRN_LLM_MODE'];
  });

  it('returns config from env vars when all three are set', () => {
    process.env['CAIRN_LLM_BASE_URL'] = 'https://api.example.com/v1/chat/completions';
    process.env['CAIRN_LLM_API_KEY'] = 'sk-test';
    process.env['CAIRN_LLM_MODEL'] = 'gpt-4o';
    process.env['CAIRN_LLM_MODE'] = 'real';

    const config = loadConfig();
    expect(config.endpoint).toBe('https://api.example.com/v1/chat/completions');
    expect(config.apiKey).toBe('sk-test');
    expect(config.model).toBe('gpt-4o');
    expect(config.mode).toBe('real');
  });

  it('applies default values for temperature / maxTokens / timeoutMs / maxRetries', () => {
    process.env['CAIRN_LLM_BASE_URL'] = 'https://api.example.com/v1/chat/completions';
    process.env['CAIRN_LLM_API_KEY'] = 'sk-test';
    process.env['CAIRN_LLM_MODEL'] = 'gpt-4o';
    process.env['CAIRN_LLM_MODE'] = 'real';

    const config = loadConfig();
    expect(config.temperature).toBe(0.3);
    expect(config.maxTokens).toBe(2048);
    expect(config.timeoutMs).toBe(30_000);
    expect(config.maxRetries).toBe(3);
  });

  it('ConfigNotFoundError is exported and constructible', () => {
    // Verify the class is importable and constructible (structural test).
    const err = new ConfigNotFoundError('test message');
    expect(err).toBeInstanceOf(ConfigNotFoundError);
    expect(err.name).toBe('ConfigNotFoundError');
    expect(err.message).toBe('test message');
  });

  it('returns a valid config when no config and mode=mock (default)', () => {
    // Default mode is mock, no env vars set.
    // On a dev machine the fallback keys.env may be present — that is OK.
    // We only assert that: mode is mock, and config is a usable object.
    const config = loadConfig();
    expect(config.mode).toBe('mock');
    // Either stub (apiKey='mock') or loaded from dev fallback key — both valid
    expect(typeof config.apiKey).toBe('string');
    expect(typeof config.endpoint).toBe('string');
  });
});

// ── completionWithRetry — mock mode ─────────────────────────────────────────

describe('completionWithRetry — mock mode', () => {
  it('does not call fetch and returns a stub result', async () => {
    const fetchSpy = vi.fn();
    const origFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy;

    try {
      const result = await completionWithRetry(MESSAGES, MOCK_CONFIG);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(result.mocked).toBe(true);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('mock cleanedText is valid JSON', async () => {
    const result = await completionWithRetry(MESSAGES, MOCK_CONFIG);
    expect(() => JSON.parse(result.cleanedText)).not.toThrow();
  });

  it('mock parsedJson is an object with expected stub keys', async () => {
    const result = await completionWithRetry(MESSAGES, MOCK_CONFIG);
    expect(result.parsedJson).not.toBeNull();
    const j = result.parsedJson as Record<string, unknown>;
    expect(j['intent']).toBe('stub.intent');
    expect(j['agent_choice']).toBe('Claude Code');
    expect(typeof j['prompt_to_agent']).toBe('string');
    expect(Array.isArray(j['history_keywords'])).toBe(true);
  });

  it('mock latencyMs is between 50 and 200ms', async () => {
    // Run a few times to verify the range is plausible
    for (let i = 0; i < 5; i++) {
      const result = await completionWithRetry(MESSAGES, MOCK_CONFIG);
      expect(result.latencyMs).toBeGreaterThanOrEqual(50);
      expect(result.latencyMs).toBeLessThanOrEqual(200);
    }
  });

  it('mock prompt_to_agent includes first 80 chars of user message', async () => {
    const result = await completionWithRetry(MESSAGES, MOCK_CONFIG);
    const j = result.parsedJson as Record<string, unknown>;
    const prompt = j['prompt_to_agent'] as string;
    expect(prompt).toContain('[mock]');
    expect(prompt).toContain('Hello, world!');
  });
});

// ── completionWithRetry — real mode (mock fetch) ─────────────────────────────

describe('completionWithRetry — real mode', () => {
  let origFetch: typeof globalThis.fetch;

  beforeEach(() => {
    origFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it('HTTP 200 with valid JSON content returns parsedJson as object', async () => {
    const content = JSON.stringify({ intent: 'dispatch.fix', agent_choice: 'Claude Code' });
    globalThis.fetch = vi.fn().mockResolvedValue(fakeOkResponse(content));

    const result = await completionWithRetry(MESSAGES, REAL_CONFIG);
    expect(result.mocked).toBe(false);
    expect(result.parsedJson).toEqual({ intent: 'dispatch.fix', agent_choice: 'Claude Code' });
    expect(result.parseError).toBeNull();
  });

  it('HTTP 200 with <think> block — cleanedText strips the think block', async () => {
    const thinkContent = '<think>Let me think about this carefully...</think>\n{"intent":"dispatch.review"}';
    globalThis.fetch = vi.fn().mockResolvedValue(fakeOkResponse(thinkContent));

    const result = await completionWithRetry(MESSAGES, REAL_CONFIG);
    expect(result.rawText).toContain('<think>');
    expect(result.cleanedText).not.toContain('<think>');
    expect(result.cleanedText).toBe('{"intent":"dispatch.review"}');
    expect((result.parsedJson as Record<string, unknown>)['intent']).toBe('dispatch.review');
  });

  it('HTTP 200 with markdown json fence — cleanedText strips the fence', async () => {
    const fencedContent = '```json\n{"intent":"dispatch.fix"}\n```';
    globalThis.fetch = vi.fn().mockResolvedValue(fakeOkResponse(fencedContent));

    const result = await completionWithRetry(MESSAGES, REAL_CONFIG);
    expect(result.cleanedText).toBe('{"intent":"dispatch.fix"}');
    expect((result.parsedJson as Record<string, unknown>)['intent']).toBe('dispatch.fix');
  });

  it('HTTP 200 with non-JSON content — parsedJson=null and parseError is set', async () => {
    const content = 'This is plain text, not JSON.';
    globalThis.fetch = vi.fn().mockResolvedValue(fakeOkResponse(content));

    const result = await completionWithRetry(MESSAGES, REAL_CONFIG);
    expect(result.parsedJson).toBeNull();
    expect(result.parseError).not.toBeNull();
    expect(typeof result.parseError).toBe('string');
  });

  it('HTTP 500 — retries maxRetries times then throws LlmHttpError', async () => {
    const configWith1Retry: LlmClientConfig = { ...REAL_CONFIG, maxRetries: 1, timeoutMs: 5000 };
    globalThis.fetch = vi.fn().mockResolvedValue(fakeErrorResponse(500, 'Internal Server Error'));

    await expect(
      completionWithRetry(MESSAGES, configWith1Retry),
    ).rejects.toBeInstanceOf(LlmHttpError);

    // Should have been called (1 initial + 1 retry = 2 times)
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });

  it('HTTP 500 — retries field reflects actual retry count', async () => {
    // We test via caught error; but easiest is to succeed after 2 tries
    const calls: number[] = [];
    globalThis.fetch = vi.fn().mockImplementation(() => {
      calls.push(1);
      if (calls.length < 3) {
        return Promise.resolve(fakeErrorResponse(500));
      }
      return Promise.resolve(fakeOkResponse('{"ok":true}'));
    });

    const result = await completionWithRetry(MESSAGES, { ...REAL_CONFIG, maxRetries: 3, timeoutMs: 5000 });
    expect(result.retries).toBe(2);
    expect((result.parsedJson as Record<string, unknown>)['ok']).toBe(true);
  });

  it('HTTP 401 — does not retry, throws LlmHttpError immediately', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(fakeErrorResponse(401, 'Unauthorized'));

    await expect(
      completionWithRetry(MESSAGES, REAL_CONFIG),
    ).rejects.toBeInstanceOf(LlmHttpError);

    // Only called once (no retries for 4xx)
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('HTTP 429 — retries (429 is treated as transient)', async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.resolve(fakeErrorResponse(429, 'Too Many Requests'));
      return Promise.resolve(fakeOkResponse('{"ok":true}'));
    });

    const result = await completionWithRetry(MESSAGES, { ...REAL_CONFIG, maxRetries: 2, timeoutMs: 5000 });
    expect(result.retries).toBe(1);
    expect((result.parsedJson as Record<string, unknown>)['ok']).toBe(true);
  });

  it('timeout — throws LlmTimeoutError', async () => {
    // Simulate AbortError from fetch when signal is aborted
    globalThis.fetch = vi.fn().mockImplementation(() => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      return Promise.reject(err);
    });

    await expect(
      completionWithRetry(MESSAGES, { ...REAL_CONFIG, timeoutMs: 100, maxRetries: 0 }),
    ).rejects.toBeInstanceOf(LlmTimeoutError);
  });

  it('network error (fetch throws) — retries then throws', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(
      completionWithRetry(MESSAGES, { ...REAL_CONFIG, maxRetries: 1, timeoutMs: 5000 }),
    ).rejects.toThrow();

    // Initial call + 1 retry = 2 calls
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });

  it('tokensUsed is populated on success', async () => {
    const content = '{"result":"ok"}';
    globalThis.fetch = vi.fn().mockResolvedValue(
      fakeOkResponse(content, { prompt_tokens: 50, completion_tokens: 100, total_tokens: 150 }),
    );

    const result = await completionWithRetry(MESSAGES, REAL_CONFIG);
    expect(result.tokensUsed).toEqual({
      promptTokens: 50,
      completionTokens: 100,
      totalTokens: 150,
    });
  });
});

// ── completionStrictJson ─────────────────────────────────────────────────────

describe('completionStrictJson', () => {
  let origFetch: typeof globalThis.fetch;

  beforeEach(() => {
    origFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it('returns json and result when parsedJson is a plain object', async () => {
    const content = JSON.stringify({ intent: 'dispatch.fix' });
    globalThis.fetch = vi.fn().mockResolvedValue(fakeOkResponse(content));

    const { json, result } = await completionStrictJson(MESSAGES, REAL_CONFIG);
    expect(json['intent']).toBe('dispatch.fix');
    expect(result.mocked).toBe(false);
  });

  it('throws LlmParseError when parsedJson is null (non-JSON response)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(fakeOkResponse('not json at all'));

    await expect(
      completionStrictJson(MESSAGES, REAL_CONFIG),
    ).rejects.toBeInstanceOf(LlmParseError);
  });

  it('throws LlmParseError when parsedJson is an array', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(fakeOkResponse('[1,2,3]'));

    await expect(
      completionStrictJson(MESSAGES, REAL_CONFIG),
    ).rejects.toBeInstanceOf(LlmParseError);
  });

  it('throws LlmParseError when parsedJson is a primitive (string)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(fakeOkResponse('"just a string"'));

    await expect(
      completionStrictJson(MESSAGES, REAL_CONFIG),
    ).rejects.toBeInstanceOf(LlmParseError);
  });
});

// ── cleanLlmText unit tests ──────────────────────────────────────────────────

describe('cleanLlmText', () => {
  it('strips <think>...</think> block', () => {
    const raw = '<think>Some reasoning here.</think>\n{"key":"value"}';
    expect(cleanLlmText(raw)).toBe('{"key":"value"}');
  });

  it('strips markdown json fence', () => {
    const raw = '```json\n{"key":"value"}\n```';
    expect(cleanLlmText(raw)).toBe('{"key":"value"}');
  });

  it('strips plain markdown fence (no language tag)', () => {
    const raw = '```\n{"key":"value"}\n```';
    expect(cleanLlmText(raw)).toBe('{"key":"value"}');
  });

  it('strips both think block and fence', () => {
    const raw = '<think>reasoning</think>\n```json\n{"key":"value"}\n```';
    expect(cleanLlmText(raw)).toBe('{"key":"value"}');
  });

  it('returns raw text unchanged when no wrappers present', () => {
    const raw = '{"key":"value"}';
    expect(cleanLlmText(raw)).toBe('{"key":"value"}');
  });
});
