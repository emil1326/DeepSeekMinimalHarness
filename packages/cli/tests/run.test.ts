/**
 * The CLI, driven as a real process against a real daemon and a real worker.
 *
 * The load-bearing test is the last one: kill the CLI hard and prove, within two
 * seconds, that the worker and a long-running check process it started are both
 * gone. A cancel that leaves a check behind is the failure this whole design
 * exists to prevent.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { delay, isAlive, killTree } from '@emilswork/harness-core';
import { startFakeDeepSeek, type ScriptedTurn } from '../../core/tests/fake-server.js';

const CLI = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
const DAEMON = fileURLToPath(new URL('../../daemon/dist/main.js', import.meta.url));

interface Bench {
  home: string;
  repo: string;
  taskPath: string;
  pidFile: string;
  env: NodeJS.ProcessEnv;
  daemonPid: number;
  stop(): Promise<void>;
}

const benches: Bench[] = [];

afterEach(async () => {
  while (benches.length > 0) await benches.pop()?.stop();
});

async function waitFor(check: () => boolean, timeoutMs: number, everyMs = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await delay(everyMs);
  }
  return check();
}

/** A daemon on its own harness home, pointed at a fake DeepSeek. */
async function bench(script: ScriptedTurn[]): Promise<Bench> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cli-'));
  const keyFile = path.join(home, 'api_key');
  fs.writeFileSync(keyFile, 'a-test-key-that-is-never-real\n');

  const fake = await startFakeDeepSeek(script);

  const repo = path.join(home, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  execFileSync('git', ['init', '-q', repo], { stdio: 'ignore' });
  fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  const git = (args: string[]): void => {
    execFileSync('git', ['-c', 'user.name=dsh tests', '-c', 'user.email=dsh@example.invalid', ...args], {
      cwd: repo,
      stdio: 'ignore',
    });
  };
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'start']);

  const pidFile = path.join(home, 'pids.json');
  const slow = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(pidFile)},JSON.stringify({check:process.pid,worker:process.ppid}));setInterval(function(){},1000)`;
  const profile = path.join(home, 'profile.json');
  fs.writeFileSync(
    profile,
    JSON.stringify({
      checks: {
        slow: { run: [process.execPath, '-e', slow] },
        echo: { run: [process.execPath, '-e', "console.log('ran')"] },
      },
      format: [],
    }),
  );

  const taskPath = path.join(home, 'task.json');
  fs.writeFileSync(
    taskPath,
    JSON.stringify({
      name: 'cli-case',
      worktree: repo,
      profile,
      model: 'deepseek-flash',
      allow: ['src/a.ts'],
      task: 'Change the constant in src/a.ts.',
      limits: { turns: 20, wallSeconds: 300 },
    }),
  );

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DSH_HOME: home,
    DSH_KEY_FILE: keyFile,
    DSH_BASE_URL: fake.url,
    DSH_DAEMON_TIMEOUT_MS: '10000',
  };

  const daemon = spawn(process.execPath, [DAEMON], { env, stdio: 'ignore', windowsHide: true });
  const daemonFile = path.join(home, 'daemon.json');
  const up = await waitFor(() => fs.existsSync(daemonFile), 15_000);
  if (!up) throw new Error('the daemon never wrote its daemon.json');

  const entry: Bench = {
    home,
    repo,
    taskPath,
    pidFile,
    env,
    daemonPid: daemon.pid ?? -1,
    stop: async () => {
      killTree(daemon.pid ?? -1);
      await fake.close();
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
  benches.push(entry);
  return entry;
}

interface RunResult {
  code: number | null;
  output: string;
}

function runCli(
  entry: Bench,
  args: string[],
  waitMs = 30_000,
): { child: ChildProcess; done: Promise<RunResult>; output: () => string } {
  const child = spawn(process.execPath, [CLI, ...args], {
    env: entry.env,
    cwd: entry.repo,
    windowsHide: true,
  });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });
  const done = new Promise<RunResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`the CLI did not finish within ${waitMs} ms. Output so far:\n${output}`));
    }, waitMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
    child.on('error', reject);
  });
  return { child, done, output: () => output };
}

/** A one-shot command, for `dsh send`, `dsh reply` and `dsh cancel`. */
async function quickCli(entry: Bench, args: string[]): Promise<RunResult> {
  const { done } = runCli(entry, args, 15_000);
  return done;
}

async function runIdOf(entry: Bench, output: () => string): Promise<string | null> {
  const found = await waitFor(() => /"runId":"(run-[0-9a-f]+)"/.test(output()), 20_000);
  if (!found) return null;
  return /"runId":"(run-[0-9a-f]+)"/.exec(output())?.[1] ?? null;
}

describe('the dsh command', () => {
  it('runs a task to the end and exits 0', async () => {
    const entry = await bench([
      { toolCalls: [{ name: 'replace_in_file', args: { path: 'src/a.ts', old: '= 1', new: '= 7' } }] },
      { toolCalls: [{ name: 'finish', args: { summary: 'bumped it to seven' } }] },
    ]);
    const { done } = runCli(entry, ['run', entry.taskPath]);
    const result = await done;
    expect(result.output).toContain('bumped it to seven');
    expect(result.code).toBe(0);
    expect(fs.readFileSync(path.join(entry.repo, 'src', 'a.ts'), 'utf8')).toBe('export const a = 7;\n');
  });

  it('prints one JSON event per line with --json', async () => {
    const entry = await bench([
      { toolCalls: [{ name: 'replace_in_file', args: { path: 'src/a.ts', old: '= 1', new: '= 8' } }] },
      { toolCalls: [{ name: 'finish', args: { summary: 'to eight' } }] },
    ]);
    const { done } = runCli(entry, ['run', entry.taskPath, '--json']);
    const result = await done;
    const lines = result.output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
    const parsed = lines.map((line) => JSON.parse(line) as { type: string });
    expect(parsed.some((event) => event.type === 'tool.call')).toBe(true);
    expect(parsed.some((event) => event.type === 'metrics')).toBe(true);
    expect(parsed[parsed.length - 1]?.type).toBe('exit');
  });

  it('exits 4 and prints every problem when the task file is bad', async () => {
    const entry = await bench([{ text: 'never used' }]);
    const bad = path.join(entry.home, 'bad.json');
    fs.writeFileSync(bad, JSON.stringify({ name: 'bad', allow: [], model: 3, nope: true }));
    const { done } = runCli(entry, ['run', bad]);
    const result = await done;
    expect(result.code).toBe(4);
    for (const field of ['worktree', 'profile', 'model', 'allow', 'nope']) {
      expect(result.output).toContain(field);
    }
  });

  it('exits 4 when the task file is not there', async () => {
    const entry = await bench([{ text: 'never used' }]);
    const { done } = runCli(entry, ['run', path.join(entry.home, 'nothing-here.json')]);
    const result = await done;
    expect(result.code).toBe(4);
  });

  it('exits 5 when no daemon can be reached or started', async () => {
    const blocked = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-blocked-'));
    const wall = path.join(blocked, 'a-file');
    fs.writeFileSync(wall, 'not a directory');
    const child = spawn(process.execPath, [CLI, 'list'], {
      env: { ...process.env, DSH_HOME: path.join(wall, 'home'), DSH_DAEMON_TIMEOUT_MS: '2000' },
      windowsHide: true,
    });
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
    expect(code).toBe(5);
    expect(output).toContain('did not come up');
    fs.rmSync(blocked, { recursive: true, force: true });
  });

  it('answers a question from the launcher and carries on', async () => {
    const entry = await bench([
      { toolCalls: [{ name: 'ask', args: { question: 'which of the two files did you mean?' } }] },
      { toolCalls: [{ name: 'finish', args: { summary: 'answered, and done' } }] },
    ]);
    const { done, output } = runCli(entry, ['run', entry.taskPath, '--json'], 60_000);
    const runId = await runIdOf(entry, output);
    expect(runId).not.toBeNull();

    const asked = await waitFor(() => output().includes('"type":"question"'), 20_000);
    expect(asked).toBe(true);

    const replied = await quickCli(entry, ['reply', runId as string, 'the ts one']);
    expect(replied.code).toBe(0);
    expect(replied.output).toContain('answered');

    const result = await done;
    expect(result.code).toBe(0);
    expect(result.output).toContain('"type":"answer"');
    expect(result.output).toContain('answered, and done');
  }, 90_000);

  it('cancels a run from a second command and the first one exits 2', async () => {
    const entry = await bench([{ hang: true }]);
    const { done, output } = runCli(entry, ['run', entry.taskPath, '--json'], 60_000);
    const runId = await runIdOf(entry, output);
    expect(runId).not.toBeNull();

    const cancelled = await quickCli(entry, ['cancel', runId as string]);
    expect(cancelled.code).toBe(0);

    const result = await done;
    expect(result.code).toBe(2);
    expect(result.output).toContain('"status":"cancelled"');
  }, 90_000);

  it('kills the worker and every check it started when the CLI is killed hard', async () => {
    // First turn: a check that never exits, and writes down both PIDs. After
    // that the model hangs, so the run is still going when the CLI dies.
    const entry = await bench([
      { toolCalls: [{ name: 'run_check', args: { name: 'slow' } }] },
      { hang: true },
    ]);
    const { child, done } = runCli(entry, ['run', entry.taskPath, '--json'], 60_000);
    void done.catch(() => undefined);

    const started = await waitFor(() => fs.existsSync(entry.pidFile), 30_000);
    expect(started).toBe(true);
    const pids = JSON.parse(fs.readFileSync(entry.pidFile, 'utf8')) as { check: number; worker: number };
    expect(isAlive(pids.check)).toBe(true);
    expect(isAlive(pids.worker)).toBe(true);

    // Killed hard: TerminateProcess, no chance to clean up. The socket closing
    // is what has to make the daemon cancel, checks and all.
    const killedAt = Date.now();
    child.kill();

    const gone = await waitFor(() => !isAlive(pids.check) && !isAlive(pids.worker), 2000);
    const tookMs = Date.now() - killedAt;
    expect({
      checkGone: !isAlive(pids.check),
      workerGone: !isAlive(pids.worker),
      withinTwoSeconds: tookMs <= 2000,
    }).toEqual({ checkGone: true, workerGone: true, withinTwoSeconds: true });
    void gone;
  }, 90_000);
});
