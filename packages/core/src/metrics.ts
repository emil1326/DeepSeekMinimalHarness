import type { RunTotals } from './events.js';

/** What one model call cost, in wall clock and tokens. */
export interface CallMetrics {
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
