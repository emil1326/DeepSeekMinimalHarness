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
 * `fnmatch` with `*` and `?`, case-insensitive because the callers lowercase first.
 *
 * Timed, and it is worth the two extra lines: this builds and compiles a fresh
 * `RegExp` on every call, and every call is one directory entry of a `list_dir`
 * or one file of a `search`, against the five name lists in `sandbox.ts`. If
 * that is milliseconds it is milliseconds a compiled-once cache would not spend,
 * and a count with no time next to it would never have said so.
 */
export function matchesGlob(name: string, pattern: string): boolean {
  return timing.measure('core.paths.matchesGlob', () => {
    let source = '';
    for (const char of pattern) {
      if (char === '*') source += '.*';
      else if (char === '?') source += '.';
      else source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp(`^${source}$`, 's').test(name);
  });
}
