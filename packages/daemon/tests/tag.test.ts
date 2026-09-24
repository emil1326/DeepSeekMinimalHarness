/**
 * Did any of the work land.
 *
 * The one question `dsh stats` could not answer, and the only measure of whether
 * any of this is worth doing. The status a run ends with cannot answer it: a run
 * that stopped at a limit and whose half-finished work was kept, and one whose
 * half-finished work was thrown away, are the same row.
 *
 * The other half of it is the migration. `runs.db` is somebody's history — four
 * months of it, in one case — and the tag columns were added to a table that
 * already had rows in it, so this is the test that says adding a column did not
 * take the history with it.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, emptyTotals, type ResolvedRunConfig } from '@emilswork/harness-core';
import { Store } from '@emilswork/harness-daemon';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tag-'));
afterAll(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

let counter = 0;
const dbFile = (): string => path.join(home, `runs-${(counter += 1)}.db`);

function config(overrides: Partial<ResolvedRunConfig> = {}): ResolvedRunConfig {
  return {
    name: 'a-line',
    worktree: path.join(home, 'repo'),
    profile: path.join(home, 'profiles', 'esap.json'),
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
    workspace: null,
    rules: '',
    soft: [],
    commands: {},
    env: {},
    setup: [],
    onAsk: null,
    ...overrides,
  } as ResolvedRunConfig;
}

/** A run with a status and a cost, so a group has something to add up. */
function addRun(
  store: Store,
  id: string,
  status: string,
  costUsd: number | null,
  overrides: Partial<ResolvedRunConfig> = {},
): void {
  store.createRun({
    id,
    name: 'a-line',
    config: config(overrides),
    detached: false,
    createdAt: '2026-01-05T20:00:00.000Z',
  });
  store.setStatus(id, status as never, {
    turns: 3,
    totals: { ...emptyTotals(), costUsd, billedTokens: 1000 },
  });
}

describe('saying what happened to the work', () => {
  it('is null until somebody says, and then it is what they said', () => {
    // A run with no tag has not been judged, which is not the same as a run that
    // produced nothing. Dumping it in with `dropped` would make the table lie in
    // the flattering direction.
    const store = new Store(dbFile());
    addRun(store, 'run-a', 'finished', 0.5);
    expect(store.getRun('run-a')?.tag).toBeNull();

    store.tag('run-a', 'landed', { note: 'went in as it was', lines: { added: 40, removed: 2 } });
    const tagged = store.getRun('run-a');
    expect(tagged?.tag).toBe('landed');
    expect(tagged?.tagNote).toBe('went in as it was');
    expect(tagged?.taggedAt).not.toBeNull();
    store.close();
  });

  it('refuses a run that is not there rather than writing nothing quietly', () => {
    const store = new Store(dbFile());
    expect(() => store.tag('run-nope', 'landed')).toThrow(/no run called run-nope/);
    store.close();
  });

  it('can be changed, because a gate is judgement and judgement changes', () => {
    const store = new Store(dbFile());
    addRun(store, 'run-a', 'finished', 0.5);
    store.tag('run-a', 'dropped');
    store.tag('run-a', 'landed');
    expect(store.getRun('run-a')?.tag).toBe('landed');
    store.close();
  });
});

