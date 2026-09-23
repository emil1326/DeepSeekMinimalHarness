import type { RunTotals } from './events.js';

/**
 * Which measurement method a set of figures came from.
 *
 * The speed numbers have been wrong once, and in a way worth remembering: v1
 * divided *all* of a call's output tokens by only the window in which the
 * visible answer streamed, so a call whose 900 tokens were mostly thinking was
 * reported at 930 tokens a second against a model that does nearer 200.
 *
 * Once a figure has been recorded wrong, it is recorded wrong for ever: the
 * rows are in `runs.db` and nothing rewrites them. So every call carries the
 * method that produced it, and a reader that aggregates calls refuses to mix
 * methods rather than quietly averaging a wrong number with a right one.
 *
 * v1 — decode window could be shorter than the tokens divided by it; the
 *      thinking channel was not counted at all.
 * v2 — the window spans every output delta of any kind, a gap guard refuses a
 *      window that is not a measurement, and thinking is counted separately.
 */
export const METRICS_VERSION = 2;

/** What a stored call with no version on it was, by definition. */
export const LEGACY_METRICS_VERSION = 1;

/**
 * The version of a call that may predate the field existing.
 *
 * Everything written before `metricsVersion` was v1's method, so an absent value
 * is not unknown, it is old, and reading it as v1 is what keeps an aggregate
 * from treating a wrong number as a current one.
 */
export function metricsVersionOf(call: { metricsVersion?: number | null }): number {
  const value = call.metricsVersion;
  return typeof value === 'number' && Number.isFinite(value) ? value : LEGACY_METRICS_VERSION;
}

/** What one model call cost, in wall clock and tokens. */
export interface CallMetrics {
  /** The method behind the speed figures here. See `METRICS_VERSION`. */
  metricsVersion: number;
  model: string;
  startedAt: string;
  /** Milliseconds from the request going out to the last token, measured on the client. */
  durationMs: number;
  timeToFirstTokenMs: number | null;
  /** Milliseconds from the first output token to the last, of any kind. */
  streamingMs: number | null;
  /** The longest wait between two output tokens, for telling a burst from a decode. */
  largestGapMs: number;
  promptTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  completionTokens: number;
  /** Of `completionTokens`, how many were thinking rather than answer. */
  reasoningTokens: number;
  /**
   * Decode only, and null when the stream did not span enough to measure one.
   *
   * Not the number to quote as "the model's speed": see the note on
   * `deepseek.ts`'s `decodeRate`. The honest headline is end to end.
   */
  generationTokensPerSecond: number | null;
  /** Output tokens over the whole call. This is what a vendor advertises. */
  endToEndTokensPerSecond: number | null;
}

/**
 * A decode window shorter than this is measurement noise, not a speed.
 *
 * A turn that only calls a tool can arrive in one tick, leaving a window of a
 * few hundred microseconds: dividing fifty tokens by that reports 500,000
 * tokens a second, which is not a fast model, it is a stopwatch that did not
 * have time to start. Real streaming never gets near this.
 */
export const MIN_MEASURED_WINDOW_MS = 1;

export function rate(tokens: number, milliseconds: number | null): number | null {
  if (milliseconds === null || !Number.isFinite(milliseconds)) return null;
  if (milliseconds < MIN_MEASURED_WINDOW_MS) return null;
  return round(tokens / (milliseconds / 1000), 1);
}

export function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/** Prices come from the daemon's config, filled in by hand. They change; don't hardcode them. */
export interface Price {
  inputPerMillion: number;
  cacheHitPerMillion?: number;
  outputPerMillion: number;
}

export type PriceTable = Record<string, Price>;

export function costOf(price: Price | undefined, metrics: CallMetrics): number | null {
  if (price === undefined) return null;
  const hitPrice = price.cacheHitPerMillion ?? price.inputPerMillion;
  const billed = Math.max(0, metrics.promptTokens - metrics.cacheHitTokens);
  return (
    (billed * price.inputPerMillion +
      metrics.cacheHitTokens * hitPrice +
      metrics.completionTokens * price.outputPerMillion) /
    1_000_000
  );
}

export function totalsOf(previous: RunTotals, metrics: CallMetrics, price: Price | undefined): RunTotals {
  const measured = metrics.timeToFirstTokenMs !== null;
  const timedCalls = previous.timedCalls + (measured ? 1 : 0);
  // A running mean over the calls that managed to measure one. A call that did
  // not must not drag the mean toward zero.
  const timeToFirstTokenMs = measured
    ? round(
        ((previous.timeToFirstTokenMs ?? 0) * (timedCalls - 1) + (metrics.timeToFirstTokenMs ?? 0)) /
          timedCalls,
        1,
      )
    : previous.timeToFirstTokenMs;
  const call = costOf(price, metrics);
  return {
    calls: previous.calls + 1,
    timedCalls,
    promptTokens: previous.promptTokens + metrics.promptTokens,
    cacheHitTokens: previous.cacheHitTokens + metrics.cacheHitTokens,
    completionTokens: previous.completionTokens + metrics.completionTokens,
    reasoningTokens: previous.reasoningTokens + metrics.reasoningTokens,
    timeToFirstTokenMs,
    // The most recent measurement, not a mean of speeds: averaging tokens per
    // second across calls of wildly different lengths means nothing.
    generationTokensPerSecond: metrics.generationTokensPerSecond,
    endToEndTokensPerSecond: metrics.endToEndTokensPerSecond,
    costUsd: call === null ? previous.costUsd : round((previous.costUsd ?? 0) + call, 6),
  };
}

export function cacheHitRate(metrics: Pick<CallMetrics, 'promptTokens' | 'cacheHitTokens'>): number | null {
  if (metrics.promptTokens <= 0) return null;
  return round(metrics.cacheHitTokens / metrics.promptTokens, 4);
}

export type { RunTotals };
