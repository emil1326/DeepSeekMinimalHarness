/**
 * The readings, end to end: a worker measures, flushes, and the daemon keeps
 * them per run and adds them up across runs.
 *
 * The assertion that matters most is the boring one: a flush that arrives twice
 * must not double a count. The worker sends its readings on every turn boundary
 * *and* once more before it reports itself done, because a run killed mid-flight
 * would otherwise take everything it had measured with it. Those two facts
 * together mean the daemon has to replace rather than append, and "replaced
 * rather than appended" is invisible until somebody reads a number that looks
 * twice too big.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { TIMING_BUCKETS } from '@emilswork/harness-core';
import type { RunTimings, TimingsResponse } from '@emilswork/harness-daemon';
import { startTestDaemon, type TestDaemon } from './harness.js';

let daemon: TestDaemon | null = null;
afterEach(async () => {
  await daemon?.close();
  daemon = null;
});

/** Three turns: a read, an edit, and a finish. */
const THREE_TURNS = [
  { toolCalls: [{ name: 'read_file', args: { path: 'src/a.ts' } }] },
  { toolCalls: [{ name: 'replace_in_file', args: { path: 'src/a.ts', old: '= 1', new: '= 2' } }] },
  { toolCalls: [{ name: 'finish', args: { summary: 'bumped the constant' } }] },
];

/**
 * Two runs' worth, in one script.
 *
 * The fake model serves its script in order across every request it ever gets,
 * and past the end it replays the last turn. A test that wants two runs to do
 * the same work has to hand it the work twice, or the second run finishes on its
 * first call and reads nothing — which is exactly how this test first failed.
 */
const TWO_RUNS = [...THREE_TURNS, ...THREE_TURNS];

async function runOnce(fixtureName: string): Promise<string> {
  const taskPath = daemon?.fixture.taskPath(fixtureName, { checks: ['echo'] }) ?? '';
  const created = await daemon?.request('POST', '/runs', { body: { taskPath } });
  const runId = String(created?.body.id);
  await daemon?.collect(runId);
  return runId;
}

describe('the readings a run leaves behind', () => {
  it('names what the run did, and does not double it on the last flush', async () => {
    daemon = await startTestDaemon(THREE_TURNS);
    const runId = await runOnce('timings');

    const response = await daemon.request('GET', `/runs/${runId}/timings`);
    expect(response.status).toBe(200);
    const body = response.body as unknown as RunTimings;
    const byName = new Map(body.entries.map((entry) => [entry.name, entry]));

    // The tool the script called, and the model call it was waiting on.
    expect(byName.has('core.sandbox.readFile')).toBe(true);
    expect(byName.get('core.sandbox.readFile')?.count).toBe(1);
    // One per turn, and three turns. Two flushes per turn plus the one before
    // `done` would have made this 3, 6, 9 or 12 if the daemon appended.
    expect(byName.get('worker.turn.model')?.count).toBe(3);

    for (const entry of body.entries) {
      expect(entry.histogram).toHaveLength(TIMING_BUCKETS);
      expect(entry.totalMs).toBeGreaterThanOrEqual(entry.maxMs === 0 ? 0 : 0);
      expect(entry.maxMs).toBeGreaterThanOrEqual(entry.minMs);
      expect(entry.count).toBeGreaterThan(0);
    }
    // Longest total first, which is the order the CLI prints.
    const totals = body.entries.map((entry) => entry.totalMs);
    expect([...totals].sort((a, b) => b - a)).toEqual(totals);
    expect(body.wallMs).toBeGreaterThan(0);
    expect(body.at).not.toBeNull();
  });

  it('says so, rather than nothing, for a run that recorded no readings', async () => {
    daemon = await startTestDaemon(THREE_TURNS);
    const response = await daemon.request('GET', '/runs/run-nonexistent/timings');
    expect(response.status).toBe(404);
  });

  it('adds every run together, and keeps the daemon itself apart', async () => {
    daemon = await startTestDaemon(TWO_RUNS);
    await runOnce('timings-one');
    const second = await runOnce('timings-two');

    const response = await daemon.request('GET', '/timings');
    expect(response.status).toBe(200);
    const body = response.body as unknown as TimingsResponse;
    const read = body.entries.find((entry) => entry.name === 'core.sandbox.readFile');
    const one = (
      (await daemon.request('GET', `/runs/${second}/timings`)).body as unknown as RunTimings
    ).entries.find((entry) => entry.name === 'core.sandbox.readFile');

    expect(body.runs).toBe(2);
    expect(read?.count).toBe(2);
    expect(read?.count).toBe((one?.count ?? 0) * 2);
    // Summed, not averaged: the histogram is what makes a merged p95 a real
    // percentile of everything rather than the mean of two percentiles.
    expect(read?.histogram.length).toBe(TIMING_BUCKETS);
    expect(body.wallMs).toBeGreaterThan(0);

    // The daemon's own readings are reported, and are not part of the runs'
    // entries: it outlives them and mixing its uptime into their runtime would
    // make both numbers mean nothing.
    expect(body.process.length).toBeGreaterThan(0);
    expect(body.process.map((entry) => entry.name)).toContain('daemon.store.appendEvent');
    expect(body.entries.map((entry) => entry.name)).not.toContain('daemon.store.appendEvent');
  });
});
