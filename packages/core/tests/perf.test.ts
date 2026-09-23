/**
 * What the tool calls cost, and the behaviour the fast paths must not change.
 *
 * An agent running at a few hundred tokens a second is only as fast as the tool
 * it is waiting on, so the cost of `search` and `read_file` is a feature and it
 * gets tested like one. Counting syscalls rather than milliseconds is
 * deliberate: a wall-clock budget is flaky on a busy machine and tells you
 * nothing about why it regressed, while "this used to resolve every file and
 * now resolves none" is exact and does not lie.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { Sandbox, type Profile } from '@emilswork/harness-core';

const PROFILE: Profile = { checks: {}, format: [] };

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-perf-'));
const repo = path.join(tmpRoot, 'repo');
fs.mkdirSync(repo, { recursive: true });
execFileSync('git', ['init', '-q', repo], { stdio: 'ignore' });

/** A tree wide enough that a per-file syscall is measurable in the count. */
const FILES = 120;
const FILE_LINES = 40;
fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
fs.mkdirSync(path.join(repo, 'node_modules', 'junk'), { recursive: true });
for (let index = 0; index < FILES; index += 1) {
  const body = Array.from({ length: FILE_LINES }, (_, line) =>
    line === 7 ? `export const needle_${index} = ${index};` : `export const row_${line} = ${index};`,
  ).join('\n');
  fs.writeFileSync(path.join(repo, 'src', `file${index}.ts`), `${body}\n`);
}
// Pruned, and large, so a regression that walks it is obvious in the count.
for (let index = 0; index < 200; index += 1) {
  fs.writeFileSync(
    path.join(repo, 'node_modules', 'junk', `dep${index}.js`),
    `module.exports = 'needle_${index}';\n`,
  );
}
const big = path.join(repo, 'src', 'big.ts');
fs.writeFileSync(big, Array.from({ length: 120_000 }, (_, line) => `line ${line + 1}`).join('\n'));

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const box = (): Sandbox => new Sandbox({ root: repo, allow: ['src/file0.ts'], profile: PROFILE });

/** Counts the filesystem calls a block makes, then restores everything. */
async function counting<T>(action: () => T): Promise<{ result: T; stats: Record<string, number> }> {
  const stats: Record<string, number> = { realpath: 0, stat: 0, read: 0, readdir: 0 };
  const realpathSync = fs.realpathSync;
  const statSync = fs.statSync;
  const readFileSync = fs.readFileSync;
  const readdirSync = fs.readdirSync;
  // The module object, loosely typed. `fs.realpathSync` carries overloads that
  // a hand-written wrapper cannot satisfy, and the point of this file is to
  // count calls, not to re-declare Node's types.
  const loose = fs as unknown as Record<string, unknown>;
  const bump =
    (key: string): (() => void) =>
    () => {
      stats[key] = (stats[key] ?? 0) + 1;
    };
  const wrap = (original: unknown, key: string): unknown =>
    Object.assign(
      (...args: unknown[]) => {
        bump(key)();
        return (original as (...a: unknown[]) => unknown)(...args);
      },
      {
        native: (target: unknown) => {
          bump(key)();
          return (original as unknown as { native: (t: unknown) => unknown }).native(target);
        },
      },
    );

  loose.realpathSync = wrap(realpathSync, 'realpath');
  loose.statSync = wrap(statSync, 'stat');
  loose.readFileSync = wrap(readFileSync, 'read');
  loose.readdirSync = wrap(readdirSync, 'readdir');

  try {
    return { result: action(), stats };
  } finally {
    loose.realpathSync = realpathSync;
    loose.statSync = statSync;
    loose.readFileSync = readFileSync;
    loose.readdirSync = readdirSync;
  }
}

