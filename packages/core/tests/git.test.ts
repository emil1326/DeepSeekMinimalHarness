/**
 * Every git call the harness makes, and the two things it got wrong.
 *
 * `windowsHide` is not a style preference here. The daemon is started detached
 * with no console of its own, so a child process launched without that flag gets
 * a brand-new console window on somebody's desktop. Opening the Diff panel in
 * the UI ran `git diff` and a black `cmd` window appeared for as long as the
 * command took. The check processes already passed the flag; the git call sites
 * did not.
 *
 * The `maxBuffer` matters more than it sounds. `strayChanges` used Node's 1 MiB
 * default; past it `execFileSync` throws `ENOBUFS`, and the old `catch` turned
 * that into "no stray changes". So the loudest control in the harness reported a
 * clean tree on the very dirty worktree it exists to catch. Probed with 6000
 * untracked files (1.22 MB of output): zero entries.
 *
 * Mocked at the module boundary rather than spied on, because an ESM namespace
 * is not configurable and `vi.spyOn` cannot reach into `node:child_process`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { execFileSync } = vi.hoisted(() => ({ execFileSync: vi.fn() }));
vi.mock('node:child_process', () => ({ execFileSync }));

const { GIT_MAX_BUFFER, git, gitFailure, gitOrNull } = await import('@emilswork/harness-core');

beforeEach(() => {
  execFileSync.mockReset();
});

/** The options the last call was made with. */
function optionsOf(call: number): Record<string, unknown> {
  return (execFileSync.mock.calls[call]?.[2] ?? {}) as Record<string, unknown>;
}

describe('running git', () => {
  it('hides the console window, because the daemon has no console to inherit', () => {
    execFileSync.mockReturnValue('ok');
    expect(git(['status'], { cwd: 'C:/tmp' })).toBe('ok');

    expect(execFileSync).toHaveBeenCalledTimes(1);
    const [program, args] = execFileSync.mock.calls[0] as [string, string[]];
    expect(program).toBe('git');
    expect(args).toEqual(['status']);
    expect(optionsOf(0).windowsHide).toBe(true);
    expect(optionsOf(0).cwd).toBe('C:/tmp');
    expect(optionsOf(0).encoding).toBe('utf8');
  });

  it('gives git a buffer that is not a surprise', () => {
    // The daemon used 32 MB and `strayChanges` used Node's 1 MB default, so the
    // two disagreed about how much output is too much. One number now.
    execFileSync.mockReturnValue('');
    git(['status'], { cwd: '.' });
    expect(optionsOf(0).maxBuffer).toBe(GIT_MAX_BUFFER);
    expect(GIT_MAX_BUFFER).toBeGreaterThan(1024 * 1024);
  });

  it('takes a smaller buffer when a caller asks for one', () => {
    execFileSync.mockReturnValue('');
    git(['diff'], { cwd: '.', maxBuffer: 1024 });
    expect(optionsOf(0).maxBuffer).toBe(1024);
  });

  it('gives null rather than throwing when a caller cannot act on the failure', () => {
    execFileSync.mockImplementation(() => {
      throw new Error('boom');
    });
    expect(gitOrNull(['status'], { cwd: '.' })).toBeNull();
  });

  it('still throws when a caller wants to know', () => {
    execFileSync.mockImplementation(() => {
      throw new Error('boom');
    });
    expect(() => git(['status'], { cwd: '.' })).toThrowError('boom');
  });

  it('hides the console window on the null-returning path too', () => {
    // The diff route is the one that popped windows, and it goes through here.
    execFileSync.mockReturnValue('a diff');
    gitOrNull(['diff', 'HEAD'], { cwd: '.' });
    expect(optionsOf(0).windowsHide).toBe(true);
  });
});

describe('saying why git could not run', () => {
  it('names a missing git', () => {
    const error = new Error('spawnSync git ENOENT') as NodeJS.ErrnoException;
    error.code = 'ENOENT';
    expect(gitFailure(error)).toContain('not installed');
  });

  it('names an output too big to hold', () => {
    // The one that used to be silent, and the reason a very dirty worktree
    // reported as clean.
    const error = new Error('Command failed: git status') as NodeJS.ErrnoException;
    error.code = 'ENOBUFS';
    expect(gitFailure(error)).toContain('more output than the harness will hold');
  });

  it('falls back to the first line of whatever the error was', () => {
    expect(gitFailure(new Error('something else\nand a second line'))).toBe('something else');
  });

  it('copes with something that is not an error at all', () => {
    expect(gitFailure('a string thrown for no good reason')).toContain('a string');
  });
});
