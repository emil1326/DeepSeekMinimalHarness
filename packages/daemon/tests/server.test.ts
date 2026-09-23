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

  it('refuses a Host that is not this daemon', async () => {
    daemon = await startTestDaemon(ONE_EDIT);
    const response = await daemon.request('GET', '/runs', { headers: { host: 'evil.example.com' } });
    expect(response.status).toBe(403);
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
        limits: { turns: 1, wallSeconds: 1, outputTokens: 1, askSeconds: 1 },
        sourcePath: null,
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
