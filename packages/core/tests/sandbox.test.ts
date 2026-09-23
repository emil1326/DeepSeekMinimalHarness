/**
 * The sandbox's refusals, ported one for one from `legacy/test_sandbox.py` and
 * then extended.
 *
 * These are the tests that matter: a guard nobody has tried to get past is a
 * guard that might not be there. The first version of the path normaliser
 * stripped every leading dot, so `.git` and `.env` walked straight past the
 * deny lists, and only trying them found it. The control test at the bottom
 * puts that bug back and insists on exactly the dot-dependent guards going red.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import {
  IS_WINDOWS,
  Sandbox,
  SandboxRefusal,
  isInside,
  realPath,
  relNorm,
  type Profile,
} from '@emilswork/harness-core';

const PROFILE: Profile = {
  checks: {
    echo: { run: [process.execPath, '-e', "console.log('ran')"] },
    ts_only: { when: ['.ts'], run: [process.execPath, '-e', "console.log('ts')"] },
  },
  format: [],
};

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sandbox-'));
const repo = path.join(tmpRoot, 'repo');
const outside = path.join(tmpRoot, 'outside.txt');
const outsideDir = path.join(tmpRoot, 'outside-dir');
const original = 'export const a = 1;\n';

fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
execFileSync('git', ['init', '-q', repo], { stdio: 'ignore' });
fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
fs.writeFileSync(path.join(repo, 'src', 'b.ts'), 'export const b = 2;\n');
fs.writeFileSync(path.join(repo, '.env'), 'TOKEN=nope\n');
fs.mkdirSync(path.join(repo, '_private'));
fs.writeFileSync(path.join(repo, '_private', 'hosting.md'), 'secrets\n');
fs.mkdirSync(path.join(repo, 'target'));
fs.writeFileSync(path.join(repo, 'target', 'x'), 'x\n');
// Real worktrees have commits; an empty repo collapses untracked dirs in git status.
execFileSync('git', ['-c', 'user.name=dsh tests', '-c', 'user.email=dsh@example.invalid', 'add', '-A'], {
  cwd: repo,
  stdio: 'ignore',
});
execFileSync(
  'git',
  ['-c', 'user.name=dsh tests', '-c', 'user.email=dsh@example.invalid', 'commit', '-q', '-m', 'start'],
  { cwd: repo, stdio: 'ignore' },
);
fs.writeFileSync(outside, 'not yours\n');
fs.mkdirSync(outsideDir);
fs.writeFileSync(path.join(outsideDir, 'inside.txt'), 'OUTSIDE_MARKER\n');

/** A read that fails because the file is missing is not a refusal. */
function refused(action: () => unknown): boolean {
  try {
    action();
  } catch (error) {
    if (error instanceof SandboxRefusal) return true;
    if (error instanceof Error && hasCode(error, 'ENOENT')) return false;
    if (error instanceof Error && hasCode(error, 'ENOTDIR')) return false;
    return false;
  }
  return false;
}

function hasCode(error: Error, code: string): boolean {
  return (error as NodeJS.ErrnoException).code === code;
}

/** The prototype's bug: `lstrip("./")` ate every leading dot, not just the prefix. */
const lstripBug = (value: string): string => value.replace(/\\/g, '/').replace(/^[./]+/, '');

/**
 * The ported suite, parameterised by how paths are normalised so the control
 * test can run it with the bug in place.
 */
