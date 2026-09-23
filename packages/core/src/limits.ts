/**
 * How close a run is to each of its ceilings, and when to say so.
 *
 * A limit that arrives as a surprise wastes everything before it. Of the nine
 * runs on this machine, seven stopped at a limit: three at `totalTokens`, four
 * at `turns`. In every case the agent had no warning, so it never had the chance
 * to finish the file it was on, ask for more room, or stop tidily and say what
 * was left. It just stopped.
 *
 * This is the arithmetic only: what is used, of what, and how near. The loop
 * decides what to do about it, and the CLI, the UI and the run report all read
 * the same numbers, so none of them can disagree about how close a run is.
 *
 * `contextTokens` is deliberately absent. Every other limit is cumulative and
 * only ever goes up, so "used of budget" describes it. `contextTokens` bounds
 * *one request*, and the harness compacts the conversation to stay under it
 * rather than counting towards it, so a running total would be meaningless.
 */

import type { RunTotals } from './events.js';
import type { RunLimits } from './task.js';

/** The limits that accumulate, and so can be warned about before they arrive. */
export type CumulativeLimit = 'turns' | 'wallSeconds' | 'outputTokens' | 'totalTokens';

export interface LimitUse {
  which: CumulativeLimit;
  /** What the run has got to. */
  used: number;
  /** What it may reach. */
  budget: number;
  /** `used / budget`, so callers do not each divide it differently. */
  ratio: number;
}

/**
 * When to tell the agent.
 *
 * Four fifths: late enough that the warning is about a real shortage and not
 * about ordinary use, early enough to leave room to act on it. At the default
 * twelve turns that is the last two or three calls, which is enough to finish a
 * file and say what is left, and not enough to start anything new.
 */
export const WARN_AT = 0.8;

export interface LimitReadings {
  /** Model calls made so far. */
  turns: number;
  /** Wall clock since the run started. */
  elapsedSeconds: number;
  totals: RunTotals;
}

/**
 * Every cumulative limit, measured.
 *
 * `totalTokens` is measured in *billed* tokens: prompt misses plus output.
 * Counting cache hits at full price is what made it fire on runs that had spent
 * almost nothing, and that mistake is not worth repeating in the warning.
 */
export function limitUse(readings: LimitReadings, limits: RunLimits): LimitUse[] {
  const rows: { which: CumulativeLimit; used: number; budget: number }[] = [
    { which: 'turns', used: readings.turns, budget: limits.turns },
    { which: 'wallSeconds', used: Math.round(readings.elapsedSeconds), budget: limits.wallSeconds },
    { which: 'outputTokens', used: readings.totals.completionTokens, budget: limits.outputTokens },
    { which: 'totalTokens', used: readings.totals.billedTokens, budget: limits.totalTokens },
  ];
  return rows.map((row) => ({
    ...row,
    // A budget of zero is not a division, and a caller asking for one wants to
    // hear that it is full rather than get a NaN.
    ratio: row.budget > 0 ? row.used / row.budget : 1,
  }));
}

/**
 * The limits that are close enough to warn about, worst first.
 *
 * `alreadyWarned` is how the caller avoids nagging: a limit is announced once
 * on the way in, not on every turn after it. Without that, a run that slows down
 * near its wall clock gets the same sentence twenty times, and the one notice
 * that mattered becomes noise the model learns to skim.
 */
export function approaching(
  uses: LimitUse[],
  alreadyWarned: ReadonlySet<CumulativeLimit>,
  at: number = WARN_AT,
): LimitUse[] {
  return uses
    .filter((use) => use.ratio >= at && !alreadyWarned.has(use.which))
    .sort((a, b) => b.ratio - a.ratio);
}

/** Which limit the run has actually reached, if any. Worst first. */
export function exceeded(uses: LimitUse[]): LimitUse | null {
  const over = uses.filter((use) => use.used >= use.budget);
  if (over.length === 0) return null;
  return over.sort((a, b) => b.ratio - a.ratio)[0] ?? null;
}

/** `1400 of 2000`, with both numbers rounded for a human. */
export function describeLimit(use: LimitUse, unit = ''): string {
  return `${format(use.used)} of ${format(use.budget)}${unit}`;
}

export function format(value: number): string {
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`;
  if (value >= 10_000) return `${Math.round(value / 1000)}k`;
  return String(Math.round(value));
}
