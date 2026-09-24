/**
 * What a call costs, from DeepSeek's published prices.
 *
 * The harness already recorded a cost, but only when somebody had typed a price
 * table into `config.json` by hand, and nobody ever did: the seeded config is
 * `{"prices": {}}`, so every run reported no cost at all. A budget you cannot
 * measure is not a budget, and "how much has this run spent" is the first
 * question anybody asks about an agent that is going to make forty model calls
 * on its own. So the published prices live here, and `config.json` is the
 * override rather than the only source.
 *
 * The prices are per million tokens and they are **not** one number per model:
 * DeepSeek charges half during off-peak hours, and it charges a separate, much
 * lower rate for input that was served from its prompt cache. Fresh input, the
 * cheapest thing you can do is hit the cache: a hit is a fiftieth of a miss on
 * Flash and a thirtieth on Pro.
 *
 * All three figures are needed to be right, and getting the cache one wrong is
 * exactly the mistake that killed seven real runs on this machine — a
 * `totalTokens` ceiling that counted cache hits at the price of a miss. See
 * `RunTotals.billedTokens`.
 */

import type { Price, PriceTable } from './metrics.js';

/** A price that depends on the hour, which DeepSeek's does. */
export interface TimedPrice {
  peak: Price;
  offPeak: Price;
}

/**
 * Peak hours in UTC, straight off the pricing page: 01:00–04:00 and 06:00–10:00,
 * Monday to Friday. Everything else is off peak — every night, every weekend —
 * and off peak is exactly half of peak.
 *
 * Chinese public holidays are off peak in full as well, and are deliberately not
 * modelled: the list changes every year and shipping a stale one would be worse
 * than not having it. The consequence is that on roughly ten days a year, calls
 * made in the peak windows here are priced at the peak rate when the bill will
 * actually be half. Every estimate this produces is therefore a little too high,
 * which is the direction that keeps a budget useful.
 */
export const PEAK_HOURS_UTC: readonly (readonly [number, number])[] = [
  [1, 4],
  [6, 10],
];

/** Whether a moment falls in one of the peak windows. */
export function atPeak(at: Date): boolean {
  const day = at.getUTCDay();
  // 0 is Sunday and 6 is Saturday, and both are off peak whatever the hour.
  if (day === 0 || day === 6) return false;
  const hour = at.getUTCHours() + at.getUTCMinutes() / 60;
  return PEAK_HOURS_UTC.some(([from, to]) => hour >= from && hour < to);
}

/**
 * The published prices, per million tokens.
 *
 * Behind `config.json` rather than in front of it: a model named here can still
 * be priced by hand, which is what to do the moment DeepSeek changes a number or
 * adds a model, without waiting for a release.
 */
export const BUILTIN_PRICES: Record<string, TimedPrice> = {
  'deepseek-flash': {
    peak: { inputPerMillion: 0.3, cacheHitPerMillion: 0.006, outputPerMillion: 1.2 },
    offPeak: { inputPerMillion: 0.15, cacheHitPerMillion: 0.003, outputPerMillion: 0.6 },
  },
  'deepseek-v4-pro': {
    peak: { inputPerMillion: 1.32, cacheHitPerMillion: 0.044, outputPerMillion: 3.96 },
    offPeak: { inputPerMillion: 0.66, cacheHitPerMillion: 0.022, outputPerMillion: 1.98 },
  },
};

/**
 * Retired model names the API still accepts, and what they are billed as.
 *
 * DeepSeek answers to `deepseek-v4-flash` and bills it at the Flash price, so a
 * task file using the old name gets a cost rather than a blank.
 */
const ALIASES: Record<string, string> = {
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
};

/**
 * The price of one call to `model` at one moment.
 *
 * A price written into `config.json` wins outright. That is not just precedence
 * for its own sake: a hand-written price is a flat number and the person who
 * wrote it may have meant exactly that, and silently blending it with a peak
 * table would produce something neither of them said.
 *
 * Returns undefined for a model nobody knows, which is the one case where a cost
 * cannot be computed and the honest answer is "no cost" rather than zero.
 */
export function priceFor(model: string, at: string | number | Date, table?: PriceTable): Price | undefined {
  const configured = table?.[model];
  if (configured !== undefined) return configured;
  const timed = BUILTIN_PRICES[ALIASES[model] ?? model];
  if (timed === undefined) return undefined;
  return atPeak(momentOf(at)) ? timed.peak : timed.offPeak;
}

/**
 * A moment, or the peak rate if the moment cannot be read.
 *
 * A timestamp that will not parse is a bug somewhere, and the two ways of
 * guessing are not equal: pricing it off peak gives an estimate that looks
 * cheaper than the bill, which is how somebody ends up surprised by one.
 */
function momentOf(at: string | number | Date): Date {
  const date = at instanceof Date ? at : new Date(at);
  // At the epoch, which is a Thursday, the peak test is false either way, so an
  // unreadable moment is priced at the peak rate by being handed a peak hour.
  return Number.isNaN(date.getTime()) ? new Date(Date.UTC(2026, 0, 5, 2, 0)) : date;
}