async function runSuite(normalise?: (value: string) => string): Promise<Map<string, boolean>> {
  const results = new Map<string, boolean>();
  const note = (label: string, ok: boolean): void => {
    results.set(label, ok);
  };
  fs.writeFileSync(path.join(repo, 'src', 'a.ts'), original);
  const box = new Sandbox({
    root: repo,
    allow: ['src/a.ts'],
    profile: PROFILE,
    ...(normalise ? { normalise } : {}),
  });

  try {
    note('an ordinary file can be read', box.readFile('src/a.ts').includes('export const a'));
  } catch {
    note('an ordinary file can be read', false);
  }
  note('a directory can be listed without .git', !box.listDir('.').includes('.git'));
  note(
    '.git is not shown',
    refused(() => box.readFile('.git/config')),
  );
  note(
    './.git is not shown either',
    refused(() => box.readFile('./.git/HEAD')),
  );
  note(
    '.env is not shown',
    refused(() => box.readFile('.env')),
  );
  note(
    '_private is not shown',
    refused(() => box.readFile('_private/hosting.md')),
  );
  note(
    'target is not shown',
    refused(() => box.readFile('target/x')),
  );
  note(
    '../ cannot escape',
    refused(() => box.readFile('../outside.txt')),
  );
  note(
    'an absolute path cannot escape',
    refused(() => box.readFile(outside)),
  );
  note('search skips what it may not show', !box.search('TOKEN|secrets').includes('TOKEN'));
  note('an allowed file can be changed', box.replaceInFile('src/a.ts', '= 1', '= 3') === 'replaced');
  // "t" is in both "export" and "const", so it cannot say which one it means.
  note('an ambiguous replace is refused', box.replaceInFile('src/a.ts', 't', 'T').startsWith('refused'));
  note(
    'a file not allowed cannot be changed',
    refused(() => box.replaceInFile('src/b.ts', '2', '4')),
  );
  note(
    'a file not allowed cannot be created',
    refused(() => box.createFile('src/c.ts', 'x')),
  );
  note('a check runs by name', (await box.runCheck('echo')).includes('ran'));
  note('a check the profile lacks is refused', (await box.runCheck('rm -rf /')).startsWith('refused'));
  note('a check for other kinds of file is skipped', (await box.runCheck('ts_only')).includes('ts'));

  const rustBox = new Sandbox({
    root: repo,
    allow: ['src/a.ts'],
    profile: { checks: { rs_only: { when: ['.rs'], run: ['x'] } } },
  });
  note(
    'a check with no allowed file of its kind does nothing',
    (await rustBox.runCheck('rs_only')).includes('nothing to check'),
  );

  for (const bad of [
    'Cargo.toml',
    'crates/x/build.rs',
    '.github/workflows/ci.yml',
    'vite.config.ts',
    'package.json',
    'tsconfig.json',
    'scripts/run.ps1',
  ]) {
    note(
      `allowing ${bad} is refused`,
      refused(() => new Sandbox({ root: repo, allow: [bad], profile: PROFILE })),
    );
  }

  // A check process must not inherit the key or any session token.
  process.env.DEEPSEEK_TEST_KEY = 'leak';
  process.env.CLAUDE_CODE_TEST = 'leak';
  const leaky = new Sandbox({
    root: repo,
    allow: ['src/a.ts'],
    profile: {
      checks: {
        env: {
          run: [
            process.execPath,
            '-e',
            'console.log(JSON.stringify(Object.entries(process.env).filter(([, v]) => String(v).toUpperCase().includes("LEAK")).map(([k]) => k)))',
          ],
        },
      },
    },
  });
  note('secrets are stripped from a check environment', (await leaky.runCheck('env')).includes('[]'));
  delete process.env.DEEPSEEK_TEST_KEY;
  delete process.env.CLAUDE_CODE_TEST;

  // The harness refuses a sandbox that contains its own rules.
  const profileInside = path.join(repo, 'profile.json');
  fs.writeFileSync(profileInside, JSON.stringify(PROFILE));
  note(
    'a profile inside the sandbox is refused',
    refused(() => Sandbox.assertOutsideSandbox(profileInside, repo, 'the profile')),
  );
  note(
    "sandboxing the harness's own tree is refused",
    refused(() => Sandbox.assertOutsideSandbox(path.join(repo, 'dsx.py'), repo, 'the harness')),
  );

  return results;
}

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('the sandbox', () => {
  it('refuses every one of the ported cases', async () => {
    const results = await runSuite();
    const failed = [...results.entries()].filter(([, ok]) => !ok).map(([label]) => label);
    expect(failed).toEqual([]);
  });

  it('goes red on exactly the dot-dependent guards when the lstrip bug is reinstated', async () => {
    const results = await runSuite(lstripBug);
    const failed = [...results.entries()]
      .filter(([, ok]) => !ok)
      .map(([label]) => label)
      .sort();
    expect(failed).toEqual(
      ['.env is not shown', './.git is not shown either', '.git is not shown', '../ cannot escape'].sort(),
    );
    // And the suite really does cover more than those four.
    expect(results.size).toBeGreaterThan(25);
  });
});

describe('containment is checked on the real path', () => {
  it('refuses a junction that points outside the worktree', () => {
    const link = path.join(repo, 'src', 'esc');
    try {
      fs.symlinkSync(outsideDir, link, IS_WINDOWS ? 'junction' : 'dir');
    } catch {
      // No permission to make links here; the plain path tests still stand.
      return;
    }
    const box = new Sandbox({ root: repo, allow: ['src/a.ts'], profile: PROFILE });
    expect(refused(() => box.readFile('src/esc/inside.txt'))).toBe(true);
    expect(refused(() => box.listDir('src/esc'))).toBe(true);
    expect(box.search('OUTSIDE_MARKER')).not.toContain('OUTSIDE_MARKER');
    fs.rmSync(link, { force: true });
  });

  it('compares case-insensitively on Windows', () => {
    if (!IS_WINDOWS) return;
    expect(isInside('F:\\vsCode\\project\\src', 'f:\\vscode\\PROJECT')).toBe(true);
    expect(isInside('F:\\vsCode\\project-other', 'f:\\vscode\\project')).toBe(false);
  });

  it('does not need the path to exist to judge containment', () => {
    const box = new Sandbox({ root: repo, allow: ['src/a.ts'], profile: PROFILE });
    // Missing, so the read fails on its own: the sandbox let it through.
    expect(refused(() => box.readFile('src/does-not-exist.ts'))).toBe(false);
    expect(
      realPath(path.join(repo, 'src', 'nope.ts'))
        .toString()
        .toLowerCase(),
    ).toContain('nope.ts');
  });
});

describe('relNorm', () => {
  it('strips only a literal ./ prefix', () => {
    expect(relNorm('./src/a.ts')).toBe('src/a.ts');
    expect(relNorm('./.git/HEAD')).toBe('.git/HEAD');
    expect(relNorm('.git/config')).toBe('.git/config');
    expect(relNorm('.env')).toBe('.env');
    expect(relNorm('src\\a.ts')).toBe('src/a.ts');
    expect(relNorm('a//b')).toBe('a/b');
  });

  it('does not collapse a parent segment', () => {
    expect(relNorm('../outside.txt')).toBe('../outside.txt');
  });
});
