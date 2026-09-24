/**
 * Commands a project declares, which the harness runs without knowing anything.
 *
 * The design question this file holds down is the one that decides whether the
 * harness is generic or not. A project needs to run its own tests, and the
 * harness is forbidden from knowing what a test is. So the project says how, and
 * the harness offers exactly that. Everything that could be `cargo` or `vitest`
 * or `playwright` in here would be the bug.
 *
 * The other half is worse if it is wrong. A command's argv is assembled from
 * arguments the *model* chose, and `process.ts` goes to real trouble to make sure
 * a model-written string never reaches a command interpreter. A free-text
 * argument would give that back one layer up — `["cargo","test","-p","{target}"]`
 * with an unconstrained target is a shell by another name, and
 * `--target-dir=../../../..` is an argument rather than a path the sandbox can
 * see. Hence: closed sets, whole-element placeholders, and a config that will
 * not load if either is missing.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  checkCommandArg,
  commandArgv,
  declaredCommandSchema,
  loadRunConfig,
  loadWorkspace,
  mergeCommands,
  taskFileSchema,
  trimOutput,
  unproven,
  type DeclaredCommand,
} from '@emilswork/harness-core';

/** A command of the shape a project would really write. */
const command = (overrides: Partial<DeclaredCommand> = {}): DeclaredCommand => ({
  description: 'run a test target',
  args: { target: { description: 'a target', values: ['core:comments', 'core:fields'] } },
  run: ['cargo', 'test', '-p', '{target}'],
  ...overrides,
});

describe('what an argument may be', () => {
  it('takes one of the values the project listed', () => {
    const arg = { description: 'a target', values: ['a', 'b'] };
    expect(checkCommandArg('target', arg, 'a')).toBeNull();
    expect(checkCommandArg('target', arg, 'b')).toBeNull();
  });

  it('refuses a value the project did not list, and says what it accepts', () => {
    // The refusal has to name the alternatives. A model told "not one of those"
    // and nothing else spends the turn guessing, which is the cost this whole
    // mechanism exists to avoid.
    const refusal = checkCommandArg('target', { description: 'a target', values: ['a', 'b'] }, 'c');
    expect(refusal).toContain('refused');
    expect(refusal).toContain('"c"');
    expect(refusal).toContain('a, b');
  });

  it('refuses a value that only starts like an accepted one', () => {
    // `a:b` is not `a`, and a prefix match here would let a model walk out of the
    // set one character at a time.
    expect(checkCommandArg('t', { description: 'x', values: ['a'] }, 'a:b')).not.toBeNull();
    expect(checkCommandArg('t', { description: 'x', values: ['core:comments'] }, 'core')).not.toBeNull();
  });

  it('honours a pattern for a set too big to list', () => {
    const arg = { description: 'a spec', pattern: '^[a-z][a-z0-9-]*$' };
    expect(checkCommandArg('spec', arg, 'add')).toBeNull();
    expect(checkCommandArg('spec', arg, 'mark-timeouts')).toBeNull();
    expect(checkCommandArg('spec', arg, 'add spec')).not.toBeNull();
    expect(checkCommandArg('spec', arg, '../../etc/passwd')).not.toBeNull();
    expect(checkCommandArg('spec', arg, '--force')).not.toBeNull();
  });

  it('refuses an argument that is neither listed nor pattered', () => {
    // The load-bearing refusal. This is what a workspace gets if somebody
    // declares `{target}` with no constraint, and the only safe answer is that
    // the command cannot be called at all.
    const refusal = checkCommandArg('target', { description: 'a target' }, 'anything');
    expect(refusal).toContain('refused');
    expect(refusal).toContain('no values or pattern');
  });

  it('insists on the ones that are not optional', () => {
    const arg = { description: 'a target', values: ['a'] };
    expect(checkCommandArg('target', arg, undefined)).toContain('required');
  });

  it('lets an optional one go', () => {
    const arg = { description: 'a filter', values: ['a'], optional: true };
    expect(checkCommandArg('filter', arg, undefined)).toBeNull();
  });

  it('refuses a non-string rather than stringifying whatever it got', () => {
    expect(checkCommandArg('t', { description: 'x', values: ['a'] }, 3)).toContain('must be a string');
    expect(checkCommandArg('t', { description: 'x', values: ['a'] }, { a: 1 })).toContain('must be a string');
  });
});

