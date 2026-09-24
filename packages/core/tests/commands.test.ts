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
import {
  checkCommandArg,
  commandArgv,
  declaredCommandSchema,
  trimOutput,
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
