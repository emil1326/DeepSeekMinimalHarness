import fs from 'node:fs';
import path from 'node:path';
import { timing } from './timing.js';

export const IS_WINDOWS = process.platform === 'win32';

/**
 * Normalise a path for the allow list and for comparisons.
 *
 * Only a literal `./` prefix is stripped. The prototype first used Python's
 * `lstrip("./")`, which ate every leading dot: `.git` became `git` and `.env`
 * became `env`, and both walked straight past the lists meant to refuse them.
 * Do not "simplify" this into a general leading-dot strip.
 */
export function relNorm(input: string): string {
  let text = String(input).replace(/\\/g, '/');
  while (text.startsWith('./')) text = text.slice(2);
  const absolute = text.startsWith('/');
  const parts = text.split('/').filter((part) => part !== '' && part !== '.');
  const joined = parts.join('/');
  if (absolute) return `/${joined}`;
  return joined === '' ? '.' : joined;
}

export function toPosix(value: string): string {
  return value.replace(/\\/g, '/');
}

/** Case-folded comparison key. On Windows `F:\vsCode` and `f:\vscode` are one folder. */
function keyOf(value: string): string {
  const normalised = path.normalize(value);
  return IS_WINDOWS ? normalised.toLowerCase() : normalised;
}

export function samePath(a: string, b: string): boolean {
  return keyOf(a) === keyOf(b);
}

/** Whether `candidate` is `root` or below it, compared on real paths. */
export function isInside(candidate: string, root: string): boolean {
  const child = keyOf(candidate);
  const parent = keyOf(root);
  if (child === parent) return true;
  return child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

/**
 * The real path of `target`, resolving symlinks and Windows junctions.
 *
 * A path that does not exist yet is not an error here: the longest existing
 * ancestor is resolved and the rest is appended, so the containment check can
 * still run on it. That matters because a missing file must read as "the
 * sandbox let this through and the path happened to miss", not as a refusal.
 *
 * Timed because it is the sandbox's most-taken path to a syscall: `resolve`,
 * `writable`, the proc-macro walk and every declared command all land here, and
 * the loop below can call `realpathSync.native` once per missing ancestor.
 */
export function realPath(target: string): string {
  return timing.measure('core.paths.realPath', () => {
    let current = path.resolve(target);
    const tail: string[] = [];
    for (;;) {
      try {
        const real = fs.realpathSync.native(current);
        return tail.length > 0 ? path.join(real, ...tail.reverse()) : real;
      } catch {
        const parent = path.dirname(current);
        if (parent === current) return path.resolve(target);
        tail.push(path.basename(current));
        current = parent;
      }
    }
  });
}

/**
 * `fnmatch` with `*`, `?` and `**`, case-insensitive because the callers lowercase first.
 *
 * `*` and `?` do not cross a slash; `**` does. That is what they mean everywhere
 * else, and it matters here rather than being pedantry: the allow and soft lists
 * are write permissions, and a pattern like `crates&#47;*&#47;tests&#47;**`
 * silently covering `crates/a/b/tests/c.rs` is a list that does something other
 * than what it says.
 *
 * A leading `**&#47;` also matches zero directories, so `**&#47;build.rs` covers
 * `build.rs` at the root as well as `crates/x/build.rs`, and one entry says both.
 * Without that, every rule that has to reach into a tree needs two entries and one
 * of them gets forgotten.
 *
 * The deny lists depend on this being right, and `NEVER_WRITE` is written
 * explicitly in these terms — see the test that pins what each entry still
 * catches, because a rule that quietly stops matching is a rule that is not
 * there.
 *
 * Timed, and it is worth the extra lines: this builds and compiles a fresh
 * `RegExp` on every call, and every call is one directory entry of a `list_dir`
 * or one file of a `search`, against the five name lists in `sandbox.ts`. If that
 * is milliseconds it is milliseconds a compiled-once cache would not spend, and a
 * count with no time next to it would never have said so.
 */
export function matchesGlob(name: string, pattern: string): boolean {
  return timing.measure('core.paths.matchesGlob', () => {
    let source = '';
    let at = 0;
    while (at < pattern.length) {
      const char = pattern[at] as string;
      if (char === '*') {
        // `**/`, `**`, then plain `*`. Order matters: `**` followed by anything
        // but a `/` is a directory-crossing run of characters.
        if (pattern[at + 1] === '*' && pattern[at + 2] === '/') {
          source += '(?:.*/)?';
          at += 3;
          continue;
        }
        if (pattern[at + 1] === '*') {
          source += '.*';
          at += 2;
          continue;
        }
        source += '[^/]*';
        at += 1;
        continue;
      }
      if (char === '?') {
        source += '[^/]';
        at += 1;
        continue;
      }
      source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      at += 1;
    }
    return new RegExp(`^${source}$`).test(name);
  });
}

/** Whether an entry is a pattern rather than one literal path. */
export function isPattern(entry: string): boolean {
  return entry.includes('*') || entry.includes('?');
}

/**
 * Whether a path is covered by a list of allow-list entries.
 *
 * The bug this exists for, found live: every caller asked
 * `allowed.has(path)` — string equality — so a glob in `allow` only ever
 * permitted a file literally named `docs/**`. `matchesGlob` was right there and
 * working; nothing called it. A task file with `"allow": ["docs/**"]` therefore
 * refused to create `docs/anything.md`, and the refusal named `docs/**` back at
 * the model as though globs were supported, which is worse than not offering
 * them: the message reads as a bug in the model's understanding rather than in
 * the harness. Two nested directories deep, a second copy of the same equality
 * check in `stray.ts` reported the file as a stray change as well.
 *
 * A literal entry stays cheap — one hash lookup — and a pattern costs one
 * compiled regex, so a list of exact paths is exactly as fast as it was.
 */
export function covered(entries: Iterable<string>, rel: string): boolean {
  for (const entry of entries) {
    if (entry === rel) return true;
    if (isPattern(entry) && matchesGlob(rel, entry)) return true;
  }
  return false;
}