describe('building the argv', () => {
  it('substitutes a placeholder and leaves the rest alone', () => {
    const built = commandArgv(command(), { target: 'core:fields' });
    expect(built).toEqual({ argv: ['cargo', 'test', '-p', 'core:fields'] });
  });

  it('substitutes a placeholder that is not the last argument', () => {
    const built = commandArgv(
      {
        description: 'x',
        args: { spec: { description: 's', values: ['add', 'remove'] } },
        run: ['node', 'script.mjs', '{spec}', '--quiet'],
      },
      { spec: 'add' },
    );
    expect(built).toEqual({ argv: ['node', 'script.mjs', 'add', '--quiet'] });
  });

  it('refuses a placeholder stuck to the middle of an argument', () => {
    // The splice. `--package={target}` would mean checking one end of a
    // model-chosen string and pasting the other into an argv, which reads as
    // escaping and is not.
    const built = commandArgv({ description: 'x', run: ['cargo', 'test', '--package={target}'] }, {});
    expect(built).toEqual({
      refusal: expect.stringContaining('whole argument') as unknown as string,
    });
  });

  it('refuses an argument the command never declared', () => {
    // A model that invents `--force` is told, rather than quietly not getting it.
    const built = commandArgv(command(), { target: 'core:comments', force: 'yes' });
    expect('refusal' in built && built.refusal).toContain('not an argument');
  });

  it('refuses a call with no value for a required placeholder', () => {
    const built = commandArgv(command(), {});
    expect('refusal' in built && built.refusal).toContain('required');
  });

  it('drops an optional argument that was not given', () => {
    const built = commandArgv(
      {
        description: 'x',
        args: { spec: { description: 's', values: ['a'], optional: true } },
        run: ['node', 'go.mjs', '{spec}'],
      },
      {},
    );
    // Dropped rather than left as an empty string, which would be passed to the
    // program as a real argument meaning something else.
    expect(built).toEqual({ argv: ['node', 'go.mjs'] });
  });

  it('cannot be made to run a second command by what goes in the value', () => {
    // Belt and braces on top of the closed set: even with a pattern that admits
    // almost anything, nothing here builds a shell string. The argv is an array
    // and `spawnTool` spawns it without a shell, so a `;` is a `;` in a filename.
    const built = commandArgv(
      { description: 'x', args: { s: { description: 's', pattern: '^.*$' } }, run: ['echo', '{s}'] },
      { s: 'a; rm -rf /' },
    );
    expect(built).toEqual({ argv: ['echo', 'a; rm -rf /'] });
  });
});

describe('the shape a workspace file may declare', () => {
  it('accepts a command with no arguments at all', () => {
    expect(declaredCommandSchema.safeParse({ description: 'x', run: ['make', 'all'] }).success).toBe(true);
  });

  it('rejects an unknown key, rather than ignoring it', () => {
    // A typo in `timeoutSeconds` would otherwise mean a command that silently
    // never gets its timeout.
    const parsed = declaredCommandSchema.safeParse({ description: 'x', run: ['make'], timeoutSecond: 30 });
    expect(parsed.success).toBe(false);
  });

  it('rejects a timeout that is not a sane number', () => {
    for (const timeoutSeconds of [0, -1, 1.5, 100_000]) {
      expect(
        declaredCommandSchema.safeParse({ description: 'x', run: ['make'], timeoutSeconds }).success,
      ).toBe(false);
    }
  });
});

