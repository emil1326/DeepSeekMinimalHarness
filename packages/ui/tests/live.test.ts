/**
 * How a run's events are accumulated, and why it is a map.
 *
 * The chat updates five times a second rather than once a turn because it streams
 * now — see `packages/ui/src/live.ts`. Three sources feed it and **they overlap**,
 * which is the whole reason this is worth a test rather than a comment:
 *
 *   - the `hello` message, carrying the log up to the moment of connecting, capped
 *     at the store's page size;
 *   - the pages fetched past that cap, because the cap is smaller than the longest
 *     run in the database;
 *   - the live events, which start arriving while those pages are still coming.
 *
 * So the same event can arrive twice and the order they arrive in is not the order
 * they happened in. An array would need de-duplication and a sort keyed on
 * something; a `Map` keyed on `seq` makes a duplicate impossible by construction,
 * and `seq` is already the order — it is what the store numbers events with.
 */

import { describe, expect, it } from 'vitest';
import { EventLog } from '../src/live';
import type { RunEvent } from '../src/types';

/** An event with nothing in it but the number, which is all this cares about. */
function at(seq: number): RunEvent {
  return {
    seq,
    runId: 'run-test',
    at: '2026-01-01T00:00:00.000Z',
    type: 'text.delta',
    turn: 1,
    text: `#${seq}`,
  };
}

const seqs = (log: EventLog): number[] => log.ordered().map((event) => event.seq);

describe('accumulating a run’s events', () => {
  it('orders by seq, whatever order they arrived in', () => {
    const log = new EventLog();
    log.merge([at(3), at(1)]);
    log.merge([at(2)]);
    expect(seqs(log)).toEqual([1, 2, 3]);
  });

  it('ignores an event it already has, and says whether anything was new', () => {
    // The return value is the point: it is what stops a flush from re-rendering
    // the conversation when a duplicate arrived and nothing actually changed.
    const log = new EventLog();
    expect(log.merge([at(1), at(2)])).toBe(true);
    expect(log.merge([at(1), at(2)])).toBe(false);
    expect(log.merge([at(2), at(3)])).toBe(true);
    expect(seqs(log)).toEqual([1, 2, 3]);
    expect(log.size).toBe(3);
  });

  it('survives the overlap that actually happens', () => {
    // The real sequence of a long run, in order: the hello arrives capped at 5,
    // one live event slips in while the top-up is being fetched, then the top-up
    // brings 3..9 — so 3, 4 and 5 arrive twice, and 10 was never in a page.
    const log = new EventLog();
    log.merge([1, 2, 3, 4, 5].map(at));
    log.merge([10].map(at));
    log.merge([3, 4, 5, 6, 7, 8, 9].map(at));
    expect(seqs(log)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('reports the highest seq as where an incremental read starts', () => {
    // 0 when nothing has arrived, so the first read asks for the whole log rather
    // than needing a special case at the call site.
    const log = new EventLog();
    expect(log.highest).toBe(0);
    log.merge([at(7)]);
    expect(log.highest).toBe(7);
    log.merge([at(3)]);
    expect(log.highest).toBe(7);
  });

  it('is empty until something arrives, rather than starting with a placeholder', () => {
    const log = new EventLog();
    expect(log.size).toBe(0);
    expect(log.ordered()).toEqual([]);
    expect(log.highest).toBe(0);
  });
});
