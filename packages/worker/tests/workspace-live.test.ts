/**
 * The workspace layer doing something, rather than just being read.
 *
 * Three things that only exist because of what the real runs did: a setup step
 * that has to happen once per worktree before anything else works, a
 * notification when the agent stops to ask something, and a command the project
 * declared being handed to the agent as a tool.
 *
 * Measured on real runs: 3 or 4 of 16 backlog lines passed their gate untouched,
 * and about half the corrections were tests the agent had written that it had no
 * way to run. That is what the command mechanism is for. The other one: a run
 * that asked "may I edit a line of wire.rs?" and waited a full hour for nobody,
 * which is what `onAsk` is for.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DeepSeekClient,
  Sandbox,
  loadRunConfig,
  toolNames,
  toolSpecs,
  type RunEventBody,
  type Speaker,
} from '@emilswork/harness-core';
import { runAgentLoop, type LoopControl } from '@emilswork/harness-worker';
import { startFakeDeepSeek } from '../../core/tests/fake-server.js';
import { createFixture } from './fixture.js';

const fixture = createFixture();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-useworkspace-'));
afterAll(() => {
  fixture.cleanup();
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
beforeEach(() => fixture.reset());

function idleControl(): LoopControl {
  return {
    signal: new AbortController().signal,
    takeMessages: (): { text: string; by: Speaker }[] => [],
    waitForAnswer: (): Promise<{ text: string; by: Speaker } | null> => Promise.resolve(null),
  };
}

let counter = 0;
/** A workspace file beside the fixture, so a task can name it explicitly. */
function workspaceWith(fields: Record<string, unknown>, extra: Record<string, string> = {}): string {
  counter += 1;
  const file = path.join(scratch, `ws-${counter}.json`);
  fs.writeFileSync(file, `${JSON.stringify({ name: 'test', ...fields }, null, 2)}\n`, 'utf8');
  for (const [name, body] of Object.entries(extra)) {
    fs.writeFileSync(path.join(scratch, name), body, 'utf8');
  }
  return file;
}

