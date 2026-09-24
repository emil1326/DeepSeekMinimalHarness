/**
 * Worktrees and patches: the two things an orchestrator redoes by hand.
 *
 * Both exist because of what the loop that drives this actually does, per line
 * of a backlog: make a worktree, link `node_modules` into it, wait for setup,
 * run an agent, then get the result out as something it can apply. Every one of
 * those steps was a shell script in somebody else's project.
 *
 * **The patch is written from git, not reconstructed from the log.** A run's
 * `replace_in_file` calls do carry the old and new text, so a patch could be
 * assembled from them — and it would be wrong the moment anything else touched
 * the file: a formatter the run invoked, a second edit that overlapped the
 * first, a check that regenerated something. Git already knows what the file
 * looks like against `HEAD` and it is the authority on how to say that as a
 * patch, so this asks it.
 *
 * The one thing git is not asked is a file the run created, because an untracked
 * file is invisible to `git diff`. The intent-to-add trick (`git add -N`) would
 * make it visible and it mutates the index of somebody's worktree, so the patch
 * for a new file is written here instead. That is a real risk of being subtly
 * wrong, so it is proved by applying it in a test rather than by reading it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gitOrNull, IS_WINDOWS, realPath, relNorm, toPosix } from '@emilswork/harness-core';

export interface PatchResult {
  patch: string;
  /** Files the patch covers. */
  files: string[];
  /**
   * Things a person needs to know before applying it.
   *
   * A file git cannot describe, a file that is already committed, a file the run
   * wrote but that is no longer there: none of those are failures, and all of
   * them make the patch say less than the whole story.
   */
  notes: string[];
}

/**
 * A patch of one run's changes, ready for `git apply --3way`.
 *
 * `files` is what the run says it wrote, which is the point: the worktree may
 * hold other people's work, and a patch that swept it up would be worse than no
 * patch at all.
 */
export function patchFor(worktree: string, files: string[]): PatchResult {
  const notes: string[] = [];
  const parts: string[] = [];
  const covered: string[] = [];

  for (const file of [...files].sort()) {
    const rel = relNorm(file);
    const full = path.join(worktree, ...rel.split('/'));
    const tracked = gitOrNull(['ls-files', '--error-unmatch', '--', rel], { cwd: worktree }) !== null;

    if (!fs.existsSync(full)) {
      // The run wrote it and it is not there now. Either somebody removed it or
      // it was never really written, and either way there is no patch to make.
      notes.push(`${rel}: gone from the worktree, so nothing to patch`);
      continue;
    }

    if (!tracked) {
      parts.push(newFilePatch(worktree, rel));
      covered.push(rel);
      continue;
    }
    const diff = gitOrNull(['diff', '--binary', 'HEAD', '--', rel], { cwd: worktree });
    if (diff === null) {
      notes.push(`${rel}: git could not diff it`);
      continue;
    }
    if (diff.trim() === '') {
      // Tracked and identical to HEAD. That usually means the work was committed
      // — in which case there is nothing to apply — or that the edit was undone.
      notes.push(`${rel}: no difference from HEAD, so already committed or undone`);
      continue;
    }
    parts.push(diff.endsWith('\n') ? diff : `${diff}\n`);
    covered.push(rel);
  }

  return { patch: parts.join(''), files: covered, notes };
}

/**
 * The patch for a file git is not tracking.
 *
 * Written by hand because `git diff` cannot see an untracked file, and the
 * alternative — `git add -N` — changes the index of a worktree that belongs to
 * somebody else. The object hash on the `index` line is the real one, computed
 * without writing anything, because `git apply --3way` reads it.
 *
 * Line endings are the part that can be subtly wrong. Git's own diff shows a
 * file as it would be stored, which means LF when `core.autocrlf` is on, and
 * `git apply` converts back on the way in. A patch that always normalised would
 * disagree with git on a repository that keeps its CRLF, and the applied file
 * would differ from the one the run actually wrote. So the setting is asked for
 * rather than guessed at, and the bytes come out the way git would have written
 * them either way.
 */
