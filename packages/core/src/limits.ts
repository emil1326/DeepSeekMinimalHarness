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
  /** `budget - used`, floored at zero, because that is the actionable number. */
  remaining: number;
  /** `used / budget`, so callers do not each divide it differently. */
  ratio: number;
}

/**
 * When to tell the agent.
 *
 * Four fifths gone, expressed as what is *left* rather than as a ratio, and
 * that is not the same thing on a small budget. With `turns: 4` the ratio never
 * reaches 0.8 at a moment the loop checks — it goes 0, 0.25, 0.5, 0.75, then
 * the run is over — so a ratio threshold silently never fires on exactly the
 * short runs that most need the warning. Measured live: a four-turn run stopped
 * at its limit having been told nothing at all.
 *
 * So the rule is "a fifth or less left, and never fewer than one". The floor of
 * one is what makes a budget of two or three work: `ceil(3 * 0.2)` is one, and
 * a budget of one warns on the only turn it has.
 */
export const WARN_AT = 0.8;

/** How many units of a limit may be left before the agent is told. */
export function warnThreshold(budget: number, at: number = WARN_AT): number {
  return Math.max(1, Math.ceil(budget * (1 - at)));
}

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
    remaining: Math.max(0, row.budget - row.used),
    // A budget of zero is not a division, and a caller asking for one wants to
    // hear that it is full rather than get a NaN.
    ratio: row.budget > 0 ? row.used / row.budget : 1,
  }));
}

/**
 * The limits that are close enough to warn about, tightest first.
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
  return (
    uses
      .filter((use) => use.remaining <= warnThreshold(use.budget, at) && !alreadyWarned.has(use.which))
      // Tightest first, and by the fraction left rather than the count: one turn
      // out of four is more urgent than sixty seconds out of an hour.
      .sort((a, b) => a.remaining / (a.budget || 1) - b.remaining / (b.budget || 1))
  );
}

/** Which limit the run has actually reached, if any. Worst first. */
export function exceeded(uses: LimitUse[]): LimitUse | null {
  const over = uses.filter((use) => use.remaining <= 0);
  if (over.length === 0) return null;
  return over.sort((a, b) => b.ratio - a.ratio)[0] ?? null;
}

/** `1400 of 2000`, with both numbers rounded for a human. */
export function describeLimit(use: LimitUse, unit = ''): string {
  return `${format(use.used)} of ${format(use.budget)}${unit}`;
}

/**
 * How long a run took, for the wall-clock limit.
 *
 * Measured to the run's *end* when it has one, and to now only while it is still
 * going. Getting this wrong is not cosmetic: `dsh limits` on a run that finished
 * four hours ago reported 15,000 of its 3,600 seconds used, so the LIMIT column
 * in `dsh list` showed `15k/3600` for a run that took three minutes, and the
 * wall-clock limit looked like the thing that had stopped it when the real one
 * was turns. Found by running it against the real runs rather than reading it.
 */
export function elapsedSeconds(input: {
  startedAt: string | null;
  endedAt?: string | null;
  now?: number;
}): number {
  if (input.startedAt === null) return 0;
  const from = Date.parse(input.startedAt);
  if (!Number.isFinite(from)) return 0;
  const to =
    input.endedAt === null || input.endedAt === undefined
      ? (input.now ?? Date.now())
      : Date.parse(input.endedAt);
  if (!Number.isFinite(to)) return 0;
  return Math.max(0, (to - from) / 1000);
}

export function format(value: number): string {
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`;
  if (value >= 10_000) return `${Math.round(value / 1000)}k`;
  return String(Math.round(value));
}
