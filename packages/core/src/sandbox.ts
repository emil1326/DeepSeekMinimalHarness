import fs from 'node:fs';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import {
  closestNames,
  explainAmbiguous,
  explainBadPattern,
  explainMissing,
  rewriteInlineFlags,
} from './diagnose.js';
import { isInside, matchesGlob, realPath, relNorm, toPosix } from './paths.js';
import { killTree, resolveExecutable, spawnTool, UnsafeCommandError } from './process.js';
import type { CheckSpec, Profile } from './profile.js';

/** Directories the sandbox never shows, wherever they turn up in a path. */
export const NEVER_READ_DIRS = new Set(['.git', 'target', 'node_modules', '_private', 'dist']);

/** Refused to read even when a path would otherwise be allowed. */
export const SECRET_NAMES = [
  '.env',
  '.env.*',
  '*.pem',
  '*.pfx',
  '*.p12',
  '*.key',
  'api_key',
  '*secret*',
  '*credential*',
];

/**
 * Refused for writing even when the task allows them: anything that runs at
 * build time, sets up the toolchain, or reaches outside the code under change.
 */
export const NEVER_WRITE = [
  'build.rs',
  '*/build.rs',
  'Cargo.toml',
  '*/Cargo.toml',
  'Cargo.lock',
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  '*.config.*',
  'tsconfig*.json',
  '.github/*',
  '.claude/*',
  '.cargo/*',
  'rust-toolchain*',
  '*.ps1',
  '*.cmd',
  '*.bat',
  '*.sh',
  'setup.py',
  'pyproject.toml',
  'Makefile',
  'Dockerfile',
];

/** Dropped from a check process's environment, whatever else it inherits. */
export const SECRET_ENV = /(DEEPSEEK|ANTHROPIC|CLAUDE|TOKEN|SECRET|PASSWORD|API_KEY|_KEY$)/i;

export const READ_LINES = 1500;
export const RESULT_CHARS = 8000;
export const SEARCH_HITS = 80;
export const SEARCH_MAX_BYTES = 2_000_000;
export const CHECK_TIMEOUT_MS = 15 * 60 * 1000;

export class SandboxRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxRefusal';
  }
}

export interface SandboxOptions {
  root: string;
  allow: string[];
  profile: Profile;
  /** Narrows the profile's checks, when the task asked for a subset. */
  checkNames?: string[];
  onRecord?: (entry: Record<string, unknown>) => void;
  /**
   * How a path becomes its allow-list form. Pluggable so the control test can
   * put the prototype's `lstrip("./")` bug back and watch exactly the
   * dot-dependent guards go red. Production always uses `relNorm`.
   */
  normalise?: (path: string) => string;
}

export class Sandbox {
  readonly root: string;
  readonly allow: Set<string>;
  readonly profile: Profile;
  readonly checks: Record<string, CheckSpec>;
  readonly checkNames: string[];

  private readonly normalise: (path: string) => string;
  private readonly onRecord: ((entry: Record<string, unknown>) => void) | undefined;
  private readonly active = new Set<number>();

  constructor(options: SandboxOptions) {
    this.root = realPath(options.root);
    this.profile = options.profile;
    this.onRecord = options.onRecord;
    this.normalise = options.normalise ?? relNorm;
    this.checks = options.profile.checks ?? {};
    this.checkNames = options.checkNames ?? Object.keys(this.checks);
    this.allow = new Set(options.allow.map((entry) => this.normalise(entry)));
    for (const allowed of this.allow) {
      if (NEVER_WRITE.some((pattern) => this.matches(allowed, pattern))) {
        throw new SandboxRefusal(`refusing to allow ${allowed}: it is on the never-write list`);
      }
      // A secret name is refused on the way in rather than discovered at write
      // time, so a task that names one fails before the run instead of four
      // turns in. `resolve` still refuses it too; this is the earlier door.
      const name = path.posix.basename(allowed);
      if (SECRET_NAMES.some((pattern) => this.matches(name, pattern))) {
        throw new SandboxRefusal(`refusing to allow ${allowed}: it looks like a secret`);
      }
    }
  }

