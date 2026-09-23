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
  elapsedSeconds,
  formatCount,
  isTerminal,
  limitUse,
  loadHarnessConfig,
  toolCatalogue,
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
import { Renderer, colour as withColour, indent, pad, statusWord, useColor } from './render.js';

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
      // STATUS is wide enough for "stopped at limit" (16) and NAME for the
      // longest task name seen in practice. Before the padding was right,
      // `list` printed `stopped at limitdeepseek-flash`: the status ran into the
      // model column with nothing between them.
      process.stdout.write(
        `${pad('ID', 14)}${pad('NAME', 24)}${pad('STATUS', 17)}${pad('MODEL', 17)}${pad('TURNS', 8)}${pad('OUT TOK', 9)}${pad('TOK/S', 8)}${pad('COST', 9)}${pad('LIMIT', 12)}${pad('DURATION', 10)}\n`,
      );
      for (const run of runs) {
        process.stdout.write(
          `${pad(run.id, 14)}${pad(run.name, 24)}${pad(statusWord(run.status), 17)}${pad(run.model, 17)}${pad(String(run.turns), 8)}${pad(String(run.totals.completionTokens), 9)}${pad(speed(run), 8)}${pad(cost(run), 9)}${pad(nearestLimit(run), 12)}${pad(duration(run), 10)}\n`,
        );
      }
    }),
  );

program
  .command('limits')
  .argument('<run>')
  .description('what a run has used of each of its budgets')
  .action((run: string) =>
    guard(async () => {
      const client = await DaemonClient.connect();
      const detail = await client.run(run);
      const uses = limitUse(
        {
          turns: detail.turns,
          // To the run's own end, not to now. A finished run's wall clock does
          // not keep growing while nobody is looking at it.
          elapsedSeconds: elapsedSeconds({ startedAt: detail.startedAt, endedAt: detail.endedAt }),
          totals: detail.totals,
        },
        detail.config.limits,
      );
      process.stdout.write(`${pad('LIMIT', 16)}${pad('USED', 12)}${pad('OF', 12)}${pad('LEFT', 12)}\n`);
      // A terminal run with no end time cannot say how long it ran, and
      // guessing "until now" reports a five-figure wall clock for a run of a few
      // minutes. Saying so is better than a number that is plainly wrong.
      const wallClockKnown = !(isTerminal(detail.status) && detail.endedAt === null);
      for (const use of uses) {
        if (use.which === 'wallSeconds' && !wallClockKnown) {
          process.stdout.write(`${pad(use.which, 16)}${pad('unknown', 12)}${pad('?', 12)}${pad('?', 12)}\n`);
          continue;
        }
        const left = Math.max(0, use.budget - use.used);
        process.stdout.write(
          `${pad(use.which, 16)}${pad(formatCount(use.used), 12)}${pad(formatCount(use.budget), 12)}${pad(formatCount(left), 12)}\n`,
        );
      }
      process.stdout.write(
        `\nContext window  ${formatCount(detail.config.limits.contextTokens)} tokens per request.\n` +
          `totalTokens counts BILLED tokens: prompt cache misses plus output. Cache hits are\n` +
          `about a tenth of a miss, so counting them at full price bounded nothing worth\n` +
          `bounding and killed runs that had spent almost nothing.\n` +
          `\nRaise one with: dsh limit ${run} --turns 60   (figures are absolute, +30 adds 30)\n`,
      );
    }),
  );