describe('what a search costs', () => {
  /**
   * Built outside the counted block on purpose.
   *
   * Constructing a sandbox is not a search, and it does real work: it walks up
   * towards the worktree root looking for a `Cargo.toml` that declares a
   * proc-macro crate, so that a file inside one can be refused before the run
   * rather than after a check has executed it. That is a handful of `readFileSync`
   * attempts per directory, cached, and counting it here would be measuring the
   * wrong thing: every assertion below is about what a *search* costs.
   */
  const built = (): Sandbox => box();

  it('reads each file once', async () => {
    const sandbox = built();
    const { result, stats } = await counting(() => sandbox.search('needle_1\\b', 'src'));

    expect(result).toContain('needle_1 = 1');
    // The 120 generated files and `big.ts`, and nothing from the pruned
    // `node_modules`, which holds 200 more.
    const candidates = FILES + 1;
    expect(stats.read).toBe(candidates);
    // One stat per candidate for the size guard, plus one to see whether the
    // search root is a directory.
    expect(stats.stat).toBe(candidates + 1);
  });

  it('resolves a constant number of paths however many files it looks at', async () => {
    // This is the point of the exercise. Resolving every path would be one
    // syscall per file on top of the read, for a question `readdir` already
    // answered. The proof is not a number: it is that the number does not move
    // when the tree gets a hundred times bigger.
    const sandbox = built();
    const one = await counting(() => sandbox.search('zzz_matches_nothing', 'src/file0.ts'));
    const many = await counting(() => sandbox.search('zzz_matches_nothing', 'src'));

    expect(many.stats.read).toBeGreaterThan(one.stats.read * 10);
    expect(many.stats.stat).toBeGreaterThan(one.stats.stat * 10);
    // The search root, and any links. Not one per file.
    expect(many.stats.realpath).toBe(one.stats.realpath);
    expect(many.stats.realpath).toBeLessThanOrEqual(3);
  });

  it('does not walk a denied directory, however many files are in it', async () => {
    const sandbox = built();
    const { stats } = await counting(() => sandbox.search('needle_1\\b', '.'));
    // 200 files live under node_modules and not one of them is opened.
    expect(stats.read).toBeLessThanOrEqual(FILES + 1);
  });

  it('stops at the hit limit instead of reading the whole tree', async () => {
    const sandbox = built();
    const { result, stats } = await counting(() => sandbox.search('export const', 'src'));
    expect(result).toContain('[stopped at 80 hits]');
    // 80 hits arrive in the first few files, so the rest are never opened.
    expect(stats.read).toBeLessThan(FILES);
  });

  it('resolves only the entries that could point somewhere else', async () => {
    const link = path.join(repo, 'src', 'link.ts');
    try {
      fs.symlinkSync(path.join(repo, 'src', 'file0.ts'), link, 'file');
    } catch {
      return;
    }
    try {
      const sandbox = built();
      const withLink = await counting(() => sandbox.search('needle_1\\b', 'src'));
      const without = await counting(() => sandbox.search('needle_1\\b', 'src'));
      void without;
      // One extra resolve, for the one link. Not one per file, and the link
      // still resolves inside the tree so its target is readable.
      expect(withLink.stats.realpath).toBeLessThanOrEqual(4);
      expect(withLink.result).toContain('needle_1 = 1');
    } finally {
      fs.rmSync(link, { force: true });
    }
  });

  it('looks for a proc-macro manifest once per directory, not once per search', async () => {
    // The constructor's probe is cached, so a second sandbox over the same tree
    // does not read every manifest again, and searching never reads one at all:
    // `read` during a search is files searched and nothing else.
    const first = await counting(() => built());
    const second = await counting(() => built());
    expect(second.stats.read).toBeLessThanOrEqual(first.stats.read);
    // Two levels up from `src/file0.ts`: `src/Cargo.toml` and `Cargo.toml`.
    expect(first.stats.read).toBeLessThanOrEqual(2);

    const sandbox = built();
    const searched = await counting(() => sandbox.search('needle_1\\b', 'src'));
    expect(searched.stats.read).toBe(FILES + 1);
  });
});

