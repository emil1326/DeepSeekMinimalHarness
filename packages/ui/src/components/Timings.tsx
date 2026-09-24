import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { seconds } from '../format';
import type { TimingStat } from '../types';

/**
 * Where the time went, for one run or for all of them.
 *
 * The question this answers is not "how long did it take" -- the model is most
 * of it and always will be -- but "is any part of the harness itself slower than
 * it should be", which is invisible everywhere else. Two numbers do the work: a
 * name's total against the run's own wall clock, and its mean against its p50.
 * A name whose mean and median are far apart is bimodal, and fixing the median
 * would not help it.
 *
 * Deliberately plain: a table, a sort, and the caveats written where they can be
 * read. It is a measuring instrument, and an instrument that needs interpreting
 * is worse than no instrument.
 */

/** A duration in the unit that fits it. `µs` for the small ones, because those are common here. */
function ms(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  if (value < 1) return `${(value * 1000).toFixed(0)}µs`;
  if (value < 1000) return `${value.toFixed(value < 10 ? 2 : 1)}ms`;
  return `${(value / 1000).toFixed(2)}s`;
}

function percentileOf(stat: TimingStat, quantile: number): number | null {
  if (stat.count <= 0) return null;
  const target = Math.ceil(stat.count * quantile);
  let seen = 0;
  for (let bucket = 0; bucket < stat.histogram.length; bucket += 1) {
    seen += stat.histogram[bucket] ?? 0;
    if (seen >= target) {
      // The buckets are a geometric ladder in the engine, and the UI only has
      // the counts, so the reading is the count's own position in the ladder up
      // to the maximum that was actually seen. Never below what was measured.
      return bucket >= stat.histogram.length - 1 ? stat.maxMs : Math.min(stat.maxMs, ladderOf(bucket));
    }
  }
  return stat.maxMs;
}

/**
 * The upper edge of a bucket, by index.
 *
 * The same 23-step ladder the engine uses (`TIMING_EDGES_MS`). Duplicated rather
 * than imported because importing `@emilswork/harness-core` into the browser
 * bundle is not worth it for an array of constants, and it is the same list the
 * buckets were built from: a mismatch would show as percentiles reading low,
 * which the "never below the maximum" clamp keeps honest.
 */
const EDGES_MS = [
  0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000,
  60000, 300000, 1800000,
];

function ladderOf(bucket: number): number {
  return EDGES_MS[bucket] ?? 1800000;
}

/**
 * Bytes over the time they took.
 *
 * The column that turns a worry into a fact: 3 ms for a 4 kB read is a fixed
 * cost and nothing to fix, 3 ms for a 2 MB read is worth reading twice. Blank
 * for a call that measures no size, which most of them do not.
 */
function rateOf(stat: TimingStat): string {
  if (stat.bytes <= 0 || stat.totalMs <= 0) return '—';
  const perSecond = stat.bytes / (stat.totalMs / 1000);
  if (perSecond >= 1_000_000) return `${(perSecond / 1_000_000).toFixed(1)} MB/s`;
  if (perSecond >= 1000) return `${(perSecond / 1000).toFixed(0)} kB/s`;
  return `${perSecond.toFixed(0)} B/s`;
}

type SortBy = 'total' | 'max' | 'p95' | 'mean' | 'count';

const SORTS: { key: SortBy; label: string; of: (stat: TimingStat) => number }[] = [
  { key: 'total', label: 'total', of: (stat) => stat.totalMs },
  { key: 'max', label: 'max', of: (stat) => stat.maxMs },
  { key: 'p95', label: 'p95', of: (stat) => percentileOf(stat, 0.95) ?? 0 },
  { key: 'mean', label: 'mean', of: (stat) => meanOf(stat) ?? 0 },
  { key: 'count', label: 'calls', of: (stat) => stat.count },
];

const SHOWN = 25;

/**
 * A column heading that sorts by its own column.
 *
 * The column order is the reading order of the question: how often, then how
 * long typically, then how long at worst, then how much of the run. The sort is
 * on the heading so the control and the number move together.
 */
function SortHead({
  label,
  by,
  sort,
  onSort,
}: {
  label: string;
  by: SortBy;
  sort: SortBy;
  onSort: (by: SortBy) => void;
}) {
  return (
    <th className="num">
      <button className="sortable" data-on={sort === by ? 'true' : undefined} onClick={() => onSort(by)}>
        {label}
      </button>
    </th>
  );
}

