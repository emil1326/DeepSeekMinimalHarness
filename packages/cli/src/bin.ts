#!/usr/bin/env node
/**
 * `dsh`, the command.
 *
 * `dsh run` attaches over a WebSocket and the run's lifetime is tied to that
 * connection unless `--detach` was given. Ctrl+C sends an explicit cancel and
 * waits up to three seconds for `cancelled`. Killed hard, the socket closes and
 * the daemon cancels instead. Either way nothing survives.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Command } from 'commander';
import {
  isTerminal,
  loadHarnessConfig,
  uiHostnames,
  type RunEvent,
  type RunStatus,
} from '@emilswork/harness-core';
import type {
  AttachMessage,
  DiffResponse,
  RunDetail,
  RunSummary,
  StatsResponse,
} from '@emilswork/harness-daemon';
import { ApiFailure, DaemonClient, DaemonUnreachable, exitCodeFor, readDaemonRecord } from './client.js';
import { Renderer, pad, statusWord, useColor } from './render.js';

const program = new Command();
program
  .name('dsh')
  .description("Emil's DeepSeek Harness: sandboxed DeepSeek agents in a git worktree")
  .version('0.1.0');

/** Every action goes through here, so a failure is one readable line and one exit code. */
async function guard(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (error instanceof DaemonUnreachable) {
      process.stderr.write(`dsh: ${error.message}\n`);
      process.exitCode = 5;
      return;
    }
    if (error instanceof ApiFailure) {
      process.stderr.write(`dsh: ${error.message}\n`);
      for (const problem of error.problems) {
        process.stderr.write(
          `  ${problem.path}: ${problem.message}${problem.file === null ? '' : `  (${problem.file})`}\n`,
        );
      }
      process.exitCode = problemExitCode(error);
      return;
    }
    process.stderr.write(`dsh: ${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}

function problemExitCode(error: ApiFailure): number {
  if (error.status === 400) return 4;
  if (error.status === 401 || error.status === 403) return 5;
  return 1;
}

program
  .command('run')
  .argument('<task>', 'the task JSON file')
  .option('--json', 'print one JSON event per line')
  .option('--detach', 'start the run and return without watching it')
  .description('start a run and stream it until it ends')
  .action((task: string, options: { json?: boolean; detach?: boolean }) =>
    guard(async () => {
      const taskPath = path.resolve(task);
      if (!fs.existsSync(taskPath)) {
        process.stderr.write(`dsh: no such task file: ${taskPath}\n`);
        process.exitCode = 4;
        return;
      }
      const client = await DaemonClient.connect();
      let created: { id: string; detail: RunDetail };
      try {
        created = await client.json<{ id: string; detail: RunDetail }>('POST', '/runs', {
          taskPath,
          detached: options.detach === true,
        });
      } catch (error) {
        if (error instanceof ApiFailure) {
          process.stderr.write(`dsh: ${error.message}\n`);
          for (const problem of error.problems) {
            process.stderr.write(
              `  ${problem.path}: ${problem.message}${problem.file === null ? '' : `  (${problem.file})`}\n`,
            );
          }
          process.exitCode = 4;
          return;
        }
        throw error;
      }

      if (options.detach === true) {
        process.stdout.write(`${created.id}\n`);
        return;
      }
      process.exitCode = await stream(client, created.id, options.json === true);
    }),
  );

program
  .command('send')
  .argument('<run>')
  .argument('<message>')
  .description('tell a running agent something')
  .action((run: string, message: string) =>
    guard(async () => {
      const client = await DaemonClient.connect();
      await client.json('POST', `/runs/${run}/messages`, { text: message, by: 'claude' });
      process.stdout.write(`sent to ${run}\n`);
    }),
  );

program
  .command('reply')
  .argument('<run>')
  .argument('<answer>')
  .description('answer the question the agent is waiting on')
  .action((run: string, answer: string) =>
    guard(async () => {
      const client = await DaemonClient.connect();
      const result = await client.json<{ ok: boolean; id: string }>('POST', `/runs/${run}/answers`, {
        text: answer,
        by: 'claude',
      });
      process.stdout.write(`answered ${run} (${result.id})\n`);
    }),
  );

program
  .command('cancel')
  .argument('<run>')
  .description('cancel a run and everything it started')
  .action((run: string) =>
    guard(async () => {
      const client = await DaemonClient.connect();
      await client.json('POST', `/runs/${run}/cancel`);
      process.stdout.write(`cancelled ${run}\n`);
    }),
  );

program
  .command('list')
  .description('every run, most recent first')
  .action(() =>
    guard(async () => {
      const client = await DaemonClient.connect();
      const { runs } = await client.runs();
      if (runs.length === 0) {
        process.stdout.write('no runs yet\n');
        return;
      }
      process.stdout.write(
        `${pad('ID', 14)}${pad('NAME', 22)}${pad('STATUS', 16)}${pad('MODEL', 18)}${pad('TURNS', 7)}${pad('OUT TOK', 9)}${pad('GEN/S', 8)}${pad('COST', 9)}${pad('DURATION', 10)}\n`,
      );
      for (const run of runs) {
        process.stdout.write(
          `${pad(run.id, 14)}${pad(run.name, 22)}${pad(statusWord(run.status), 16)}${pad(run.model, 18)}${pad(String(run.turns), 7)}${pad(String(run.totals.completionTokens), 9)}${pad(speed(run), 8)}${pad(cost(run), 9)}${pad(duration(run), 10)}\n`,
        );
      }
    }),
  );

program
  .command('show')
  .argument('<run>')
  .description('one run: status, totals and the config it ran with')
  .action((run: string) =>
    guard(async () => {
      const client = await DaemonClient.connect();
      const detail = await client.run(run);
      process.stdout.write(`${JSON.stringify(detail, null, 2)}\n`);
    }),
  );

program
  .command('logs')
  .argument('<run>')
  .option('--json', 'print one JSON event per line')
  .description('everything a run did, replayed')
  .action((run: string, options: { json?: boolean }) =>
    guard(async () => {
      const client = await DaemonClient.connect();
      const { events } = await client.events(run);
      const renderer = new Renderer((text) => process.stdout.write(text), {
        json: options.json === true,
        color: useColor(),
      });
      for (const event of events) renderer.event(event);
      if (options.json !== true) process.stdout.write('\n');
    }),
  );

program
  .command('diff')
  .argument('<run>')
  .description("the worktree's current diff, with stray changes flagged")
  .action((run: string) =>
    guard(async () => {
      const client = await DaemonClient.connect();
      const body = await client.json<DiffResponse>('GET', `/runs/${run}/diff`);
      if (body.stray.length > 0) {
        process.stdout.write(`STRAY CHANGES OUTSIDE THE ALLOWED FILES: ${body.stray.join(', ')}\n\n`);
      }
      process.stdout.write(body.diff === '' ? '(no changes)\n' : body.diff);
    }),
  );

program
  .command('stats')
  .description('speed and cost per model, from every run so far')
  .action(() =>
    guard(async () => {
      const client = await DaemonClient.connect();
      const stats = await client.json<StatsResponse>('GET', '/stats');
      if (stats.models.length === 0) {
        process.stdout.write('no model calls recorded yet\n');
        return;
      }
      process.stdout.write(
        `${pad('MODEL', 20)}${pad('CALLS', 7)}${pad('IN TOK', 10)}${pad('CACHED', 10)}${pad('OUT TOK', 10)}${pad('FIRST TOK', 11)}${pad('GEN/S', 8)}${pad('E2E/S', 8)}${pad('COST', 10)}\n`,
      );
      for (const model of stats.models) {
        process.stdout.write(
          `${pad(model.model, 20)}${pad(String(model.calls), 7)}${pad(String(model.promptTokens), 10)}${pad(String(model.cacheHitTokens), 10)}${pad(String(model.completionTokens), 10)}${pad(seconds(model.timeToFirstTokenMs), 11)}${pad(number(model.generationTokensPerSecond), 8)}${pad(number(model.endToEndTokensPerSecond), 8)}${pad(model.costUsd === null ? '-' : `$${model.costUsd.toFixed(4)}`, 10)}\n`,
        );
      }
      process.stdout.write(
        `\nfrom ${stats.runs} run(s). Prices come from ${'config.json'} in the harness home.\n`,
      );
    }),
  );

program
  .command('ui')
  .description('open the UI, logged in')
  .action(() =>
    guard(async () => {
      const client = await DaemonClient.connect();
      const { ticket } = await client.json<{ ticket: string }>('POST', '/ui/ticket');
      // The name from `config.json` when there is one. It has to be the name the
      // browser ends up on, because the session cookie is set for the host it
      // was sent to: signing in at 127.0.0.1 and then browsing at another name
      // is a second, empty session. `DaemonClient` still talks to the loopback
      // address itself, which is the host the daemon always answers to.
      const [name] = uiHostnames(loadHarnessConfig());
      const url = `http://${name ?? '127.0.0.1'}:${client.port}/ui/session?ticket=${ticket}`;
      process.stdout.write(`${url}\n`);
      openBrowser(url);
    }),
  );

