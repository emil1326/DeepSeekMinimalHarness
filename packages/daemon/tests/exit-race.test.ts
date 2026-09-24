/**
 * A worker that finished, recorded as one that stopped without finishing.
 *
 * Found in the database, not by reading code: six runs in one session had the note
 * *"the worker stopped without finishing (code 0, signal none)"* — and every one of
 * them had written its summary. `code 0` is a clean exit. Two of them were runs
 * started to check this very change, and their own event logs end at `summary`,
 * then `message`, then the daemon's `error`.
 *
 * The cause is an ordering question, not a lost message. The worker sends `done`
 * and exits 30 ms later; that is normally long enough for the bytes to leave. But
 * `fork`'s IPC channel is a pipe, and Node's `exit` event fires when the process
 * ends — **before** the parent has necessarily read what is still buffered in it.
 * So `Supervisor`'s `exit` handler can run first, look at the row, find no terminal
 * status, and write the verdict. Then it reads the `done` and finds the run already
 * settled.
 *
 * The 30 ms is why it is intermittent, and why it survived this long: a worker's
 * last act is usually followed by enough teardown that the parent wins the race.
 * It shows up on runs that finish fast, which is exactly the shape of a small task
 * — and of this project's own verification runs.
 *
 * This test is what makes it deterministic. `fixtures/quit-after-done.mjs` sends
 * `done` and exits with no teardown at all, so the parent almost always loses.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { delay, isTerminal } from '@emilswork/harness-core';
import { Store, Supervisor } from '@emilswork/harness-daemon';
import { createFixture, type Fixture } from '../../worker/tests/fixture.js';

const QUIT_AFTER_DONE = fileURLToPath(new URL('./fixtures/quit-after-done.mjs', import.meta.url));

let fixture: Fixture | null = null;
let store: Store | null = null;
let home: string | null = null;

afterEach(() => {
  store?.close();
  store = null;
  fixture?.cleanup();
  fixture = null;
  if (home !== null) {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    home = null;
  }
  delete process.env.DSH_KEY_FILE;
  delete process.env.DSH_DATA_DIR;
});

/** A daemon's worth of state, with a worker script that quits the instant it is done. */
function bench(): { supervisor: Supervisor; store: Store; fixture: Fixture } {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-exit-'));
  const keyFile = path.join(home, 'api_key');
  fs.writeFileSync(keyFile, 'a-test-key-that-is-never-real\n');
  process.env.DSH_KEY_FILE = keyFile;
  process.env.DSH_DATA_DIR = home;

  fixture = createFixture();
  store = new Store(path.join(home, 'runs.db'));
  const supervisor = new Supervisor({
    store,
    // Never contacted: the fixture worker does not make a model call.
    baseUrl: 'http://127.0.0.1:1',
    workerScript: QUIT_AFTER_DONE,
    unattachedGraceMs: 30_000,
  });
  return { supervisor, store, fixture };
}

/** Runs one, and hands back the row once it has settled. */
async function runOnce(supervisor: Supervisor, store: Store, taskPath: string) {
  const created = supervisor.createRun(taskPath, true);
  const deadline = Date.now() + 15_000;
  for (;;) {
    const now = store.getRun(created.id);
    if (now !== null && isTerminal(now.status)) return now;
    // A row that vanished would be a different failure, and one worth seeing
    // rather than waiting fifteen seconds for.
    if (now === null) throw new Error(`the run ${created.id} disappeared as it was created`);
    if (Date.now() > deadline) return now;
    await delay(20);
  }
}

describe('a worker that exits the moment it has finished', () => {
  it('keeps the reason the worker gave, instead of overwriting it with the exit', async () => {
    // Five runs rather than one. A race that reproduces two times in three needs
    // more than a single throw of the dice to be worth trusting either way, and
    // the assertion is about the absence of a failure mode, not about one example.
    const { supervisor, store: runs, fixture: work } = bench();
    const taskPath = work.taskPath('quits', {});

    const outcomes = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const run = await runOnce(supervisor, runs, taskPath);
      const events = runs.eventsAfter(run.id, 0);
      const reason = events.find((event) => event.type === 'error');
      outcomes.push({
        status: run.status,
        // What the worker said, which is the thing that used to be lost.
        said: reason?.type === 'error' ? reason.message : null,
        // And what the daemon wrote over the top of it, when it won the race.
        verdict: run.detail,
      });
    }

    // The worker said `failed` and gave a reason; every run has to keep both.
    for (const outcome of outcomes) {
      expect(outcome.said).toContain('the profile is inside the sandbox');
      expect(outcome.status).toBe('failed');
      // The old failure: this is present and the reason above is not, because the
      // exit handler ran before the `done` was read.
      expect(outcome.verdict ?? '').not.toContain('without finishing');
    }
  });
});
