import fs from 'node:fs';
import path from 'node:path';

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
 */
export function realPath(target: string): string {
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
}

/** `fnmatch` with `*` and `?`, case-insensitive because the callers lowercase first. */
export function matchesGlob(name: string, pattern: string): boolean {
  let source = '';
  for (const char of pattern) {
    if (char === '*') source += '.*';
    else if (char === '?') source += '.';
    else source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`, 's').test(name);
}
