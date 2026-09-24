/**
 * Where the time goes.
 *
 * The harness already measures the model: `CallMetrics` says how long a call
 * took and how many tokens came out of it. Nothing measured the harness itself,
 * which is the half of a run that is under our control. A tool call that spends
 * 10 ms inside the sandbox to return four lines, a `compact` that walks the
 * whole conversation four times per turn, a transcript rewritten in full on
 * every turn — none of that was visible, so none of it was ever optimised.
 *
 * This is a stopwatch with a memory. Spans are recorded by name, aggregated per
 * process, and handed to the daemon at the end of a run; the daemon keeps one
 * row per (run, name) and can sum across runs for a global view. The question it
 * exists to answer is "is this 10 ms where it should be 1 ms", so the figures
 * that matter are the count, the mean, and the tail — not just the total.
 *
 * **Why a fixed histogram rather than samples.** A percentile needs to survive
 * two things samples do not: a merge across runs, and a store that is read far
 * more often than it is written. Keeping the raw samples means keeping megabytes
 * of numbers, and a p95 computed from the samples of one run is not the same
 * number as a p95 computed from the samples of all of them. A bucket ladder
 * merges exactly by adding two arrays, costs 24 numbers per name however many
 * times the name was hit, and answers p50/p95/p99 to bucket precision. That
 * precision is a bucket edge, and every reader is told so.
 *
 * **Why it is on by default.** The spans sit at syscall or per-file granularity,
 * where one `performance.now()` pair costs tens of nanoseconds against
 * microseconds or milliseconds of work: under a tenth of a percent, and the only
 * way a 10 ms outlier is ever going to be seen. `DSH_TIMING=0` turns it off when
 * somebody wants it off.
 *
 * **Why names are dotted strings.** `core.sandbox.readFile` reads as a path from
 * the layer to the operation, so a reader can eyeball the table without a legend
 * and a new span needs no registry. They are also the store's primary key half,
 * so they are stable once shipped: renaming one orphans its history instead of
 * moving it. `TIMING_VERSION` covers the day the *shape* of a stat changes,
 * which is a different thing from a name changing and is why a snapshot carries
 * it the way a call carries `metricsVersion`.
 */

import { performance } from 'node:perf_hooks';

/**
 * The shape of a `TimingStat`, so a reader can tell a historical row apart from
 * one this build wrote.
 *
 * 1 — name, count, totalMs, minMs, maxMs, bytes, histogram.
 */
export const TIMING_VERSION = 1;

/**
 * Upper edges of the histogram buckets, in milliseconds.
 *
 * Geometric with a factor of about 2.5, from 10 µs to half an hour, plus one
 * overflow bucket at the end. Finer than log2 where the interesting calls live
 * (sub-millisecond to 100 ms) because that is the range a fix has to move, and
 * coarse above a second because "this took 4 minutes" has one conclusion anyway.
 */
export const TIMING_EDGES_MS = [
  0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000,
  30000, 60000, 300000, 1800000,
];

/** How many buckets a histogram has: one per edge, plus the overflow. */
export const TIMING_BUCKETS = TIMING_EDGES_MS.length + 1;

/** One name's aggregated readings. Small, and additive: see `mergeStats`. */
export interface TimingStat {
  name: string;
  count: number;
  /** The sum of every measured span, which is what a whole-run reading is. */
  totalMs: number;
  minMs: number;
  maxMs: number;
  /**
   * The work the time was spent on, when the span has a unit.
   *
   * Bytes read, bytes searched, characters of tool output. Set where it is known
   * and zero otherwise, so a reader can ask "ms per megabyte" and see that a
   * 4 KB read costing 3 ms is a fixed cost while a 2 MB search costing 40 ms is
   * throughput. Without it every figure is a total with nothing to divide by,
   * which is how a perfectly efficient call gets mistaken for a slow one.
   */
  bytes: number;
  /** Counts per bucket, merged by summing. Never edited in place by a reader. */
  histogram: number[];
}

