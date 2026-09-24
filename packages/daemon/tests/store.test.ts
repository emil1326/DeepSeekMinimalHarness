/**
 * What a run cost, worked out from its own calls when its row does not say.
 *
 * The harness recorded no cost at all until the published prices went into the
 * code, so every run already in `runs.db` carries `costUsd: null` in its stored
 * totals, and nothing rewrites recorded history. Leaving it at that would put a
 * dash in the run list next to a `dsh stats` table that has dollars in it for the
 * same calls — and the two views disagreeing about the same fact is how a reader
 * stops trusting both.
 *
 * The calls are all there, the price table is known, so the amount is knowable.
 * It is filled in only where the row says nothing: a recorded cost was worked out
 * at the prices in force at the time, which is what the run was actually billed.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, emptyTotals, type ResolvedRunConfig } from '@emilswork/harness-core';
import { Store } from '@emilswork/harness-daemon';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-store-'));
// Windows will not unlink a database file while a handle is open, and a failed
// assertion is exactly when a handle does not get closed.
afterAll(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

/** Monday. 02:00 UTC is a peak hour and 20:00 UTC is not. */
const PEAK = '2026-01-05T02:00:00.000Z';
const OFF_PEAK = '2026-01-05T20:00:00.000Z';

function config(overrides: Partial<ResolvedRunConfig> = {}): ResolvedRunConfig {
  return {
    name: 'a-task',
    worktree: path.join(home, 'repo'),
    profile: path.join(home, 'p.json'),
    profileHash: 'x',
    model: 'deepseek-flash',
    allow: ['src/a.ts'],
    checks: [],
    task: 'change the constant',
    limits: { ...DEFAULT_LIMITS },
    sourcePath: null,
    configPath: path.join(home, 'task.json'),
    raw: {},
    resolvedProfile: { checks: {}, format: [] },
    ...overrides,
  } as ResolvedRunConfig;
}

/** A million of each kind of token, so the arithmetic reads off the price list. */
const MILLION = { promptTokens: 1_000_000, cacheHitTokens: 900_000, completionTokens: 1_000_000 };

function storeWith(
  id: string,
  at: string,
  usage: typeof MILLION,
  prices?: ConstructorParameters<typeof Store>[1],
  recordedCost?: number,
): Store {
  const store = new Store(path.join(home, `runs-${id}-${Math.random().toString(36).slice(2)}.db`), prices);
  store.createRun({ id, name: 'a-task', config: config(), detached: false, createdAt: at });
  store.appendEvent(
    id,
    {
      type: 'metrics',
      turn: 1,
      call: { model: 'deepseek-flash', startedAt: at, ...usage } as never,
      totals: { ...emptyTotals() } as never,
    },
    at,
  );
  // A cost in the row is a cost the run was told at the time. This is where a
  // back-fill has to look, and it is what must not be overwritten.
  if (recordedCost !== undefined) {
    store.progress(id, 1, { ...emptyTotals(), costUsd: recordedCost });
  }
  return store;
}

describe('a run whose row does not say what it cost', () => {
  it('is priced from its own calls, so it is not a dash beside stats dollars', () => {
    // Off peak: 100,000 fresh at $0.15 and 900,000 cached at $0.003, plus a
    // million written at $0.60.
    const store = storeWith('run-old', OFF_PEAK, MILLION);
    expect(store.getRun('run-old')?.totals.costUsd).toBeCloseTo(0.015 + 0.0027 + 0.6, 6);
    store.close();
  });

  it('is priced at the hour the call was made, at both ends', () => {
    // The same call at 02:00 UTC on a Monday costs exactly twice as much, and a
    // back-filled figure that ignored the hour would be wrong by 100% for half
    // the day.
    const peak = storeWith('run-peak', PEAK, MILLION);
    const off = storeWith('run-off', OFF_PEAK, MILLION);
    expect(peak.getRun('run-peak')?.totals.costUsd).toBeCloseTo(0.6177 * 2, 6);
    expect(off.getRun('run-off')?.totals.costUsd).toBeCloseTo(0.6177, 6);
    peak.close();
    off.close();
  });

  it('never rewrites a cost that is already recorded', () => {
    // A recorded figure was worked out at the prices in force when the run was
    // billed. Recomputing it at today's prices would be inventing a bill.
    const store = storeWith('run-known', OFF_PEAK, MILLION, undefined, 9.99);
    expect(store.getRun('run-known')?.totals.costUsd).toBe(9.99);
    store.close();
  });

  it('honours a price written into config.json over the published one', () => {
    const store = storeWith('run-mine', OFF_PEAK, MILLION, {
      'deepseek-flash': { inputPerMillion: 1, outputPerMillion: 0 },
    });
    // 100,000 fresh at $1 a million, and the cache rate falls back to the miss
    // rate because the hand-written table does not name one.
    expect(store.getRun('run-mine')?.totals.costUsd).toBeCloseTo(1, 6);
    store.close();
  });

  it('leaves a model nobody has priced at no cost rather than zero', () => {
    const store = new Store(path.join(home, 'runs-unknown.db'));
    store.createRun({
      id: 'run-unknown',
      name: 'a-task',
      config: config({ model: 'someone-elses-model' }),
      detached: false,
      createdAt: OFF_PEAK,
    });
    store.appendEvent(
      'run-unknown',
      {
        type: 'metrics',
        turn: 1,
        call: { model: 'someone-elses-model', startedAt: OFF_PEAK, ...MILLION } as never,
        totals: { costUsd: null } as never,
      },
      OFF_PEAK,
    );
    expect(store.getRun('run-unknown')?.totals.costUsd).toBeNull();
    store.close();
  });
});