function newFilePatch(worktree: string, rel: string): string {
  const full = path.join(worktree, ...rel.split('/'));
  const raw = fs.readFileSync(full, 'utf8');
  const normalise = gitNormalisesLineEndings(worktree);
  const text = normalise ? raw.replace(/\r\n/g, '\n') : raw;
  const lines = text.split('\n');
  // A file ending in a newline splits to a trailing empty element, which is not
  // a line and must not become a `+` line of its own.
  const trailing = lines[lines.length - 1] === '';
  if (trailing) lines.pop();

  // The object name is of the text as it is written into the patch, not of the
  // file on disk: git compares against the stored form, and the two differ
  // whenever it is rewriting line endings.
  const blob = blobHash(text);
  const mode = isExecutable(full) ? '100755' : '100644';
  const body = lines.map((line) => `+${line}`);
  if (!trailing && lines.length > 0) body.push('\\ No newline at end of file');

  return [
    `diff --git a/${rel} b/${rel}`,
    `new file mode ${mode}`,
    `index 0000000..${blob.slice(0, 7)}`,
    '--- /dev/null',
    `+++ b/${rel}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...body,
    '',
  ].join('\n');
}

/**
 * Whether git would rewrite line endings on the way in or out.
 *
 * `true` and `input` both mean the stored form is LF. Anything else, including
 * an unset value, means the bytes are the bytes.
 */
function gitNormalisesLineEndings(worktree: string): boolean {
  const setting = (gitOrNull(['config', '--get', 'core.autocrlf'], { cwd: worktree }) ?? '').trim();
  return setting === 'true' || setting === 'input';
}

function isExecutable(full: string): boolean {
  if (IS_WINDOWS) return false;
  try {
    return (fs.statSync(full).mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * A git blob's object name: SHA-1 over `blob <byte length>\0<content>`.
 *
 * Computed here rather than by shelling out to `git hash-object`, which would
 * need a way to pipe input through the shared git helper and would be a change
 * to a file other work is going through. The format is part of git's on-disk
 * contract and has not changed since it was written, and the test that applies a
 * generated patch proves the name is the one git expected.
 */
function blobHash(text: string): string {
  const body = Buffer.from(text, 'utf8');
  const header = Buffer.from(`blob ${body.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(body).digest('hex');
}

export interface WorktreeResult {
  path: string;
  notes: string[];
}

/**
 * A worktree beside the repository, with the dependencies linked in.
 *
 * Beside rather than inside, because inside is where the agent works and a
 * second checkout under the first would show up in the first one's `git status`.
 * That convention is `F:/vsCode/esap-ds-1` next to `F:/vsCode/esap`, so a name
 * alone is enough to say where it goes.
 *
 * `node_modules` is linked rather than installed. An install per worktree is
 * minutes and gigabytes for a tree that is identical in all of them, and a
 * junction on Windows and a symlink elsewhere both cost nothing. It is skipped
 * when the new worktree already has one, which happens when it was committed.
 *
 * `setup` from the workspace is deliberately not run here. The worker runs it
 * once per worktree on the first run, and doing it in two places would be two
 * implementations of one thing that could disagree.
 */
export function createWorktree(input: { repo: string; name: string; from?: string }): WorktreeResult {
  const repo = realPath(input.repo);
  const target = path.join(path.dirname(repo), input.name);
  if (fs.existsSync(target)) {
    throw new Error(`${target} is already there`);
  }
  const notes: string[] = [];

  const args = ['worktree', 'add', target, '-b', input.name];
  if (input.from !== undefined) args.push(input.from);
  const output = gitOrNull(args, { cwd: repo });
  if (output === null) {
    // Git's own message is better than anything worth paraphrasing here: it says
    // whether the branch exists, whether the path is taken and why.
    throw new Error(`git worktree add failed; run it by hand in ${repo} to see why`);
  }

  const modules = path.join(repo, 'node_modules');
  const linked = path.join(target, 'node_modules');
  if (fs.existsSync(modules) && !fs.existsSync(linked)) {
    try {
      // `junction` on Windows, and it needs no elevation, which `'dir'` does.
      fs.symlinkSync(modules, linked, IS_WINDOWS ? 'junction' : 'dir');
      notes.push(`linked node_modules from ${repo}`);
    } catch (error) {
      notes.push(`could not link node_modules: ${(error as Error).message}`);
    }
  }

  notes.push("the workspace's `setup` steps run on this worktree the first time a run starts in it");
  return { path: target, notes };
}

export interface ResetResult {
  path: string;
  /** How many untracked files went with it. */
  removed: number;
  notes: string[];
}

/**
 * A worktree back to a commit, keeping the ignored files.
 *
 * `clean -fd` and not `-x`: `node_modules` and `target` are ignored, they are the
 * expensive part, and a reset that deleted them would make resetting as slow as
 * making a new worktree. What it does delete is untracked *source*, which is
 * exactly what a half-finished agent run leaves behind.
 *
 * The caller is expected to have checked that nothing is running in there. It is
 * a separate step rather than done here because this file knows nothing about
 * the daemon.
 */
export function resetWorktree(input: { repo: string; target: string; ref: string }): ResetResult {
  const target = path.resolve(input.target);
  const notes: string[] = [];

  const before = gitOrNull(['status', '--porcelain', '-uall'], { cwd: target });
  const dirty = before === null ? 0 : before.split('\n').filter((line) => line.trim() !== '').length;

  if (gitOrNull(['reset', '--hard', input.ref], { cwd: target }) === null) {
    throw new Error(`git reset --hard ${input.ref} failed in ${target}`);
  }
  // `-d` for untracked directories, which a plan folder or a scratch build is.
  gitOrNull(['clean', '-fd'], { cwd: target });

  if (dirty > 0) notes.push(`${dirty} file(s) had changes before the reset, and they are gone`);
  return { path: toPosix(target), removed: dirty, notes };
}

/** Where a worktree named this would be, given the repository it belongs to. */
export function worktreePathFor(repo: string, nameOrPath: string): string {
  if (path.isAbsolute(nameOrPath) || nameOrPath.includes('/') || nameOrPath.includes('\\')) {
    return path.resolve(nameOrPath);
  }
  return path.join(path.dirname(realPath(repo)), nameOrPath);
}