program
  .command('limit')
  .argument('<run>')
  .description('grant a running agent more room')
  .option('--turns <n>', 'turns to allow')
  .option('--wallSeconds <n>', 'wall clock seconds to allow')
  .option('--outputTokens <n>', 'output tokens to allow')
  .option('--totalTokens <n>', 'billed tokens to allow')
  .action(
    (
      run: string,
      options: {
        turns?: string;
        wallSeconds?: string;
        outputTokens?: string;
        totalTokens?: string;
      },
    ) =>
      guard(async () => {
        const client = await DaemonClient.connect();
        const detail = await client.run(run);
        const patch: Record<string, number> = {};
        const names = ['turns', 'wallSeconds', 'outputTokens', 'totalTokens'] as const;
        for (const name of names) {
          const given = options[name];
          if (given === undefined) continue;
          const value = absoluteLimit(given, detail.config.limits[name], name);
          patch[name] = value;
        }
        if (Object.keys(patch).length === 0) {
          process.stderr.write(
            'dsh: give at least one of --turns, --wallSeconds, --outputTokens, --totalTokens\n',
          );
          process.exitCode = 1;
          return;
        }
        const answer = await client.json<{ ok: boolean; limits: Record<string, number> }>(
          'POST',
          `/runs/${run}/limits`,
          patch,
        );
        process.stdout.write(
          `${run} now has ${Object.entries(answer.limits)
            .map(([name, value]) => `${name} ${value}`)
            .join(', ')}\n`,
        );
      }),
  );

/**
 * `60` means sixty, `+30` means thirty more than it has now.
 *
 * Relative is what a person reaches for when an agent asks for more room, and
 * absolute is what goes on the wire, so the conversion happens here once. If
 * the same message were ever delivered twice, a delta would compound and an
 * absolute figure cannot.
 */
function absoluteLimit(given: string, current: number, name: string): number {
  const relative = /^\+\s*\d+$/.test(given.trim());
  const value = Number(relative ? given.trim().slice(1) : given);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`--${name} needs a positive whole number, not ${given}`);
  }
  return relative ? current + value : value;
}

program
  .command('report')
  .argument('<run>')
  .description('everything that happened in a run, for somebody who did not watch it')
  .option('--json', 'the same thing, as JSON')
  .action((run: string, options: { json?: boolean }) =>
    guard(async () => {
      const client = await DaemonClient.connect();
      const { report } = await client.report(run);
      if (options.json === true) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        return;
      }
      const colour = useColor();
      const paint = (code: 'red' | 'yellow' | 'green' | 'dim' | 'bold', text: string): string =>
        withColour(colour, code, text);
      const line = (label: string, value: string): void => {
        process.stdout.write(`${pad(label, 16)}${value}\n`);
      };

      const tone =
        report.status === 'finished' && report.claimSupported !== false
          ? 'green'
          : report.status === 'finished'
            ? 'yellow'
            : 'red';
      process.stdout.write(`\n${paint(tone, report.headline)}\n\n`);

      line('run', `${report.name} (${report.id})`);
      line('status', statusWord(report.status));
      line('model', report.model);
      line('turns', String(report.turns));
      line(
        'tokens',
        `${formatCount(report.totals.promptTokens)} sent, ${formatCount(report.totals.cacheHitTokens)} cached, ` +
          `${formatCount(report.totals.completionTokens)} written (${formatCount(report.totals.reasoningTokens)} thinking)`,
      );
      line(
        'billed',
        `${formatCount(report.totals.billedTokens)} of ${formatCount(report.limits.totalTokens)}`,
      );
      line(
        'cost',
        report.totals.costUsd === null ? 'no price table' : `$${report.totals.costUsd.toFixed(4)}`,
      );

      process.stdout.write(`\n${paint('bold', 'limits')}\n`);
      for (const use of report.used) {
        const near = use.ratio >= 0.8 ? paint('yellow', ' (near)') : '';
        line(`  ${use.which}`, `${formatCount(use.used)} of ${formatCount(use.budget)}${near}`);
      }

      process.stdout.write(`\n${paint('bold', 'checks')}\n`);
      if (report.checks.length === 0) {
        process.stdout.write('  none were run, so nothing verified this change\n');
      }
      for (const check of report.checks) {
        const word =
          check.outcome === 'pass'
            ? paint('green', 'pass')
            : check.outcome === 'fail'
              ? paint('red', 'FAIL')
              : paint('yellow', 'n/a ');
        line(`  ${check.name}`, `${word}  ${check.output.split('\n').slice(0, 2).join(' | ').slice(0, 160)}`);
      }

      process.stdout.write(`\n${paint('bold', 'files')}\n`);
      line('  allowed', String(report.allowed.length));
      if (report.changed.length === 0) {
        line('  changed', 'nothing');
      } else {
        line('  changed', report.changed.join(', '));
      }
      if (report.strayFailure !== null) {
        line('  stray', paint('red', `COULD NOT CHECK: ${report.strayFailure}`));
      } else if (report.stray.length > 0) {
        line('  stray', paint('red', `OUTSIDE THE ALLOWLIST: ${report.stray.join(', ')}`));
      } else {
        line('  stray', 'none');
      }

      if (report.questions.length > 0) {
        process.stdout.write(`\n${paint('bold', 'questions')}\n`);
        for (const question of report.questions) {
          line('  asked', question.question.split('\n')[0]?.slice(0, 140) ?? '');
          line('  answer', question.answer === null ? paint('yellow', 'never answered') : question.answer);
        }
      }
      if (report.warnings > 0) {
        process.stdout.write(
          `\n${paint('bold', 'limits')} the harness warned the agent ${report.warnings} time${report.warnings === 1 ? '' : 's'} before it stopped.\n`,
        );
      }

      if (report.claim !== null) {
        process.stdout.write(`\n${paint('bold', "the agent's own claim")}\n`);
        if (report.claimSupported === false) {
          process.stdout.write(
            `${paint('yellow', '  NOT BACKED BY A CHECK: a check it ran last did not pass.')}\n`,
          );
        }
        process.stdout.write(`${indent(report.claim, '  ')}\n`);
      }

      if (report.status === 'stopped_at_limit') {
        process.stdout.write(
          `\n${paint('yellow', 'This run did not finish.')} Its changes are in the worktree, partially applied.\n` +
            `Continue it with more room:  dsh continue ${report.id} --turns +20\n`,
        );
      }
      process.stdout.write('\n');
    }),
  );

