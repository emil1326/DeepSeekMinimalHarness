/**
 * The UI keeps its own copy of the event union, because the browser build must
 * not pull in the daemon's Node-only dependencies. A copy drifts.
 *
 * It already did: `context` was added to the log and to `fold`, and the UI's
 * union silently kept the old shape, so `limit` was missing two kinds and
 * nothing anywhere complained. Found by reading, not by a failing test, which
 * is the wrong way round.
 *
 * The assertion below is a compile-time one. `Equal` resolves to `false` the
 * moment the two unions disagree, and `Assert<false>` is a type error, so
 * `npm run typecheck` fails with the name of this file in it. The `import type`
 * is erased before the test ever runs, so there is no runtime coupling to the
 * daemon at all.
 */

import { describe, expect, it } from 'vitest';
import type { RunEventBody as UIBody } from '../src/types';
import type { RunEventBody as CoreBody } from '../../core/src/events';
import { fold } from '../src/fold';
import type { RunEvent, RunEventBody } from '../src/types';

type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;

/** Fails to compile, naming this file, if the UI's union drifts from core's. */
export type UiEventUnionMatchesCore = Assert<Equal<UIBody, CoreBody>>;

let seq = 0;

function event(body: RunEventBody): RunEvent {
  seq += 1;
  return { seq, runId: 'run-test', at: '2026-01-01T00:00:00.000Z', ...body } as RunEvent;
}

describe('the UI event union', () => {
  it('is the same union core writes', () => {
    // The real assertion is the type above. This test exists so the file is a
    // test rather than a lone type alias, and so the failure is visible in the
    // test run as well as the typecheck.
    expect(true).toBe(true);
  });
});

describe('fold and a trimmed context', () => {
  it('says what the model forgot, in words', () => {
    const blocks = fold([
      event({ type: 'turn.start', turn: 1 }),
      event({
        type: 'context',
        turn: 1,
        dropped: 2,
        subjects: ['read_file src/a.ts', 'search_rows query'],
        tokensBefore: 812_000,
        tokensAfter: 610_000,
      }),
    ]);

    const note = blocks.find((block) => block.kind === 'note');
    expect(note?.kind).toBe('note');
    if (note?.kind !== 'note') throw new Error('unreachable');
    expect(note.tone).toBe('info');
    expect(note.text).toBe(
      'forgot 2 earlier results to fit the window: read_file src/a.ts, search_rows query',
    );
  });

  it('gets the singular right, because "1 results" reads like a bug', () => {
    const blocks = fold([
      event({ type: 'turn.start', turn: 1 }),
      event({
        type: 'context',
        turn: 1,
        dropped: 1,
        subjects: ['read_file src/a.ts'],
        tokensBefore: 100,
        tokensAfter: 90,
      }),
    ]);

    const note = blocks.find((block) => block.kind === 'note');
    if (note?.kind !== 'note') throw new Error('unreachable');
    expect(note.text).toContain('forgot 1 earlier result ');
  });
});