  /**
   * Refuse a path that is not the worktree's own git checkout, or that would
   * let the model edit its own rules.
   */
  static assertOutsideSandbox(trusted: string, root: string, what: string): void {
    if (isInside(realPath(trusted), realPath(root))) {
      throw new SandboxRefusal(`${what} is inside the sandbox, where the model could edit its own rules`);
    }
  }

  private matches(name: string, pattern: string): boolean {
    return matchesGlob(name.toLowerCase(), pattern.toLowerCase());
  }

  private relOf(full: string): string[] {
    return toPosix(path.relative(this.root, full))
      .split('/')
      .filter((part) => part !== '' && part !== '.');
  }

  /** The real path of an allowed-to-read file, or a refusal saying why not. */
  resolve(target: string): string {
    const rel = this.normalise(target);
    const full = realPath(path.resolve(this.root, rel));
    if (!isInside(full, this.root)) {
      throw new SandboxRefusal(`${target} is outside the sandbox`);
    }
    const parts = this.relOf(full);
    if (parts.some((part) => NEVER_READ_DIRS.has(part))) {
      throw new SandboxRefusal(`${target} is in a directory the sandbox does not show`);
    }
    const name = parts[parts.length - 1] ?? '';
    if (SECRET_NAMES.some((pattern) => this.matches(name, pattern))) {
      throw new SandboxRefusal(`${target} looks like a secret and is not shown`);
    }
    return full;
  }

  /** The real path of a file this task may change, or a refusal. */
  writable(target: string): string {
    const rel = this.normalise(target);
    if (!this.allow.has(rel)) {
      throw new SandboxRefusal(
        `${rel} is not one of the files this task may change: ${[...this.allow].sort().join(', ')}`,
      );
    }
    return this.resolve(rel);
  }

  // --- the tools ---------------------------------------------------------

  readFile(target: string, start = 1, end?: number | null): string {
    const full = this.resolve(target);
    let raw: string;
    try {
      raw = fs.readFileSync(full, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'EISDIR') throw error;
      // Not a refusal: the sandbox let this through and the path missed. The
      // message says which path, and what is next to it, because that is the
      // difference between one turn and three.
      const hint = this.nearbyHint(target);
      const failure = new Error(
        code === 'EISDIR'
          ? `${toPosix(this.normalise(target))} is a directory; use list_dir.${hint}`
          : `no such file: ${toPosix(this.normalise(target))}${hint}`,
      ) as NodeJS.ErrnoException;
      failure.code = code;
      throw failure;
    }
    const text = raw.includes('\r\n') ? raw.replace(/\r\n/g, '\n') : raw;
    const from = Math.max(1, Math.trunc(start));
    const wanted = end ? Math.max(from, Math.trunc(end)) : from + READ_LINES - 1;

    // Only the window is split. Splitting the whole file would allocate an
    // array with an entry per line, so reading 40 lines of a 100,000-line file
    // used to cost 100,000 strings. A read is the tool an agent calls most, and
    // that was the most expensive thing in it.
    const window = sliceLines(text, from, wanted);
    if (window.lines.length === 0) {
      return `(nothing: line ${from} is past the end; ${toPosix(this.normalise(target))} has ${window.total} lines)`;
    }
    const body = window.lines.map((line, index) => `${from + index}\t${line}`);
    const more =
      window.last < window.total ? `\n[${window.total} lines in all; read more with start/end]` : '';
    return body.join('\n') + more;
  }

  /** "did you mean" for a path that was not there, cheap enough to always do. */
  private nearbyHint(target: string): string {
    const rel = this.normalise(target);
    const parent = path.dirname(rel);
    const wanted = path.basename(rel);
    let entries: string[];
    try {
      entries = fs.readdirSync(this.resolve(parent === '.' ? '.' : parent)).filter((name) => {
        return !SECRET_NAMES.some((pattern) => this.matches(name, pattern));
      });
    } catch {
      return '';
    }
    const close = closestNames(wanted, entries);
    if (close.length === 0) return '';
    return `\nthe closest name${close.length === 1 ? '' : 's'} there: ${close.join(', ')}`;
  }

