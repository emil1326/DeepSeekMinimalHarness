/**
 * What a call costs, which until now was nothing at all.
 *
 * The harness recorded a cost, but only from a price table somebody had to type
 * into `config.json`, and nobody did: the seeded file is `{"prices": {}}`. So
 * every run reported no cost, `dsh stats` had an empty column, and a run could
 * not be given a dollar budget because there was nothing to measure one with.
 *
 * The prices are DeepSeek's, and the three figures all matter. Getting the cache
 * one wrong is not a rounding error: a hit is a fiftieth of a miss on Flash, and
 * a repo-reading run is 95% hits, so a table that charges full price for a cache
 * hit overstates the bill by an order of magnitude. That is the same mistake as
 * `totalTokens` counting cache hits at full price, which killed seven real runs.
 *
 * Peak and off peak are the other half of it. Off peak is exactly half, and it
 * is most of the day, so pricing everything at peak is an estimate that is wrong
 * by 100% — in the direction that stops runs early.
 */

import { describe, expect, it } from 'vitest';
import { BUILTIN_PRICES, PEAK_HOURS_UTC, atPeak, costOf, priceFor } from '@emilswork/harness-core';

/** A Monday in January 2026, so the peak windows are the weekday ones. */
const monday = (hour: number, minute = 0): Date => new Date(Date.UTC(2026, 0, 5, hour, minute));
const saturday = (hour: number, minute = 0): Date => new Date(Date.UTC(2026, 0, 10, hour, minute));

describe('when a call is billed', () => {
  it('reads a Monday as a Monday, so the rest of these tests mean something', () => {
    expect(monday(2).getUTCDay()).toBe(1);
    expect(saturday(2).getUTCDay()).toBe(6);
  });

  it('is peak in the two windows on a weekday', () => {
    // 01:00–04:00 and 06:00–10:00 UTC, from the pricing page.
    expect(PEAK_HOURS_UTC).toEqual([
      [1, 4],
      [6, 10],
    ]);
    for (const hour of [1, 2, 3, 6, 7, 8, 9]) expect(atPeak(monday(hour))).toBe(true);
  });

  it('is off peak in the hour between them, which is the easy one to get wrong', () => {
    // Five in the morning is a gap, not an oversight. A single window of
    // 01:00–10:00 would have priced every call in it at double.
    expect(atPeak(monday(4))).toBe(false);
    expect(atPeak(monday(5))).toBe(false);
    expect(atPeak(monday(10))).toBe(false);
  });

  it('is off peak at the minute the window opens and closes', () => {
    expect(atPeak(monday(0, 59))).toBe(false);
    expect(atPeak(monday(1, 0))).toBe(true);
    expect(atPeak(monday(3, 59))).toBe(true);
    expect(atPeak(monday(4, 0))).toBe(false);
    expect(atPeak(monday(9, 59))).toBe(true);
    expect(atPeak(monday(10, 0))).toBe(false);
  });

  it('is off peak all weekend, whatever the hour', () => {
    for (const hour of [1, 2, 6, 9]) expect(atPeak(saturday(hour))).toBe(false);
  });
});

