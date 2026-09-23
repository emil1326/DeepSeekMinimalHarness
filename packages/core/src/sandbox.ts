import fs from 'node:fs';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
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
    const text = fs.readFileSync(this.resolve(target), 'utf8').replace(/\r\n/g, '\n');
    const lines = text.split('\n');
    const from = Math.max(1, Math.trunc(start));
    const to = Math.min(lines.length, end ? Math.trunc(end) : from + READ_LINES - 1);
    const body: string[] = [];
    for (let n = from; n <= to; n += 1) body.push(`${n}\t${lines[n - 1] ?? ''}`);
    const more = to < lines.length ? `\n[${lines.length} lines in all; read more with start/end]` : '';
    return body.join('\n') + more;
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
    const regex = new RegExp(pattern);
    const base = this.resolve(target);
    const files: string[] = [];
    const walk = (folder: string): void => {
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        // Pruned here, not just refused per file: node_modules is often a
        // junction to a whole dependency tree and target holds gigabytes.
        if (NEVER_READ_DIRS.has(entry.name)) continue;
        const child = path.join(folder, entry.name);
        if (entry.isDirectory()) walk(child);
        // Symlinked directories are not followed, same as os.walk's default.
        else if (entry.isFile()) files.push(child);
      }
    };
    if (pathIsDirectory(base)) walk(base);
    else files.push(base);

    const hits: string[] = [];
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
        text = fs.readFileSync(this.resolve(toPosix(path.relative(this.root, file))), 'utf8');
      } catch {
        // Refused by the sandbox, or unreadable. Either way it is not shown.
        continue;
      }
      const lines = text.split(/\r?\n/);
      for (let n = 1; n <= lines.length; n += 1) {
        const line = lines[n - 1] ?? '';
        if (!regex.test(line)) continue;
        hits.push(`${toPosix(path.relative(this.root, file))}:${n}: ${line.trim().slice(0, 200)}`);
        if (hits.length >= SEARCH_HITS) return `${hits.join('\n')}\n[stopped at ${SEARCH_HITS} hits]`;
      }
    }
    return hits.join('\n') || '(no matches)';
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
      return `refused: the old text matched ${count} times; it must match exactly once`;
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