describe('what a search finds', () => {
  it('reports the line the match is on, counted from one', () => {
    const result = box().search('needle_0\\b', 'src/file0.ts');
    expect(result).toBe('src/file0.ts:8: export const needle_0 = 0;');
  });

  it('still anchors ^ and $ to a line, the way a per-line test did', () => {
    // The rewrite matches the whole file at once with `m`. Without it these
    // would match nothing, because `^` would only mean the start of the file.
    expect(box().search('^export const row_1 = 0;$', 'src/file0.ts')).toBe(
      'src/file0.ts:2: export const row_1 = 0;',
    );
    expect(box().search('^line 1$', 'src/big.ts')).toBe('src/big.ts:1: line 1');
  });

  it('counts lines right deep into a large file', () => {
    // The line number is tracked incrementally rather than recounted from the
    // start for every hit, which would be quadratic. This checks the count is
    // still right thousands of lines in.
    expect(box().search('^line 99999$', 'src/big.ts')).toBe('src/big.ts:99999: line 99999');
  });

  it('does not loop for ever on a pattern that can match nothing', () => {
    // `x*` matches the empty string at every position. A global regex that is
    // not advanced past a zero-length match spins until the heat death of the
    // universe, which for an agent means a run that never returns.
    const result = box().search('z*', 'src/file0.ts');
    expect(result).not.toBe('');
    expect(result.split('\n').length).toBeLessThanOrEqual(81);
  });

  it('says so when nothing matches, which is the common case', () => {
    expect(box().search('nothing_matches_this_at_all', 'src')).toBe('(no matches)');
  });
});

describe('what a read costs and returns', () => {
  it('returns the window with the right numbers on it', () => {
    const result = box().readFile('src/file0.ts', 7, 9);
    expect(result.split('\n').slice(0, 3)).toEqual([
      '7\texport const row_6 = 0;',
      '8\texport const needle_0 = 0;',
      '9\texport const row_8 = 0;',
    ]);
  });

  it('reads the first and last lines correctly', () => {
    expect(box().readFile('src/file0.ts', 1, 1).split('\n')[0]).toBe('1\texport const row_0 = 0;');
    expect(box().readFile('src/file0.ts', 40, 40).split('\n')[0]).toBe('40\texport const row_39 = 0;');
    // Past the end of a 40-line file plus its trailing newline.
    expect(box().readFile('src/file0.ts', 41, 41)).toBe('41\t');
  });

  it('says how much is left without reading it all into strings', () => {
    const result = box().readFile('src/file0.ts', 1, 3);
    expect(result).toContain('[41 lines in all; read more with start/end]');
    expect(result.split('\n').filter((line) => line.includes('\t'))).toHaveLength(3);
  });

  it('does not claim there is more when the window reaches the end', () => {
    const result = box().readFile('src/file0.ts', 1, 1000);
    expect(result).not.toContain('lines in all');
    expect(result.split('\n')).toHaveLength(41);
  });

  it('reads a window of a huge file without splitting the whole thing', () => {
    // 120,000 lines. The old code built an array of 120,000 strings to return
    // ten of them. This is a budget, not a benchmark: it is loose enough to be
    // honest on a busy machine and tight enough to catch the array coming back.
    const started = performance.now();
    const result = box().readFile('src/big.ts', 60_000, 60_009);
    const took = performance.now() - started;

    expect(result).toContain('60000\tline 60000');
    expect(result).toContain('60009\tline 60009');
    expect(result).toContain('[120000 lines in all');
    expect(took).toBeLessThan(250);
  });

  it('reports the total the same way split would, trailing newline and all', () => {
    const shapes = path.join(repo, 'src', 'shapes.ts');
    const reader = new Sandbox({ root: repo, allow: ['src/shapes.ts'], profile: PROFILE });

    fs.writeFileSync(shapes, 'a\nb\nc');
    expect(reader.readFile('src/shapes.ts', 1, 1000)).toBe('1\ta\n2\tb\n3\tc');

    // The trailing newline makes one more line, which is what split gives too.
    fs.writeFileSync(shapes, 'a\nb\nc\n');
    expect(reader.readFile('src/shapes.ts', 4, 4)).toBe('4\t');
    expect(reader.readFile('src/shapes.ts', 1, 3)).toContain('[4 lines in all');
  });
});