describe('adding up what landed', () => {
  it('groups by model and profile, and counts the outcomes', () => {
    const store = new Store(dbFile());
    addRun(store, 'run-1', 'finished', 0.2);
    addRun(store, 'run-2', 'stopped_at_limit', 0.3);
    addRun(store, 'run-3', 'failed', 0.1);

    store.tag('run-1', 'landed', { lines: { added: 100, removed: 5 } });
    store.tag('run-2', 'fixed', { lines: { added: 60, removed: 1 } });
    store.tag('run-3', 'dropped');

    const [row] = store.outcomes();
    expect(row?.model).toBe('deepseek-flash');
    expect(row?.profile).toBe('esap.json');
    expect(row?.runs).toBe(3);
    expect(row?.finished).toBe(1);
    expect(row?.stoppedAtLimit).toBe(1);
    expect(row?.failed).toBe(1);
    expect(row?.landed).toBe(1);
    expect(row?.fixed).toBe(1);
    expect(row?.dropped).toBe(1);
    store.close();
  });

  it('counts only the lines that landed untouched towards the cost', () => {
    // A run tagged `fixed` needed a human to finish it, so its lines are not the
    // harness's output. Including them would make the one figure here that
    // matters flatter itself, which is the opposite of its job.
    const store = new Store(dbFile());
    addRun(store, 'run-1', 'finished', 1);
    addRun(store, 'run-2', 'finished', 1);
    store.tag('run-1', 'landed', { lines: { added: 100, removed: 0 } });
    store.tag('run-2', 'fixed', { lines: { added: 900, removed: 0 } });

    const [row] = store.outcomes();
    expect(row?.landedLinesAdded).toBe(100);
    // $2 of runs over the 100 lines that landed untouched.
    expect(row?.costPerLandedLine).toBeCloseTo(0.02, 6);
    store.close();
  });

  it('is null, not zero, when nothing has landed', () => {
    // Zero would read as free, and free is a claim. Nothing landed, so there is
    // no figure, and the table has to be able to say that.
    const store = new Store(dbFile());
    addRun(store, 'run-1', 'stopped_at_limit', 1);
    const [row] = store.outcomes();
    expect(row?.costPerLandedLine).toBeNull();
    expect(row?.landedLinesAdded).toBe(0);
    store.close();
  });

  it('is null when no price is known either, rather than dividing by nothing', () => {
    const store = new Store(dbFile());
    addRun(store, 'run-1', 'finished', null);
    store.tag('run-1', 'landed', { lines: { added: 10, removed: 0 } });
    expect(store.outcomes()[0]?.costPerLandedLine).toBeNull();
    store.close();
  });

  it('keeps two projects apart, because the question is per project', () => {
    const store = new Store(dbFile());
    addRun(store, 'run-1', 'finished', 1, { profile: path.join(home, 'profiles', 'esap.json') });
    addRun(store, 'run-2', 'finished', 1, { profile: path.join(home, 'profiles', 'other.json') });
    addRun(store, 'run-3', 'finished', 1, { model: 'deepseek-v4-pro' });

    const rows = store.outcomes();
    expect(rows.map((row) => `${row.model} ${row.profile}`)).toEqual([
      'deepseek-flash esap.json',
      'deepseek-flash other.json',
      'deepseek-v4-pro esap.json',
    ]);
    store.close();
  });

  it('has a row for every run, tagged or not, so the rate is readable', () => {
    // The share that landed is only meaningful next to the total, and a run
    // nobody has judged has to be in the total or the rate is computed over a
    // subset somebody chose by accident.
    const store = new Store(dbFile());
    addRun(store, 'run-1', 'finished', 0.1);
    addRun(store, 'run-2', 'finished', 0.1);
    store.tag('run-1', 'landed', { lines: { added: 5, removed: 0 } });

    const [row] = store.outcomes();
    expect(row?.runs).toBe(2);
    expect(row?.landed).toBe(1);
    store.close();
  });
});

describe('adding the columns to a database that already has runs in it', () => {
  it('keeps every run, and makes the new columns usable', () => {
    // The thing that had to be proved. `runs.db` in the real harness home holds
    // months of history and there is no second copy of it, so a migration that
    // recreated the table would destroy the only record of every run ever made.
    const file = dbFile();
    counter += 1;
    const old = new Database(file);
    old.exec(`
      CREATE TABLE runs (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL,
        config_json TEXT NOT NULL, created_at TEXT NOT NULL, started_at TEXT,
        ended_at TEXT, detail TEXT, summary TEXT,
        turns INTEGER NOT NULL DEFAULT 0, detached INTEGER NOT NULL DEFAULT 0,
        totals_json TEXT
      );
      CREATE TABLE events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, at TEXT NOT NULL,
        type TEXT NOT NULL, payload_json TEXT NOT NULL
      );
    `);
    old
      .prepare(
        `INSERT INTO runs (id, name, status, config_json, created_at, totals_json)
         VALUES ('run-old', 'from before', 'finished', ?, '2026-01-01T00:00:00.000Z', ?)`,
      )
      .run(JSON.stringify(config()), JSON.stringify({ ...emptyTotals(), costUsd: 0.4 }));
    old.close();

    // Opening it with the current code is the migration.
    const store = new Store(file);
    const kept = store.getRun('run-old');
    expect(kept?.name).toBe('from before');
    expect(kept?.tag).toBeNull();
    expect(store.countRuns()).toBe(1);

    // And the new columns work on the old row.
    store.tag('run-old', 'landed', { lines: { added: 12, removed: 0 } });
    expect(store.getRun('run-old')?.tag).toBe('landed');
    expect(store.outcomes()[0]?.landedLinesAdded).toBe(12);
    store.close();
  });

  it('can be opened twice, because a daemon restarts', () => {
    const file = dbFile();
    const first = new Store(file);
    addRun(first, 'run-1', 'finished', 0.1);
    first.close();
    // The second open runs the migration again against columns that are already
    // there, which has to be a no-op rather than an error.
    const second = new Store(file);
    expect(second.getRun('run-1')?.tag).toBeNull();
    second.tag('run-1', 'landed', { lines: { added: 1, removed: 0 } });
    expect(second.outcomes()[0]?.landed).toBe(1);
    second.close();
  });
});
