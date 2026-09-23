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
  it('refuses a request that carries no token', async () => {
    daemon = await startTestDaemon(ONE_EDIT);
    const response = await daemon.request('GET', '/runs', { auth: false });
    expect(response.status).toBe(401);
    expect(String(response.body.error)).toContain('token');
  });

  it('refuses an Origin that is not the UI', async () => {
    daemon = await startTestDaemon(ONE_EDIT);
    const response = await daemon.request('GET', '/runs', { headers: { origin: 'https://example.com' } });
    expect(response.status).toBe(403);
  });

  it("refuses Origin: null, which is what somebody else's page sends", async () => {
    // A sandboxed iframe and a `file://` page both send the literal string
    // "null", which is the one value that means "a page, but not a page I can
    // name" while looking like "no page at all". The token is still the wall
    // here, since a SameSite=Strict cookie is not sent cross-site, so this is
    // depth rather than the defence. It costs nothing to refuse: the CLI and
    // curl send no Origin at all rather than a null one.
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

  it('refuses an upgrade from a foreign Origin, and one with no token', async () => {
    daemon = await startTestDaemon(ONE_EDIT);
    const foreign = await new Promise<number>((resolve, reject) => {
      const client = new WebSocket(`ws://127.0.0.1:${daemon?.port ?? 0}/events`, {
        origin: 'https://example.com',
        headers: { authorization: `Bearer ${daemon?.token ?? ''}` },
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

    const unauthenticated = await new Promise<number>((resolve, reject) => {
      const client = new WebSocket(`ws://127.0.0.1:${daemon?.port ?? 0}/events`);
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
    expect(unauthenticated).toBe(401);
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
    expect(paths).toContain('profile');
    expect(paths).toContain('model');
    expect(paths).toContain('extra');
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
        },
        sourcePath: null,
        configPath: path.join(home, 'task.json'),
        raw: {},
        resolvedProfile: {},
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
        },
        sourcePath: null,
        configPath: path.join(home, 'task.json'),
        raw: {},
        resolvedProfile: {},
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
