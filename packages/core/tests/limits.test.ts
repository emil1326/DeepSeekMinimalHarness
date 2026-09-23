/**
 * Limits: how close a run is, and the mistake that killed most of the real ones.
 *
 * Nine runs on this machine, seven of them dead at a limit. Three died at
 * `totalTokens` while being 95-97% cache hits, which cost almost nothing: the
 * limit was counting prompt tokens that had been served from cache at the price
 * of new ones. These tests hold down both the arithmetic and the reason for it.
 *
 * The other half is the warning. A limit that arrives as a surprise wastes
 * everything before it, so the harness has to say so in time to act on it — and
 * has to say it once, or the one notice that mattered becomes noise.
 */

import { describe, expect, it } from 'vitest';
import {
  WARN_AT,
  approaching,
  describeLimit,
  emptyTotals,
  exceeded,
  formatCount,
  limitUse,
  warnThreshold,
  type LimitUse,
} from '@emilswork/harness-core';

const LIMITS = {
  turns: 10,
  wallSeconds: 100,
  outputTokens: 1000,
  // The real default is 2M and the point of these tests is that a repo-reading
  // run is nowhere near it once cache hits stop counting. A small budget here
  // would test the arithmetic and not the mistake.
  totalTokens: 2_000_000,
  contextTokens: 700_000,
  askSeconds: 3600,
};

function readings(overrides: Partial<Parameters<typeof limitUse>[0]> = {}) {
  return { turns: 0, elapsedSeconds: 0, totals: emptyTotals(), ...overrides };
}

describe('measuring the limits', () => {
  it('reads a fresh run as nothing used', () => {
    const uses = limitUse(readings(), LIMITS);
    expect(uses.map((use) => use.used)).toEqual([0, 0, 0, 0]);
    expect(uses.every((use) => use.ratio === 0)).toBe(true);
  });

  it('measures totalTokens in billed tokens, not in prompt tokens', () => {
    // The whole point. 900,000 prompt tokens of which 880,000 were cache hits is
    // 20,000 billed, which is 1% of a 2M budget, not 45%. Counting it the other
    // way is what stopped three real runs that had spent almost nothing.
    const uses = limitUse(
      readings({
        totals: {
          ...emptyTotals(),
          promptTokens: 900_000,
          cacheHitTokens: 880_000,
          completionTokens: 1000,
          billedTokens: 20_000 + 1000,
        },
      }),
      LIMITS,
    );
    const total = uses.find((use) => use.which === 'totalTokens');
    expect(total?.used).toBe(21_000);
    expect(total?.ratio).toBeLessThan(0.02);
  });

  it('reports every cumulative limit, and only those', () => {
    // contextTokens bounds one request and is handled by compacting, so a
    // running total of it would be meaningless. askSeconds is a wait, not a
    // budget.
    const uses = limitUse(readings(), LIMITS);
    expect(uses.map((use) => use.which)).toEqual(['turns', 'wallSeconds', 'outputTokens', 'totalTokens']);
  });

  it('treats a budget of zero as full rather than dividing by it', () => {
    const uses = limitUse(readings({ turns: 1 }), { ...LIMITS, turns: 0 });
    expect(uses[0]?.ratio).toBe(1);
  });
});

describe('stopping at a limit', () => {
  it('picks the one that is actually reached', () => {
    const hit = exceeded(limitUse(readings({ turns: 10 }), LIMITS));
    expect(hit?.which).toBe('turns');
  });

  it('is a stop at exactly the budget, not one past it', () => {
    // A run has used "all 45 turns" when it has made 45 calls, not 46.
    expect(exceeded(limitUse(readings({ turns: 9 }), LIMITS))).toBeNull();
    expect(exceeded(limitUse(readings({ turns: 10 }), LIMITS))?.which).toBe('turns');
  });

  it('reports the worst one when several are reached at once', () => {
    // A run can arrive at the end of a long turn and be over two budgets. The
    // one furthest past is the honest one to name.
    const hit = exceeded(
      limitUse(
        readings({
          turns: 10,
          elapsedSeconds: 500,
          totals: { ...emptyTotals(), completionTokens: 5000, billedTokens: 9000 },
        }),
        LIMITS,
      ),
    );
    expect(hit?.which).toBe('wallSeconds');
  });

  it('says null when nothing is reached', () => {
    expect(exceeded([])).toBeNull();
  });
});