function Rows({ entries, wallMs }: { entries: TimingStat[]; wallMs: number }) {
  const [sort, setSort] = useState<SortBy>('total');
  const [everyRow, setEveryRow] = useState(false);

  const of = SORTS.find((each) => each.key === sort)?.of ?? ((stat: TimingStat) => stat.totalMs);
  const sorted = [...entries].sort((a, b) => of(b) - of(a));
  const rows = everyRow ? sorted : sorted.slice(0, SHOWN);
  // A column of dashes is a column of nothing: the rate earns its place only
  // when at least one of these names recorded a size.
  const anyBytes = entries.some((stat) => stat.bytes > 0);

  return (
    <>
      <table className="timings">
        <thead>
          <tr>
            <th>name</th>
            <SortHead label="calls" by="count" sort={sort} onSort={setSort} />
            <SortHead label="mean" by="mean" sort={sort} onSort={setSort} />
            <th className="num">p50</th>
            <SortHead label="p95" by="p95" sort={sort} onSort={setSort} />
            <SortHead label="max" by="max" sort={sort} onSort={setSort} />
            <SortHead label="total" by="total" sort={sort} onSort={setSort} />
            <th className="num">share</th>
            {anyBytes && <th className="num">per byte</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((stat) => {
            const p50 = percentileOf(stat, 0.5);
            return (
              <tr key={stat.name}>
                <td className="name" title={stat.name}>
                  {stat.name}
                </td>
                <td className="num">{stat.count}</td>
                <td className="num">{ms(meanOf(stat))}</td>
                <td className="num">{ms(p50)}</td>
                <td className="num">{ms(percentileOf(stat, 0.95))}</td>
                {/* A maximum ten times the median is a cliff, and a cliff is
                    what a person actually notices, so it is marked rather than
                    left to be found in a column of numbers. */}
                <td
                  className="num"
                  data-spike={stat.maxMs > 10 * (p50 ?? 0) && stat.count > 3 ? 'true' : undefined}
                >
                  {ms(stat.maxMs)}
                </td>
                <td className="num">{ms(stat.totalMs)}</td>
                <td className="num">{wallMs > 0 ? `${((stat.totalMs / wallMs) * 100).toFixed(1)}%` : '—'}</td>
                {anyBytes && <td className="num">{rateOf(stat)}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
      {sorted.length > SHOWN && (
        <button className="quiet" onClick={() => setEveryRow((current) => !current)}>
          {everyRow ? `just the slowest ${SHOWN}` : `all ${sorted.length} names`}
        </button>
      )}
    </>
  );
}

function meanOf(stat: TimingStat): number | null {
  return stat.count > 0 ? stat.totalMs / stat.count : null;
}

/** The three things a reader has to know to read the table without being misled. */
function Caveats() {
  return (
    <p className="note">
      share is of the runs' own wall clock, waiting for the model included, which is what answers "how much of
      this was the harness". shares overlap on purpose: a name contains the names it calls, so they do not add
      up to 100%. p50, p95 and max come from a fixed bucket ladder and are the top edge of the bucket they
      land in, so they are a bound and never lower than what was measured. per byte divides the bytes a call
      handled by the time it took, which is what tells a 3 ms read of 4 kB from a 3 ms read of 2 MB.
    </p>
  );
}

/** One run's readings: the per-chat answer. */
export function Timings({ runId }: { runId: string }) {
  const readings = useQuery({
    queryKey: ['timings', runId],
    // Polled rather than pushed: a worker flushes at every turn boundary, so a
    // live run's table fills in as it goes, and no reading is worth waking the
    // whole live channel for.
    queryFn: () => api.timings(runId),
    refetchInterval: 5000,
  });

  if (readings.isPending) return <div className="empty">reading the stopwatch…</div>;
  if (readings.isError) {
    return <div className="empty">could not read the timings: {(readings.error as Error).message}</div>;
  }

  const { entries, wallMs, at } = readings.data;
  if (entries.length === 0) {
    return (
      <div className="empty">
        <h2>Nothing measured yet</h2>
        <p>
          A run hands its readings over at every turn boundary, so this fills in from the first turn that
          finishes. A run recorded before the stopwatch existed has none at all.
        </p>
      </div>
    );
  }

  const spikes = entries.filter(
    (stat) => stat.count > 3 && stat.maxMs > 10 * (percentileOf(stat, 0.5) ?? 0),
  ).length;

  return (
    <div className="scroller">
      <div className="section-head">
        <h1>Where this run's time went</h1>
        <span className="sub">
          {seconds(wallMs)} of run · {entries.length} call site{entries.length === 1 ? '' : 's'} measured
          {spikes === 0 ? '' : ` · ${spikes} name${spikes === 1 ? '' : 's'} with a slow tail`}
          {at === null ? '' : ` · read at ${new Date(at).toLocaleTimeString()}`}
        </span>
      </div>

      <div className="pane">
        <Rows entries={entries} wallMs={wallMs} />
      </div>
      <Caveats />
    </div>
  );
}

/**
 * Every run at once, and the daemon itself.
 *
 * The daemon's readings are a second table rather than more rows in the first:
 * it outlives hundreds of runs, and adding its uptime to their runtime would
 * make both numbers meaningless.
 */
export function AllTimings() {
  const readings = useQuery({
    queryKey: ['timings', 'all'],
    queryFn: api.allTimings,
    refetchInterval: 20_000,
  });

  // Nothing is shown rather than an empty panel: on a fresh harness this is a
  // heading nobody asked for, and the page already has a shape without it.
  if (readings.isPending || readings.isError) return null;
  const { entries, runs, wallMs, process } = readings.data;
  if (entries.length === 0) return null;

  return (
    <details className="metrics all-timings">
      <summary className="metrics-strip">
        <div>
          <dt>runs measured</dt>
          <dd>{runs}</dd>
        </div>
        <div>
          <dt>call sites</dt>
          <dd>{entries.length}</dd>
        </div>
        <div>
          <dt>wall clock, all runs</dt>
          <dd>{seconds(wallMs)}</dd>
        </div>
      </summary>
      <Rows entries={entries} wallMs={wallMs} />
      <Caveats />
      {process.length > 0 && (
        // The daemon outlives hundreds of runs, so its readings are a second
        // table: adding its uptime to a run's runtime would make both numbers
        // mean nothing.
        <details className="metrics">
          <summary className="metrics-strip">
            <div>
              <dt>the daemon itself</dt>
              <dd>{process.length} names</dd>
            </div>
          </summary>
          <Rows entries={process} wallMs={0} />
        </details>
      )}
    </details>
  );
}
