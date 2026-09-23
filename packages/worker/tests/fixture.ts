import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadRunConfig, type ResolvedRunConfig } from '@emilswork/harness-core';

/** A repo with commits, so `git status` and `git diff HEAD` behave like the real thing. */
export function git(cwd: string, args: string[]): void {
  execFileSync('git', ['-c', 'user.name=dsh tests', '-c', 'user.email=dsh@example.invalid', ...args], {
    cwd,
    stdio: 'ignore',
  });
}

export interface Fixture {
  /** Holds the repo, the profile and every task file; none of them inside each other. */
  base: string;
  repo: string;
  profile: string;
  /** The path of a freshly written task file, for the daemon, which reads it itself. */
  taskPath(name: string, task: Record<string, unknown>): string;
  writeTask(name: string, task: Record<string, unknown>): ResolvedRunConfig;
  read(relative: string): string;
  cleanup(): void;
}

/** A throwaway git worktree, a profile outside it, and task files to match. */
export function createFixture(): Fixture {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-worker-'));
  const repo = path.join(base, 'repo');
  // `spawn` reports a missing cwd as ENOENT, so the directory has to exist
  // before git is asked to work in it.
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  git(repo, ['init', '-q']);
  fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(repo, 'src', 'b.ts'), 'export const b = 2;\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'start']);

  const profile = path.join(base, 'profile.json');
  fs.writeFileSync(
    profile,
    JSON.stringify(
      {
        checks: {
          echo: { run: [process.execPath, '-e', "console.log('ran')"] },
          slow: { run: [process.execPath, '-e', 'setInterval(() => {}, 1000)'] },
          ts_only: { when: ['.ts'], run: [process.execPath, '-e', "console.log('ts')"] },
        },
        format: [],
      },
      null,
      2,
    ),
  );

  return {
    base,
    repo,
    profile,
    taskPath(name, task) {
      const file = path.join(base, `${name}.json`);
      fs.writeFileSync(
        file,
        JSON.stringify(
          {
            name,
            worktree: repo,
            profile,
            model: 'deepseek-flash',
            allow: ['src/a.ts'],
            task: 'Change the constant in src/a.ts.',
            ...task,
          },
          null,
          2,
        ),
      );
      return file;
    },
    writeTask(name, task) {
      return loadRunConfig(this.taskPath(name, task));
    },
    read(relative) {
      return fs.readFileSync(path.join(repo, relative), 'utf8');
    },
    cleanup() {
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}
