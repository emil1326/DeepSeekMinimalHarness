/**
 * The dollar budget: what a run may spend, which is the limit a person means.
 *
 * Turns and tokens are proxies for a bill, and they are poor ones. A run that
 * reads a large file and a run that reads a small one cost the same number of
 * turns and wildly different amounts of money, and the price of a token depends
 * on the hour and on whether that token was served from the prompt cache. Five
 * cents is the default, so a task that never thought about money cannot burn a
 * balance, and the agent is told before it gets there.
 *
 * These tests drive the real loop against the fake server, with a flat price
 * table of their own rather than the published one: the published prices are
 * peak in the morning and off peak at night, so a test that used them would pass
 * or fail depending on when it ran.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DeepSeekClient, Sandbox, type RunEventBody, type Speaker } from '@emilswork/harness-core';
import { runAgentLoop, type LoopControl } from '@emilswork/harness-worker';
import { startFakeDeepSeek, type ScriptedTurn } from '../../core/tests/fake-server.js';
import { createFixture } from './fixture.js';

const fixture = createFixture();
afterAll(() => fixture.cleanup());
beforeEach(() => fixture.reset());

/** Nothing here asks, cancels or sends; those have their own tests. */
function idleControl(): LoopControl {
  return {
    signal: new AbortController().signal,
    takeMessages: (): { text: string; by: Speaker }[] => [],
    waitForAnswer: (): Promise<{ text: string; by: Speaker } | null> => Promise.resolve(null),
  };
}

/**
 * One cent a call, exactly.
 *
 * The fake server's usage is 1,000 prompt and 50 completion tokens a call, none
 * of it cached, so a dollar per million fresh tokens and 180 a million written
 * is a penny a call — which is what makes the arithmetic in the tests below
 * readable rather than a set of magic numbers.
 */
const ONE_CENT_A_CALL = { 'deepseek-flash': { inputPerMillion: 1, outputPerMillion: 180 } };

/** Turns that read the same file and never finish, until a limit stops them. */
function endlessTurns(count: number): ScriptedTurn[] {
  return Array.from({ length: count }, () => ({
    text: 'looking again',
    toolCalls: [{ name: 'read_file', args: { path: 'src/a.ts' } }],
  }));
}

async function drive(
  task: Record<string, unknown>,
  turns: ScriptedTurn[] = endlessTurns(12),
  prices?: Record<string, { inputPerMillion: number; cacheHitPerMillion?: number; outputPerMillion: number }>,
): Promise<RunEventBody[]> {
  const server = await startFakeDeepSeek(turns);
  const config = fixture.writeTask(`cost-${Math.random().toString(36).slice(2)}`, task);
  const sandbox = new Sandbox({
    root: fixture.repo,
    allow: config.allow,
    profile: config.resolvedProfile,
    checkNames: config.checks,
  });
  const client = new DeepSeekClient({ apiKey: 'test-key', baseUrl: server.url });
  const events: RunEventBody[] = [];
  await runAgentLoop(
    { sandbox, client, config, emit: (body) => events.push(body), ...(prices ? { prices } : {}) },
    idleControl(),
  );
  return events;
}

const limits = (events: RunEventBody[]): Extract<RunEventBody, { type: 'limit' }>[] =>
  events.filter((event): event is Extract<RunEventBody, { type: 'limit' }> => event.type === 'limit');

const warnings = (events: RunEventBody[]): Extract<RunEventBody, { type: 'warning' }>[] =>
  events.filter((event): event is Extract<RunEventBody, { type: 'warning' }> => event.type === 'warning');

function lastCost(events: RunEventBody[]): number | null {
  const metrics = events.filter((event) => event.type === 'metrics');
  const last = metrics[metrics.length - 1];
  return last?.type === 'metrics' ? last.totals.costUsd : null;
}

const calls = (events: RunEventBody[]): number => events.filter((event) => event.type === 'metrics').length;

