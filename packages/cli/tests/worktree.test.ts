/**
 * Worktrees and patches: the two things an orchestrator redid by hand.
 *
 * The important test in here is the one that **applies** a generated patch. A
 * patch is text somebody else's git has to accept, and a hand-written diff is
 * exactly the kind of thing that looks right and is not: the wrong object name
 * on the `index` line, a missing "no newline at end of file", an off-by-one in
 * the hunk header. Reading it proves nothing, so the new-file patch is written
 * to a worktree, applied to a second one, and the file is read back.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { createWorktree, patchFor, resetWorktree, worktreePathFor } from '../src/worktree.js';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-worktree-'));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

let counter = 0;

/** A git repository with one commit, and a `git` that never asks who you are. */
function repo(files: Record<string, string> = { 'src/a.ts': 'export const a = 1;\n' }): string {
  counter += 1;
  const root = path.join(scratch, `repo-${counter}`);
  fs.mkdirSync(root, { recursive: true });
  git(root, ['init', '-q']);
  for (const [name, body] of Object.entries(files)) write(root, name, body);
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'start']);
  return root;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=dsh', '-c', 'user.email=dsh@example.invalid', ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
}

function write(root: string, name: string, body: string): void {
  const full = path.join(root, ...name.split('/'));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body, 'utf8');
}

function read(root: string, name: string): string {
  return fs.readFileSync(path.join(root, ...name.split('/')), 'utf8');
}

/**
 * A file's text with its line endings made uniform.
 *
 * Git checks out with CRLF on a machine whose `core.autocrlf` says so, and the
 * tests here compare content rather than line endings. What the line endings are
 * is git's business, and the patch has a test of its own for that.
 */
function textOf(root: string, name: string): string {
  return read(root, name).replace(/\r\n/g, '\n');
}

describe('the patch for a run', () => {
  it('applies to a clean worktree, for an edit and for a new file', () => {
    // The whole reason this test exists. Two kinds of change, one patch, and the
    // proof is a second worktree that ends up byte-identical.
    const source = repo();
    const target = repo();

    write(source, 'src/a.ts', 'export const a = 2;\n');
    write(source, 'src/new.ts', 'export const fresh = true;\n');

    const { patch, files, notes } = patchFor(source, ['src/a.ts', 'src/new.ts']);
    expect(files).toEqual(['src/a.ts', 'src/new.ts']);
    expect(notes).toEqual([]);

    fs.writeFileSync(path.join(scratch, 'p.patch'), patch, 'utf8');
    git(target, ['apply', '--3way', path.join(scratch, 'p.patch')]);

    expect(textOf(target, 'src/a.ts')).toBe('export const a = 2;\n');
    expect(textOf(target, 'src/new.ts')).toBe('export const fresh = true;\n');
  });

  it('applies a new file that has no trailing newline', () => {
    // The case a hand-written diff gets wrong, and the reason `\ No newline at
    // end of file` exists. Without it the applied file gains a newline it never
    // had, and a formatter check the run passed suddenly fails in the
    // orchestrator's tree.
    const source = repo();
    const target = repo();
    write(source, 'src/no-newline.ts', 'export const x = 1;');

    const { patch } = patchFor(source, ['src/no-newline.ts']);
    fs.writeFileSync(path.join(scratch, 'nl.patch'), patch, 'utf8');
    git(target, ['apply', '--3way', path.join(scratch, 'nl.patch')]);

    expect(textOf(target, 'src/no-newline.ts')).toBe('export const x = 1;');
  });

  it('leaves out a file that is already committed', () => {
    // A run whose work was committed has nothing to apply, and a patch that
    // silently contained nothing would look like a run that changed nothing.
    const source = repo();
    write(source, 'src/a.ts', 'export const a = 3;\n');
    git(source, ['add', '-A']);
    git(source, ['commit', '-q', '-m', 'the run']);

    const { patch, files, notes } = patchFor(source, ['src/a.ts']);
    expect(patch).toBe('');
    expect(files).toEqual([]);
    expect(notes.join(' ')).toContain('already committed');
  });

  it('says so when a file the run wrote is gone', () => {
    const source = repo();
    const { files, notes } = patchFor(source, ['src/vanished.ts']);
    expect(files).toEqual([]);
    expect(notes.join(' ')).toContain('gone from the worktree');
  });

  it('covers only the files it was given, whatever else is lying around', () => {
    // The worktree can hold somebody else's work. A patch that swept it up would
    // be worse than no patch.
    const source = repo();
    write(source, 'src/a.ts', 'export const a = 2;\n');
    write(source, 'somebody-elses.ts', 'theirs\n');

    const { patch, files } = patchFor(source, ['src/a.ts']);
    expect(files).toEqual(['src/a.ts']);
    expect(patch).not.toContain('somebody-elses');
  });

  it('is empty when the run changed nothing', () => {
    const source = repo();
    expect(patchFor(source, []).patch).toBe('');
  });
});

