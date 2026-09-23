import { git, gitFailure, relNorm, toPosix, type ResolvedRunConfig } from '@emilswork/harness-core';

export interface StrayReport {
  /** Changed files that are not on the allow list. */
  files: string[];
  /**
   * Why the worktree could not be read, when it could not be.
   *
   * This used to be indistinguishable from "nothing stray", which is how the
   * loudest control reported a clean tree on a very dirty one: `execFileSync`
   * threw `ENOBUFS` past its 1 MiB buffer, the `catch` returned `[]`, and the
   * caller read that as a pass. A report that cannot tell has to say so.
   */
  failure: string | null;
}

/**
 * What the worktree changed that the task did not allow.
 *
 * Whatever caused it, it is reported loudly: the whole point of running in a
 * git worktree is that every change it makes is a diff somebody reads.
 *
 * `-uall` matters: without it git collapses a wholly untracked directory into
 * one `dir/` entry, which never matches the allow list and reports a stray
 * change for a file that was allowed.
 */
export function strayChanges(root: string, allow: Iterable<string>): StrayReport {
  const allowed = new Set([...allow].map((entry) => relNorm(entry)));
  let output: string;
  try {
    // Through the shared helper, so this cannot drift from the daemon's own git
    // calls in buffer size or in whether it hides its console window.
    output = git(['status', '--porcelain', '-uall'], { cwd: root });
  } catch (error) {
    return { files: [], failure: gitFailure(error) };
  }
  const changed = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => {
      const entry = line.slice(2).trim();
      const renamed = entry.split(' -> ');
      return toPosix((renamed[renamed.length - 1] ?? entry).replace(/^"|"$/g, ''));
    });
  return { files: changed.filter((file) => !allowed.has(relNorm(file))), failure: null };
}

export function isGitWorktree(root: string): boolean {
  try {
    return git(['rev-parse', '--is-inside-work-tree'], { cwd: root }).trim() === 'true';
  } catch {
    return false;
  }
}

export type { ResolvedRunConfig };