describe('keeping only the output that matters', () => {
  const output = ['ok one', 'ok two', 'FAIL three', '  expected 1', '  got 2', 'ok four'].join('\n');

  it('keeps the matching lines and a little either side', () => {
    // A test runner prints a hundred lines of "ok" and four of failure, and the
    // four are the whole message. What counts as a failure is the project's
    // business, so it says so with a pattern.
    const kept = trimOutput(output, 'FAIL', 1);
    expect(kept).toContain('FAIL three');
    expect(kept).toContain('ok two');
    expect(kept).toContain('  expected 1');
    expect(kept).not.toContain('ok one');
    expect(kept).not.toContain('ok four');
  });

  it('marks the gap, so a reader can tell lines were skipped', () => {
    // Two matches with five lines between them, so the gap is real rather than a
    // run of adjacent lines that happens to be a single block.
    const spread = ['FAIL a', 'one', 'two', 'three', 'FAIL b'].join('\n');
    const kept = trimOutput(spread, 'FAIL', 0);
    expect(kept).toBe('FAIL a\n[...]\nFAIL b');
  });

  it('leaves the output alone when the pattern matches nothing', () => {
    // The important case. "I asked to keep the failures and there are none" is a
    // pass, and an empty result would read as "this command printed nothing",
    // which is a different and much more worrying thing.
    expect(trimOutput('all good\nnothing to report', 'FAIL')).toBe('all good\nnothing to report');
  });

  it('leaves the output alone when the pattern is not a pattern', () => {
    // A typo in a config file must not be able to empty a result and make a
    // failing run look silent.
    expect(trimOutput(output, 'FAIL[')).toBe(output);
  });

  it('does nothing at all when the project asked for nothing', () => {
    expect(trimOutput(output, undefined)).toBe(output);
  });
});

/**
 * A command that exits 0 having done nothing.
 *
 * Not a hypothesis. A real workspace declared a command that ran one test by
 * name; the name was a helper function rather than a test, `cargo test -p x
 * --test y <filter>` exited **0** and printed "0 passed; 0 failed", and the
 * command reported a green tick for months of runs while executing nothing. It
 * is the same class of mistake as a check that reports clean because it could
 * not read the tree — the failure mode is success.
 *
 * The exit code cannot catch it, because the exit code is right. Only the
 * project can say what proof looks like, in its own tool's words.
 */