const daemon = program.command('daemon').description('the daemon that runs the agents');

daemon
  .command('start')
  .description('start it if it is not already up')
  .action(() =>
    guard(async () => {
      const client = await DaemonClient.connect();
      const health = await client.health();
      process.stdout.write(`running on 127.0.0.1:${health.port} (pid ${health.pid})\n`);
    }),
  );

daemon
  .command('status')
  .description('whether it is up, and what it is holding')
  .action(() =>
    guard(async () => {
      const record = readDaemonRecord();
      if (record === null) {
        process.stdout.write('not running\n');
        return;
      }
      try {
        const client = new DaemonClient(record);
        const health = await client.health();
        const { runs } = await client.runs();
        const live = runs.filter((run) => !isTerminal(run.status)).length;
        process.stdout.write(
          `running on 127.0.0.1:${health.port} (pid ${health.pid}) | ${runs.length} run(s), ${live} still going\n`,
        );
      } catch {
        process.stdout.write(
          `a stale daemon.json points at port ${record.port}, but nothing answers there\n`,
        );
      }
    }),
  );

daemon
  .command('stop')
  .description('stop it and cancel everything it is running')
  .action(() =>
    guard(async () => {
      const record = readDaemonRecord();
      if (record === null) {
        process.stdout.write('not running\n');
        return;
      }
      try {
        await new DaemonClient(record).json('POST', '/daemon/stop');
        process.stdout.write('stopped\n');
      } catch {
        process.stdout.write('not running\n');
      }
    }),
  );