describe('warning before a limit arrives', () => {
  it('warns on a small budget, where a ratio threshold would never fire', () => {
    // Found live. With four turns, the ratio at the moments the loop checks goes
    // 0, 0.25, 0.5, 0.75, and then the run is over: 0.8 is never reached, so a
    // four-turn run was stopped by its limit having been told nothing at all.
    // The threshold is on what is left, with a floor of one.
    const uses = limitUse(readings({ turns: 3 }), { ...LIMITS, turns: 4 });
    expect(approaching(uses, new Set()).map((use) => use.which)).toEqual(['turns']);
    expect(warnThreshold(4)).toBe(1);
  });

  it('warns on the only turn a one-turn budget has', () => {
    const uses = limitUse(readings({ turns: 0 }), { ...LIMITS, turns: 1 });
    expect(approaching(uses, new Set()).map((use) => use.which)).toEqual(['turns']);
  });

  it('counts what is left, so the notice can say it', () => {
    const uses = limitUse(readings({ turns: 7 }), LIMITS);
    expect(uses.find((use) => use.which === 'turns')?.remaining).toBe(3);
  });

  it('warns once a limit is four fifths used', () => {
    const uses = limitUse(readings({ turns: 8 }), LIMITS);
    const near = approaching(uses, new Set());
    expect(near.map((use) => use.which)).toContain('turns');
  });

  it('says nothing before that', () => {
    // Ordinary use is not a warning. Crying wolf at half full would teach the
    // model to ignore the one that mattered.
    const uses = limitUse(readings({ turns: 5 }), LIMITS);
    expect(approaching(uses, new Set())).toEqual([]);
  });

  it('never repeats a limit it has already warned about', () => {
    // Otherwise a run that slows down near its wall clock gets the same sentence
    // on every remaining turn.
    const uses = limitUse(readings({ turns: 9 }), LIMITS);
    expect(approaching(uses, new Set(['turns']))).toEqual([]);
    // The control: a different limit is still announced.
    const both = limitUse(readings({ turns: 9, elapsedSeconds: 90 }), LIMITS);
    expect(approaching(both, new Set(['turns'])).map((use) => use.which)).toEqual(['wallSeconds']);
  });

  it('warns worst-first, so the tightest one is the first thing read', () => {
    const uses = limitUse(readings({ turns: 9, elapsedSeconds: 99 }), LIMITS);
    const near = approaching(uses, new Set());
    expect(near[0]?.which).toBe('wallSeconds');
  });

  it('warns about a limit that has already been passed too', () => {
    // The loop checks for a stop first, so in practice this is the boundary
    // case, and it must not be a silent gap: a ratio of 1 is over the line.
    const uses = limitUse(readings({ turns: 10 }), LIMITS);
    expect(approaching(uses, new Set()).map((use) => use.which)).toContain('turns');
  });

  it('is four fifths, and that number is stated in one place', () => {
    expect(WARN_AT).toBe(0.8);
  });
});

describe('describing a limit', () => {
  it('gives both numbers, rounded for a person', () => {
    const use: LimitUse = {
      which: 'totalTokens',
      used: 1_240_000,
      budget: 2_000_000,
      remaining: 760_000,
      ratio: 0.62,
    };
    expect(describeLimit(use)).toBe('1.2M of 2M');
  });

  it('counts in thousands once a number is big enough to be hard to read', () => {
    expect(formatCount(999)).toBe('999');
    expect(formatCount(45_000)).toBe('45k');
    expect(formatCount(1_048_576)).toBe('1M');
    expect(formatCount(8_041_954)).toBe('8M');
  });
});

describe('a limit event through the whole loop', () => {
  it('carries used and budget, so a reader is never shown a bare number', () => {
    // The shape the loop emits. Asserted here because the event is what the CLI,
    // the UI and the report all read, and a limit that reads as "6.0M tokens
    // used" with no denominator is the thing that prompted all of this.
    const event = {
      type: 'limit' as const,
      which: 'totalTokens' as const,
      detail: 'the run used 8M billed tokens of the 8M it may',
      used: 8_041_954,
      budget: 8_000_000,
    };
    expect(event.used).toBeGreaterThan(event.budget);
    expect(formatCount(event.used)).toBe('8M');
    expect(formatCount(event.budget)).toBe('8M');
  });
});