export interface TimingSnapshot {
  version: number;
  /** When the readings were taken. */
  at: string;
  entries: TimingStat[];
}

/** Which bucket a duration falls in. The last bucket is everything above the top edge. */
export function bucketOf(ms: number): number {
  if (!(ms > 0)) return 0;
  // Linear over 23 edges. A binary search would be eight comparisons against
  // twenty-two of a loop over a 23-element array that is almost always decided
  // in the first few steps anyway.
  for (let index = 0; index < TIMING_EDGES_MS.length; index += 1) {
    if (ms <= (TIMING_EDGES_MS[index] as number)) return index;
  }
  return TIMING_EDGES_MS.length;
}

/** A fresh histogram, all zeroes. */
export function emptyHistogram(): number[] {
  return new Array<number>(TIMING_BUCKETS).fill(0);
}

/**
 * A quantile from a histogram, as the top edge of the bucket it lands in.
 *
 * Deliberately an upper bound. Reporting a midpoint would be inventing
 * precision: the bucket's floor is the top edge of the previous bucket, and
 * across a factor of 2.5 the difference between floor and ceiling is most of
 * the answer. A reader is told "p95 is at most 25 ms, and above 10 ms" by the
 * number and by the doc.
 */
export function percentile(stat: Pick<TimingStat, 'count' | 'histogram' | 'maxMs'>, q: number): number | null {
  if (stat.count <= 0) return null;
  const target = Math.ceil(stat.count * Math.min(1, Math.max(0, q)));
  let seen = 0;
  for (let bucket = 0; bucket < stat.histogram.length; bucket += 1) {
    seen += stat.histogram[bucket] ?? 0;
    if (seen >= target) {
      // The overflow bucket has no edge, so the observed maximum is what it can
      // honestly report.
      return bucket >= TIMING_EDGES_MS.length ? stat.maxMs : (TIMING_EDGES_MS[bucket] as number);
    }
  }
  return stat.maxMs;
}

export function meanMs(stat: Pick<TimingStat, 'count' | 'totalMs'>): number | null {
  return stat.count > 0 ? stat.totalMs / stat.count : null;
}

/**
 * Add readings together, exactly and without sampling.
 *
 * This is the whole reason the histogram exists: two runs' worth of `read_file`
 * become one row whose count, total, extremes, bytes and percentiles are all
 * right, from 24 numbers added to 24 numbers. Order does not matter, so a partial
 * flush and a later one can be merged in either order.
 */
export function mergeStats(stats: readonly TimingStat[]): TimingStat[] {
  const byName = new Map<string, TimingStat>();
  for (const stat of stats) {
    const current = byName.get(stat.name);
    if (current === undefined) {
      byName.set(stat.name, { ...stat, histogram: [...stat.histogram] });
      continue;
    }
    current.count += stat.count;
    current.totalMs += stat.totalMs;
    current.bytes += stat.bytes;
    current.minMs = Math.min(current.minMs, stat.minMs);
    current.maxMs = Math.max(current.maxMs, stat.maxMs);
    for (let bucket = 0; bucket < current.histogram.length; bucket += 1) {
      current.histogram[bucket] = (current.histogram[bucket] ?? 0) + (stat.histogram[bucket] ?? 0);
    }
  }
  return [...byName.values()];
}

/** Longest-first, which is the order a table of "what costs the most" wants. */
export function byTotal(stats: readonly TimingStat[]): TimingStat[] {
  return [...stats].sort((a, b) => b.totalMs - a.totalMs);
}

/**
 * A stopwatch for one call site.
 *
 * `end` is idempotent and safe to call on a path that threw: the wrappers in
 * `Recorder` do their own try/finally, and a hand-held span is meant to be ended
 * in a `finally` too. Ending twice would record twice, so it does not.
 */
export interface TimingSpan {
  /** Records the span. Returns its duration so a caller can reuse it. */
  end(bytes?: number): number;
}