/** Attach, stream, and own the run. Returns the exit code. */
function stream(client: DaemonClient, runId: string, json: boolean): Promise<number> {
  return new Promise<number>((resolve) => {
    const socket = client.attach(runId);
    const renderer = new Renderer((text) => process.stdout.write(text), { json, color: useColor() });
    let lastStatus: RunStatus | null = null;
    let settled = false;
    let asked = false;

    const settle = (status: RunStatus): void => {
      if (settled) return;
      settled = true;
      process.removeListener('SIGINT', onSigint);
      if (json)
        process.stdout.write(`${JSON.stringify({ type: 'exit', status, code: exitCodeFor(status) })}\n`);
      // The socket is what owned the run; leaving it open would both keep the
      // process alive and look like somebody is still watching.
      socket.removeAllListeners();
      socket.close();
      socket.terminate();
      resolve(exitCodeFor(status));
    };

    const note = (event: RunEvent): void => {
      renderer.event(event);
      if (event.type === 'status') lastStatus = event.status;
    };

    socket.on('message', (raw: Buffer) => {
      const message = JSON.parse(raw.toString('utf8')) as AttachMessage;
      if (message.type === 'hello') {
        for (const event of message.events) note(event);
        if (isTerminal(message.detail.status)) settle(message.detail.status);
        return;
      }
      if (message.type === 'event') note(message.event);
      if (message.type === 'bye') settle(message.status);
    });

    socket.on('error', (error: Error) => {
      process.stderr.write(`dsh: the connection to the daemon failed: ${error.message}\n`);
      settle(lastStatus ?? 'interrupted');
    });

    socket.on('close', () => {
      // Killed hard, or the daemon went away. The daemon cancels on its side.
      settle(lastStatus ?? 'interrupted');
    });

    const onSigint = (): void => {
      if (asked) {
        process.exit(2);
      }
      asked = true;
      process.stderr.write('\ndsh: cancelling; nothing it started will survive\n');
      void client.json('POST', `/runs/${runId}/cancel`).catch(() => undefined);
      const deadline = Date.now() + 3000;
      const poll = setInterval(() => {
        if (lastStatus === 'cancelled' || Date.now() > deadline) {
          clearInterval(poll);
          process.exit(2);
        }
      }, 100);
    };
    process.on('SIGINT', onSigint);
  });
}

function speed(run: RunSummary): string {
  const value = run.totals.generationTokensPerSecond;
  return value === null ? '-' : value.toFixed(0);
}

function cost(run: RunSummary): string {
  return run.totals.costUsd === null ? '-' : `$${run.totals.costUsd.toFixed(4)}`;
}

function duration(run: RunSummary): string {
  const start = run.startedAt === null ? null : Date.parse(run.startedAt);
  if (start === null) return '-';
  const end = run.endedAt === null ? Date.now() : Date.parse(run.endedAt);
  return `${Math.max(0, Math.round((end - start) / 1000))}s`;
}

function seconds(value: number | null): string {
  return value === null ? '-' : `${(value / 1000).toFixed(2)}s`;
}

function number(value: number | null): string {
  return value === null ? '-' : value.toFixed(1);
}

function openBrowser(url: string): void {
  const [command, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

await program.parseAsync(process.argv);
