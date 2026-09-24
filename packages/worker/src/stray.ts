import {
  covered,
  git,
  gitFailure,
  relNorm,
  timing,
  toPosix,
  type ResolvedRunConfig,
} from '@emilswork/harness-core';

export interface StrayReport {
  /** Changed files that are on no list at all. The ones that matter. */
  files: string[];
  /**
   * Changed files on the task's soft list.
   *
   * Writable, and reported rather than refused. A test file beside the one a
   * task modifies has to be touched almost every time and is forgotten in the
   * task file almost every time, and the choice used to be between stopping the
   * run and loosening a rule. These are the middle ground: allowed, and said out
   * loud, so a reader can see the task grew beyond its own plan without the run
   * having to stop and ask.
   */
  offPlan: string[];
  /**
   * Files that were already changed when this run started.
   *
   * Excluded from `files` on purpose. A second run in a worktree that already
   * holds a first run's work reported every one of the first run's files as a
   * stray change, which is true and useless: the loudest control in the harness
   * fired on every run after the first, and the one that mattered was lost in
   * it. What a reader needs is what *this* run did.
   */
  preExisting: string[];
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
 * The files a worktree has changed, split by whether anybody said they could be.
 *
 * Whatever caused it, a change on no list is reported loudly: the whole point of
 * running in a git worktree is that every change it makes is a diff somebody
 * reads.
 *
 * `-uall` matters: without it git collapses a wholly untracked directory into
 * one `dir/` entry, which never matches the allow list and reports a stray
 * change for a file that was allowed.
 */
export function strayChanges(
  root: string,
  allow: Iterable<string>,
  options: { soft?: Iterable<string>; baseline?: Iterable<string> } = {},
): StrayReport {
  // One `git status --porcelain -uall` over the worktree, listed and then
  // filtered through three sets. Timed because it runs twice per run — once for
  // the baseline and once at the end — and on a checkout with an installed
  // `node_modules` that is a genuinely large listing to parse.
  return timing.measure('worker.stray.status', () => scanForStray(root, allow, options));
}

function scanForStray(
  root: string,
  allow: Iterable<string>,
  options: { soft?: Iterable<string>; baseline?: Iterable<string> },
): StrayReport {
  // Kept as lists rather than sets, because membership is `covered` and not
  // equality: a task file's allow list holds globs, and until this asked the
  // glob matcher, a file created under `docs/**` was reported as a change on no
  // list at all — a loud false alarm about the only thing the run was allowed to
  // touch. See `covered` in `paths.ts`.
  const allowed = [...allow].map((entry) => relNorm(entry));
  const soft = [...(options.soft ?? [])].map((entry) => relNorm(entry));
  const before = new Set([...(options.baseline ?? [])].map((entry) => relNorm(entry)));

  let output: string;
  try {
    // Through the shared helper, so this cannot drift from the daemon's own git
    // calls in buffer size or in whether it hides its console window.
    output = git(['status', '--porcelain', '-uall'], { cwd: root });
  } catch (error) {
    return { files: [], offPlan: [], preExisting: [], failure: gitFailure(error) };
  }

  const changed = changedPaths(output);
  return {
    files: changed.filter((file) => !covered(allowed, file) && !covered(soft, file) && !before.has(file)),
    offPlan: changed.filter((file) => covered(soft, file) && !before.has(file)),
    preExisting: changed.filter((file) => before.has(file)),
    failure: null,
  };
}

/**
 * Every path `git status --porcelain` reports, in allow-list form.
 *
 * Split out because two callers want the raw set now: the check at the end of a
 * run, and the snapshot taken at the start of one. A rename is reported as the
 * name it ended up with, which is the one that exists on disk.
 */
export function changedPaths(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => {
      const entry = line.slice(2).trim();
      const renamed = entry.split(' -> ');
      return toPosix((renamed[renamed.length - 1] ?? entry).replace(/^"|"$/g, ''));
    })
    .map((file) => relNorm(file));
}

/**
 * The set of already-changed files, taken before an agent starts.
 *
 * Best effort: a worktree that cannot be read gives an empty set, which means
 * everything it later reports is treated as this run's doing. That is the safe
 * direction — it over-reports rather than under-reports — and the failure is
 * reported separately when the run ends.
 */
export function snapshotChanges(root: string): string[] {
  try {
    return changedPaths(git(['status', '--porcelain', '-uall'], { cwd: root }));
  } catch {
    return [];
  }
}

export function isGitWorktree(root: string): boolean {
  try {
    return git(['rev-parse', '--is-inside-work-tree'], { cwd: root }).trim() === 'true';
  } catch {
    return false;
  }
}

export type { ResolvedRunConfig };
