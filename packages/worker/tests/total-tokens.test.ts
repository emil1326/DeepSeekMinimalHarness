/**
 * The token budget, which is the only bound on what a run costs.
 *
 * `outputTokens` counts what the model *wrote*. A tool-using run's bill is
 * mostly the prompt it reads back every turn — the conversation, plus every
 * file it has read, re-sent on each call — and nothing capped that. So a run
 * that keeps working was bounded by nothing but turns and wall clock, which is
 * why `totalTokens` exists.
 *
 * Both tests below drive the same loop; the only difference is which limit is
 * tighter. That is the point: the new one has to fire on prompt weight, and the
 * old one still has to fire on its own, or one of them is not doing anything.
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
 * Turns that read the same file and never finish, so the loop keeps going until
 * a limit stops it. The fake server's default usage is 1,000 prompt tokens and
 * 50 completion tokens per call.
 */
function endlessTurns(count: number): ScriptedTurn[] {
  return Array.from({ length: count }, () => ({
    text: 'looking again',
    toolCalls: [{ name: 'read_file', args: { path: 'src/a.ts' } }],
  }));
}

async function drive(task: Record<string, unknown>): Promise<RunEventBody[]> {
  const server = await startFakeDeepSeek(endlessTurns(12));
  const config = fixture.writeTask(`tokens-${Math.random().toString(36).slice(2)}`, task);
  const sandbox = new Sandbox({
    root: fixture.repo,
    allow: config.allow,
    profile: config.resolvedProfile,
    checkNames: config.checks,
  });
  const client = new DeepSeekClient({ apiKey: 'test-key', baseUrl: server.url });
  const events: RunEventBody[] = [];
  await runAgentLoop({ sandbox, client, config, emit: (body) => events.push(body) }, idleControl());
  return events;
}

function limitOf(events: RunEventBody[]): { which: string; detail: string } | null {
  const limit = events.find((event) => event.type === 'limit');
  return limit?.type === 'limit' ? { which: limit.which, detail: limit.detail } : null;
}

function lastTotals(events: RunEventBody[]): { promptTokens: number; completionTokens: number } | null {
  const metrics = events.filter((event) => event.type === 'metrics');
  const last = metrics[metrics.length - 1];
  return last?.type === 'metrics'
    ? { promptTokens: last.totals.promptTokens, completionTokens: last.totals.completionTokens }
    : null;
}

describe('the total token budget', () => {
  it('stops a run on prompt weight alone, before it has written anything much', async () => {
    const events = await drive({
      allow: ['src/a.ts'],
      task: 'read the file until you are told to stop',
      limits: { turns: 10, wallSeconds: 900, totalTokens: 3000 },
    });

    const limit = limitOf(events);
    expect(limit?.which).toBe('totalTokens');
    expect(limit?.detail).toContain('3000');

    // Three calls of 1,000 prompt tokens each land past 3,000, and the check
    // runs before the fourth. So the run stopped having written 150 tokens in
    // all — nowhere near the 40,000 `outputTokens` would have allowed. Without
    // the new limit this run had ten turns to go.
    const totals = lastTotals(events);
    expect(totals?.promptTokens).toBe(3000);
    expect(totals?.completionTokens).toBe(150);
    expect(totals?.completionTokens ?? 0).toBeLessThan(40_000);

    const calls = events.filter((event) => event.type === 'metrics');
    expect(calls).toHaveLength(3);
  });

  it('leaves the output limit to fire on its own, so neither check hides the other', async () => {
    const events = await drive({
      allow: ['src/a.ts'],
      task: 'read the file until you are told to stop',
      // Room for any amount of prompt, and a very small output allowance.
      limits: { turns: 10, wallSeconds: 900, totalTokens: 100_000, outputTokens: 100 },
    });

    const limit = limitOf(events);
    expect(limit?.which).toBe('outputTokens');
    expect(limit?.detail).toContain('100');

    // 50 completion tokens a call: two calls reach 100, and the third is refused.
    expect(lastTotals(events)?.completionTokens).toBe(100);
    expect(events.filter((event) => event.type === 'metrics')).toHaveLength(2);
  });

  it('defaults to a figure that only a runaway reaches', async () => {
    const events = await drive({
      allow: ['src/a.ts'],
      task: 'read the file twice and stop',
      limits: { turns: 2, wallSeconds: 900 },
    });

    // Two turns of the default fake usage is 2,100 tokens, so the default
    // 2,000,000 budget is not what stopped this; the turn limit was.
    expect(limitOf(events)?.which).toBe('turns');
  });
});