/** A task pointing at that workspace, with the fixture's own worktree. */
function taskFor(workspace: string, extra: Record<string, unknown> = {}): string {
  const file = path.join(scratch, `task-${counter}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({
      name: 'a-line',
      worktree: fixture.repo,
      workspace: path.relative(path.dirname(file), workspace),
      profile: fixture.profile,
      model: 'deepseek-flash',
      allow: ['src/a.ts'],
      task: 'Change the constant in src/a.ts.',
      ...extra,
    }),
    'utf8',
  );
  return file;
}

function sandboxOf(config: ReturnType<typeof loadRunConfig>): Sandbox {
  return new Sandbox({
    root: config.worktree,
    allow: config.allow,
    soft: config.soft,
    profile: config.resolvedProfile,
    checkNames: config.checks,
    commands: config.commands,
    env: config.env,
  });
}

describe('a project is told who to notify', () => {
  it('runs the declared command with the question, the moment it is asked', async () => {
    // The run 9b-L1 asked a question and waited an hour for nobody. The harness
    // cannot answer it, but somebody who is told can run `dsh reply`.
    const marker = path.join(scratch, `asked-${counter}.txt`);
    const workspace = workspaceWith(
      {
        onAsk: {
          run: [process.execPath, '-e', `require('fs').appendFileSync(${JSON.stringify(marker)}, 'called')`],
        },
      },
      {},
    );
    const config = loadRunConfig(taskFor(workspace));

    const server = await startFakeDeepSeek([
      { text: 'thinking', toolCalls: [{ name: 'ask', args: { question: 'may I edit wire.rs?' } }] },
      { text: 'done', toolCalls: [{ name: 'finish', args: { summary: 'ok' } }] },
    ]);
    const sandbox = sandboxOf(config);
    const client = new DeepSeekClient({ apiKey: 'test-key', baseUrl: server.url });
    const events: RunEventBody[] = [];
    let notified: { id: string; question: string } | null = null;

    await runAgentLoop(
      {
        sandbox,
        client,
        config,
        emit: (body) => events.push(body),
        onQuestion: (id, question) => {
          notified = { id, question };
          sandbox.notify(config.onAsk?.run ?? [], `${question}\n`, { DSH_RUN: 'run-test' });
        },
      },
      idleControl(),
    );

    // The question reached the run's launcher...
    expect(notified).toEqual({ id: expect.any(String) as string, question: 'may I edit wire.rs?' });
    expect(events.some((event) => event.type === 'question')).toBe(true);
    // ...and the project's own script ran, which is the part that stops an
    // unattended run from waiting in silence.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(fs.existsSync(marker)).toBe(true);
  });

  it('does not run anything when the workspace declares no onAsk', async () => {
    // Not an error and must not be one: most projects will not have one, and a
    // missing notification is a missing convenience rather than a fault.
    const config = loadRunConfig(taskFor(workspaceWith({})));
    expect(config.onAsk).toBeNull();
  });
});

describe('a project sets its own worktree up once', () => {
  it('is what the workspace says it is, and is not run by the loop', async () => {
    // The loop must not run setup: it is a property of the worktree, and running
    // it per turn would be a build in the middle of a conversation. The worker
    // runs it once, before the first model call. This checks the half that is
    // visible from here — that the config carries it and the tools do not grow.
    const workspace = workspaceWith({
      setup: [{ run: [process.execPath, '-e', "console.log('set up')"], timeoutSeconds: 30 }],
    });
    const config = loadRunConfig(taskFor(workspace));
    expect(config.setup).toHaveLength(1);
    expect(config.setup[0]?.timeoutSeconds).toBe(30);
    expect(toolNames({ checkNames: config.checks, commands: config.commands }).has('setup')).toBe(false);
  });

  it('runs in the worktree, with the environment the workspace declared', async () => {
    // Which is the whole point of `{worktree}` in an env value: a setup that
    // builds into a shared target directory is a setup that works for one
    // worktree and misleads every other.
    const out = path.join(scratch, `setup-${counter}.txt`);
    const workspace = workspaceWith({
      env: { CARGO_TARGET_DIR: '{worktree}-target' },
      setup: [
        {
          run: [
            process.execPath,
            '-e',
            `require('fs').writeFileSync(${JSON.stringify(out)}, process.env.CARGO_TARGET_DIR + '|' + process.cwd())`,
          ],
        },
      ],
    });
    const config = loadRunConfig(taskFor(workspace));
    const sandbox = sandboxOf(config);
    for (const step of config.setup) await sandbox.run(step.run, 20_000);

    const [target, cwd] = fs.readFileSync(out, 'utf8').split('|');
    expect(target).toBe(`${fixture.repo}-target`);
    expect(cwd?.toLowerCase()).toBe(fixture.repo.toLowerCase());
  });
});

describe('a command the project declared, as the agent sees it', () => {
  const declared = {
    commands: {
      run_test: {
        description: 'Run one test target that this task owns.',
        args: {
          target: { description: 'a target', values: ['core:comments', 'core:fields'] },
          verbose: { description: 'more output', values: ['-v', '-q'], optional: true },
        },
        // `{verbose}` is optional, so a call that leaves it out drops the
        // element rather than passing an empty string, which the program would
        // read as a real argument meaning something else.
        run: [
          process.execPath,
          '-e',
          'console.log(process.argv.slice(1).join(" "))',
          '--',
          '{target}',
          '{verbose}',
        ],
      },
    },
  };

  it('is offered to the model, described in the words the project wrote', () => {
    const config = loadRunConfig(taskFor(workspaceWith(declared)));
    const spec = toolSpecs({ checkNames: config.checks, commands: config.commands }).find(
      (each) => each.function.name === 'run_test',
    );
    expect(spec).toBeDefined();
    expect(spec?.function.description).toContain('Run one test target');
    // The values are in the description, because a model that is told the closed
    // set gets it right first time and one that is told "a test target" guesses,
    // is refused, and has spent the turn anyway.
    expect(spec?.function.description).toContain('core:comments');
    expect(spec?.function.parameters.required).toEqual(['target']);
  });

  it('is in the tool set for this run, and is not a tool the harness knows about', () => {
    const config = loadRunConfig(taskFor(workspaceWith(declared)));
    const names = toolNames({ checkNames: config.checks, commands: config.commands });
    expect(names.has('run_test')).toBe(true);
    expect(names.has('read_file')).toBe(true);

    // The negative control, and the point of the whole design: the harness has
    // no idea this command exists. A project that declares nothing gets nothing,
    // and there is no `cargo` or `vitest` anywhere in the package to have been
    // offered by accident.
    const bare = loadRunConfig(taskFor(workspaceWith({})));
    expect(toolNames({ checkNames: bare.checks, commands: bare.commands }).has('run_test')).toBe(false);
  });

  it('runs, with the argument the model chose, and answers with the output', async () => {
    const config = loadRunConfig(taskFor(workspaceWith(declared)));
    const sandbox = sandboxOf(config);
    const output = await sandbox.runDeclared('run_test', { target: 'core:fields' });
    expect(output).toContain('exit 0');
    expect(output).toContain('core:fields');
  });

  it('refuses a target the project did not list, and names the ones it did', async () => {
    const config = loadRunConfig(taskFor(workspaceWith(declared)));
    const sandbox = sandboxOf(config);
    const output = await sandbox.runDeclared('run_test', { target: 'core:something-else' });
    expect(output).toContain('refused');
    expect(output).toContain('core:comments');
  });

  it('refuses to run a command the project never declared', async () => {
    const config = loadRunConfig(taskFor(workspaceWith(declared)));
    const sandbox = sandboxOf(config);
    expect(await sandbox.runDeclared('rm_rf', {})).toContain('no command called rm_rf');
  });

  it('answers a model that calls it through the loop, and the turn carries on', async () => {
    // The whole path: the model asks for the tool, the loop routes it to the
    // declared command, and the output comes back as the tool result.
    const server = await startFakeDeepSeek([
      { text: 'testing', toolCalls: [{ name: 'run_test', args: { target: 'core:comments' } }] },
      { text: 'done', toolCalls: [{ name: 'finish', args: { summary: 'ran it' } }] },
    ]);
    const config = loadRunConfig(taskFor(workspaceWith(declared)));
    const sandbox = sandboxOf(config);
    const client = new DeepSeekClient({ apiKey: 'test-key', baseUrl: server.url });
    const events: RunEventBody[] = [];
    await runAgentLoop({ sandbox, client, config, emit: (body) => events.push(body) }, idleControl());

    const result = events.find((event) => event.type === 'tool.result' && event.name === 'run_test');
    expect(result?.type === 'tool.result' && result.ok).toBe(true);
    expect(result?.type === 'tool.result' && result.result).toContain('core:comments');
    // And the model was told about it on the next call, which is what makes the
    // result worth returning rather than only logging.
    const second = JSON.stringify(server.requests[1]?.messages ?? []);
    expect(second).toContain('core:comments');
  });
});

describe('files outside the plan', () => {
  it('are writable, and come back as off-plan rather than as a stray change', async () => {
    // The middle ground. A test file beside the one a task modifies has to be
    // touched almost every time and is forgotten in the task file almost every
    // time; the choice used to be between stopping the run and loosening a rule.
    const config = loadRunConfig(taskFor(workspaceWith({ soft: ['src/b.ts'] })));
    const sandbox = sandboxOf(config);

    expect(sandbox.writable('src/b.ts')).toBeTruthy();
    expect(await sandbox.replaceInFile('src/b.ts', 'export const b = 2;', 'export const b = 3;')).toBe(
      'replaced',
    );
    // And the file the task did not name at all is still refused, with the soft
    // list named in the refusal so a model knows what it may reach for.
    await expect(async () => sandbox.writable('src/c.ts')).rejects.toThrow(/soft list/);
  });

  it('are not reported when the task itself named them', async () => {
    // An entry on both lists is in the plan, and reporting it as outside the
    // plan would be a note about a file the task asked for.
    const config = loadRunConfig(taskFor(workspaceWith({ soft: ['src/a.ts'] })));
    const sandbox = sandboxOf(config);
    expect(sandbox.soft.has('src/a.ts')).toBe(false);
  });
});