describe('pricing a model', () => {
  it('halves everything off peak, which is what the price list says', () => {
    for (const [name, timed] of Object.entries(BUILTIN_PRICES)) {
      expect(timed.offPeak.inputPerMillion, name).toBeCloseTo(timed.peak.inputPerMillion / 2, 10);
      expect(timed.offPeak.cacheHitPerMillion, name).toBeCloseTo(
        (timed.peak.cacheHitPerMillion ?? 0) / 2,
        10,
      );
      expect(timed.offPeak.outputPerMillion, name).toBeCloseTo(timed.peak.outputPerMillion / 2, 10);
    }
  });

  it('charges a fiftieth for a cache hit on flash, which is why billing one at full price was so wrong', () => {
    const flash = BUILTIN_PRICES['deepseek-flash'];
    expect(flash?.peak.cacheHitPerMillion).toBe(0.006);
    expect(flash?.peak.inputPerMillion).toBe(0.3);
    expect((flash?.peak.inputPerMillion ?? 0) / (flash?.peak.cacheHitPerMillion ?? 1)).toBe(50);
  });

  it('picks the window from the moment of the call', () => {
    const peak = priceFor('deepseek-flash', monday(2));
    const off = priceFor('deepseek-flash', monday(2 + 12));
    expect(peak?.outputPerMillion).toBe(1.2);
    expect(off?.outputPerMillion).toBe(0.6);
  });

  it('prices a retired name at the price of the model that answers to it', () => {
    // DeepSeek still accepts `deepseek-v4-flash` and bills it as Flash, so a
    // task file using the old name gets a cost rather than a blank.
    expect(priceFor('deepseek-v4-flash', monday(2))).toEqual(priceFor('deepseek-flash', monday(2)));
  });

  it('lets config.json override it outright, and does not blend the two', () => {
    // A hand-written price is a flat number. Averaging it with the peak table
    // would produce a figure neither the file nor the price list states.
    const mine = { inputPerMillion: 9, outputPerMillion: 9 };
    expect(priceFor('deepseek-flash', monday(2), { 'deepseek-flash': mine })).toEqual(mine);
    expect(priceFor('deepseek-flash', saturday(2), { 'deepseek-flash': mine })).toEqual(mine);
  });

  it('prices a model the table has never heard of from that same table', () => {
    const mine = { inputPerMillion: 7, outputPerMillion: 8 };
    expect(priceFor('my-own-model', monday(2), { 'my-own-model': mine })).toEqual(mine);
  });

  it('has nothing to say about a model nobody has priced', () => {
    expect(priceFor('someone-elses-model', monday(2))).toBeUndefined();
  });

  it('prices an unreadable timestamp at peak, which is the honest direction', () => {
    // An estimate that comes out under the bill is how somebody gets surprised
    // by one, so a timestamp that will not parse is not given the cheap rate.
    expect(priceFor('deepseek-flash', 'not a date')).toEqual(BUILTIN_PRICES['deepseek-flash']?.peak);
    expect(priceFor('deepseek-flash', '')).toEqual(BUILTIN_PRICES['deepseek-flash']?.peak);
    // And the real thing still works, or the test above would pass on a bug.
    expect(priceFor('deepseek-flash', '2026-01-05T01:00:00.000Z')).toEqual(
      BUILTIN_PRICES['deepseek-flash']?.peak,
    );
  });
});

describe('what one call costs', () => {
  /** A million of each kind of token, so the arithmetic reads off the price list. */
  const million = { promptTokens: 1_000_000, cacheHitTokens: 900_000, completionTokens: 1_000_000 };

  it('bills the cache hits at the hit rate and everything else at the miss rate', () => {
    // 100,000 fresh at $0.15, 900,000 cached at $0.003, a million written at $0.60.
    const off = priceFor('deepseek-flash', monday(20));
    expect(costOf(off, million)).toBeCloseTo(0.015 + 0.0027 + 0.6, 10);
    // And the same call in a peak window is exactly twice as much.
    const peak = priceFor('deepseek-flash', monday(2));
    expect(costOf(peak, million)).toBeCloseTo(0.03 + 0.0054 + 1.2, 10);
  });

  it('charges full price when the table has no cache rate at all', () => {
    // A table that does not know about caching must not be read as charging
    // nothing for a cache hit.
    const flat = { inputPerMillion: 1, outputPerMillion: 0 };
    expect(costOf(flat, { promptTokens: 1000, cacheHitTokens: 1000, completionTokens: 0 })).toBeCloseTo(
      0.001,
      12,
    );
  });

  it('is null for a model with no price, rather than zero', () => {
    // Zero is a claim that the run was free. Null is the truth: nothing is
    // measuring it, and the cost limit is left out rather than counted as met.
    expect(costOf(undefined, million)).toBeNull();
  });
});
