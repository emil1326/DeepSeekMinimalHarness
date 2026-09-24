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
  formatLimit,
  formatUsd,
  isTerminal,
  limitUse,
  loadHarnessConfig,
  loadRunConfig,
  samePath,
  toolCatalogue,
  uiHostnames,
  type FailureCause,
  type ResolvedRunConfig,
  type RunEvent,
  type RunStatus,
  type ToolContext,
} from '@emilswork/harness-core';
import { createWorktree, patchFor, resetWorktree, worktreePathFor } from './worktree.js';
import type {
  AttachMessage,
  DiffResponse,
  OutcomeStats,
  RunDetail,
  RunSummary,
  RunTag,
  RunTimings,
  StatsResponse,
  TimingsResponse,
} from '@emilswork/harness-daemon';
import { RUN_TAGS } from '@emilswork/harness-daemon';
import { ApiFailure, DaemonClient, DaemonUnreachable, exitCodeFor, readDaemonRecord } from './client.js';
import { Renderer, colour as withColour, indent, pad, statusWord, useColor } from './render.js';
import { timingsFootnotes, timingsTable, type TimingSort } from './timings.js';

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
  .command('watch')
  .argument('<run>')
  .option('--json', 'print one JSON event per line, then an exit line')
  .option('--quiet', 'only what a person has to act on: questions, warnings, the summary, the end')
  .option('--thinking', "print the model's thinking, which is billed as output")
  .option(
    '--on-question <command>',
    'run this shell command when the agent asks something, with the question on its stdin',
  )
  .description('follow a run without owning it, and have something tell you when it asks')
  .action((run: string, options: FollowOptions) =>
    guard(async () => {
      const client = await DaemonClient.connect();
      process.exitCode = await follow(client, run, options);
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
          `${pad(run.id, 14)}${pad(run.name, 24)}${pad(statusWord(run.status), 17)}${pad(run.model, 17)}${pad(String(run.turns), 8)}${pad(String(run.totals.completionTokens), 9)}${pad(speed(run), 8)}${pad(cost(run), 9)}${pad(nearestLimit(run), 17)}${pad(duration(run), 10)}\n`,
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
        const stated = (value: number): string => formatLimit(use.which, value);
        process.stdout.write(
          `${pad(use.which, 16)}${pad(stated(use.used), 12)}${pad(stated(use.budget), 12)}${pad(stated(use.remaining), 12)}\n`,
        );
      }
      process.stdout.write(
        `\nContext window  ${formatCount(detail.config.limits.contextTokens)} tokens per request.\n` +
          `totalTokens counts BILLED tokens: prompt cache misses plus output. Cache hits are\n` +
          `about a fiftieth of a miss on flash, so counting them at full price bounded nothing\n` +
          `worth bounding and killed runs that had spent almost nothing.\n` +
          `costUsd counts dollars, from DeepSeek's published prices at the hour of each call.\n` +
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
  .option('--costUsd <n>', 'dollars to allow, e.g. 0.25 or +0.05')
  .action(
    (
      run: string,
      options: {
        turns?: string;
        wallSeconds?: string;
        outputTokens?: string;
        totalTokens?: string;
        costUsd?: string;
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
        if (options.costUsd !== undefined) {
          patch.costUsd = absoluteLimit(options.costUsd, detail.config.limits.costUsd, 'costUsd');
        }
        if (Object.keys(patch).length === 0) {
          process.stderr.write(
            'dsh: give at least one of --turns, --wallSeconds, --outputTokens, --totalTokens, --costUsd\n',
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
 *
 * Not restricted to whole numbers, because one of the limits is money and
 * `--costUsd +0.05` is how somebody grants five more cents.
 */
function absoluteLimit(given: string, current: number | undefined, name: string): number {
  const relative = /^\+\s*\d+(\.\d+)?$/.test(given.trim());
  const value = Number(relative ? given.trim().slice(1) : given);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`--${name} needs a positive number, not ${given}`);
  }
  if (name === 'costUsd') return Math.round((relative ? (current ?? 0) + value : value) * 1e6) / 1e6;
  if (!Number.isInteger(value)) throw new Error(`--${name} needs a whole number, not ${given}`);
  return relative ? (current ?? 0) + value : value;
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
        report.totals.costUsd === null
          ? 'the model has no known price'
          : `${formatUsd(report.totals.costUsd)} of ${formatUsd(report.limits.costUsd)} allowed`,
      );

      process.stdout.write(`\n${paint('bold', 'limits')}\n`);
      for (const use of report.used) {
        const near = use.ratio >= 0.8 ? paint('yellow', ' (near)') : '';
        line(
          `  ${use.which}`,
          `${formatLimit(use.which, use.used)} of ${formatLimit(use.which, use.budget)}${near}`,
        );
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
        // A declared command is the project's own verification, which is the
        // strongest evidence in the section and used to be invisible here.
        const what = check.kind === 'command' ? `${check.name} (command)` : check.name;
        line(`  ${what}`, `${word}  ${check.output.split('\n').slice(0, 2).join(' | ').slice(0, 160)}`);
      }

      process.stdout.write(`\n${paint('bold', 'files')}\n`);
      line('  allowed', String(report.allowed.length));
      if (report.changed.length === 0) {
        line('  changed', 'nothing');
      } else {
        line('  changed', report.changed.join(', '));
      }
      // The run's own record against the worktree as it stands. They disagree
      // whenever somebody committed or reset in between, and a reader deciding
      // whether to trust the file list needs to know which one they are seeing.
      if (report.changed.length > 0 && report.onDisk.length === 0) {
        line('  on disk', paint('yellow', 'no changes now: the worktree was reset or committed since'));
      } else if (report.changed.length > 0 && !sameSet(report.changed, report.onDisk)) {
        line(
          '  on disk',
          paint('yellow', `differs from the list above: ${report.onDisk.join(', ') || '(nothing)'}`),
        );
      }
      if (report.offPlan.length > 0) {
        line('  off plan', paint('yellow', `${report.offPlan.join(', ')}  (outside the plan, allowed)`));
      }
      if (report.preExisting.length > 0) {
        line('  before', `${report.preExisting.length} file(s) were already changed, so not counted`);
      }
      if (report.strayFailure !== null) {
        line('  stray', paint('red', `COULD NOT CHECK: ${report.strayFailure}`));
      } else if (report.stray.length > 0) {
        line('  stray', paint('red', `OUTSIDE THE ALLOWLIST: ${report.stray.join(', ')}`));
      } else {
        line('  stray', 'none');
      }

      // The agent's own list, against what the run can account for. A run that
      // wrote "ui/add.spec.ts rewritten" when the file had not changed was only
      // ever found by reading the diff by hand, which is what this is for.
      if (report.claimed !== null) {
        process.stdout.write(`\n${paint('bold', 'what it said it changed')}\n`);
        line(
          '  claimed',
          report.claimed.length === 0
            ? paint('yellow', 'it listed no files')
            : `${report.claimed.join(', ')}  (+${report.lines.added} −${report.lines.removed} lines)`,
        );
        if (report.claimGaps.length > 0) {
          line('  ', paint('red', `NOTHING ACCOUNTS FOR: ${report.claimGaps.join(', ')} changing`));
        }
        if (report.unclaimed.length > 0) {
          line('  terse', `also changed, without listing: ${report.unclaimed.join(', ')}`);
        }
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
          `\n${paint('bold', 'limits')} the harness warned the agent ${report.warnings} time${report.warnings === 1 ? '' : 's'} before it stopped, about ${report.warnedAbout.join(' and ')}.\n`,
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
  .argument('[task]', 'a task file, to show the tools that run would actually get')
  .description('every tool an agent can call, and what it is for')
  .option('--json', 'the same thing, as JSON')
  .action((task: string | undefined, options: { json?: boolean }) =>
    guard(async () => {
      // With a task file, the answer is the real one: the built-ins plus every
      // command that project declared. Without one there is no way to know what
      // a project declares, so the built-ins are what can honestly be listed.
      const context = task === undefined ? { checkNames: [] } : toolsOf(loadRunConfig(path.resolve(task)));
      const listing = toolCatalogue(context);
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
        (task === undefined
          ? "These are the harness's own tools. A project declares more, and `dsh tools <task.json>`\n" +
            'lists exactly what that run gets, project commands included.\n'
          : `As ${task} would get them, project commands included.\n`) +
          'A check is named, never a command: the profile decides what each name runs. A declared\n' +
          'command takes only the arguments its project listed, and nothing reaches a shell.\n',
      );
    }),
  );

function toolsOf(config: ResolvedRunConfig): ToolContext {
  const checkNames = config.checks;
  return { checkNames, commands: config.commands };
}

program
  .command('continue')
  .argument('<run>')
  .description('carry on a stopped run, with its conversation and its cache intact')
  .option('--turns <n>', 'turns to allow, absolute, or +n for more than it had')
  .option('--wallSeconds <n>', 'wall clock seconds to allow')
  .option('--outputTokens <n>', 'output tokens to allow')
  .option('--totalTokens <n>', 'billed tokens to allow')
  .option('--costUsd <n>', 'dollars to allow, absolute, or +n for more than it had')
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
        costUsd?: string;
        json?: boolean;
        detach?: boolean;
      },
    ) =>
      guard(async () => {
        const client = await DaemonClient.connect();
        const parent = await client.run(run);
        const limits: Record<string, number> = {};
        const names = ['turns', 'wallSeconds', 'outputTokens', 'totalTokens', 'costUsd'] as const;
        for (const name of names) {
          const given = options[name];
          if (given === undefined) continue;
          limits[name] = absoluteLimit(given, parent.limits[name], name);
        }
        // A continuation with no new room would stop at the same wall again, so
        // a bare `dsh continue` doubles the three budgets that actually run out.
        if (Object.keys(limits).length === 0) {
          limits.turns = parent.limits.turns * 2;
          limits.totalTokens = parent.limits.totalTokens * 2;
          limits.costUsd = parent.limits.costUsd * 2;
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
  .command('patch')
  .argument('<run>')
  .option('--out <file>', 'write it here instead of to stdout')
  .description("the run's changes as a patch, ready for `git apply --3way`")
  .action((run: string, options: { out?: string }) =>
    guard(async () => {
      const client = await DaemonClient.connect();
      const detail = await client.run(run);
      const { report } = await client.report(run);
      // The run's own file list, not the worktree's: a worktree can hold somebody
      // else's work, and a patch that swept it up would be worse than none.
      const { patch, files, notes } = patchFor(detail.worktree, report.changed);
      if (files.length === 0) {
        process.stdout.write(
          `nothing to patch for ${run}: ${
            report.changed.length === 0
              ? 'it changed no file'
              : 'none of the files it changed can be diffed now'
          }\n`,
        );
      }
      if (options.out === undefined) {
        process.stdout.write(patch);
      } else {
        fs.writeFileSync(options.out, patch, 'utf8');
        process.stdout.write(`${options.out}: ${files.length} file(s)\n`);
        if (notes.length > 0) process.stdout.write(`${indent(notes.join('\n'), '  ')}\n`);
        process.stdout.write(`\napply it with:  git apply --3way ${options.out}\n`);
      }
    }),
  );

program
  .command('worktree')
  .description('make and reset the worktrees agents run in')
  .addCommand(
    new Command('new')
      .argument('<name>', 'the worktree, made beside the repository')
      .option('--repo <path>', 'the repository it belongs to', process.cwd())
      .option('--from <ref>', 'the commit or branch to start from', 'HEAD')
      .action((name: string, options: { repo: string; from: string }) =>
        guard(async () => {
          const made = createWorktree({ repo: options.repo, name, from: options.from });
          process.stdout.write(`${made.path}\n`);
          if (made.notes.length > 0) process.stdout.write(`${indent(made.notes.join('\n'), '  ')}\n`);
        }),
      ),
  )
  .addCommand(
    new Command('reset')
      .argument('<name>', 'the worktree, by name or by path')
      .argument('<ref>', 'the commit to put it back to')
      .option('--repo <path>', 'the repository it belongs to', process.cwd())
      .action((name: string, ref: string, options: { repo: string }) =>
        guard(async () => {
          const target = worktreePathFor(options.repo, name);
          if (!fs.existsSync(target)) {
            process.stderr.write(`dsh: no worktree at ${target}\n`);
            process.exitCode = 4;
            return;
          }

          // A run in there would have its work deleted under it, mid-turn. The
          // check is skipped rather than failed when no daemon answers: a run's
          // lifetime is tied to the daemon, so no daemon means no live runs.
          const live = await runsIn(target);
          if (live.length > 0) {
            process.stderr.write(
              `dsh: ${live.join(', ')} ${live.length === 1 ? 'is' : 'are'} running in ${target}.\n` +
                `  Resetting now would delete work out from under it. Cancel first, or wait.\n`,
            );
            process.exitCode = 1;
            return;
          }

          const result = resetWorktree({ repo: options.repo, target, ref });
          process.stdout.write(`${result.path} is back at ${ref}\n`);
          if (result.notes.length > 0) process.stdout.write(`${indent(result.notes.join('\n'), '  ')}\n`);
          process.stdout.write('  ignored files, such as node_modules and target, were left alone\n');
        }),
      ),
  );

/**
 * The runs still going in a worktree.
 *
 * An empty list when the daemon cannot be reached, which is the safe answer and
 * not a guess: a run's lifetime is tied to the daemon that owns it, so nothing
 * is running when nothing is listening.
 */
async function runsIn(worktree: string): Promise<string[]> {
  try {
    const client = await DaemonClient.connect();
    const { runs } = await client.runs();
    return runs
      .filter((run) => !isTerminal(run.status) && samePath(run.worktree, worktree))
      .map((run) => run.id);
  } catch {
    return [];
  }
}

program
  .command('tag')
  .argument('<run>')
  .argument('<outcome>', 'landed, fixed or dropped')
  .option('--note <text>', 'why, in your own words')
  .description("say what happened to a run's work, after your own gate")
  .action((run: string, outcome: string, options: { note?: string }) =>
    guard(async () => {
      if (!isTag(outcome)) {
        process.stderr.write(`dsh: outcome must be one of ${RUN_TAGS.join(', ')}, not ${outcome}\n`);
        process.exitCode = 4;
        return;
      }
      const client = await DaemonClient.connect();
      const answer = await client.json<{ ok: boolean; lines: { added: number; removed: number } }>(
        'POST',
        `/runs/${run}/tag`,
        { tag: outcome, ...(options.note === undefined ? {} : { note: options.note }) },
      );
      // The line count is the run's own, taken from what it wrote, so it says
      // the same thing in six months as it does now.
      process.stdout.write(
        `${run} is ${outcome} (+${answer.lines.added} −${answer.lines.removed} lines, from the run's own edits)\n`,
      );
      if (outcome !== 'landed') {
        process.stdout.write(
          `Those lines do not count towards $ per line in \`dsh stats\`: only work that landed\n` +
            `untouched does, or the figure would flatter itself.\n`,
        );
      }
    }),
  );

function isTag(value: string): value is RunTag {
  return (RUN_TAGS as readonly string[]).includes(value);
}

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
      process.stdout.write(outcomesTable(stats.outcomes));
    }),
  );

/**
 * Whether the work landed, grouped by model and profile.
 *
 * The half of `stats` that decides anything. Speed and cost are inputs; this is
 * what came out. A model that is fast and cheap and produces nothing worth
 * keeping is worse than a slow one that does, and the status column alone cannot
 * tell them apart: a run stopped at a limit and a run stopped at a limit whose
 * half-finished work was kept look identical there.
 */
function outcomesTable(outcomes: OutcomeStats[]): string {
  if (outcomes.length === 0) return '';
  const tagged = outcomes.some((row) => row.landed + row.fixed + row.dropped > 0);
  const lines = [
    '\ndid the work land\n',
    `${pad('MODEL', 20)}${pad('PROFILE', 22)}${pad('RUNS', 6)}${pad('FIN', 5)}${pad('LIMIT', 6)}${pad('FAIL', 6)}${pad('LANDED', 8)}${pad('FIXED', 7)}${pad('DROPPED', 9)}${pad('LINES', 8)}${pad('$ PER LINE', 11)}\n`,
  ];
  for (const row of outcomes) {
    lines.push(
      `${pad(row.model, 20)}${pad(row.profile, 22)}${pad(String(row.runs), 6)}${pad(String(row.finished), 5)}${pad(String(row.stoppedAtLimit), 6)}${pad(String(row.failed), 6)}${pad(tagged ? String(row.landed) : '-', 8)}${pad(tagged ? String(row.fixed) : '-', 7)}${pad(tagged ? String(row.dropped) : '-', 9)}${pad(String(row.landedLinesAdded), 8)}${pad(row.costPerLandedLine === null ? '-' : `$${row.costPerLandedLine.toFixed(4)}`, 11)}\n`,
    );
  }
  let foot =
    '\nFIN, LIMIT and FAIL are how the runs ended. LANDED, FIXED and DROPPED are what\n' +
    'happened to the work afterwards, which only you can say:\n\n' +
    '  dsh tag <run> landed            it went in as it was\n' +
    '  dsh tag <run> fixed --note "…"  it went in after you corrected it\n' +
    '  dsh tag <run> dropped           thrown away\n';
  if (!tagged) {
    foot +=
      '\nNothing is tagged yet, so the outcome columns are blank and $ PER LINE cannot be\n' +
      'worked out. Three commands on three runs is enough to make it mean something.\n';
  } else {
    foot +=
      '\nLINES counts only what landed untouched, and $ PER LINE is the whole cost of the\n' +
      'group over it. A run tagged `fixed` needed you to finish it, so its lines are not\n' +
      'counted — that is the one figure here that flatters itself if you let it.\n';
  }
  // The table and the footnotes, in that order. Returning only the footnotes was
  // a real bug, and a quiet one: the header and every row were built and thrown
  // away, so `dsh stats` printed a paragraph explaining columns that were not
  // there.
  return `${lines.join('')}${foot}`;
}

program
  .command('timings')
  .argument('[run]', 'one run, or nothing for every run together')
  .option('--json', 'print the figures as JSON')
  .option('--all', 'every name, not just the slowest 25')
  .option('--sort <by>', 'total, max, p95, mean or count', 'total')
  .description('where the time went inside the harness, rather than inside the model')
  .action((run: string | undefined, options: { json?: boolean; all?: boolean; sort?: string }) =>
    guard(async () => {
      const client = await DaemonClient.connect();
      const top = options.all === true ? 100_000 : 25;
      const wanted = (['total', 'max', 'p95', 'mean', 'count'] as const).find(
        (each) => each === options.sort,
      );
      if (options.sort !== undefined && wanted === undefined) {
        process.stderr.write(`dsh: --sort takes total, max, p95, mean or count\n`);
        process.exitCode = 4;
        return;
      }
      const sort: TimingSort = wanted ?? 'total';

      if (run !== undefined) {
        const body = await client.json<RunTimings>('GET', `/runs/${run}/timings`);
        if (options.json === true) {
          process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
          return;
        }
        if (body.entries.length === 0) {
          process.stdout.write(
            `no readings for ${run}: no turn of it finished, or it ran on a build from before\n` +
              `the stopwatch, which records nothing for a run that never got that far.\n`,
          );
          return;
        }
        process.stdout.write(`${timingsTable(body.entries, { wallMs: body.wallMs, top, sort })}\n`);
        process.stdout.write(
          `\n${run} took ${seconds(body.wallMs)} in all, most of it waiting for the model.\n` +
            `Last flushed ${body.at ?? 'never'}.\n\n`,
        );
        process.stdout.write(timingsFootnotes());
        return;
      }

      const body = await client.json<TimingsResponse>('GET', '/timings');
      if (options.json === true) {
        process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
        return;
      }
      if (body.entries.length === 0) {
        process.stdout.write('no readings recorded yet\n');
        return;
      }
      process.stdout.write(`${timingsTable(body.entries, { wallMs: body.wallMs, top, sort })}\n`);
      process.stdout.write(
        `\nadded up over ${body.runs} run(s), which took ${seconds(body.wallMs)} between them.\n\n`,
      );
      process.stdout.write(timingsFootnotes());
      if (body.process.length > 0) {
        // The daemon's own readings, kept apart from the runs' because a daemon
        // outlives hundreds of them and adding its uptime to a run's runtime
        // would make both meaningless.
        process.stdout.write(
          `\nthe daemon itself, since it started (not part of the total above):\n\n` +
            `${timingsTable(body.process, { wallMs: 0, top, sort })}`,
        );
      }
    }),
  );

program
  .command('ui')
  .description('open the UI')
  .action(() =>
    guard(async () => {
      const client = await DaemonClient.connect();
      // No ticket, no cookie, no session. The daemon serves the page and the page
      // talks to the daemon, so a browser that can reach the address is already
      // the operator's own browser — which is what the guard checks.
      //
      // The name from `config.json` when there is one, because that is the name a
      // person will type tomorrow as well; `DaemonClient` keeps talking to the
      // loopback address itself, which is the host the daemon always answers to.
      const [name] = uiHostnames(loadHarnessConfig());
      const url = `http://${name ?? '127.0.0.1'}:${client.port}/`;
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
    /**
     * Why the run failed, when the harness said.
     *
     * Read off the terminal `status` event, which is where it belongs: a
     * launcher watching the stream already sees that event, and a cause that
     * arrived in a separate event it had to know to look for would be a cause it
     * would not look for.
     */
    let lastCause: FailureCause | undefined;
    let settled = false;
    let asked = false;

    const codeOf = (status: RunStatus): number => exitCodeFor(status, lastCause);

    const settle = (status: RunStatus): void => {
      if (settled) return;
      settled = true;
      process.removeListener('SIGINT', onSigint);
      if (json)
        process.stdout.write(
          `${JSON.stringify({ type: 'exit', status, code: codeOf(status), ...(lastCause === undefined ? {} : { cause: lastCause }) })}\n`,
        );
      // The socket is what owned the run; leaving it open would both keep the
      // process alive and look like somebody is still watching.
      socket.removeAllListeners();
      socket.close();
      socket.terminate();
      resolve(codeOf(status));
    };

    const note = (event: RunEvent): void => {
      renderer.event(event);
      if (event.type === 'status') {
        lastStatus = event.status;
        if (event.cause !== undefined) lastCause = event.cause;
      }
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

interface FollowOptions {
  json?: boolean;
  quiet?: boolean;
  thinking?: boolean;
  onQuestion?: string;
}

/**
 * Events a person has to act on, or would be annoyed to have missed.
 *
 * The point of `--quiet`: a run's stream is mostly the model writing, and a
 * watcher exists precisely so that nobody has to read that. What it must not
 * lose is the four things it was set up to catch — a question, a limit, a stray
 * change, and the end.
 */
const WORTH_INTERRUPTING: ReadonlySet<RunEvent['type']> = new Set<RunEvent['type']>([
  'question',
  'answer',
  'message',
  'warning',
  'limit',
  'stray',
  'offPlan',
  'error',
  'summary',
]);

/**
 * Follow a run somebody else is running, without owning it.
 *
 * `dsh run` is a claim on a run: it starts a queued one and the run dies when it
 * goes away. That is right for the person who launched it and wrong for anybody
 * else, so this uses the daemon's watch stream, which is the same events and
 * none of the ownership. Two windows, one run, no race — and closing this one is
 * not an act of sabotage.
 *
 * The question notification is the part that earns the command. `onAsk` in a
 * workspace spawns a process per question inside the sandbox, with a stripped
 * environment and no shell, because everything it runs is code somebody wrote.
 * This runs on the operator's own machine, from a string they typed themselves,
 * so it gets a shell — and it is the thing that makes `dsh run --detach` plus
 * `dsh watch --on-question ...` a complete answer to "tell me when it needs me"
 * rather than a run that quietly waits out its allowance.
 */
function follow(client: DaemonClient, runId: string, options: FollowOptions): Promise<number> {
  return new Promise<number>((resolve) => {
    const socket = client.watch(runId);
    const renderer = new Renderer((text) => process.stdout.write(text), {
      json: options.json === true,
      color: useColor(),
      thinking: options.thinking === true,
    });
    const loud = options.quiet !== true;
    let lastStatus: RunStatus | null = null;
    let lastCause: FailureCause | undefined;
    let settled = false;
    /**
     * Questions announced, and questions answered.
     *
     * A watcher that starts late is handed the whole history, which is the point
     * — a run that has been waiting twenty minutes for an answer is exactly what
     * somebody starts a watcher to find out. So the two sets are folded over the
     * replay, and anything still open at the end of it is announced then. Without
     * the answered set, a question that was answered last turn would be reported
     * as pending for ever.
     */
    const asked = new Set<string>();
    const answered = new Set<string>();

    const settle = (status: RunStatus): void => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      const code = exitCodeFor(status, lastCause);
      if (options.json === true) {
        process.stdout.write(
          `${JSON.stringify({ type: 'exit', status, code, ...(lastCause === undefined ? {} : { cause: lastCause }) })}\n`,
        );
      } else if (loud) {
        process.stdout.write(`\n${statusWord(status)}${lastCause === undefined ? '' : ` (${lastCause})`}\n`);
      }
      socket.close();
      socket.terminate();
      resolve(code);
    };

    const announce = (id: string, question: string): void => {
      if (asked.has(id)) return;
      asked.add(id);
      if (options.onQuestion !== undefined) notifyOperator(options.onQuestion, runId, id, question);
    };

    socket.on('message', (raw: Buffer) => {
      const message = JSON.parse(raw.toString('utf8')) as AttachMessage;
      if (message.type === 'hello') {
        const detail = message.detail;
        if (loud) {
          process.stdout.write(
            `watching ${runId} (${detail.name}), ${statusWord(detail.status)}${detail.detached ? ', detached' : ''}\n`,
          );
        }
        // The question nobody is answering, stated as such. A run that is
        // waiting looks identical to a run that is thinking from the outside,
        // which is why this is worth saying rather than leaving to be inferred.
        if (detail.owners === 0 && !detail.detached && !isTerminal(detail.status) && loud) {
          process.stdout.write(
            '  nothing is attached to this run, so it will be cancelled. Watch with `dsh run`, or it must be detached.\n',
          );
        }
        // Two passes over the replay, deliberately. The first only records what
        // is already answered and where the run got to; the second announces
        // whatever is still open. Doing it in one pass would announce a question
        // that the next event answers, which is a notification nobody can act on
        // and the fastest way to teach somebody to ignore them.
        for (const event of message.events) {
          if (event.type === 'answer') answered.add(event.id);
          if (event.type === 'status') {
            lastStatus = event.status;
            if (event.cause !== undefined) lastCause = event.cause;
          }
        }
        for (const event of message.events) {
          if (event.type === 'question' && !answered.has(event.id)) announce(event.id, event.question);
          if (loud || WORTH_INTERRUPTING.has(event.type)) renderer.event(event);
        }
        if (isTerminal(detail.status)) settle(detail.status);
        return;
      }
      if (message.type === 'event') {
        const event = message.event;
        if (event.type === 'question') announce(event.id, event.question);
        if (event.type === 'answer') answered.add(event.id);
        if (event.type === 'status') {
          lastStatus = event.status;
          if (event.cause !== undefined) lastCause = event.cause;
        }
        if (loud || WORTH_INTERRUPTING.has(event.type)) renderer.event(event);
        return;
      }
      if (message.type === 'bye') settle(message.status);
    });

    socket.on('error', (error: Error) => {
      process.stderr.write(`dsh: the connection to the daemon failed: ${error.message}\n`);
      settle(lastStatus ?? 'interrupted');
    });

    // Unlike `dsh run`, a watcher going away is not an event worth reacting to:
    // it owns nothing, so there is nothing to hand over or cancel.
    socket.on('close', () => settle(lastStatus ?? 'interrupted'));
  });
}

/**
 * Run the operator's own command, when the agent asks something.
 *
 * `shell: true`, which is the one place in this codebase that is allowed. The
 * sandbox never spawns a shell and `process.ts` goes to real trouble to keep
 * model-written strings away from one. This string is not model-written: it came
 * from command-line arguments typed by whoever started the watcher, on their own
 * machine, and it is the same trust level as the command line itself. The
 * question is handed over on stdin, so a notifier can be a one-liner — and the
 * run id and question id are in the environment for anything that needs to
 * answer rather than merely shout.
 *
 * A notifier that fails is swallowed on purpose. The whole point of this process
 * is to survive and keep reporting; a broken `notify-send` must not take the
 * watcher down with it.
 */
function notifyOperator(command: string, runId: string, questionId: string, question: string): void {
  try {
    const child = spawn(command, {
      shell: true,
      stdio: ['pipe', 'inherit', 'inherit'],
      env: { ...process.env, DSH_RUN: runId, DSH_QUESTION: questionId },
      windowsHide: true,
    });
    child.on('error', () => undefined);
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(`${question}\n`);
    child.unref();
  } catch {
    /* a notifier is best effort; the watcher keeps watching */
  }
}

function speed(run: RunSummary): string {
  const value = run.totals.generationTokensPerSecond;
  return value === null ? '-' : value.toFixed(0);
} /**
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
  return `${formatLimit(worst.which, worst.used)}/${formatLimit(worst.which, worst.budget)}`;
}

function cost(run: RunSummary): string {
  return run.totals.costUsd === null ? '-' : formatUsd(run.totals.costUsd);
}

/** Whether two file lists name the same set, whatever order they came in. */
function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((value, at) => value === right[at]);
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
