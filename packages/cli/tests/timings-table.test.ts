/**
 * How `dsh timings` prints a row.
 *
 * A pure function on purpose, so the three decisions a reader depends on can be
 * checked without a daemon: the order (and that the "top N" cut is taken in that
 * same order), the units, and the rate that turns a byte count into something
 * comparable.
 */

import { describe, expect, it } from 'vitest';
import { emptyHistogram, TIMING_BUCKETS, type TimingStat } from '@emilswork/harness-core';
import { timingsTable } from '../src/timings.js';

/** A stat as the worker would have written one, without going through a clock. */
function stat(name: string, values: number[], bytes = 0): TimingStat {
  const histogram = emptyHistogram();
  let total = 0;
  let max = 0;
  let min = Number.POSITIVE_INFINITY;
  for (const value of values) {
    total += value;
    max = Math.max(max, value);
    min = Math.min(min, value);
    histogram[Math.min(TIMING_BUCKETS - 1, Math.floor(value))] =
      (histogram[Math.min(TIMING_BUCKETS - 1, Math.floor(value))] ?? 0) + 1;
  }
  return {
    name,
    count: values.length,
    totalMs: total,
    minMs: min,
    maxMs: max,
    bytes,
    histogram,
  };
}

const rows = [stat('core.sandbox.readFile', [1, 2], 2048), stat('worker.turn.model', [1000, 2000])];

describe('the timings table', () => {
  it('prints the slowest name first and keeps the cut in the same order', () => {
    const table = timingsTable(rows, { wallMs: 10_000, top: 1, sort: 'total' });
    expect(table.split('\n')[0]).toContain('NAME');
    expect(table).toContain('worker.turn.model');
    expect(table).not.toContain('core.sandbox.readFile');
  });

  it('reads a duration in the unit that fits it', () => {
    const table = timingsTable([stat('core.x', [0.5]), stat('core.y', [1500])], {
      wallMs: 0,
      top: 5,
      sort: 'total',
    });
    expect(table).toContain('500µs');
    expect(table).toContain('1.50s');
    // No wall clock given, so no share column to divide by zero.
    expect(table.split('\n')[0]).not.toContain('SHARE');
  });

  it('turns bytes and time into a rate, and leaves it blank without a size', () => {
    const withSize = timingsTable([stat('core.sandbox.readFile', [2], 2_000_000)], {
      wallMs: 0,
      top: 5,
      sort: 'total',
    });
    expect(withSize).toContain('1000.0 MB/s');
    const without = timingsTable([stat('worker.emit', [2])], { wallMs: 0, top: 5, sort: 'total' });
    expect(without.split('\n')[1]?.trimEnd().endsWith('-')).toBe(true);
  });

  it('prints nothing at all when nothing was measured', () => {
    expect(timingsTable([], { wallMs: 1000, top: 25, sort: 'total' })).toBe('');
  });

  it('reads a total as a share of the runs, not of the model', () => {
    const table = timingsTable([stat('core.sandbox.readFile', [250])], {
      wallMs: 10_000,
      top: 5,
      sort: 'total',
    });
    expect(table).toContain('2.5%');
  });
});
