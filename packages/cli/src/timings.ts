/**
 * The timings table, for `dsh timings`.
 *
 * Its own file rather than a block in `bin.ts`, because the interesting part is
 * not the wiring but the three readings that make a row actionable:
 *
 *   - **share** of the runs' wall clock, so 12 ms is either nothing or the
 *     answer;
 *   - **mean against p50**, which is how a bimodal name shows itself (a fix that
 *     helps the median and not the tail is not a fix);
 *   - **max**, which is where a cliff is: a name whose maximum is a hundred
 *     times its median is a name that occasionally takes a second, and that is
 *     the one a user notices.
 *
 * Throughput is printed when the call recorded bytes, which is the column that
 * says whether a slow read is the file or the harness around it.
 */

import { meanMs, percentile, type TimingStat } from '@emilswork/harness-core';
import { pad } from './render.js';

export type TimingSort = 'total' | 'max' | 'p95' | 'mean' | 'count';

export interface TimingsTableOptions {
  /** What the figures are a share of, in ms. Zero drops the column. */
  wallMs: number;
  /** How many rows to print. */
  top: number;
  sort: TimingSort;
}

/** A duration a person can read at a glance, in whatever unit fits. */
function ms(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '-';
  if (value < 1) return `${(value * 1000).toFixed(0)}µs`;
  if (value < 1000) return `${value.toFixed(value < 10 ? 2 : 1)}ms`;
  return `${(value / 1000).toFixed(2)}s`;
}

/** Bytes over the time they took, which is how a read is read. */
function throughput(stat: TimingStat): string {
  if (stat.bytes <= 0 || stat.totalMs <= 0) return '-';
  const perSecond = stat.bytes / (stat.totalMs / 1000);
  if (perSecond >= 1_000_000) return `${(perSecond / 1_000_000).toFixed(1)} MB/s`;
  if (perSecond >= 1000) return `${(perSecond / 1000).toFixed(0)} kB/s`;
  return `${perSecond.toFixed(0)} B/s`;
}

function sortKey(sort: TimingSort): (stat: TimingStat) => number {
  switch (sort) {
    case 'max':
      return (stat) => stat.maxMs;
    case 'p95':
      return (stat) => percentile(stat, 0.95) ?? 0;
    case 'mean':
      return (stat) => meanMs(stat) ?? 0;
    case 'count':
      return (stat) => stat.count;
    case 'total':
      return (stat) => stat.totalMs;
  }
}

/**
 * The table itself, as text.
 *
 * Sorted here rather than by the caller, because the sort and the "top N" cut
 * have to be the same choice: cutting 25 rows by total and then sorting by max
 * would print the wrong 25.
 */
export function timingsTable(entries: TimingStat[], options: TimingsTableOptions): string {
  if (entries.length === 0) return '';
  const key = sortKey(options.sort);
  const rows = [...entries].sort((a, b) => key(b) - key(a)).slice(0, Math.max(1, options.top));

  const header =
    `${pad('NAME', 40)}${pad('COUNT', 7)}${pad('MEAN', 9)}${pad('P50', 9)}${pad('P95', 9)}` +
    `${pad('MAX', 10)}${pad('TOTAL', 10)}${options.wallMs > 0 ? pad('SHARE', 8) : ''}${pad('RATE', 12)}\n`;

  const body = rows
    .map((stat) => {
      const share = options.wallMs > 0 ? `${((stat.totalMs / options.wallMs) * 100).toFixed(1)}%` : '';
      return (
        `${pad(stat.name, 40)}${pad(String(stat.count), 7)}${pad(ms(meanMs(stat)), 9)}` +
        `${pad(ms(percentile(stat, 0.5)), 9)}${pad(ms(percentile(stat, 0.95)), 9)}` +
        `${pad(ms(stat.maxMs), 10)}${pad(ms(stat.totalMs), 10)}` +
        `${options.wallMs > 0 ? pad(share, 8) : ''}${pad(throughput(stat), 12)}\n`
      );
    })
    .join('');

  return header + body;
}

/** What a reader has to know to read the table without being misled by it. */
export function timingsFootnotes(): string {
  return (
    'SHARE is of the runs\u2019 own wall clock, model waiting included, so it is the right\n' +
    'denominator for "how much of this run was the harness". The figures overlap on\n' +
    'purpose: a name contains the names it calls (worker.tool.read_file contains\n' +
    'core.sandbox.readFile), so shares do not add up to 100%.\n' +
    'P50, P95 and MAX come from a fixed bucket ladder, so a percentile is the top edge\n' +
    'of the bucket it lands in -- a bound, and never lower than what was measured.\n' +
    'RATE divides the bytes a call handled by the time it took. It is blank where a\n' +
    'call has no size, and it is what tells a 3 ms read of 4 kB from a 3 ms read of 2 MB.\n'
  );
}
