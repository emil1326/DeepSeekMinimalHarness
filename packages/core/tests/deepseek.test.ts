import { describe, expect, it } from 'vitest';
import {
  AbortedError,
  DeepSeekClient,
  DeepSeekError,
  costOf,
  totalsOf,
  emptyTotals,
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
        tokenDelayMs: 12,
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
      // Generation leaves the prompt processing and the network out, so it is
      // always the faster of the two.
      expect(metrics.generationTokensPerSecond ?? 0).toBeGreaterThan(metrics.endToEndTokensPerSecond ?? 0);
      // The stream is what makes this possible: first token is a real number.
      expect(metrics.promptTokens).toBe(2000);
      expect(metrics.completionTokens).toBe(9);
    } finally {
      await server.close();
    }
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
      const client = new DeepSeekClient({
        apiKey: key,
        baseUrl: server.url,
        onRetry: (info) => retries.push(info.status),
      });
      const outcome = await client.stream({
        model: 'deepseek-flash',
        messages: [{ role: 'user', content: 'go' }],
      });
      expect(outcome.message.content).toBe('third time lucky');
      expect(retries).toEqual([429, 429]);
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
      model: 'deepseek-flash',
      startedAt: new Date().toISOString(),
      durationMs: 1000,
      timeToFirstTokenMs: 100,
      streamingMs: 900,
      promptTokens: 1_000_000,
      cacheHitTokens: 750_000,
      cacheMissTokens: 250_000,
      completionTokens: 100_000,
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