describe('output that has to prove the command did something', () => {
  it('accepts output matching what the project said proof looks like', () => {
    const ran = command({ run: ['cargo', 'test', '-p', 'core'], expect: 'test result: ok\\. [1-9]' });
    expect(unproven(ran, 'running 12 tests\ntest result: ok. 12 passed; 0 failed')).toBeNull();
  });

  it('refuses output that exits 0 having run nothing', () => {
    // The whole reason `expect` exists. `0 passed; 0 failed` is a success by exit
    // code and the run did not happen.
    const ran = command({ run: ['cargo', 'test', '-p', 'core'], expect: 'test result: ok\\. [1-9]' });
    const reason = unproven(ran, 'running 0 tests\ntest result: ok. 0 passed; 0 failed');
    expect(reason).not.toBeNull();
    expect(reason).toContain('has not proved anything');
  });

  it('says nothing at all when the project asked for no proof', () => {
    // Every existing command in every existing workspace keeps working. This is
    // opt-in, and a command without `expect` is exactly as it was.
    expect(unproven(command(), 'anything at all')).toBeNull();
  });

  it('counts a broken pattern as unproven rather than as a pass', () => {
    // A typo in a config file must not be able to turn into a green tick. Note
    // the direction: an unusable pattern fails closed, the same way an unreadable
    // tree does.
    const ran = command({ expect: 'test result: ok. [1-9' });
    expect(unproven(ran, 'test result: ok. 12 passed')).not.toBeNull();
  });

  it('is loaded from a workspace file, and refused when it is not a string', () => {
    const parsed = declaredCommandSchema.safeParse({
      description: 'run the suite',
      run: ['npm', 'test'],
      expect: 'Tests\\s+[1-9]\\d* passed',
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.expect).toBe('Tests\\s+[1-9]\\d* passed');
    expect(declaredCommandSchema.safeParse({ description: 'x', run: ['a'], expect: 12 }).success).toBe(false);
  });
});

/**
 * A task narrowing a command the workspace declared.
 *
 * The gap: a workspace lists the test targets it knows about, and a task that
 * owns one crate could only ever run those four. Which of them a run may touch
 * is a fact about the line of backlog, so the task says so.
 *
 * Every way of getting this wrong is silent — an override naming a command that
 * does not exist does nothing, one naming an argument that does not exist does
 * nothing, and a narrowing that leaves an argument unconstrained is a shell by
 * another name. So all three are problems rather than no-ops.
 */
describe('a task narrowing what a command may be pointed at', () => {
  const four = {
    run_test: command({ args: { target: { description: 'a target', values: ['a', 'b', 'c', 'd'] } } }),
  };

  it('narrows an argument to the values the task names', () => {
    const merged = mergeCommands(four, { run_test: { args: { target: { values: ['a'] } } } });
    expect('commands' in merged).toBe(true);
    if (!('commands' in merged)) return;
    expect(merged.commands.run_test?.args?.target?.values).toEqual(['a']);
    // And the narrowing is real, not decorative: the other three are refused now.
    expect(checkCommandArg('target', merged.commands.run_test!.args!.target!, 'b')).not.toBeNull();
    expect(checkCommandArg('target', merged.commands.run_test!.args!.target!, 'a')).toBeNull();
  });

  it('leaves the commands the task did not mention exactly as they were', () => {
    const merged = mergeCommands(four, { run_test: { args: { target: { values: ['a'] } } } });
    if (!('commands' in merged)) throw new Error('expected a merge');
    expect(merged.commands.run_test?.run).toEqual(['cargo', 'test', '-p', '{target}']);
    expect(merged.commands.run_test?.description).toBe(four.run_test.description);
  });

  it('replaces a pattern with values rather than carrying both', () => {
    // The trap: `checkCommandArg` prefers `values`, so a merged command holding
    // the workspace's old `pattern` beside the task's new `values` would look
    // narrowed and behave narrowed — until somebody read the file and believed
    // the pattern. One constraint or the other, never both.
    const byPattern = {
      run_test: command({
        args: { target: { description: 'a target', pattern: '^[a-z-]+$' } },
      }),
    };
    const merged = mergeCommands(byPattern, { run_test: { args: { target: { values: ['a'] } } } });
    if (!('commands' in merged)) throw new Error('expected a merge');
    expect(merged.commands.run_test?.args?.target?.values).toEqual(['a']);
    expect(merged.commands.run_test?.args?.target?.pattern).toBeUndefined();
  });

  it('refuses an override naming a command the workspace does not declare', () => {
    const merged = mergeCommands(four, { run_everything: { args: {} } });
    expect('problems' in merged).toBe(true);
    if (!('problems' in merged)) return;
    expect(merged.problems[0]?.path).toBe('commands.run_everything');
    expect(merged.problems[0]?.message).toContain('does not declare');
  });

  it('refuses an override naming an argument the command does not have', () => {
    // Otherwise a typo'd argument name reads as a successful narrowing and the
    // run keeps its whole target list, which is the opposite of what was asked.
    const merged = mergeCommands(four, { run_test: { args: { targets: { values: ['a'] } } } });
    expect('problems' in merged).toBe(true);
    if (!('problems' in merged)) return;
    expect(merged.problems[0]?.path).toBe('commands.run_test.args.targets');
  });

  it('lets a task make an argument optional without freeing it', () => {
    // The task may say a run need not name a target. It may not say the target
    // can be anything: the constraint survives the override, because the
    // constraint is the thing standing between a model-chosen string and an
    // argv. "Optional" and "unconstrained" are different words and this is the
    // line between them.
    const two = {
      run_test: command({
        args: { target: { description: 'a target', values: ['a', 'b'] } },
        run: ['cargo', 'test', '{target}'],
      }),
    };
    const merged = mergeCommands(two, { run_test: { args: { target: { optional: true } } } });
    if (!('commands' in merged)) throw new Error('expected a merge');
    const target = merged.commands.run_test?.args?.target;
    expect(target?.optional).toBe(true);
    expect(target?.values).toEqual(['a', 'b']);
    // Droppable, because the placeholder stands where the value goes rather than
    // after a flag that would be left hanging.
    expect(commandArgv(merged.commands.run_test!, {})).toEqual({ argv: ['cargo', 'test'] });
    expect(commandArgv(merged.commands.run_test!, { target: 'b' })).toEqual({
      argv: ['cargo', 'test', 'b'],
    });
  });

  it('refuses an optional argument that would leave a flag with nothing after it', () => {
    // Found while writing the test above. `["cargo","test","-p","{target}"]`
    // with an optional target spawns `cargo test -p`, which is not "no target"
    // — it is a broken command, and the failure would have surfaced as a
    // confusing tool error several turns into a run.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-optional-'));
    try {
      fs.mkdirSync(path.join(dir, 'work'), { recursive: true });
      const file = path.join(dir, 'dsh.workspace.json');
      fs.writeFileSync(
        file,
        JSON.stringify({
          name: 'demo',
          commands: {
            run_test: {
              description: 'run one target',
              args: { target: { description: 'a target', values: ['a'], optional: true } },
              run: ['cargo', 'test', '-p', '{target}'],
            },
          },
        }),
      );
      expect(() => loadWorkspace(file)).toThrowError(/cannot be optional/);

      // And the same command is fine when the value stands on its own.
      fs.writeFileSync(
        file,
        JSON.stringify({
          name: 'demo',
          commands: {
            run_test: {
              description: 'run one target',
              args: { target: { description: 'a target', values: ['a'], optional: true } },
              run: ['cargo', 'test', '{target}'],
            },
          },
        }),
      );
      expect(loadWorkspace(file).config.commands?.run_test?.run).toEqual(['cargo', 'test', '{target}']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('refuses a command that would load with an argument it cannot constrain', () => {
    // Unreachable through a real workspace — `checkCommandArg` refuses to run one
    // — so this holds the branch down directly. An argument with neither values
    // nor a pattern is free text spliced into an argv, and the merge has to say
    // so rather than produce it.
    const broken = {
      run_test: command({ args: { target: { description: 'a target' } } }),
    };
    const merged = mergeCommands(broken, { run_test: { args: { target: { optional: true } } } });
    expect('problems' in merged).toBe(true);
    if (!('problems' in merged)) return;
    expect(merged.problems[0]?.message).toContain('a shell by another name');
  });

  it('cannot reach the argv, only the arguments', () => {
    // Deliberate, and the load-bearing half of the design: everything dangerous
    // is in the argv, and it stays in the workspace where the project can be read
    // as a whole. A task file that writes `run` is refused as an unknown key.
    const parsed = taskFileSchema.safeParse({
      name: 't',
      worktree: '..',
      allow: ['src/**'],
      commands: { run_test: { run: ['rm', '-rf', '/'] } },
    });
    expect(parsed.success).toBe(false);
  });

  it('merges into the task config, and fails the task on an unknown command', () => {
    // Through `loadRunConfig`, because the merge only matters if it is wired in.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-task-cmd-'));
    try {
      fs.mkdirSync(path.join(dir, 'work'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'dsh.workspace.json'),
        JSON.stringify({
          name: 'demo',
          model: 'deepseek-flash',
          defaultProfile: 'default',
          profiles: { default: 'profile.json' },
          commands: {
            run_test: {
              description: 'run one target',
              args: { target: { description: 'a target', values: ['a', 'b'] } },
              run: ['cargo', 'test', '-p', '{target}'],
            },
          },
        }),
      );
      fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify({ checks: {} }));
      const task = (commands: unknown): string => {
        const file = path.join(dir, `task-${Math.random().toString(36).slice(2)}.json`);
        fs.writeFileSync(
          file,
          JSON.stringify({ name: 't', worktree: 'work', task: 'do it', allow: ['src/**'], commands }),
        );
        return file;
      };

      const narrowed = loadRunConfig(task({ run_test: { args: { target: { values: ['a'] } } } }));
      expect(narrowed.commands.run_test?.args?.target?.values).toEqual(['a']);

      expect(() => loadRunConfig(task({ nope: { args: {} } }))).toThrowError(/does not declare/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});
