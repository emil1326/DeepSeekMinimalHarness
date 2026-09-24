/**
 * Running git, from a process that has no console of its own.
 *
 * Every git call in the harness goes through here, for two reasons that were
 * both found the hard way.
 *
 * **`windowsHide`.** The daemon is started detached with no console, so a child
 * process it launches without this flag gets a *new console window*. Clicking
 * "diff" in the UI ran `git diff`, and a black `cmd` window appeared on the
 * user's desktop for as long as the command took. The worker's checks already
 * passed the flag; these three call sites did not, and there is now one place
 * that does.
 *
 * **A buffer big enough, and an error that is not silence.** `strayChanges` used
 * Node's default 1 MiB `maxBuffer`. Past it `execFileSync` throws `ENOBUFS`, the
 * `catch` swallowed it and returned "no stray changes" — so the loudest control
 * in the harness reported a clean tree on exactly the dirty worktree it exists
 * to catch. Probed with 6000 untracked files (1.22 MB of output): zero entries
 * reported. The buffer is bigger now and a failure is returned rather than
 * swallowed, so a report can say "could not tell" instead of "clean".
 */

import { execFileSync } from 'node:child_process';
import { timing } from './timing.js';

/**
 * Big enough for a very dirty worktree.
 *
 * `strayChanges` asks for `-uall`, which lists every untracked file, so on a
 * checkout with a freshly installed `node_modules` this is genuinely megabytes.
 * The daemon already used 32 MB for the diff; this is that number, in one place.
 */
export const GIT_MAX_BUFFER = 32 * 1024 * 1024;

export interface GitOptions {
  cwd: string;
  maxBuffer?: number;
}

/**
 * Run git and return its stdout. Throws on a non-zero exit.
 *
 * Timed because a git call is the one thing in the harness that starts a whole
 * process for a millisecond of work, and the end-of-run stray check is a
 * `git status -uall` over an entire worktree. It is also named for its argv, so
 * the table says which call was slow rather than "git was slow".
 */
export function git(args: string[], options: GitOptions): string {
  return timing.measure(
    `core.git.${args[0] ?? 'git'}`,
    () =>
      execFileSync('git', args, {
        cwd: options.cwd,
        encoding: 'utf8',
        maxBuffer: options.maxBuffer ?? GIT_MAX_BUFFER,
        // Without this a detached daemon puts a console window on somebody's screen.
        windowsHide: true,
      }),
    (out) => out.length,
  );
}

/** Run git, or get `null` if it failed at all. */
export function gitOrNull(args: string[], options: GitOptions): string | null {
  try {
    return git(args, options);
  } catch {
    return null;
  }
}

/** Why git could not be run, phrased for a person reading a report. */
export function gitFailure(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return 'git is not installed, or not on PATH';
  if (code === 'ENOBUFS') return 'git produced more output than the harness will hold';
  if (code === 'ENOTDIR' || code === 'ENOENT') return 'that folder is not there any more';
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0] ?? message;
}
