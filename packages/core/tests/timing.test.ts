/**
 * The stopwatch's own tests, and the properties the reports depend on.
 *
 * Percentiles come out of a histogram, so the thing worth testing is not
 * "is p95 exactly 12.3" but the three invariants every reader relies on: a
 * merge is the same as having measured everything at once, a quantile never
 * reads lower than the samples it came from, and a broken duration cannot
 * poison a name's figures.
 */

import { describe, expect, it } from 'vitest';
import {
  Recorder,
  TIMING_BUCKETS,
  TIMING_EDGES_MS,
  TIMING_VERSION,
  bucketOf,
  byTotal,
  meanMs,
  mergeStats,
  percentile,
  type TimingStat,
} from '@emilswork/harness-core';

/** A stat built the way a span builds one, without going through a clock. */
function statOf(name: string, values: number[], bytes = 0): TimingStat {
  const recorder = new Recorder();
  for (const value of values) recorder.add(name, value, bytes);
  return recorder.snapshot().entries[0] as TimingStat;
}

describe('the bucket ladder', () => {
  it('puts an edge exactly at its own bucket, and above it in the next', () => {
    expect(bucketOf(TIMING_EDGES_MS[0] as number)).toBe(0);
    expect(bucketOf((TIMING_EDGES_MS[0] as number) + 1e-6)).toBe(1);
    expect(TIMING_EDGES_MS.every((edge, index) => bucketOf(edge) === index)).toBe(true);
  });

  it('never goes out of range, however absurd the duration', () => {
    for (const ms of [0, -1, 1e-9, 1, 1800000, 1e12]) {
      const bucket = bucketOf(ms);
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThan(TIMING_BUCKETS);
    }
  });
});

describe('a recorder', () => {
  it('counts, sums and remembers both extremes', () => {
    const stat = statOf('core.test.op', [1, 2, 3]);
    expect(stat.count).toBe(3);
    expect(stat.totalMs).toBeCloseTo(6, 6);
    expect(stat.minMs).toBeCloseTo(1, 6);
    expect(stat.maxMs).toBeCloseTo(3, 6);
    expect(stat.histogram).toHaveLength(TIMING_BUCKETS);
  });

  it('times a span once, however many times it is ended', () => {
    const recorder = new Recorder();
    const span = recorder.start('core.test.span');
    span.end();
    span.end();
    expect(recorder.snapshot().entries[0]?.count).toBe(1);
  });

  it('times a throw as well as a return', () => {
    const recorder = new Recorder();
    expect(() =>
      recorder.measure('core.test.throw', () => {
        throw new Error('refused');
      }),
    ).toThrow('refused');
    expect(recorder.snapshot().entries[0]?.count).toBe(1);
  });

  it('counts the bytes a call returned', () => {
    const recorder = new Recorder();
    const text = recorder.measure(
      'core.test.bytes',
      () => 'abcdef',
      (result) => result.length,
    );
    expect(text).toBe('abcdef');
    expect(recorder.snapshot().entries[0]?.bytes).toBe(6);
  });

  it('records nothing at all when it is off', () => {
    const recorder = new Recorder(false);
    recorder.measure('core.test.off', () => 1);
    recorder.start('core.test.off').end();
    recorder.add('core.test.off', 5);
    expect(recorder.snapshot().entries).toEqual([]);
  });

  it('stamps the shape it wrote', () => {
    expect(new Recorder().snapshot().version).toBe(TIMING_VERSION);
  });

  it('does not let a nonsense duration poison a name', () => {
    const recorder = new Recorder();
    recorder.add('core.test.nan', Number.NaN);
    recorder.add('core.test.nan', -5);
    recorder.add('core.test.nan', 2);
    const stat = recorder.snapshot().entries[0] as TimingStat;
    expect(stat.totalMs).toBe(2);
    expect(stat.maxMs).toBe(2);
    expect(stat.minMs).toBe(0);
  });
});

describe('percentiles', () => {
  it('never reads below the value it came from', () => {
    // 100 readings of 8 ms: the bucket p50 lands in has 10 ms as its top edge,
    // and 10 is the honest answer for a reading the ladder cannot place exactly.
    const stat = statOf('core.test.p', new Array<number>(100).fill(8));
    expect(percentile(stat, 0.5)).toBe(10);
    expect(percentile(stat, 0.95)).toBe(10);
    expect(percentile(stat, 1)).toBe(10);
  });

  it('reads the overflow bucket as the maximum that was seen', () => {
    const stat = statOf('core.test.slow', [40 * 60 * 1000]);
    expect(percentile(stat, 0.5)).toBe(40 * 60 * 1000);
  });

  it('separates a fast bulk from a slow tail', () => {
    // 94 of one and 6 of fifty: the 95th reading is the first slow one, and a
    // mean alone would put this at 3.9 ms and hide it.
    const stat = statOf('core.test.tail', [
      ...new Array<number>(94).fill(1),
      ...new Array<number>(6).fill(50),
    ]);
    expect(percentile(stat, 0.5)).toBe(1);
    expect(percentile(stat, 0.95)).toBe(50);
    // And the mean is dragged by the tail, which is why both are printed.
    expect(meanMs(stat)).toBeCloseTo((94 * 1 + 6 * 50) / 100, 6);
  });

  it('has nothing to say about a name that was never hit', () => {
    expect(percentile({ count: 0, histogram: [], maxMs: 0 }, 0.5)).toBeNull();
    expect(meanMs({ count: 0, totalMs: 0 })).toBeNull();
  });
});

describe('merging', () => {
  it('is the same as having measured everything in one process', () => {
    const all = statOf('core.test.m', [1, 2, 30, 1, 2, 30], 30);
    const parts = mergeStats([statOf('core.test.m', [1, 2, 30], 30), statOf('core.test.m', [1, 2, 30], 30)]);
    expect(parts).toEqual([all]);
  });

  it('keeps the extremes of each side, not the extremes of one', () => {
    const [merged] = mergeStats([statOf('core.test.x', [1, 2]), statOf('core.test.x', [7, 9])]) as [
      TimingStat,
    ];
    expect(merged.minMs).toBeCloseTo(1, 6);
    expect(merged.maxMs).toBeCloseTo(9, 6);
    expect(merged.count).toBe(4);
  });

  it('leaves the inputs alone', () => {
    const left = statOf('core.test.y', [1]);
    const before = JSON.stringify(left);
    mergeStats([left, statOf('core.test.y', [5])]);
    expect(JSON.stringify(left)).toBe(before);
  });

  it('orders by total, which is the order the report is read in', () => {
    const rows = byTotal([statOf('core.test.a', [1]), statOf('core.test.b', [10, 10])]);
    expect(rows.map((row) => row.name)).toEqual(['core.test.b', 'core.test.a']);
  });
});
