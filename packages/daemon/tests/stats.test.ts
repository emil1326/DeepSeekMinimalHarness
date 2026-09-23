/**
 * Aggregating model calls across runs.
 *
 * The one thing this must not do is average two measurement methods together.
 * The speed figures were wrong once — a call whose output was mostly thinking
 * was reported at 930 tokens a second — and those rows are still in `runs.db`,
 * because nothing rewrites recorded history. A table that mixed them would
 * produce a figure describing neither method and would get worse as more rows
 * accumulated, which is the worst kind of wrong: quietly, on its own.
 */

import { describe, expect, it } from 'vitest';
import { METRICS_VERSION } from '@emilswork/harness-core';
import { summarise } from '@emilswork/harness-daemon';

/** A stored call as `allMetrics` hands it over: the JSON object, verbatim. */
type Call = Record<string, number | string | null>;

interface Metric {
  model: string;
  call: Call;
  runId: string;
}

/** A call as `allMetrics` hands it over: the stored object, verbatim. */
function call(overrides: Call = {}): Metric {
  return {
    model: String(overrides.model ?? 'deepseek-flash'),
    runId: 'run-test',
    call: {
      model: 'deepseek-flash',
      promptTokens: 1000,
      cacheHitTokens: 400,
      completionTokens: 100,
      reasoningTokens: 0,
      timeToFirstTokenMs: 400,
      generationTokensPerSecond: 200,
      endToEndTokensPerSecond: 100,
      ...overrides,
    },
  };
}

function withVersion(version: number, overrides: Call = {}): Metric {
  return call({ metricsVersion: version, ...overrides });
}

describe('summarising model calls', () => {
  it('adds up a model measured one way into a single row', () => {
    const stats = summarise([withVersion(METRICS_VERSION), withVersion(METRICS_VERSION)], undefined);
    expect(stats).toHaveLength(1);
    expect(stats[0]?.model).toBe('deepseek-flash');
    expect(stats[0]?.metricsVersion).toBe(METRICS_VERSION);
    expect(stats[0]?.calls).toBe(2);
    expect(stats[0]?.promptTokens).toBe(2000);
    expect(stats[0]?.timeToFirstTokenMs).toBe(400);
    expect(stats[0]?.generationTokensPerSecond).toBe(200);
  });

  it('splits a model into one row per measurement method', () => {
    const stats = summarise(
      [
        // The old method, and it says 930 where the new one says 200. Averaging
        // these would give 565, which is a number about nothing.
        withVersion(1, { generationTokensPerSecond: 930, timeToFirstTokenMs: 100 }),
        withVersion(METRICS_VERSION, { generationTokensPerSecond: 200, timeToFirstTokenMs: 400 }),
      ],
      undefined,
    );

    expect(stats).toHaveLength(2);
    // Newest first, so the number that is true today is the one read first.
    expect(stats[0]?.metricsVersion).toBe(METRICS_VERSION);
    expect(stats[0]?.generationTokensPerSecond).toBe(200);
    expect(stats[1]?.metricsVersion).toBe(1);
    expect(stats[1]?.generationTokensPerSecond).toBe(930);
    // Neither row is a mixture.
    expect(stats.map((row) => row.calls)).toEqual([1, 1]);
  });

  it('reads a call stored before the field existed as the old method', () => {
    // Not "unknown": every call recorded before `metricsVersion` was v1's
    // method, so this is a fact about the row rather than a guess.
    const stats = summarise([call({ generationTokensPerSecond: 930 })], undefined);
    expect(stats).toHaveLength(1);
    expect(stats[0]?.metricsVersion).toBe(1);

    // And a current call is not mistaken for an old one.
    const both = summarise([call(), withVersion(METRICS_VERSION)], undefined);
    expect(both.map((row) => row.metricsVersion)).toEqual([METRICS_VERSION, 1]);
  });

  it('keeps tokens and cost together across methods, because those are comparable', () => {
    // Prompt tokens, completion tokens and money were measured the same way in
    // both methods, so splitting them would throw away real information for no
    // reason. Only the speeds are incomparable.
    const stats = summarise(
      [
        withVersion(1, { promptTokens: 100, completionTokens: 10 }),
        withVersion(METRICS_VERSION, { promptTokens: 200, completionTokens: 20 }),
      ],
      undefined,
    );
    // Same model, two methods, so two rows: the split is by method, and each
    // row's tokens are that row's tokens.
    expect(stats.map((row) => row.promptTokens).sort()).toEqual([100, 200]);
    expect(stats.map((row) => row.completionTokens).sort()).toEqual([10, 20]);
  });

  it('averages only the calls that managed to measure a speed', () => {
    // A call that could not measure one reports null, and a null must not drag
    // the mean towards zero. There is a real case for this: a turn that only
    // calls a tool arrives in one tick and has no decode window.
    const stats = summarise(
      [
        withVersion(METRICS_VERSION, { generationTokensPerSecond: 200 }),
        withVersion(METRICS_VERSION, { generationTokensPerSecond: null, timeToFirstTokenMs: null }),
      ],
      undefined,
    );
    expect(stats[0]?.calls).toBe(2);
    expect(stats[0]?.generationTokensPerSecond).toBe(200);
    expect(stats[0]?.timeToFirstTokenMs).toBe(400);
  });

  it('counts cost per method, from the price table', () => {
    const price = { inputPerMillion: 1, outputPerMillion: 1 };
    const stats = summarise(
      [withVersion(1, { promptTokens: 1_000_000, cacheHitTokens: 0, completionTokens: 0 })],
      { 'deepseek-flash': price },
    );
    expect(stats[0]?.costUsd).toBeCloseTo(1, 6);
  });

  it('reports nothing rather than zero for a model with no calls', () => {
    expect(summarise([], undefined)).toEqual([]);
  });
});
