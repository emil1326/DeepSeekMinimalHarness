import { describe, expect, it } from 'vitest';
import {
  AbortedError,
  DeepSeekClient,
  DeepSeekError,
  METRICS_VERSION,
  MIN_DECODE_WINDOW_MS,
  costOf,
  decodeRate,
  emptyTotals,
  totalsOf,
} from '@emilswork/harness-core';
import { startFakeDeepSeek } from './fake-server.js';

const key = 'test-key-not-a-secret';

describe('the DeepSeek client', () => {
  it('streams text, tool calls and usage, and captures the metrics', async () => {
    const server = await startFakeDeepSeek([
      {
        text: 'hello there, this is a streamed answer',
        promptTokens: 2000,
        cacheHitTokens: 1500,
        completionTokens: 9,
        delayMs: 40,
        // Long enough between chunks that the window is a measurement rather
        // than scheduler granularity, which is what the decode guard checks.
        tokenDelayMs: 40,
      },
    ]);
    try {
      const client = new DeepSeekClient({ apiKey: key, baseUrl: server.url });
      const seen: string[] = [];
      const outcome = await client.stream({
        model: 'deepseek-flash',
        messages: [{ role: 'user', content: 'hi' }],
        onText: (delta) => seen.push(delta),
      });

      expect(outcome.message.content).toBe('hello there, this is a streamed answer');
      expect(seen.join('')).toBe('hello there, this is a streamed answer');
      expect(seen.length).toBeGreaterThan(1);
      expect(outcome.usage.prompt_cache_hit_tokens).toBe(1500);
      expect(outcome.usage.prompt_cache_miss_tokens).toBe(500);

      const metrics = outcome.metrics;
      expect(metrics.timeToFirstTokenMs).toBeGreaterThanOrEqual(30);
      expect(metrics.streamingMs).toBeGreaterThan(0);
      expect(metrics.generationTokensPerSecond).not.toBeNull();
      expect(metrics.endToEndTokensPerSecond).not.toBeNull();
      // Decode leaves the wait for the first token out, so it is always the
      // faster of the two.
      expect(metrics.generationTokensPerSecond ?? 0).toBeGreaterThan(metrics.endToEndTokensPerSecond ?? 0);
      // The stream is what makes this possible: first token is a real number.
      expect(metrics.promptTokens).toBe(2000);
      expect(metrics.completionTokens).toBe(9);
    } finally {
      await server.close();
    }
  });

  it('reads the thinking channel, which is billed as output', async () => {
    const server = await startFakeDeepSeek([
      {
        reasoning: 'the answer is obvious, but let me check what the task actually asked for',
        text: 'Done.',
        completionTokens: 40,
        reasoningTokens: 32,
        tokenDelayMs: 20,
      },
    ]);
    try {
      const client = new DeepSeekClient({ apiKey: key, baseUrl: server.url });
      const thoughts: string[] = [];
      const outcome = await client.stream({
        model: 'deepseek-flash',
        messages: [{ role: 'user', content: 'go' }],
        onReasoning: (delta) => thoughts.push(delta),
      });

      // The thinking is separate from the answer, and both are kept.
      expect(thoughts.join('')).toBe(
        'the answer is obvious, but let me check what the task actually asked for',
      );
      expect(outcome.reasoning).toBe(
        'the answer is obvious, but let me check what the task actually asked for',
      );
      expect(outcome.message.content).toBe('Done.');
      // And the number of them, because it is most of what was paid for.
      expect(outcome.usage.reasoning_tokens).toBe(32);
      expect(outcome.metrics.reasoningTokens).toBe(32);
    } finally {
      await server.close();
    }
  });

  it('does not report a decode speed from a window too short to measure one', async () => {
    // This is the control for the guard, and the reason it exists: a real tool
    // call arrived across 34 ms and the naive division turned it into 129,799
    // tokens a second.
    const server = await startFakeDeepSeek([{ text: 'a short burst of an answer', completionTokens: 400 }]);
    try {
      const client = new DeepSeekClient({ apiKey: key, baseUrl: server.url });
      const outcome = await client.stream({
        model: 'deepseek-flash',
        messages: [{ role: 'user', content: 'go' }],
      });
      expect(outcome.metrics.streamingMs ?? 0).toBeLessThan(MIN_DECODE_WINDOW_MS);
      expect(outcome.metrics.generationTokensPerSecond).toBeNull();
      // But the honest number is still there.
      expect(outcome.metrics.endToEndTokensPerSecond).not.toBeNull();
    } finally {
      await server.close();
    }
  });

  it('times the thinking too, so the window matches the tokens it is divided by', () => {
    // The bug this encodes: only `content` was timed, so a turn whose output was
    // almost entirely thinking reported the answer's few milliseconds as the
    // window and divided the whole output by it.
    expect(decodeRate(500, 400, 20)).toBe(1250);
    // The last gap is half the window, so the window is a wait, not a decode.
    expect(decodeRate(500, 400, 200)).toBeNull();
    // Just under the half rule is still a measurement.
    expect(decodeRate(500, 400, 199)).not.toBeNull();
    // Under the floor.
    expect(decodeRate(500, MIN_DECODE_WINDOW_MS - 1, 1)).toBeNull();
    expect(decodeRate(500, MIN_DECODE_WINDOW_MS, 1)).not.toBeNull();
    expect(decodeRate(500, null, 0)).toBeNull();
  });

  it('reassembles tool call arguments from their deltas', async () => {
    const server = await startFakeDeepSeek([
      { toolCalls: [{ name: 'read_file', args: { path: 'src/a.ts', start: 10 } }] },
    ]);
    try {
      const client = new DeepSeekClient({ apiKey: key, baseUrl: server.url });
      const outcome = await client.stream({
        model: 'deepseek-flash',
        messages: [{ role: 'user', content: 'go' }],
      });
      const call = outcome.message.tool_calls?.[0];
      expect(call?.function.name).toBe('read_file');
      expect(JSON.parse(call?.function.arguments ?? '{}')).toEqual({ path: 'src/a.ts', start: 10 });
      expect(call?.id).toBeTruthy();
    } finally {
      await server.close();
    }
  });

  it('retries a 429 with backoff and then succeeds', async () => {
    const server = await startFakeDeepSeek([{ status: 429 }, { status: 429 }, { text: 'third time lucky' }]);
    try {
      const retries: number[] = [];
      const client = new DeepSeekClient({ apiKey: key, baseUrl: server.url });
      const outcome = await client.stream({
        model: 'deepseek-flash',
        messages: [{ role: 'user', content: 'go' }],
        // Per call, next to onText, because the caller is the one that knows
        // which turn is being retried.
        onRetry: (info) => retries.push(info.status),
      });
      expect(outcome.message.content).toBe('third time lucky');
      expect(retries).toEqual([429, 429]);
    } finally {
      await server.close();
    }
  });

  it('says how long it will wait, before it waits', async () => {
    // The point of the hook is to explain a stall while it is happening, so the
    // wait has to be reported before the sleep rather than after it.
    const server = await startFakeDeepSeek([{ status: 429 }, { text: 'ok' }]);
    try {
      const waits: number[] = [];
      const seen: string[] = [];
      const client = new DeepSeekClient({ apiKey: key, baseUrl: server.url });
      const outcome = await client.stream({
        model: 'deepseek-flash',
        messages: [{ role: 'user', content: 'go' }],
        onRetry: (info) => {
          waits.push(info.waitMs);
          seen.push(`waiting ${info.waitMs}ms`);
        },
        onText: () => seen.push('text arrived'),
      });
      expect(outcome.message.content).toBe('ok');
      // One retry, with a real wait, and the wait came first.
      expect(waits).toHaveLength(1);
      expect(waits[0] ?? 0).toBeGreaterThanOrEqual(400);
      expect(seen[0]).toBe(`waiting ${waits[0] ?? 0}ms`);
      expect(seen).toContain('text arrived');
    } finally {
      await server.close();
    }
  });

  it('gives up after the retry budget and reports the status', async () => {
    const server = await startFakeDeepSeek([{ status: 503 }]);
    try {
      const client = new DeepSeekClient({ apiKey: key, baseUrl: server.url, maxRetries: 1 });
      await expect(
        client.stream({ model: 'deepseek-flash', messages: [{ role: 'user', content: 'go' }] }),
      ).rejects.toThrowError(DeepSeekError);
    } finally {
      await server.close();
    }
  });

  it('stops mid-stream when the signal is aborted', async () => {
    const server = await startFakeDeepSeek([
      { text: 'this will never finish', delayMs: 4000, tokenDelayMs: 100 },
    ]);
    try {
      const client = new DeepSeekClient({ apiKey: key, baseUrl: server.url });
      const controller = new AbortController();
      const started = Date.now();
      const pending = client.stream({
        model: 'deepseek-flash',
        messages: [{ role: 'user', content: 'go' }],
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 150);
      await expect(pending).rejects.toThrowError(AbortedError);
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      await server.close();
    }
  });

  it('derives cost from the price table rather than hardcoding one', () => {
    const metrics = {
      metricsVersion: METRICS_VERSION,
      model: 'deepseek-flash',
      startedAt: new Date().toISOString(),
      durationMs: 1000,
      timeToFirstTokenMs: 100,
      streamingMs: 900,
      largestGapMs: 10,
      promptTokens: 1_000_000,
      cacheHitTokens: 750_000,
      cacheMissTokens: 250_000,
      completionTokens: 100_000,
      reasoningTokens: 0,
      generationTokensPerSecond: 111,
      endToEndTokensPerSecond: 100,
    };
    const price = { inputPerMillion: 0.27, cacheHitPerMillion: 0.07, outputPerMillion: 1.1 };
    // 250k at 0.27, 750k at 0.07, 100k at 1.1, all per million.
    expect(costOf(price, metrics)).toBeCloseTo(0.0675 + 0.0525 + 0.11, 6);
    expect(costOf(undefined, metrics)).toBeNull();

    const totals = totalsOf(emptyTotals(), metrics, price);
    expect(totals.calls).toBe(1);
    expect(totals.promptTokens).toBe(1_000_000);
    expect(totals.costUsd).toBeCloseTo(0.23, 6);
  });
});

// One real call, only when asked for by hand:
//   DSH_SMOKE=1 npx vitest run packages/core/tests/deepseek.test.ts
const smoke = process.env.DSH_SMOKE === '1';
describe.skipIf(!smoke)('a real smoke call', () => {
  it('answers through the live API', async () => {
    const { readApiKey, DEFAULT_BASE_URL } = await import('@emilswork/harness-core');
    const client = new DeepSeekClient({
      apiKey: readApiKey(),
      baseUrl: process.env.DSH_BASE_URL ?? DEFAULT_BASE_URL,
    });
    const outcome = await client.stream({
      model: process.env.DSH_SMOKE_MODEL ?? 'deepseek-chat',
      messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
    });
    expect((outcome.message.content ?? '').toLowerCase()).toContain('ready');
    expect(outcome.metrics.timeToFirstTokenMs).toBeGreaterThan(0);
  }, 120_000);
});