describe('the dollar budget', () => {
  it('stops a run that has spent it, and says how much', async () => {
    const events = await drive(
      {
        allow: ['src/a.ts'],
        task: 'read the file until you are told to stop',
        // A penny a call, so the third call would go over a two-cent budget.
        limits: { turns: 10, wallSeconds: 900, costUsd: 0.02 },
      },
      endlessTurns(12),
      ONE_CENT_A_CALL,
    );

    const limit = limits(events)[0];
    expect(limit?.which).toBe('costUsd');
    expect(limit?.used).toBeCloseTo(0.02, 6);
    expect(limit?.budget).toBe(0.02);
    expect(limit?.detail).toContain('$0.020');
    // The check runs before the call that would break the budget, so the run
    // stopped having spent exactly what it was allowed — not one call past it.
    expect(calls(events)).toBe(2);
    expect(lastCost(events)).toBeCloseTo(0.02, 6);
  });

  it('warns the agent while there is still a turn to act in', async () => {
    const events = await drive(
      {
        allow: ['src/a.ts'],
        task: 'read the file until you are told to stop',
        limits: { turns: 10, wallSeconds: 900, costUsd: 0.05 },
      },
      endlessTurns(12),
      ONE_CENT_A_CALL,
    );

    // Four cents spent of five leaves one, which is a fifth and so the line.
    expect(warnings(events).map((warning) => warning.which)).toEqual(['costUsd']);
    const warning = warnings(events)[0];
    expect(warning?.detail).toContain('$0.010 left of $0.050');
    expect(warning?.detail).toContain('$0.040 already used');
    expect(warning?.detail).toContain('call ask');
    // Told before the call it could still afford, and stopped before the one it
    // could not: five calls spent the budget and the sixth never happened.
    expect(calls(events)).toBe(5);
    expect(limits(events)[0]?.which).toBe('costUsd');
  });

  it('does not say a dollar is nearly gone when a cent is', async () => {
    // The regression this exists to catch. Every other limit is counted in whole
    // things and rounds up to one of them, so that even a four-turn budget warns
    // — one turn left out of four is nearly over. A dollar is not counted in
    // whole things, and with that floor of one, the four cents left of a fresh
    // five-cent budget was "one unit left": every run was warned on its first
    // turn and told a dollar was nearly gone when a cent was.
    const events = await drive(
      {
        allow: ['src/a.ts'],
        task: 'read the file until you are told to stop',
        limits: { turns: 10, wallSeconds: 900, costUsd: 0.05 },
      },
      endlessTurns(12),
      ONE_CENT_A_CALL,
    );

    const at = events.findIndex((event) => event.type === 'warning' && event.which === 'costUsd');
    expect(at).toBeGreaterThanOrEqual(0);
    const warning = events[at];
    // Five cents less a fifth is four, so the warning comes once four calls have
    // been paid for — not after the first one, which is where a floor of one
    // puts it.
    expect(warning?.type === 'warning' && warning.used).toBeCloseTo(0.04, 6);
    expect(events.slice(0, at).filter((event) => event.type === 'metrics')).toHaveLength(4);
  });

  it('cannot measure a model nobody has priced, and does not pretend to', async () => {
    const events = await drive({
      allow: ['src/a.ts'],
      task: 'read the file until you are told to stop',
      model: 'some-other-vendors-model',
      // A budget too small to make one call, on a model with no price: if the
      // harness treated an unknown cost as zero it would stop immediately.
      limits: { turns: 3, wallSeconds: 900, costUsd: 0.000001 },
    });

    expect(calls(events)).toBe(3);
    expect(limits(events)[0]?.which).toBe('turns');
    expect(lastCost(events)).toBeNull();
  });

  it('counts cache hits at the cache rate, which is the whole point of a cache', async () => {
    const events = await drive(
      {
        allow: ['src/a.ts'],
        task: 'answer and stop',
        limits: { turns: 3, wallSeconds: 900, costUsd: 5 },
      },
      [{ text: 'done', promptTokens: 1000, cacheHitTokens: 900, completionTokens: 0 }],
      // A tenth of a miss. The real table is a fiftieth on Flash, and the point
      // is the same either way: a cached token must not be billed as a fresh
      // one. That mistake, on the token budget, is what killed seven real runs.
      { 'deepseek-flash': { inputPerMillion: 1, cacheHitPerMillion: 0.1, outputPerMillion: 1 } },
    );

    // 100 fresh at $1/M is $0.0001, and the 900 cached ones at a tenth of that
    // are $0.00009. Billed as fresh they would have been $0.0009 — ten times as
    // much for the part that never reached the model as new text.
    expect(lastCost(events)).toBeCloseTo(0.00019, 9);
  });
});
