/**
 * The workspace: one file, found once, applied to every run in a project.
 *
 * What this layer is for is worth restating, because the tests below are all
 * consequences of it. Over 55 real runs on one project, the same eight project
 * rules, the same check list and the same "here is how you run a test" preamble
 * were copied into every task file by hand. Every copy was a chance to copy one
 * wrong, and there was nowhere to write down something true about the project
 * rather than about one line of it.
 *
 * Two things below are not conveniences and are worth finding the test for:
 * `{worktree}` in an environment value, because two worktrees sharing a build
 * directory is how a check in one printed the other's compile errors, and the
 * refusal of a command argument with no values and no pattern, because that is
 * the whole security of the command mechanism.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  WorkspaceError,
  findWorkspace,
  interpolate,
  loadRunConfig,
  loadWorkspace,
} from '@emilswork/harness-core';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-workspace-'));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

let counter = 0;
/** A fresh directory, so one test's workspace cannot be found by the next. */
function place(files: Record<string, unknown>): { dir: string; repo: string } {
  counter += 1;
  const dir = path.join(scratch, `case-${counter}`);
  const repo = path.join(dir, 'repo');
  // Not a git repo: nothing here runs git, and making one per case is slow.
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'one.ts'), 'export const one = 1;\n');
  for (const [name, body] of Object.entries(files)) {
    const target = path.join(dir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof body === 'string' ? body : `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  }
  return { dir, repo };
}

/** A profile, which every task still needs unless the workspace names one. */
const PROFILE = {
  checks: { echo: { run: [process.execPath, '-e', "console.log('ran')"] } },
};

/**
 * A task file beside a profile, which is what nearly every case here needs.
 *
 * `profile` in a task file is a path, not an object: the profile is a file the
 * harness reads, and letting it be inline would mean two ways to write the same
 * thing and no way to say which one a run used.
 */
function taskUsing(dir: string, repo: string, fields: Record<string, unknown>): string {
  if (!fs.existsSync(path.join(dir, 'profile.json'))) {
    fs.writeFileSync(path.join(dir, 'profile.json'), `${JSON.stringify(PROFILE, null, 2)}\n`, 'utf8');
  }
  const file = path.join(dir, 'task.json');
  fs.writeFileSync(
    file,
    `${JSON.stringify({ name: 'a-line', worktree: repo, profile: 'profile.json', ...fields }, null, 2)}\n`,
    'utf8',
  );
  return file;
}

describe('finding the workspace', () => {
  it('finds one in the worktree, without the task file saying so', () => {
    const { dir, repo } = place({ 'dsh.workspace.json': { name: 'p' } });
    expect(findWorkspace({ worktree: repo, taskPath: path.join(dir, 't.json') })).toBe(
      path.join(dir, 'dsh.workspace.json'),
    );
  });

  it('finds one above the worktree, which is where a project with several has it', () => {
    // The real shape: `F:/vsCode/esap-ds-1`, `-ds-2`, `-ds-3` are siblings and the
    // config belongs to the project, not to any one worktree of it.
    const { dir, repo } = place({ 'dsh.workspace.json': { name: 'p' } });
    expect(findWorkspace({ worktree: path.join(repo, 'src'), taskPath: path.join(dir, 't.json') })).toBe(
      path.join(dir, 'dsh.workspace.json'),
    );
  });

  it('finds the dotted spelling too', () => {
    const { dir, repo } = place({ '.dsh/workspace.json': { name: 'p' } });
    expect(findWorkspace({ worktree: repo, taskPath: path.join(dir, 't.json') })).toBe(
      path.join(dir, '.dsh', 'workspace.json'),
    );
  });

  it('takes an explicit path over anything it would have found', () => {
    const { dir, repo } = place({
      'dsh.workspace.json': { name: 'found' },
      'other.json': { name: 'named' },
    });
    expect(
      findWorkspace({ explicit: 'other.json', worktree: repo, taskPath: path.join(dir, 't.json') }),
    ).toBe(path.join(dir, 'other.json'));
  });

  it('says there is none, rather than inventing one', () => {
    // Not a problem and it must not be one: every run before this existed had no
    // workspace, and a one-repo project does not need one.
    const { dir, repo } = place({});
    expect(findWorkspace({ worktree: repo, taskPath: path.join(dir, 't.json') })).toBeNull();
  });
});

describe('reading a workspace', () => {
  it('refuses a file that does not parse rather than carrying on without it', () => {
    // Continuing would silently drop the project's rules and run the agent to
    // the wrong instructions, which is worse than not starting.
    const { dir } = place({ 'dsh.workspace.json': '{ not json' });
    expect(() => loadWorkspace(path.join(dir, 'dsh.workspace.json'))).toThrow(WorkspaceError);
  });

  it('names an unknown key instead of ignoring it', () => {
    const { dir } = place({ 'dsh.workspace.json': { name: 'p', rulesFile: 'x.md' } });
    try {
      loadWorkspace(path.join(dir, 'dsh.workspace.json'));
      throw new Error('unreachable');
    } catch (error) {
      expect((error as WorkspaceError).problems.map((problem) => problem.path)).toContain('rulesFile');
    }
  });

  it('refuses a command whose name would shadow a tool the harness has', () => {
    const { dir } = place({
      'dsh.workspace.json': {
        name: 'p',
        commands: { read_file: { description: 'x', run: ['echo'] } },
      },
    });
    expect(() => loadWorkspace(path.join(dir, 'dsh.workspace.json'))).toThrow(/already has/);
  });

  it('refuses an argument with no values and no pattern, at load rather than at call', () => {
    // The whole security of the mechanism, checked as early as it can be. An
    // argument the model can put any text into is a shell by another name, and
    // the person who can fix that is the person who typed the config file.
    const { dir } = place({
      'dsh.workspace.json': {
        name: 'p',
        commands: {
          run: { description: 'x', args: { t: { description: 'a target' } }, run: ['cargo', '{t}'] },
        },
      },
    });
    expect(() => loadWorkspace(path.join(dir, 'dsh.workspace.json'))).toThrow(/shell by another name/);
  });

  it('refuses a placeholder in the middle of an argument', () => {
    const { dir } = place({
      'dsh.workspace.json': {
        name: 'p',
        commands: {
          run: {
            description: 'x',
            args: { t: { description: 'a target', values: ['a'] } },
            run: ['cargo', '--package={t}'],
          },
        },
      },
    });
    expect(() => loadWorkspace(path.join(dir, 'dsh.workspace.json'))).toThrow(/whole argument/);
  });

  it('refuses a placeholder with no argument behind it, and an argument nothing uses', () => {
    // Two typos that would otherwise be a command that never works: one that
    // cannot be called at all, and one with an argument that does nothing.
    const { dir } = place({
      'dsh.workspace.json': {
        name: 'p',
        commands: { run: { description: 'x', run: ['cargo', '{target}'] } },
      },
    });
    expect(() => loadWorkspace(path.join(dir, 'dsh.workspace.json'))).toThrow(/not a declared argument/);

    const unused = place({
      'dsh.workspace.json': {
        name: 'p',
        commands: {
          run: {
            description: 'x',
            args: { t: { description: 'a target', values: ['a'] } },
            run: ['cargo', 'test'],
          },
        },
      },
    });
    expect(() => loadWorkspace(path.join(unused.dir, 'dsh.workspace.json'))).toThrow(/never used/);
  });

  it('refuses a defaultProfile that names nothing', () => {
    const { dir } = place({ 'dsh.workspace.json': { name: 'p', defaultProfile: 'nope' } });
    expect(() => loadWorkspace(path.join(dir, 'dsh.workspace.json'))).toThrow(/no profile called nope/);
  });

  it('hashes the file, so a run records which version of the rules it used', () => {
    const { dir } = place({ 'dsh.workspace.json': { name: 'p' } });
    const one = loadWorkspace(path.join(dir, 'dsh.workspace.json'));
    fs.writeFileSync(path.join(dir, 'dsh.workspace.json'), JSON.stringify({ name: 'q' }));
    const two = loadWorkspace(path.join(dir, 'dsh.workspace.json'));
    expect(one.hash).not.toBe(two.hash);
  });
});

describe('substituting into an environment value', () => {
  it('puts the worktree where it is asked for', () => {
    // The one that earned its keep. Two worktrees of one project shared a
    // CARGO_TARGET_DIR, so a check in one printed the other's compile errors and
    // a run concluded, wrongly, that the work it was given did not build.
    expect(
      interpolate('{worktree}-target', {
        worktree: 'F:/a/b',
        parent: 'F:/a',
        name: 'n',
        home: 'H',
      }),
    ).toBe('F:/a/b-target');
  });

  it('still does what {parent} always did', () => {
    expect(interpolate('{parent}/t', { worktree: 'F:/a/b', parent: 'F:/a', name: 'n', home: 'H' })).toBe(
      'F:/a/t',
    );
  });

  it('leaves a value with no placeholders exactly as it was', () => {
    const into = { worktree: 'w', parent: 'p', name: 'n', home: 'h' };
    expect(interpolate('RUST_LOG=debug', into)).toBe('RUST_LOG=debug');
  });
});

describe('a task resolved against a workspace', () => {
  it('takes the profile, the model and the checks the project declared', () => {
    const { dir, repo } = place({
      'dsh.workspace.json': {
        name: 'proj',
        model: 'deepseek-flash',
        profiles: { default: 'profile.json' },
        defaultProfile: 'default',
        checks: { lint: { run: [process.execPath, '-e', "console.log('lint')"] } },
      },
      'profile.json': { checks: { echo: { run: [process.execPath, '-e', "console.log('ran')"] } } },
    });
    const task = path.join(dir, 't.json');
    fs.writeFileSync(
      task,
      JSON.stringify({ name: 'a-line', worktree: repo, allow: ['src/one.ts'], task: 'do it' }),
    );

    const config = loadRunConfig(task);
    expect(config.model).toBe('deepseek-flash');
    // The workspace's check and the profile's, together. A project can define a
    // check once and every profile in it can use it.
    expect(Object.keys(config.resolvedProfile.checks ?? {}).sort()).toEqual(['echo', 'lint']);
    expect(config.workspace?.name).toBe('proj');
  });

  it('reads the project rules, and puts them in the stored config', () => {
    const { dir, repo } = place({
      'dsh.workspace.json': { name: 'p', rules: 'notes.md' },
      'notes.md': 'Never assume ids come out in order.\n',
    });
    const task = taskUsing(dir, repo, { model: 'deepseek-flash', allow: ['src/one.ts'], task: 'do it' });
    expect(loadRunConfig(task).rules).toContain('Never assume');
  });

  it('takes rules written inline, for a project with only a line or two to say', () => {
    const { dir, repo } = place({
      'dsh.workspace.json': { name: 'p', rulesText: 'No shell, and ids are random.' },
    });
    const task = taskUsing(dir, repo, { model: 'deepseek-flash', allow: ['src/one.ts'], task: 'do it' });
    expect(loadRunConfig(task).rules).toBe('No shell, and ids are random.');
  });

  it('refuses rules that name a file which is not there, rather than dropping them', () => {
    // Having no rules is worse than having none, because the run's own config
    // says it had them and the agent worked without them.
    const { dir, repo } = place({
      'dsh.workspace.json': { name: 'p', rules: 'missing-notes.md' },
    });
    const task = taskUsing(dir, repo, { model: 'deepseek-flash', allow: ['src/one.ts'], task: 'do it' });
    expect(() => loadRunConfig(task)).toThrow();
  });

  it('carries the declared commands, which is what becomes the tools', () => {
    const { dir, repo } = place({
      'dsh.workspace.json': {
        name: 'p',
        commands: { run_test: { description: 'run a target', run: ['make', 'test'] } },
      },
    });
    const task = taskUsing(dir, repo, { model: 'deepseek-flash', allow: ['src/one.ts'], task: 'do it' });
    expect(Object.keys(loadRunConfig(task).commands)).toEqual(['run_test']);
  });

  it('resolves the build directory per worktree', () => {
    const { dir, repo } = place({
      'dsh.workspace.json': { name: 'p', env: { CARGO_TARGET_DIR: '{worktree}-target' } },
    });
    const task = taskUsing(dir, repo, { model: 'deepseek-flash', allow: ['src/one.ts'], task: 'do it' });
    expect(loadRunConfig(task).env.CARGO_TARGET_DIR).toBe(`${repo}-target`);
  });

  it('lets a profile override one variable without restating the rest', () => {
    const { dir, repo } = place({
      'dsh.workspace.json': { name: 'p', env: { A: 'from-workspace', B: 'from-workspace' } },
      'profile.json': { checks: {}, env: { B: 'from-profile' } },
    });
    const task = taskUsing(dir, repo, { model: 'deepseek-flash', allow: ['src/one.ts'], task: 'do it' });
    expect(loadRunConfig(task).env).toEqual({ A: 'from-workspace', B: 'from-profile' });
  });

  it('takes the soft list from both, so a project can add to it per task', () => {
    const { dir, repo } = place({
      'dsh.workspace.json': { name: 'p', soft: ['crates/*/tests/**'] },
    });
    const task = taskUsing(dir, repo, {
      model: 'deepseek-flash',
      allow: ['src/one.ts'],
      soft: ['src/one.spec.ts'],
      task: 'do it',
    });
    expect(loadRunConfig(task).soft).toEqual(['crates/*/tests/**', 'src/one.spec.ts']);
  });

  it('still works with no workspace at all, exactly as before', () => {
    // Everything written before this existed has no workspace, and none of it may
    // stop working.
    const { dir, repo } = place({});
    const task = taskUsing(dir, repo, { model: 'deepseek-flash', allow: ['src/one.ts'], task: 'do it' });
    const config = loadRunConfig(task);
    expect(config.workspace).toBeNull();
    expect(config.commands).toEqual({});
    expect(config.rules).toBe('');
    expect(config.soft).toEqual([]);
    expect(config.model).toBe('deepseek-flash');
  });

  it('uses a profile path a task gives even when a workspace exists', () => {
    // `"profile": "some/path.json"` is not a key in `profiles`, so it is a path.
    // Every task file that already spells one out keeps working.
    const { dir, repo } = place({
      'dsh.workspace.json': { name: 'p', profiles: { named: 'profile.json' } },
      'other/profile.json': { checks: { other: { run: [process.execPath, '-e', 'console.log(1)'] } } },
    });
    const task = taskUsing(dir, repo, {
      profile: 'other/profile.json',
      model: 'deepseek-flash',
      allow: ['src/one.ts'],
      task: 'do it',
    });
    expect(Object.keys(loadRunConfig(task).resolvedProfile.checks ?? {})).toEqual(['other']);
  });

  it('resolves a named profile relative to the workspace, not to the task file', () => {
    // A workspace points at its own profiles, so the same task file works from a
    // different directory and finds the same profile.
    const { repo } = place({
      'dsh.workspace.json': { name: 'p', profiles: { default: 'profile.json' }, defaultProfile: 'default' },
      'profile.json': PROFILE,
    });
    const elsewhere = path.join(scratch, `tasks-${counter}`);
    fs.mkdirSync(elsewhere, { recursive: true });
    const task = path.join(elsewhere, 't.json');
    fs.writeFileSync(
      task,
      JSON.stringify({
        name: 'a-line',
        worktree: repo,
        model: 'deepseek-flash',
        allow: ['src/one.ts'],
        task: 'do it',
      }),
    );
    expect(Object.keys(loadRunConfig(task).resolvedProfile.checks ?? {})).toEqual(['echo']);
  });

  it('refuses an explicit workspace that is not there, rather than walking up', () => {
    // A task that named a workspace and got the path wrong should hear that, not
    // be quietly given a different project's rules because one happened to be
    // further up the tree.
    const { dir, repo } = place({
      'dsh.workspace.json': { name: 'p' },
    });
    const task = taskUsing(dir, repo, {
      workspace: 'nowhere.json',
      model: 'deepseek-flash',
      allow: ['src/one.ts'],
      task: 'do it',
    });
    expect(() => loadRunConfig(task)).toThrow(/no such workspace file/);
  });

  it('says the name it could not find when the workspace names a profile with no file', () => {
    // The two ways to get this wrong read differently: a name the workspace
    // declared but never wrote, and a path that is simply not there.
    const { dir, repo } = place({
      'dsh.workspace.json': { name: 'p', profiles: { default: 'gone.json' }, defaultProfile: 'default' },
    });
    const task = path.join(dir, 't.json');
    fs.writeFileSync(
      task,
      JSON.stringify({
        name: 'a-line',
        worktree: repo,
        model: 'deepseek-flash',
        allow: ['src/one.ts'],
        task: 'do it',
      }),
    );
    let message = '';
    try {
      loadRunConfig(task);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('the workspace names default');
  });
});