  listDir(target = '.'): string {
    const full = this.resolve(target);
    const rows = fs
      .readdirSync(full, { withFileTypes: true })
      .filter((entry) => !NEVER_READ_DIRS.has(entry.name))
      // The prototype listed secret file names even though it would not read
      // them. Tightening, not loosening: they are hidden now too.
      .filter((entry) => !SECRET_NAMES.some((pattern) => this.matches(entry.name, pattern)))
      .map((entry) => entry.name + (isDirectory(full, entry) ? '/' : ''))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return rows.join('\n') || '(empty)';
  }

  search(pattern: string, target = '.'): string {
    // Inline flags first, because a model that writes `(?i)` wants a
    // case-insensitive search and refusing costs it a turn. A leading `(?i)`
    // means the whole pattern, which is exactly the `i` flag.
    const rewritten = rewriteInlineFlags(pattern);
    const source = rewritten === null ? pattern : rewritten.pattern;
    let regex: RegExp;
    try {
      regex = new RegExp(source, rewritten?.flags ?? '');
    } catch (error) {
      return explainBadPattern(pattern, (error as Error).message);
    }
    const base = this.resolve(target);
    const files: string[] = [];
    const links: string[] = [];
    const walk = (folder: string): void => {
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        // Pruned here, not just refused per file: node_modules is often a
        // junction to a whole dependency tree and target holds gigabytes.
        if (NEVER_READ_DIRS.has(entry.name)) continue;
        if (SECRET_NAMES.some((deny) => this.matches(entry.name, deny))) continue;
        const child = path.join(folder, entry.name);
        if (entry.isDirectory()) {
          walk(child);
          continue;
        }
        if (!entry.isFile()) {
          // A symlink, a socket, a device: `readdir` already told us so, and it
          // is the only kind of entry whose real path could be somewhere else.
          // Those few go through the full containment check; the thousands of
          // ordinary files do not pay for it.
          if (entry.isSymbolicLink()) links.push(child);
          continue;
        }
        files.push(child);
      }
    };
    if (pathIsDirectory(base)) walk(base);
    else files.push(base);

    // Only the links need resolving, and the answer is cached across them.
    const allowedLinks = new Set<string>();
    for (const link of links) {
      try {
        allowedLinks.add(this.resolve(toPosix(path.relative(this.root, link))));
      } catch {
        // Points outside, carries a denied name, or is broken. Not shown.
      }
    }
    files.push(...allowedLinks);