const NOOP_SPAN: TimingSpan = { end: () => 0 };

/**
 * The process-wide recorder.
 *
 * One per process, because one process is one thing being measured: the worker
 * is a run, so its readings are that run's; the daemon is a daemon, and its
 * readings are the harness's own overhead. Nothing here is a global in the
 * dangerous sense — it is a map of counters, mutated only by the thread that
 * owns it, and nothing in a run reads another run's numbers.
 */
export class Recorder {
  private readonly rows = new Map<string, TimingStat>();
  private enabled: boolean;

  constructor(enabled = true) {
    this.enabled = enabled;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Turned off by `DSH_TIMING=0`, for a run being profiled by something else. */
  setEnabled(value: boolean): void {
    this.enabled = value;
  }

  /** One measurement that has already been timed. The only way a stat is written. */
  add(name: string, ms: number, bytes = 0): void {
    if (!this.enabled) return;
    const safe = Number.isFinite(ms) && ms >= 0 ? ms : 0;
    let row = this.rows.get(name);
    if (row === undefined) {
      row = {
        name,
        count: 0,
        totalMs: 0,
        minMs: Number.POSITIVE_INFINITY,
        maxMs: 0,
        bytes: 0,
        histogram: emptyHistogram(),
      };
      this.rows.set(name, row);
    }
    row.count += 1;
    row.totalMs += safe;
    row.minMs = Math.min(row.minMs, safe);
    row.maxMs = Math.max(row.maxMs, safe);
    row.bytes += bytes > 0 ? bytes : 0;
    const bucket = bucketOf(safe);
    row.histogram[bucket] = (row.histogram[bucket] ?? 0) + 1;
  }

  start(name: string): TimingSpan {
    if (!this.enabled) return NOOP_SPAN;
    const started = performance.now();
    let ended = false;
    return {
      end: (bytes = 0): number => {
        if (ended) return 0;
        ended = true;
        const ms = performance.now() - started;
        this.add(name, ms, bytes);
        return ms;
      },
    };
  }

  /**
   * Time `work`, sync, and return what it returned.
   *
   * `bytesOf` is called with the result inside the timed region, because the
   * size of a result is part of what the call cost to produce: a `readFile` that
   * returns 2 MB took that long partly *because* it returned 2 MB, and a
   * measurement that stopped before the string was built would hide it.
   */
  measure<T>(name: string, work: () => T, bytesOf?: (result: T) => number): T {
    if (!this.enabled) return work();
    const started = performance.now();
    try {
      const result = work();
      this.add(name, performance.now() - started, bytesOf ? bytesOf(result) : 0);
      return result;
    } catch (error) {
      // A refusal is a result too. Timing only the successes would make a
      // sandbox that refuses everything look instant.
      this.add(name, performance.now() - started);
      throw error;
    }
  }

  async measureAsync<T>(name: string, work: () => Promise<T>, bytesOf?: (result: T) => number): Promise<T> {
    if (!this.enabled) return work();
    const started = performance.now();
    try {
      const result = await work();
      this.add(name, performance.now() - started, bytesOf ? bytesOf(result) : 0);
      return result;
    } catch (error) {
      this.add(name, performance.now() - started);
      throw error;
    }
  }

  /**
   * Everything measured so far, longest total first.
   *
   * A copy, and a deep one for the histograms: a flush hands this to IPC and a
   * test reads it, and neither may see a row change under it.
   */
  snapshot(at = new Date()): TimingSnapshot {
    return {
      version: TIMING_VERSION,
      at: at.toISOString(),
      entries: byTotal([...this.rows.values()].map((row) => ({ ...row, histogram: [...row.histogram] }))),
    };
  }

  reset(): void {
    this.rows.clear();
  }
}

/** The process-wide recorder every instrumented call site writes to. */
export const timing = new Recorder(process.env.DSH_TIMING !== '0');
