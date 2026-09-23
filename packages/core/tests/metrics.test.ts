/**
 * The speed numbers, derived from what the stream actually measured.
 *
 * These are the numbers the whole streaming design exists to produce, so the
 * arithmetic gets held down. The interesting case is the guard: a window so
 * short there was no time to decode anything is not a speed.
 */

import { describe, expect, it } from 'vitest';
import {
  LEGACY_METRICS_VERSION,
  METRICS_VERSION,
  MIN_MEASURED_WINDOW_MS,
  cacheHitRate,
  costOf,
  metricsVersionOf,
  rate,
  totalsOf,
} from '@emilswork/harness-core';
import type { CallMetrics } from '@emilswork/harness-core';
import { emptyTotals } from '@emilswork/harness-core';

function metrics(overrides: Partial<CallMetrics> = {}): CallMetrics {
  return {
    metricsVersion: METRICS_VERSION,
    model: 'deepseek-flash',
    startedAt: '2026-01-01T00:00:00.000Z',
    durationMs: 2000,
    timeToFirstTokenMs: 400,
    streamingMs: 1000,
    largestGapMs: 20,
    promptTokens: 1000,
    cacheHitTokens: 400,
    cacheMissTokens: 600,
    completionTokens: 500,
    reasoningTokens: 0,
    generationTokensPerSecond: 500,
    endToEndTokensPerSecond: 250,
    ...overrides,
  };
}

describe('deriving a speed', () => {
  it('measures tokens over the window, in seconds', () => {
    // 500 tokens in one second.
    expect(rate(500, 1000)).toBe(500);
    // 100 tokens in half a second.
    expect(rate(100, 500)).toBe(200);
  });

  it('refuses to divide by a window that never opened', () => {
    expect(rate(50, 0)).toBeNull();
    expect(rate(50, null)).toBeNull();
    expect(rate(50, -3)).toBeNull();
  });

  it('refuses a window shorter than the noise floor, which is not a fast model', () => {
    // This is the real bug it guards: a tool-call-only turn arriving in one
    // tick reported 500,000 tokens a second.
    expect(rate(50, 0.1)).toBeNull();
    expect(rate(50, MIN_MEASURED_WINDOW_MS - 0.01)).toBeNull();
    expect(rate(50, MIN_MEASURED_WINDOW_MS)).toBe(50_000);
  });
});

describe('running totals', () => {
  it('adds up tokens and averages the first-token time', () => {
    const one = totalsOf(emptyTotals(), metrics({ timeToFirstTokenMs: 200 }), undefined);
    const two = totalsOf(one, metrics({ timeToFirstTokenMs: 400 }), undefined);
    expect(two.calls).toBe(2);
    expect(two.promptTokens).toBe(2000);
    expect(two.cacheHitTokens).toBe(800);
    expect(two.completionTokens).toBe(1000);
    // The mean of 200 and 400.
    expect(two.timeToFirstTokenMs).toBe(300);
  });

  it('keeps the last speed rather than averaging speeds across calls', () => {
    const one = totalsOf(emptyTotals(), metrics({ generationTokensPerSecond: 100 }), undefined);
    const two = totalsOf(one, metrics({ generationTokensPerSecond: 300 }), undefined);
    expect(two.generationTokensPerSecond).toBe(300);
  });

  it('leaves cost alone when there is no price for the model', () => {
    const totals = totalsOf(emptyTotals(), metrics(), undefined);
    expect(totals.costUsd).toBeNull();
    const priced = totalsOf(emptyTotals(), metrics(), {
      inputPerMillion: 1,
      cacheHitPerMillion: 0.1,
      outputPerMillion: 2,
    });
    // 600 miss at 1, 400 hit at 0.1, 500 out at 2, per million.
    expect(priced.costUsd).toBeCloseTo(0.0006 + 0.00004 + 0.001, 9);
  });

  it('bills the miss tokens at the full price, not the whole prompt', () => {
    const price = { inputPerMillion: 10, cacheHitPerMillion: 1, outputPerMillion: 0 };
    const cached = costOf(price, metrics({ promptTokens: 1000, cacheHitTokens: 1000, completionTokens: 0 }));
    const uncached = costOf(price, metrics({ promptTokens: 1000, cacheHitTokens: 0, completionTokens: 0 }));
    expect(cached).toBeCloseTo(0.001, 9);
    expect(uncached).toBeCloseTo(0.01, 9);
    // The cache saved 90% of this call.
    expect((uncached ?? 0) / (cached ?? 1)).toBeCloseTo(10, 6);
  });

  it('stamps every call with the method that measured it', () => {
    // The speed figures were wrong once and the rows are still in the database,
    // so a call has to say which method produced it or a later reader cannot
    // tell a wrong number from a right one.
    expect(metrics().metricsVersion).toBe(METRICS_VERSION);
  });
});

describe('the metrics version of a stored call', () => {
  it('is the version it was stamped with', () => {
    expect(metricsVersionOf({ metricsVersion: METRICS_VERSION })).toBe(METRICS_VERSION);
    expect(metricsVersionOf({ metricsVersion: 7 })).toBe(7);
  });

  it('is the old method when there is no stamp, including for a null', () => {
    // Not "unknown". Every row written before the field existed was v1's method,
    // so reading an absent value as v1 keeps a wrong number out of a current
    // row instead of treating it as a third, meaningless kind.
    expect(metricsVersionOf({})).toBe(LEGACY_METRICS_VERSION);
    expect(metricsVersionOf({ metricsVersion: null })).toBe(LEGACY_METRICS_VERSION);
    expect(metricsVersionOf({ metricsVersion: undefined })).toBe(LEGACY_METRICS_VERSION);
  });

  it('does not trust a value that is not a finite number', () => {
    // A stored NaN would otherwise compare unequal to every version and land in
    // a row of its own, which is how one bad row becomes a table nobody trusts.
    expect(metricsVersionOf({ metricsVersion: Number.NaN })).toBe(LEGACY_METRICS_VERSION);
    expect(metricsVersionOf({ metricsVersion: Number.POSITIVE_INFINITY })).toBe(LEGACY_METRICS_VERSION);
  });
});

describe('cache hit rate', () => {
  it('is the share of the prompt that came from the cache', () => {
    expect(cacheHitRate({ promptTokens: 1000, cacheHitTokens: 400 })).toBe(0.4);
    expect(cacheHitRate({ promptTokens: 1000, cacheHitTokens: 0 })).toBe(0);
    expect(cacheHitRate({ promptTokens: 1000, cacheHitTokens: 1000 })).toBe(1);
  });

  it('is not a rate when nothing was sent', () => {
    expect(cacheHitRate({ promptTokens: 0, cacheHitTokens: 0 })).toBeNull();
  });
});
