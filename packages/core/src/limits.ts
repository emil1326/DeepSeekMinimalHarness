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
 *
 * `costUsd` is the odd one out and is only listed when the run's model has a
 * known price. It is the limit a person actually cares about — turns and tokens
 * are proxies for a bill — and it is the only one counted in dollars rather than
 * in whole things, which every caller has to be told rather than left to guess.
 * See `formatLimit`.
 */

import type { RunTotals } from './events.js';
import type { RunLimits } from './task.js';

/** The limits that accumulate, and so can be warned about before they arrive. */
export type CumulativeLimit = 'turns' | 'wallSeconds' | 'outputTokens' | 'totalTokens' | 'costUsd';

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
 * one is what makes a budget of two or three work: `3 * 0.2` is 0.6, and a
 * budget of one warns on the only turn it has.
 */
export const WARN_AT = 0.8;

/**
 * The smallest amount of each limit that is still worth acting on, in that
 * limit's own unit.
 *
 * One, for everything counted in whole things: one more model call, one more
 * second, one more token. The floor exists because a single unit can be a large
 * fraction of a small budget — a quarter of a four-turn run — and without it the
 * warning silently never fires on exactly the short runs that need it most.
 *
 * Zero for money, and that is not an oversight. A dollar budget is not counted in
 * indivisible steps: a call costs a fraction of a cent, so the fifth-of-a-budget
 * line is always reachable and a floor of "one" would be a floor of one dollar,
 * which is twenty times the whole default budget. Every run would be warned on
 * its first turn and told a dollar was nearly gone when a cent was.
 */
const SMALLEST: Record<CumulativeLimit, number> = {
  turns: 1,
  wallSeconds: 1,
  outputTokens: 1,
  totalTokens: 1,
  costUsd: 0,
};

/** How much of a limit may be left before the agent is told. */
export function warnThreshold(budget: number, at: number = WARN_AT, granular = 1): number {
  const left = budget * (1 - at);
  // For a limit counted in whole things, up to the next whole one. Not fussiness:
  // a fifth of ten is 1.9999999999999996 in binary, so without the rounding a
  // ten-turn budget would not warn until two turns were left instead of three.
  // A dollar budget is not counted in whole things, so it is left alone — one
  // dollar is twenty times the whole default budget.
  return Math.max(granular, granular > 0 ? Math.ceil(left) : left);
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
 *
 * `costUsd` appears only when the run's model has a known price and the run
 * actually has a cost. A model nobody has priced produces a row of `0 of 0.05`
 * that reads as a run which has spent nothing, when the truth is that nothing is
 * measuring it, and those are not the same claim.
 */
export function limitUse(readings: LimitReadings, limits: RunLimits): LimitUse[] {
  const rows: { which: CumulativeLimit; used: number; budget: number }[] = [
    { which: 'turns', used: readings.turns, budget: limits.turns },
    { which: 'wallSeconds', used: Math.round(readings.elapsedSeconds), budget: limits.wallSeconds },
    { which: 'outputTokens', used: readings.totals.completionTokens, budget: limits.outputTokens },
    { which: 'totalTokens', used: readings.totals.billedTokens, budget: limits.totalTokens },
  ];
  const spent = readings.totals.costUsd;
  const costBudget = limits.costUsd;
  if (spent !== null && typeof costBudget === 'number' && costBudget > 0) {
    rows.push({ which: 'costUsd', used: spent, budget: costBudget });
  }
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
      .filter(
        (use) =>
          atOrPast(use.remaining, warnThreshold(use.budget, at, SMALLEST[use.which]), use.budget) &&
          !alreadyWarned.has(use.which),
      )
      // Tightest first, and by the fraction left rather than the count: one turn
      // out of four is more urgent than sixty seconds out of an hour.
      .sort((a, b) => a.remaining / (a.budget || 1) - b.remaining / (b.budget || 1))
  );
}

/** Which limit the run has actually reached, if any. Worst first. */
export function exceeded(uses: LimitUse[]): LimitUse | null {
  const over = uses.filter((use) => atOrPast(use.remaining, 0, use.budget));
  if (over.length === 0) return null;
  return over.sort((a, b) => b.ratio - a.ratio)[0] ?? null;
}

/**
 * How close to a line counts as on it, as a fraction of the budget.
 *
 * Every number here is an estimate: token counts come from the API, prices are
 * published figures, and a cost accumulates through a division by a million. A
 * comparison that lands two parts in ten to the eighteenth away from a line is
 * not a measurement of anything, and both directions were wrong without this.
 *
 * Measured: a five-cent budget spent in one-cent calls never warned at all. A
 * fifth of five cents is 0.009999999999999998, and the cent that was left when
 * the warning was due is 0.010000000000000002, so "a fifth or less left" was
 * false by two quadrillionths. And the stop, which asks whether anything at all
 * is left, could be held off past the budget by the same slop — in the one
 * direction that spends money nobody granted.
 */
const EDGE = 1e-9;

/**
 * Whether a figure is at or past a line, within the noise of the arithmetic.
 *
 * The tolerance leans the way a budget has to: at or past the line means stop,
 * so the worst a rounding error can do is end a run a billionth of a unit early.
 */
function atOrPast(value: number, line: number, budget: number): boolean {
  return value <= line + Math.abs(budget) * EDGE;
}

/** `1400 of 2000`, with both numbers rounded for a human. */
export function describeLimit(use: LimitUse, unit = ''): string {
  return `${formatLimit(use.which, use.used)} of ${formatLimit(use.which, use.budget)}${unit}`;
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

/**
 * A number in the unit its limit is counted in.
 *
 * Turns, seconds and tokens round to whole things, and a cost does not: rounding
 * four tenths of a cent to the nearest whole number gives zero, so a run that
 * had spent three cents would be described as having spent none.
 *
 * Takes any name, not just the cumulative ones: a run can stop at
 * `contextTokens` or `askSeconds` too, and a caller holding one of those should
 * get a number rather than a type error.
 */
export function formatLimit(which: CumulativeLimit | string, value: number): string {
  return which === 'costUsd' ? formatUsd(value) : format(value);
}

/**
 * Dollars, at a fixed number of decimal places for the size of the number.
 *
 * Fixed rather than trimmed, because these get read in columns and against each
 * other: `$0.050` next to `$0.032` compares in one glance, where `$0.05` next to
 * `$0.032` makes the reader count digits. Never in exponent notation either — a
 * run that has spent a hundredth of a cent is `$0.0001`, not `1e-4`.
 */
export function formatUsd(value: number): string {
  if (value === 0) return '$0';
  if (value >= 1) return `$${value.toFixed(2)}`;
  // Under a dollar the cents are the interesting part, and under a cent even
  // they are gone: a tenth of a cent is $0.001, which is a real amount here and
  // not the $0.00 it would round to at two places.
  return `$${value >= 0.01 ? value.toFixed(3) : value.toFixed(4)}`;
}
