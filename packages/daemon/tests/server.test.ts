import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '@emilswork/harness-daemon';
import { delay } from '@emilswork/harness-core';
import { startTestDaemon, statusesOf, type TestDaemon } from './harness.js';

let daemon: TestDaemon | null = null;
afterEach(async () => {
  await daemon?.close();
  daemon = null;
});

const ONE_EDIT = [
  { toolCalls: [{ name: 'replace_in_file', args: { path: 'src/a.ts', old: '= 1', new: '= 2' } }] },
  { toolCalls: [{ name: 'finish', args: { summary: 'bumped the constant' } }] },
];

describe('the daemon', () => {
  it('answers a request with no credentials at all', async () => {
    // There is no login. The CLI, `curl` and the page all just talk to it, which
    // is the whole point: this is one person's own machine, and a password he has
    // to type to look at his own runs is a password that buys nothing — it would
    // have been written in `daemon.json`, readable by every process it could
    // plausibly have been protecting against.
    daemon = await startTestDaemon(ONE_EDIT);
    const response = await daemon.request('GET', '/runs', {});
    expect(response.status).toBe(200);
  });

  it('refuses a request from a page, which is the one thing that does need refusing', async () => {
    // A localhost server is reachable from any page the browser has open, so a
    // site could otherwise POST `/runs/.../cancel` — a route that takes no body —
    // or start a run that spends money and writes files.
    daemon = await startTestDaemon(ONE_EDIT);
    const crossSite = await daemon.request('GET', '/runs', {
      headers: { origin: 'https://example.com', 'sec-fetch-site': 'cross-site' },
    });
    expect(crossSite.status).toBe(403);

    // The same page with no Origin at all, which is what a form POST used to look
    // like: `Sec-Fetch-Site` is set by the browser and cannot be written by
    // JavaScript, so it is the header a page cannot lie about.
    const headerOnly = await daemon.request('GET', '/runs', {
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    expect(headerOnly.status).toBe(403);
  });

  it('allows the page it served, which sends same-origin', async () => {
    // The control for the above, and the reason it does not break the UI: the
    // UI's own fetches are same-origin, so this is what they look like.
    daemon = await startTestDaemon(ONE_EDIT);
    const response = await daemon.request('GET', '/runs', {
      headers: { origin: `http://127.0.0.1:${daemon.port}`, 'sec-fetch-site': 'same-origin' },
    });
    expect(response.status).toBe(200);
  });

  it('refuses an Origin that is not the UI', async () => {
    daemon = await startTestDaemon(ONE_EDIT);
    const response = await daemon.request('GET', '/runs', { headers: { origin: 'https://example.com' } });
    expect(response.status).toBe(403);
  });

  it('fails loudly when its fixed port is taken, rather than moving', async () => {
    // The fixed port is what makes the URL bookmarkable, so a silent fallback to
    // another number would be the worst of both: a stable address almost always,
    // and a mystery the one time it matters. The message names the two ways out.
    daemon = await startTestDaemon(ONE_EDIT);
    const taken = daemon.port;
    await expect(startTestDaemon(ONE_EDIT, { port: taken })).rejects.toThrowError(/already in use/);
    await expect(startTestDaemon(ONE_EDIT, { port: taken })).rejects.toThrowError(/config\.json/);
  });

  it("refuses Origin: null, which is what somebody else's page sends", async () => {
    // A sandboxed iframe and a `file://` page both send the literal string
    // "null", which is the one value that means "a page, but not a page I can
    // name" while looking like "no page at all".
    daemon = await startTestDaemon(ONE_EDIT);
    const response = await daemon.request('GET', '/runs', { headers: { origin: 'null' } });
    expect(response.status).toBe(403);
    // The control: no Origin at all is still the CLI, and still allowed.
    const cli = await daemon.request('GET', '/runs', {});
    expect(cli.status).toBe(200);
  });

  it('refuses a Host that is not this daemon', async () => {
    daemon = await startTestDaemon(ONE_EDIT);
    const response = await daemon.request('GET', '/runs', { headers: { host: 'evil.example.com' } });
    expect(response.status).toBe(403);
  });

  it('answers a name from config.json, on both Host and Origin', async () => {
    daemon = await startTestDaemon(ONE_EDIT, { uiHosts: ['emilsharnessui'] });
    // Uppercase on purpose: browsers lowercase both headers, but the daemon
    // lowercases them itself rather than trusting that, so this is the check
    // that a name written with capitals in `config.json` still matches.
    const response = await daemon.request('GET', '/runs', {
      headers: {
        host: `EmilsHarnessUI:${daemon.port}`,
        origin: `http://EmilsHarnessUI:${daemon.port}`,
      },
    });
    expect(response.status).toBe(200);
  });

  it('answers the loopback address and localhost alongside a configured name', async () => {
    daemon = await startTestDaemon(ONE_EDIT, { uiHosts: ['emilsharnessui'] });
    // The CLI and the dev loop both keep talking to 127.0.0.1, so a configured
    // name has to add to the list rather than replace it.
    const byAddress = await daemon.request('GET', '/runs', {
      headers: { origin: `http://127.0.0.1:${daemon.port}` },
    });
    expect(byAddress.status).toBe(200);

    const byLocalhost = await daemon.request('GET', '/runs', {
      headers: { host: `localhost:${daemon.port}`, origin: `http://localhost:${daemon.port}` },
    });
    expect(byLocalhost.status).toBe(200);
  });

  it('still refuses everything else once a name is configured', async () => {
    daemon = await startTestDaemon(ONE_EDIT, { uiHosts: ['emilsharnessui'] });
    // A configured name must not turn into "any host goes": both checks are
    // still one list, and neither of these is on it.
    const wrongHost = await daemon.request('GET', '/runs', {
      headers: {
        host: `evil.example.com:${daemon.port}`,
        origin: `http://emilsharnessui:${daemon.port}`,
      },
    });
    expect(wrongHost.status).toBe(403);

    const wrongOrigin = await daemon.request('GET', '/runs', {
      headers: { host: `emilsharnessui:${daemon.port}`, origin: 'https://example.com' },
    });
    expect(wrongOrigin.status).toBe(403);
  });

  it('refuses an upgrade from a foreign Origin, and one from a foreign page', async () => {
    daemon = await startTestDaemon(ONE_EDIT);
    const foreign = await new Promise<number>((resolve, reject) => {
      const client = new WebSocket(`ws://127.0.0.1:${daemon?.port ?? 0}/events`, {
        origin: 'https://example.com',
      });
      client.on('unexpected-response', (_request, response) => {
        client.terminate();
        resolve(response.statusCode ?? 0);
      });
      client.on('open', () => {
        client.terminate();
        resolve(200);
      });
      client.on('error', reject);
      setTimeout(() => reject(new Error('no answer to the upgrade')), 5000);
    });
    expect(foreign).toBe(403);

    // The same is true without an Origin, because a socket is not a lesser door:
    // closing the last owner's connection is what cancels a run.
    const crossSite = await new Promise<number>((resolve, reject) => {
      const client = new WebSocket(`ws://127.0.0.1:${daemon?.port ?? 0}/events`, {
        headers: { 'sec-fetch-site': 'cross-site' },
      });
      client.on('unexpected-response', (_request, response) => {
        client.terminate();
        resolve(response.statusCode ?? 0);
      });
      client.on('open', () => {
        client.terminate();
        resolve(200);
      });
      client.on('error', reject);
      setTimeout(() => reject(new Error('no answer to the upgrade')), 5000);
    });
    expect(crossSite).toBe(403);
  });

  it('nudges the UI with the id of the run that changed', async () => {
    // The bug this pins. The nudge always said `runId: null`, so the UI's branch
    // for "this run changed" was dead code — an open run was never told to refresh
    // and the only thing moving its conversation was a three-second poll. Three
    // seconds is about how long a turn takes, which is why the chat looked like it
    // updated once a turn rather than as the model wrote.
    daemon = await startTestDaemon(ONE_EDIT);
    const notices: (string | null)[] = [];
    const client = new WebSocket(`ws://127.0.0.1:${daemon.port}/events`);
    client.on('message', (raw: Buffer) => {
      const parsed = JSON.parse(raw.toString('utf8')) as { type: string; runId: string | null };
      if (parsed.type === 'notice') notices.push(parsed.runId);
    });
    await new Promise<void>((resolve, reject) => {
      client.once('open', () => resolve());
      client.once('error', reject);
    });

    // The handshake sends one with no run on it, which is still correct: it is
    // about the list, not about any one run.
    expect(notices).toEqual([null]);

    const taskPath = daemon.fixture.taskPath('nudged', {});
    const created = await daemon.request('POST', '/runs', { body: { taskPath } });
    const runId = String(created.body.id);
    const owner = daemon.attach(runId);
    await new Promise<void>((resolve) => owner.once('open', () => resolve()));

    const deadline = Date.now() + 20_000;
    while (!notices.includes(runId) && Date.now() < deadline) await delay(50);

    expect(notices).toContain(runId);
    // And it names the run and not something else, which a `toContain` alone would
    // not catch if the id were ever the wrong one.
    expect(notices.filter((each) => each !== null).every((each) => each === runId)).toBe(true);

    owner.close();
    client.close();
  });

  it('prints every problem in a bad task file at once, with the path of the field', async () => {
    daemon = await startTestDaemon(ONE_EDIT);
    const bad = path.join(daemon.fixture.base, 'bad.json');
    fs.writeFileSync(bad, JSON.stringify({ name: 'bad', worktree: 7, allow: 'src/a.ts', extra: true }));
    const response = await daemon.request('POST', '/runs', { body: { taskPath: bad } });
    expect(response.status).toBe(400);
    const problems = response.body.problems as { path: string; message: string }[];
    const paths = problems.map((problem) => problem.path).sort();
    expect(paths).toContain('allow');
    expect(paths).toContain('worktree');
    expect(paths).toContain('extra');
    // `profile` and `model` are no longer unconditionally required: a workspace
    // can supply both, which is the point of having one. They are still missing
    // from this file and still reported, when the file is otherwise well formed
    // — see the next test, because a schema failure short-circuits the rest.
    expect(paths).not.toContain('profile');
  });

  it('says so when nothing supplies a profile or a model, rather than guessing', async () => {
    daemon = await startTestDaemon(ONE_EDIT);
    const bare = path.join(daemon.fixture.base, 'bare.json');
    // Well formed, and every one of these is optional on its own: the worktree,
    // the task text and the allow list are here, and the profile and the model
    // are supposed to come from a workspace that this project does not have.
    fs.writeFileSync(
      bare,
      JSON.stringify({
        name: 'bare',
        worktree: daemon.fixture.repo,
        allow: ['src/a.ts'],
        task: 'change the constant',
      }),
    );
    const response = await daemon.request('POST', '/runs', { body: { taskPath: bare } });
    expect(response.status).toBe(400);
    const problems = response.body.problems as { path: string; message: string }[];
    const paths = problems.map((problem) => problem.path).sort();
    expect(paths).toEqual(['model', 'profile']);
    // The message has to say what to do, because "profile is required" would be
    // wrong now: it is required *somewhere*, and the workspace is the other place.
    const profile = problems.find((problem) => problem.path === 'profile');
    expect(profile?.message).toContain('workspace');
  });

  it('runs a task end to end and stores the config exactly as used', async () => {
    daemon = await startTestDaemon(ONE_EDIT);
    const taskPath = daemon.fixture.taskPath('e2e', { checks: ['echo'] });
    const created = await daemon.request('POST', '/runs', { body: { taskPath } });
    expect(created.status).toBe(201);
    const runId = String(created.body.id);

    const events = await daemon.collect(runId);
    expect(statusesOf(events)).toContain('running');
    expect(daemon.fixture.read('src/a.ts')).toBe('export const a = 2;\n');

    const detail = await daemon.request('GET', `/runs/${runId}`);
    expect(detail.status).toBe(200);
    const run = detail.body as unknown as {
      status: string;
      config: { task: string; limits: { turns: number } };
    };
    expect(run.status).toBe('finished');
    expect(run.config.task).toContain('Change the constant');
    expect(run.config.limits.turns).toBe(12);

    const summary = events.find((event) => event.type === 'summary');
    expect(summary?.type === 'summary' && summary.text).toBe('bumped the constant');

    const metrics = events.find((event) => event.type === 'metrics');
    expect(metrics?.type === 'metrics' && metrics.call.promptTokens).toBeGreaterThan(0);
  });

  it("reports a run's progress while it is still running, not only once it stops", async () => {
    // Found live. `state.turns` and `state.totals` were kept in the supervisor
    // and written to the row only when a `status` event arrived, which for a
    // normal run is once at the start. A run that was 44 turns and 200,000
    // prompt tokens deep reported 0 and 0 to `dsh list`, `dsh show` and the UI,
    // and reported the real numbers only once it had finished, when there was
    // nothing left to watch. The second turn is deliberately slow, so the run is
    // still going when the row is read.
    daemon = await startTestDaemon([
      { toolCalls: [{ name: 'list_dir', args: { path: '.' } }], completionTokens: 40 },
      { text: 'still thinking about it', delayMs: 4000 },
    ]);
    const taskPath = daemon.fixture.taskPath('progress', {});
    const created = await daemon.request('POST', '/runs', { body: { taskPath } });
    const runId = String(created.body.id);

    // POST queues the run and an attach is what starts it, so the socket has to
    // be held open for the run to be live while the row is read.
    const socket = daemon.attach(runId);
    await new Promise<void>((resolve) => socket.once('open', () => resolve()));

    type Row = { status: string; turns: number; totals: { completionTokens: number } };
    const deadline = Date.now() + 15_000;
    let seen: Row | null = null;
    while (Date.now() < deadline) {
      const detail = await daemon.request('GET', `/runs/${runId}`);
      const row = detail.body as unknown as Row;
      if (row.turns > 0) {
        seen = row;
        break;
      }
      await delay(30);
    }
    socket.close();

    expect(seen).not.toBeNull();
    if (seen === null) throw new Error('unreachable');
    // The point: progress is readable while the run is still going.
    expect(seen.status).toBe('running');
    expect(seen.turns).toBeGreaterThanOrEqual(1);
    expect(seen.totals.completionTokens).toBeGreaterThan(0);
  });

  it('refuses a task whose profile is inside the worktree', async () => {
    daemon = await startTestDaemon(ONE_EDIT);
    const insideProfile = path.join(daemon.fixture.repo, 'profile.json');
    fs.writeFileSync(insideProfile, JSON.stringify({ checks: {} }));
    const task = path.join(daemon.fixture.base, 'inside.json');
    fs.writeFileSync(
      task,
      JSON.stringify({
        name: 'inside',
        worktree: daemon.fixture.repo,
        profile: insideProfile,
        model: 'deepseek-flash',
        allow: ['src/a.ts'],
        task: 'nothing',
      }),
    );
    const created = await daemon.request('POST', '/runs', { body: { taskPath: task } });
    const runId = String(created.body.id);
    const events = await daemon.collect(runId);
    const failure = events.find((event) => event.type === 'error');
    expect(failure?.type === 'error' && failure.message).toContain('inside the sandbox');
    const detail = await daemon.request('GET', `/runs/${runId}`);
    expect((detail.body as unknown as { status: string }).status).toBe('failed');
  });

  it('turns a run left running by a crash into interrupted', async () => {
    const home = fs.mkdtempSync(path.join(process.env.TEMP ?? '/tmp', 'dsh-restart-'));
    const file = path.join(home, 'runs.db');
    const first = new Store(file);
    first.createRun({
      id: 'run-old',
      name: 'left behind',
      detached: true,
      createdAt: new Date().toISOString(),
      config: {
        name: 'left behind',
        worktree: home,
        profile: path.join(home, 'p.json'),
        profileHash: 'x',
        model: 'deepseek-flash',
        allow: ['src/a.ts'],
        checks: [],
        task: 'x',
        limits: {
          turns: 1,
          wallSeconds: 1,
          outputTokens: 1,
          totalTokens: 2,
          contextTokens: 500_000,
          askSeconds: 1,
          costUsd: 0.05,
        },
        sourcePath: null,
        configPath: path.join(home, 'task.json'),
        raw: {},
        resolvedProfile: {},
        workspace: null,
        rules: '',
        soft: [],
        commands: {},
        env: {},
        setup: [],
        onAsk: null,
      },
    });
    first.setStatus('run-old', 'running');
    first.close();

    const reopened = new Store(file);
    expect(reopened.markRunningAsInterrupted()).toBe(1);
    expect(reopened.getRun('run-old')?.status).toBe('interrupted');
    reopened.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('ends an interrupted run at its last event, not at the moment it was noticed', async () => {
    // Found by running against real runs: two of them were marked interrupted by
    // a daemon started the next morning, and their end times were set to that
    // moment. `dsh list` reported 13,281 seconds for a run of a few minutes, and
    // the wall-clock limit looked like the thing that had stopped them. A run's
    // duration is a fact about the run.
    const home = fs.mkdtempSync(path.join(process.env.TEMP ?? '/tmp', 'dsh-interrupt-'));
    const file = path.join(home, 'runs.db');
    const started = '2026-01-01T10:00:00.000Z';
    const lastEvent = '2026-01-01T10:04:00.000Z';

    const store = new Store(file);
    store.createRun({
      id: 'run-crashed',
      name: 'crashed',
      detached: true,
      createdAt: started,
      config: {
        name: 'crashed',
        worktree: home,
        profile: path.join(home, 'p.json'),
        profileHash: 'x',
        model: 'deepseek-flash',
        allow: ['src/a.ts'],
        checks: [],
        task: 'x',
        limits: {
          turns: 50,
          wallSeconds: 3600,
          outputTokens: 1000,
          totalTokens: 1000,
          contextTokens: 500_000,
          askSeconds: 1,
          costUsd: 0.05,
        },
        sourcePath: null,
        configPath: path.join(home, 'task.json'),
        raw: {},
        resolvedProfile: {},
        workspace: null,
        rules: '',
        soft: [],
        commands: {},
        env: {},
        setup: [],
        onAsk: null,
      },
    });
    store.setStatus('run-crashed', 'running');
    store.appendEvent('run-crashed', { type: 'turn.start', turn: 1 }, started);
    store.appendEvent('run-crashed', { type: 'turn.start', turn: 2 }, lastEvent);
    store.close();

    // Reopened much later, as a daemon started the next morning would.
    const reopened = new Store(file);
    expect(reopened.markRunningAsInterrupted()).toBe(1);
    const run = reopened.getRun('run-crashed');
    expect(run?.status).toBe('interrupted');
    // Four minutes, not however long the machine was asleep.
    expect(run?.endedAt).toBe(lastEvent);
    reopened.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('cancels a run and leaves nothing behind', async () => {
    // The model hangs, and a check that never exits is running underneath it.
    daemon = await startTestDaemon([{ toolCalls: [{ name: 'run_check', args: { name: 'slow' } }] }]);
    const taskPath = daemon.fixture.taskPath('cancel-me', { limits: { wallSeconds: 600 } });
    const created = await daemon.request('POST', '/runs', { body: { taskPath } });
    const runId = String(created.body.id);

    const socket = daemon.attach(runId);
    await new Promise<void>((resolve) => {
      socket.on('message', (raw: Buffer) => {
        const message = JSON.parse(raw.toString('utf8')) as {
          type: string;
          event?: { type: string; name?: string };
        };
        if (message.type === 'event' && message.event?.type === 'tool.call') resolve();
      });
      setTimeout(resolve, 10_000);
    });

    const cancelled = await daemon.request('POST', `/runs/${runId}/cancel`);
    expect(cancelled.status).toBe(200);

    // The worker gets a moment to abort and reap its own checks before the
    // daemon kills the tree; either way it is gone quickly.
    const deadline = Date.now() + 3000;
    while (daemon.supervisor.isLive(runId) && Date.now() < deadline) await delay(50);
    expect(daemon.supervisor.isLive(runId)).toBe(false);

    const detail = await daemon.request('GET', `/runs/${runId}`);
    expect((detail.body as unknown as { status: string }).status).toBe('cancelled');
    socket.terminate();
  });
});
