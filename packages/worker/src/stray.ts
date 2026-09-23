import { execFileSync } from 'node:child_process';
import { relNorm, toPosix, type ResolvedRunConfig } from '@emilswork/harness-core';

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
export function strayChanges(root: string, allow: Iterable<string>): string[] {
  const allowed = new Set([...allow].map((entry) => relNorm(entry)));
  let output: string;
  try {
    output = execFileSync('git', ['status', '--porcelain', '-uall'], { cwd: root, encoding: 'utf8' });
  } catch {
    return [];
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
  return changed.filter((file) => !allowed.has(relNorm(file)));
}

export function isGitWorktree(root: string): boolean {
  try {
    return (
      execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, encoding: 'utf8' }).trim() ===
      'true'
    );
  } catch {
    return false;
  }
}

export type { ResolvedRunConfig };