describe('making a worktree', () => {
  it('puts it beside the repository, with its own branch', () => {
    // The convention the project already used: `F:/vsCode/esap-ds-1` next to
    // `F:/vsCode/esap`, so a name is enough to say where it goes.
    const source = repo();
    const name = `wt-${counter}-a`;
    const made = createWorktree({ repo: source, name });
    expect(fs.existsSync(path.join(made.path, 'src', 'a.ts'))).toBe(true);
    expect(path.dirname(made.path)).toBe(path.dirname(source));
    expect(git(made.path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe(name);
  });

  it('links node_modules rather than installing it again', () => {
    // An install per worktree is minutes and gigabytes for a tree identical in
    // all of them. The link is what makes `dsh worktree new` worth having.
    const source = repo();
    write(source, 'node_modules/dep/index.js', 'module.exports = 1;\n');
    const made = createWorktree({ repo: source, name: `wt-${counter}-b` });
    const linked = path.join(made.path, 'node_modules');
    expect(fs.existsSync(linked)).toBe(true);
    expect(fs.readFileSync(path.join(linked, 'dep', 'index.js'), 'utf8')).toContain('module.exports');
    expect(made.notes.join(' ')).toContain('linked node_modules');
  });

  it('refuses a path that is already taken', () => {
    const source = repo();
    const made = createWorktree({ repo: source, name: `wt-${counter}-c` });
    expect(() => createWorktree({ repo: source, name: path.basename(made.path) })).toThrow(/already there/);
  });

  it('says that setup runs later, rather than running it twice', () => {
    // The worker runs the workspace's `setup` on the first run in a worktree.
    // Doing it here too would be two implementations of one thing.
    const source = repo();
    const made = createWorktree({ repo: source, name: `wt-${counter}-d` });
    expect(made.notes.join(' ')).toContain('setup');
  });

  it('finds a worktree by name, and takes a path as a path', () => {
    const source = repo();
    expect(worktreePathFor(source, 'esap-ds-1')).toBe(path.join(path.dirname(source), 'esap-ds-1'));
    expect(worktreePathFor(source, path.join(scratch, 'somewhere'))).toBe(path.join(scratch, 'somewhere'));
  });
});

describe('resetting a worktree', () => {
  it('puts the tracked files back and takes the untracked ones with it', () => {
    const source = repo();
    write(source, 'src/a.ts', 'export const a = 2;\n');
    write(source, 'src/half-finished.ts', 'scratch\n');
    git(source, ['add', 'src/a.ts']);
    git(source, ['commit', '-q', '-m', 'the run']);

    const result = resetWorktree({ repo: source, target: source, ref: 'HEAD~1' });
    expect(textOf(source, 'src/a.ts')).toBe('export const a = 1;\n');
    expect(fs.existsSync(path.join(source, 'src', 'half-finished.ts'))).toBe(false);
    expect(result.removed).toBeGreaterThan(0);
  });

  it('leaves the ignored files alone, because they are the expensive part', () => {
    // `clean -fd` and not `-x`. Deleting node_modules would make resetting as
    // slow as making a new worktree, and the point of resetting is that it is
    // cheap.
    const source = repo();
    write(source, '.gitignore', 'node_modules/\ntarget/\n');
    git(source, ['add', '-A']);
    git(source, ['commit', '-q', '-m', 'ignore']);
    write(source, 'node_modules/dep/index.js', 'kept\n');
    write(source, 'target/debug/thing', 'kept\n');

    resetWorktree({ repo: source, target: source, ref: 'HEAD' });
    expect(fs.existsSync(path.join(source, 'node_modules', 'dep', 'index.js'))).toBe(true);
    expect(fs.existsSync(path.join(source, 'target', 'debug', 'thing'))).toBe(true);
  });

  it('says how much it threw away, so a reset is not silent', () => {
    // The destructive one. Somebody typing this at the wrong moment should be
    // told what went, not just that it worked.
    const source = repo();
    write(source, 'src/a.ts', 'changed\n');
    write(source, 'src/untracked.ts', 'new\n');
    const result = resetWorktree({ repo: source, target: source, ref: 'HEAD' });
    expect(result.removed).toBe(2);
    expect(result.notes.join(' ')).toContain('2 file(s) had changes');
  });

  it('is quiet when there was nothing to lose', () => {
    const source = repo();
    const result = resetWorktree({ repo: source, target: source, ref: 'HEAD' });
    expect(result.removed).toBe(0);
    expect(result.notes).toEqual([]);
  });
});
