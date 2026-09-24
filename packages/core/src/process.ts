import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess, type StdioOptions } from 'node:child_process';
import { IS_WINDOWS } from './paths.js';
import { timing } from './timing.js';

/**
 * Resolve a program the way `shutil.which` did, preferring npm's `.cmd` shim on Windows.
 *
 * Timed, and it is one of the first things to look at in a table of small
 * numbers: on Windows this `statSync`s every PATH directory for a `.cmd` shim,
 * then every extension in `PATHEXT` in both cases, so a 40-entry PATH with no
 * hit near the front is a few hundred stat calls before a check even starts.
 */
export function resolveExecutable(name: string): string {
  return timing.measure(
    'core.process.resolveExecutable',
    () => resolveOnPath(name),
    (found) => found.length,
  );
}

function resolveOnPath(name: string): string {
  if (name.includes('/') || name.includes('\\')) return name;
  const searchPath = process.env.PATH ?? process.env.Path ?? '';
  const dirs = searchPath.split(path.delimiter).filter((dir) => dir !== '');
  const extensions = IS_WINDOWS
    ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((ext) => ext !== '')
    : [''];

  const exists = (candidate: string): boolean => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  };

  if (IS_WINDOWS) {
    for (const dir of dirs) {
      const shim = path.join(dir, `${name}.cmd`);
      if (exists(shim)) return shim;
    }
  }
  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = path.join(dir, name + extension.toLowerCase());
      if (exists(candidate)) return candidate;
      const upper = path.join(dir, name + extension.toUpperCase());
      if (exists(upper)) return upper;
    }
    const bare = path.join(dir, name);
    if (exists(bare)) return bare;
  }
  return name;
}

/**
 * Characters that break out of a double-quoted argument in `cmd.exe`.
 * `%` expands even inside quotes and `"` ends the quote, so neither is allowed
 * through: an argument carrying one is refused rather than escaped.
 */
const CMD_UNSAFE = /["%\r\n]/;

export class UnsafeCommandError extends Error {}

/**
 * Start a check process with no shell.
 *
 * On Windows a `.cmd` shim cannot be started directly by `CreateProcess`, so it
 * goes through `cmd.exe /d /s /c ""app" "arg"..."`. That is the same form Node
 * itself builds for `shell: true`, without handing Node the argument string.
 * Arguments are validated first, so nothing the model writes can reach a
 * command interpreter: the model only ever picks a check name, and the profile
 * is trusted configuration.
 */
export function spawnTool(
  argv: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdio?: 'pipe' | 'ignore' },
): ChildProcess {
  return timing.measure('core.process.spawnTool', () => spawnToolInner(argv, options));
}

function spawnToolInner(
  argv: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdio?: 'pipe' | 'ignore' },
): ChildProcess {
  const [program, ...args] = argv;
  if (program === undefined) throw new UnsafeCommandError('an empty command was given');
  const stdio = options.stdio ?? 'pipe';
  const stdioOption: StdioOptions = stdio === 'ignore' ? 'ignore' : ['ignore', 'pipe', 'pipe'];
  const needsShell = IS_WINDOWS && /\.(cmd|bat)$/i.test(program);
  if (needsShell) {
    for (const part of [program, ...args]) {
      if (CMD_UNSAFE.test(part)) {
        throw new UnsafeCommandError(`an argument contains a character cmd.exe would act on: ${part}`);
      }
    }
    const comspec = process.env.ComSpec ?? 'cmd.exe';
    const line = [`"${program}"`, ...args.map((arg) => `"${arg}"`)].join(' ');
    return spawn(comspec, ['/d', '/s', '/c', `"${line}"`], {
      cwd: options.cwd,
      env: options.env,
      stdio: stdioOption,
      windowsVerbatimArguments: true,
      windowsHide: true,
    });
  }
  // No shell anywhere in this path: Node quotes the arguments itself and they
  // go straight to CreateProcess.
  return spawn(program, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: stdioOption,
    windowsHide: true,
  });
}

/** Kill a process and everything it started. Nothing may survive a cancel. */
export function killTree(pid: number): void {
  // On Windows this starts `taskkill`, so it is a process spawn and not a
  // signal: worth a row of its own when a cancel takes a second to land.
  return timing.measure('core.process.killTree', () => killProcessTree(pid));
}

function killProcessTree(pid: number): void {
  if (pid <= 0) return;
  if (IS_WINDOWS) {
    try {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch {
      /* the process is already gone */
    }
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* the process is already gone */
    }
  }
}

export function isAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
