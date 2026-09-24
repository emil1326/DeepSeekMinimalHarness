/**
 * Watching a run without owning it.
 *
 * `dsh run` is a claim. It starts a run that was left queued, and the run is
 * cancelled when the last attached connection goes away — which is right for the
 * person who launched it and wrong for everybody else. Before this, the only way
 * to see a run's events was to attach to it, so the only way to *watch* a run was
 * to take responsibility for it. Closing a terminal window would cancel somebody
 * else's work.
 *
 * So the daemon has two sockets onto the same stream and they differ in exactly
 * one thing: whether the run's lifetime is tied to yours. Everything below is
 * that one difference, in both directions — a watcher must not start a run, and a
 * watcher must not be able to stop one — plus the catch-up, because a watcher
 * that starts late is the normal case rather than the edge one.
 */

import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { delay } from '@emilswork/harness-core';
import { startTestDaemon, type TestDaemon } from './harness.js';

let daemon: TestDaemon | null = null;
afterEach(async () => {
  await daemon?.close();
  daemon = null;
});

/** Two turns, the second slow, so a run can be watched while it is going. */
const SLOW_EDIT = [
  { toolCalls: [{ name: 'replace_in_file', args: { path: 'src/a.ts', old: '= 1', new: '= 2' } }] },
  { text: 'carrying on', delayMs: 3000 },
];

const ONE_EDIT = [
  { toolCalls: [{ name: 'replace_in_file', args: { path: 'src/a.ts', old: '= 1', new: '= 2' } }] },
  { toolCalls: [{ name: 'finish', args: { summary: 'bumped the constant' } }] },
];

interface Messages {
  events: { type: string; status?: string; cause?: string }[];
  hellos: number;
  status: string | null;
  closed: boolean;
}

/** Open a watch socket and record everything it is told. */
function watch(
  daemon: TestDaemon,
  runId: string,
): { socket: WebSocket; seen: Messages; opened: Promise<void> } {
  const socket = new WebSocket(`ws://127.0.0.1:${daemon.port}/runs/${runId}/watch`, {
    headers: { authorization: `Bearer ${daemon.token}` },
  });
  const seen: Messages = { events: [], hellos: 0, status: null, closed: false };
  socket.on('message', (raw: Buffer) => {
    const message = JSON.parse(raw.toString('utf8')) as {
      type: string;
      events?: { type: string; status?: string }[];
      event?: { type: string; status?: string };
      status?: string;
    };
    if (message.type === 'hello') {
      seen.hellos += 1;
      seen.events.push(...(message.events ?? []));
      return;
    }
    if (message.type === 'event' && message.event !== undefined) {
      seen.events.push(message.event);
      return;
    }
    if (message.type === 'bye') {
      seen.status = message.status ?? null;
      seen.closed = true;
    }
  });
  const opened = new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  return { socket, seen, opened };
}