    const hits: string[] = [];
    let truncated = false;
    for (const file of files) {
      let size = Number.POSITIVE_INFINITY;
      try {
        size = fs.statSync(file).size;
      } catch {
        continue;
      }
      if (size > SEARCH_MAX_BYTES) continue;
      let text: string;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        // Unreadable, or vanished between the walk and the read.
        continue;
      }
      const shown = toPosix(path.relative(this.root, file));
      // Matched against the whole text rather than line by line. Testing each
      // line meant splitting every file in the tree into an array of lines
      // first, which for a large repo allocates more than the search reads:
      // the common case is a pattern that matches nothing, and it was paying
      // full price for a result of "(no matches)". `m` is what keeps `^` and
      // `$` meaning start and end of a line, which is what the per-line test
      // did before.
      for (const found of eachMatch(text, regex, SEARCH_HITS - hits.length)) {
        const line = text.slice(found.from, found.to).trim().slice(0, 200);
        hits.push(`${shown}:${found.line}: ${line}`);
      }
      if (hits.length >= SEARCH_HITS) {
        truncated = true;
        break;
      }
    }
    const lines = [...hits];
    if (truncated) lines.push(`[stopped at ${SEARCH_HITS} hits]`);
    // Say when a pattern was rewritten, because the model asked for something
    // and got something equivalent but not identical back. Silence there would
    // be a small lie about what was actually searched for.
    if (rewritten !== null) lines.push(`[${rewritten.note}]`);
    return lines.join('\n') || '(no matches)';
  }

  replaceInFile(target: string, oldText: string, newText: string): string {
    const full = this.writable(target);
    const raw = fs.readFileSync(full, 'utf8');
    const newline = raw.includes('\r\n') ? '\r\n' : '\n';
    let text = raw.replace(/\r\n/g, '\n');
    const before = String(oldText).replace(/\r\n/g, '\n');
    const after = String(newText).replace(/\r\n/g, '\n');
    let count = 0;
    if (before !== '') {
      let at = text.indexOf(before);
      while (at !== -1) {
        count += 1;
        at = text.indexOf(before, at + before.length);
      }
    }
    if (count !== 1) {
      // Both of these are named exactly, because a model that knows why it
      // missed fixes it on the next turn instead of re-reading the file.
      const shown = toPosix(this.normalise(target));
      return count === 0 ? explainMissing(shown, text, before) : explainAmbiguous(shown, text, before, count);
    }
    text = text.replace(before, after);
    fs.writeFileSync(full, newline === '\n' ? text : text.replace(/\n/g, newline), 'utf8');
    return 'replaced';
  }

  createFile(target: string, content: string): string {
    const full = this.writable(target);
    if (fs.existsSync(full)) return 'refused: the file exists; use replace_in_file';
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
    return 'created';
  }

  /** A profile entry made into argv, `{allowed}` standing for the files it applies to. */
  command(spec: CheckSpec): string[] | null {
    const when = spec.when;
    const files = [...this.allow]
      .filter((allowed) => !when || when.some((suffix) => allowed.endsWith(suffix)))
      .sort();
    if (when && files.length === 0) return null;
    const argv: string[] = [];
    for (const part of spec.run) argv.push(...(part === '{allowed}' ? files : [part]));
    return argv.length === 0 ? null : argv;
  }

  runCheck(name: string): Promise<string> {
    if (name === 'format') {
      return this.runFormat();
    }
    const spec = this.checks[name];
    if (spec === undefined || !this.checkNames.includes(name)) {
      const offered = [...this.checkNames, 'format'].sort();
      return Promise.resolve(`refused: no check called ${name}; there are ${offered.join(', ')}`);
    }
    const argv = this.command(spec);
    if (argv === null) return Promise.resolve('nothing to check: no allowed file of that kind');
    return this.run(argv);
  }

  private async runFormat(): Promise<string> {
    const results: string[] = [];
    for (const spec of this.profile.format ?? []) {
      const argv = this.command(spec);
      if (argv === null) continue;
      const program = argv[0] ?? '';
      results.push(`${path.basename(program, path.extname(program))}: ${await this.run(argv)}`);
    }
    return results.join('\n') || 'nothing to format';
  }

  /** Run one check process: stripped environment, no shell, whole tree killable. */
  async run(argv: string[]): Promise<string> {
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (!SECRET_ENV.test(key)) env[key] = value;
    }
    for (const [key, value] of Object.entries(this.profile.env ?? {})) {
      env[key] = value.replace('{parent}', path.dirname(this.root));
    }

    const resolved = [resolveExecutable(argv[0] ?? ''), ...argv.slice(1)];
    let child: ChildProcess;
    try {
      child = spawnTool(resolved, { cwd: this.root, env });
    } catch (error) {
      if (error instanceof UnsafeCommandError) return `refused: ${error.message}`;
      return `could not start ${resolved[0]}: ${(error as Error).message}`;
    }

    const pid = child.pid ?? -1;
    this.active.add(pid);
    const started = Date.now();
    const output = await new Promise<{ code: number; text: string }>((settle) => {
      let text = '';
      const collect = (chunk: Buffer | string): void => {
        text += String(chunk);
      };
      child.stdout?.on('data', collect);
      child.stderr?.on('data', collect);
      const timer = setTimeout(() => {
        killTree(pid);
      }, CHECK_TIMEOUT_MS);
      child.on('error', (error) => {
        clearTimeout(timer);
        settle({ code: -1, text: `could not start ${resolved[0]}: ${error.message}` });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        settle({ code: code ?? -1, text });
      });
    }).finally(() => this.active.delete(pid));

    if (Date.now() - started >= CHECK_TIMEOUT_MS) {
      return 'the check ran past 15 minutes and was stopped';
    }
    const text = output.text.trim();
    const body =
      text.length > RESULT_CHARS
        ? `${text.slice(0, 2000)}\n[...]\n${text.slice(-(RESULT_CHARS - 2000))}`
        : text;
    return `exit ${output.code}\n${body}`;
  }

  /** Every check process this sandbox started, gone. Used when a run is cancelled. */
  killChecks(): void {
    for (const pid of this.active) killTree(pid);
    this.active.clear();
  }

  record(entry: Record<string, unknown>): void {
    this.onRecord?.(entry);
  }
}