program
  .command('tools')
  .description('every tool an agent can call, and what it is for')
  .option('--json', 'the same thing, as JSON')
  .action((options: { json?: boolean }) =>
    guard(async () => {
      const listing = toolCatalogue();
      if (options.json === true) {
        process.stdout.write(`${JSON.stringify(listing, null, 2)}\n`);
        return;
      }
      for (const tool of listing) {
        process.stdout.write(`${withColour(useColor(), 'bold', tool.name)}\n`);
        process.stdout.write(`${indent(tool.description, '  ')}\n`);
        if (tool.args !== '') process.stdout.write(`${indent(tool.args, '  ')}\n`);
        process.stdout.write('\n');
      }
      process.stdout.write(
        'A check is named, never a command: the profile decides what each name runs, and the\n' +
          'agent cannot pass it an argument or reach a shell. `dsh tools --json` is the same list.\n',
      );
    }),
  );

program
  .command('continue')
  .argument('<run>')
  .description('carry on a stopped run, with its conversation and its cache intact')
  .option('--turns <n>', 'turns to allow, absolute, or +n for more than it had')
  .option('--wallSeconds <n>', 'wall clock seconds to allow')
  .option('--outputTokens <n>', 'output tokens to allow')
  .option('--totalTokens <n>', 'billed tokens to allow')
  .option('--json', 'print one JSON event per line')
  .option('--detach', 'start it and return without watching')
  .action(
    (
      run: string,
      options: {
        turns?: string;
        wallSeconds?: string;
        outputTokens?: string;
        totalTokens?: string;
        json?: boolean;
        detach?: boolean;
      },
    ) =>
      guard(async () => {
        const client = await DaemonClient.connect();
        const parent = await client.run(run);
        const limits: Record<string, number> = {};
        const names = ['turns', 'wallSeconds', 'outputTokens', 'totalTokens'] as const;
        for (const name of names) {
          const given = options[name];
          if (given === undefined) continue;
          limits[name] = absoluteLimit(given, parent.limits[name], name);
        }
        // A continuation with no new room would stop at the same wall again, so
        // a bare `dsh continue` doubles the two budgets that actually run out.
        if (Object.keys(limits).length === 0) {
          limits.turns = parent.limits.turns * 2;
          limits.totalTokens = parent.limits.totalTokens * 2;
        }
        const created = await client.json<{ id: string }>('POST', '/runs', {
          // The same task file it was resolved from, re-read rather than
          // copied, so a corrected task file is what the continuation gets.
          taskPath: parent.config.configPath,
          continueFrom: run,
          limits,
          detached: options.detach === true,
        });
        process.stdout.write(
          `${created.id} continues ${run} with ${Object.entries(limits)
            .map(([name, value]) => `${name} ${value}`)
            .join(', ')}\n`,
        );
        if (options.detach === true) return;
        process.exitCode = await stream(client, created.id, options.json === true);
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
      // The method only goes in the model column when a model has more than one,
      // so the ordinary case reads exactly as it did before there was a version.
      const methods = new Map<string, number>();
      for (const model of stats.models) methods.set(model.model, (methods.get(model.model) ?? 0) + 1);
      process.stdout.write(
        `${pad('MODEL', 20)}${pad('CALLS', 7)}${pad('IN TOK', 10)}${pad('CACHED', 10)}${pad('OUT TOK', 10)}${pad('THOUGHT', 10)}${pad('FIRST TOK', 11)}${pad('TOK/S', 8)}${pad('DECODE', 8)}${pad('COST', 10)}\n`,
      );
      for (const model of stats.models) {
        const label =
          (methods.get(model.model) ?? 0) > 1 ? `${model.model} m${model.metricsVersion}` : model.model;
        process.stdout.write(
          `${pad(label, 20)}${pad(String(model.calls), 7)}${pad(String(model.promptTokens), 10)}${pad(String(model.cacheHitTokens), 10)}${pad(String(model.completionTokens), 10)}${pad(String(model.reasoningTokens), 10)}${pad(seconds(model.timeToFirstTokenMs), 11)}${pad(number(model.endToEndTokensPerSecond), 8)}${pad(number(model.generationTokensPerSecond), 8)}${pad(model.costUsd === null ? '-' : `$${model.costUsd.toFixed(4)}`, 10)}\n`,
        );
      }
      process.stdout.write(
        `\nTOK/S is output tokens over the whole call, which is the number a vendor advertises.\n` +
          `DECODE counts only the streaming window, is often blank because the call spent longer\n` +
          `waiting for its first token than decoding, and is not the number to quote.\n` +
          `THOUGHT is the part of OUT TOK the model spent thinking, which is billed as output.\n`,
      );
      if ([...methods.values()].some((count) => count > 1)) {
        process.stdout.write(
          `\nm1 and m2 are two measurement methods, not two models. The speed figures were wrong\n` +
            `once and the rows it produced are still in the database, so calls measured each way\n` +
            `are counted separately: only compare within one method. Tokens and cost are\n` +
            `comparable across the two.\n`,
        );
      }
      process.stdout.write(
        `\nfrom ${stats.runs} run(s). Prices come from config.json in the harness home.\n`,
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

/**
 * The limit this run is closest to, as `used of budget`.
 *
 * A bare token count says nothing. "6.0M" is only meaningful next to the 8M it
 * is heading for, and the question a person actually has — how much room is
 * left — cannot be answered from the total alone.
 */
function nearestLimit(run: RunSummary): string {
  const uses = limitUse(
    {
      turns: run.turns,
      elapsedSeconds: elapsedSeconds({ startedAt: run.startedAt, endedAt: run.endedAt }),
      totals: run.totals,
    },
    run.limits,
  );
  const worst = [...uses].sort((a, b) => b.ratio - a.ratio)[0];
  if (worst === undefined) return '-';
  return `${formatCount(worst.used)}/${formatCount(worst.budget)}`;
}

function cost(run: RunSummary): string {
  return run.totals.costUsd === null ? '-' : `$${run.totals.costUsd.toFixed(4)}`;
}

function duration(run: RunSummary): string {
  const start = run.startedAt === null ? null : Date.parse(run.startedAt);
  if (start === null) return '-';
  if (run.endedAt === null) {
    // Still going, so to now. Finished but with no end recorded is different:
    // the process died and nobody wrote the time down, and measuring to now
    // makes the duration grow for as long as the row exists, which is how
    // `dsh list` came to show 13,281s for a run of a few minutes.
    if (isTerminal(run.status)) return '-';
    return `${Math.max(0, Math.round((Date.now() - start) / 1000))}s`;
  }
  return `${Math.max(0, Math.round((Date.parse(run.endedAt) - start) / 1000))}s`;
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