describe('watching a run', () => {
  it('sees the same events as an owner, and is told when the run ends', async () => {
    daemon = await startTestDaemon(ONE_EDIT);
    const taskPath = daemon.fixture.taskPath('watched', {});
    const created = await daemon.request('POST', '/runs', { body: { taskPath } });
    const runId = String(created.body.id);

    const owner = daemon.attach(runId);
    const viewer = watch(daemon, runId);
    await Promise.all([new Promise<void>((resolve) => owner.once('open', () => resolve())), viewer.opened]);

    const deadline = Date.now() + 25_000;
    while (!viewer.seen.closed && Date.now() < deadline) await delay(50);
    owner.close();

    expect(viewer.seen.hellos).toBe(1);
    expect(viewer.seen.closed).toBe(true);
    expect(viewer.seen.status).toBe('finished');
    const types = viewer.seen.events.map((event) => event.type);
    expect(types).toContain('turn.start');
    expect(types).toContain('tool.result');
    expect(types).toContain('summary');
    // The one that matters: it saw the summary, so it saw the whole run rather
    // than a hello and then nothing.
    expect(viewer.seen.events.some((event) => event.type === 'status' && event.status === 'finished')).toBe(
      true,
    );
  });

  it('does not count as an owner, so it cannot keep a run alive', async () => {
    // The bug this route exists to prevent, stated as a number. If a watcher
    // incremented `owners`, then a run with one `dsh run` and one `dsh watch`
    // would report two, and the CLI's own "is anybody listening" answer would be
    // wrong in the direction that hides a run about to be cancelled.
    daemon = await startTestDaemon(SLOW_EDIT);
    const taskPath = daemon.fixture.taskPath('owned', {});
    const created = await daemon.request('POST', '/runs', { body: { taskPath } });
    const runId = String(created.body.id);

    const owner = daemon.attach(runId);
    await new Promise<void>((resolve) => owner.once('open', () => resolve()));
    expect(daemon.supervisor.ownersOf(runId)).toBe(1);

    const viewer = watch(daemon, runId);
    await viewer.opened;
    await delay(200);
    expect(daemon.supervisor.ownersOf(runId)).toBe(1);

    viewer.socket.close();
    await delay(200);
    expect(daemon.supervisor.ownersOf(runId)).toBe(1);
    owner.close();
  });

  it('does not start a run that nothing has attached to', async () => {
    // The other direction, and the more dangerous one. `ownerAttached` calls
    // `start`, and attaching is deliberately what starts a queued run — so a
    // watcher that went through the owner path would launch work as a side
    // effect of somebody looking at it.
    daemon = await startTestDaemon(SLOW_EDIT);
    const taskPath = daemon.fixture.taskPath('queued', {});
    const created = await daemon.request('POST', '/runs', { body: { taskPath } });
    const runId = String(created.body.id);

    const viewer = watch(daemon, runId);
    await viewer.opened;
    await delay(400);

    const detail = await daemon.request('GET', `/runs/${runId}`);
    expect((detail.body as { status: string }).status).toBe('queued');
    expect(viewer.seen.events.some((event) => event.type === 'turn.start')).toBe(false);
    viewer.socket.close();
  });

  it('closing a watcher does not cancel the run it was watching', async () => {
    // This is the whole point for a person who opens a second terminal. Under
    // the owner route the run would have been cancelled here, and the message
    // would have said "the connection that owned this run went away" — about a
    // connection that never owned anything.
    daemon = await startTestDaemon(SLOW_EDIT);
    const taskPath = daemon.fixture.taskPath('survives', {});
    const created = await daemon.request('POST', '/runs', { body: { taskPath } });
    const runId = String(created.body.id);

    const owner = daemon.attach(runId);
    await new Promise<void>((resolve) => owner.once('open', () => resolve()));

    for (let round = 0; round < 3; round += 1) {
      const viewer = watch(daemon, runId);
      await viewer.opened;
      await delay(100);
      viewer.socket.close();
      await delay(100);
      const detail = await daemon.request('GET', `/runs/${runId}`);
      const status = (detail.body as { status: string }).status;
      expect(['running', 'queued']).toContain(status);
    }

    owner.close();
  });

  it('catches a watcher up on everything that already happened', async () => {
    // A watcher that starts late is the normal case: you start a run, notice it
    // has been quiet for a while, and want to know why. That only works if the
    // replay carries the question the run is stuck on.
    daemon = await startTestDaemon(SLOW_EDIT);
    const taskPath = daemon.fixture.taskPath('catch-up', {});
    const created = await daemon.request('POST', '/runs', { body: { taskPath } });
    const runId = String(created.body.id);

    const owner = daemon.attach(runId);
    await new Promise<void>((resolve) => owner.once('open', () => resolve()));

    // Wait until the run has actually done something, so the replay is not
    // empty for a boring reason.
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (daemon.store.eventsAfter(runId, 0).some((event) => event.type === 'turn.start')) break;
      await delay(50);
    }

    const viewer = watch(daemon, runId);
    await viewer.opened;
    await delay(300);

    const replayed = viewer.seen.events.map((event) => event.type);
    expect(replayed).toContain('status');
    expect(replayed.filter((type) => type === 'turn.start').length).toBeGreaterThanOrEqual(1);
    // The status event says it was queued when it was created, which is history
    // rather than a live claim. A reader gets the sequence and works out where
    // the run got to; the socket does not pretend the past did not happen.
    expect(replayed[0]).toBe('status');
    viewer.socket.close();
    owner.close();
  });

  it('answers a finished run straight away rather than holding the socket open', async () => {
    // Otherwise `dsh watch` on an old run is a command that hangs, and the one
    // thing somebody does after a run ends is look at it.
    daemon = await startTestDaemon(ONE_EDIT);
    const taskPath = daemon.fixture.taskPath('done', {});
    const created = await daemon.request('POST', '/runs', { body: { taskPath } });
    const runId = String(created.body.id);
    await daemon.collect(runId);

    const viewer = watch(daemon, runId);
    await viewer.opened;
    const deadline = Date.now() + 5000;
    while (!viewer.seen.closed && Date.now() < deadline) await delay(50);

    expect(viewer.seen.closed).toBe(true);
    expect(viewer.seen.status).toBe('finished');
    expect(viewer.seen.events.some((event) => event.type === 'summary')).toBe(true);
  });

  it('refuses a watch on a run that does not exist, and one with no token', async () => {
    daemon = await startTestDaemon(ONE_EDIT);

    const missing = await new Promise<string>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${daemon?.port ?? 0}/runs/no-such-run/watch`, {
        headers: { authorization: `Bearer ${daemon?.token ?? ''}` },
      });
      socket.on('message', (raw: Buffer) => {
        const message = JSON.parse(raw.toString('utf8')) as { type: string; status?: string };
        if (message.type === 'bye') resolve(message.status ?? '');
      });
      socket.on('error', reject);
      setTimeout(() => reject(new Error('no answer for a run that does not exist')), 5000);
    });
    expect(missing).toBe('failed');

    const unauthenticated = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${daemon?.port ?? 0}/runs/whatever/watch`);
      socket.on('unexpected-response', (_request, response) => {
        socket.terminate();
        resolve(response.statusCode ?? 0);
      });
      socket.on('open', () => {
        socket.terminate();
        resolve(200);
      });
      socket.on('error', reject);
      setTimeout(() => reject(new Error('no answer to the upgrade')), 5000);
    });
    expect(unauthenticated).toBe(401);
  });
});