function isDirectory(full: string, entry: fs.Dirent): boolean {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return fs.statSync(path.join(full, entry.name)).isDirectory();
  } catch {
    return false;
  }
}

function pathIsDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The lines `from`..`to` of `text`, 1-based and inclusive, without splitting the
 * whole file. `total` counts the same way `split('\n')` would, so a file ending
 * in a newline still reports the trailing empty line rather than one more.
 */
function sliceLines(
  text: string,
  from: number,
  to: number,
): { lines: string[]; total: number; last: number } {
  const lines: string[] = [];
  let line = 1;
  let start = 0;
  let at = text.indexOf('\n');
  for (;;) {
    const end = at === -1 ? text.length : at;
    if (line >= from && line <= to) lines.push(text.slice(start, end));
    if (at === -1) break;
    if (line >= to) {
      // Enough lines collected. Count the rest for the total without building
      // any more strings, so a 40-line read of a 100,000-line file stays cheap.
      let extra = 0;
      for (let index = at + 1; index < text.length; index += 1) {
        if (text[index] === '\n') extra += 1;
      }
      return { lines, total: line + extra + 1, last: line };
    }
    line += 1;
    start = at + 1;
    at = text.indexOf('\n', start);
  }
  return { lines, total: line, last: line };
}

interface FoundMatch {
  /** 1-based line the match starts on. */
  line: number;
  /** Offsets of the whole line, for the snippet. */
  from: number;
  to: number;
}

/**
 * Every match of `regex` in `text`, with the line it is on, up to `limit`.
 *
 * `m` is added so anchors behave as they did when each line was tested on its
 * own, and the line numbers are tracked incrementally: counting newlines from
 * the start for each match would be quadratic on a file with many hits.
 *
 * One entry per line, not per match. A line holding three matches used to be
 * printed three times, which read as three hits, spent three lines of the
 * budget on identical text, and could exhaust `limit` on a single line of a
 * single file. Measured live: a search for a five-way alternation printed a
 * seven-hit result as fifteen lines.
 */
function eachMatch(text: string, regex: RegExp, limit: number): FoundMatch[] {
  if (limit <= 0) return [];
  const flags = regex.flags.includes('m') ? regex.flags : `${regex.flags}m`;
  const scoped = new RegExp(regex.source, flags.includes('g') ? flags : `${flags}g`);
  const found: FoundMatch[] = [];
  let cursor = 0;
  let line = 1;
  for (;;) {
    const match = scoped.exec(text);
    if (match === null) break;
    const at = match.index;
    // A pattern that can match nothing would otherwise loop for ever.
    if (match[0] === '') {
      scoped.lastIndex += 1;
      continue;
    }
    while (cursor < at) {
      const newline = text.indexOf('\n', cursor);
      if (newline === -1 || newline >= at) break;
      line += 1;
      cursor = newline + 1;
    }
    cursor = at;
    const lineStart = text.lastIndexOf('\n', at) + 1;
    const lineEnd = text.indexOf('\n', at);
    // Matches arrive in order, so the previous entry is on the same line
    // exactly when its start matches. Skipping costs nothing and keeps one
    // line from filling the whole result.
    if (found[found.length - 1]?.from === lineStart) continue;
    found.push({ line, from: lineStart, to: lineEnd === -1 ? text.length : lineEnd });
    if (found.length >= limit) break;
  }
  return found;
}
