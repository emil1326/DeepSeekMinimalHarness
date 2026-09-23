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
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
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
    // Secret names are refused on the way in, not discovered at write time.
    // Two of these are dot-dependent, so the control covers them as well.
    '.env',
    'src/.env.local',
    'keys/id_rsa.key',
    'api_key',
    'src/secret-notes.txt',
    'credentials.json',
  ]) {
    // `normalise` is passed through, so these take part in the control too.
    // Without it they would keep passing with the bug reinstated, and a guard
    // the control cannot see is a guard the control does not cover.
    note(
      `allowing ${bad} is refused`,
      refused(
        () =>
          new Sandbox({ root: repo, allow: [bad], profile: PROFILE, ...(normalise ? { normalise } : {}) }),
      ),
    );
  }

  // The control for the allow list: an ordinary name is not refused.
  note(
    'allowing an ordinary file is fine',
    !refused(() => new Sandbox({ root: repo, allow: ['src/d.ts'], profile: PROFILE })),
  );

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
    // Everything the bug can reach, and nothing else. The bug only eats a
    // *leading* dot, so `.env` and `.github/...` fall through while
    // `src/.env.local` and `keys/x.key` do not: those never started with a dot,
    // and listing them here would be claiming coverage the control does not have.
    expect(failed).toEqual(
      [
        '.env is not shown',
        './.git is not shown either',
        '.git is not shown',
        '../ cannot escape',
        'allowing .env is refused',
        'allowing .github/workflows/ci.yml is refused',
      ].sort(),
    );
    // And the suite really does cover more than those six.
    expect(results.size).toBeGreaterThan(30);
  });
});

describe('the sandbox, hardened further', () => {
  // Its own file with known content. The ported suite above mutates `src/a.ts`
  // (it rewrites `= 1` to `= 3`), so reusing it here would make these tests
  // depend on the order the describes happen to run in.
  const TARGET = 'src/hardened.ts';
  const CONTENT = ['export const a = 1;', 'export const b = 2;', ''].join('\n');
  const reset = (): void => {
    fs.writeFileSync(path.join(repo, TARGET), CONTENT);
  };
  const box = (allow: string[] = [TARGET]): Sandbox => new Sandbox({ root: repo, allow, profile: PROFILE });

  beforeEach(() => reset());

  it('refuses a file symlink that points outside the worktree, in a search', () => {
    // This is the control for the search fast path. Search no longer resolves
    // every file, because `readdir` already says which ones are links and only
    // those can point somewhere else. If that reasoning is wrong, this fails.
    const link = path.join(repo, 'src', 'leak.txt');
    try {
      fs.symlinkSync(outside, link, 'file');
    } catch {
      // No permission to make links here; the junction test covers the same rule.
      return;
    }
    try {
      expect(box().search('not yours')).not.toContain('not yours');
      expect(box().listDir('src')).toContain('leak.txt');
      // And reading it directly is still refused, so the two agree.
      expect(refused(() => box().readFile('src/leak.txt'))).toBe(true);
    } finally {
      fs.rmSync(link, { force: true });
    }
  });

  it('does not follow a symlinked directory in a search', () => {
    const link = path.join(repo, 'src', 'esc-dir');
    try {
      fs.symlinkSync(outsideDir, link, IS_WINDOWS ? 'junction' : 'dir');
    } catch {
      return;
    }
    try {
      expect(box().search('OUTSIDE_MARKER')).not.toContain('OUTSIDE_MARKER');
    } finally {
      fs.rmSync(link, { force: true });
    }
  });

  it('reports a pattern that is not a regular expression instead of throwing', () => {
    const message = box().search('([unclosed', 'src');
    expect(message.startsWith('failed:')).toBe(true);
    expect(message).toContain('not a valid regular expression');
  });

  it('says a directory is a directory rather than failing obscurely', () => {
    let message = '';
    try {
      box().readFile('src');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('is a directory');
    expect(message).toContain('list_dir');
  });

  it('suggests a close name when a read misses', () => {
    let message = '';
    try {
      box().readFile('src/hardened.tsx');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('no such file');
    expect(message).toContain('hardened.ts');
  });

  it('keeps a missing file a miss rather than a refusal', () => {
    // Load-bearing: if a missing file were a refusal, the lstrip bug could hide
    // behind it, which is exactly how it hid in the prototype.
    expect(refused(() => box().readFile('src/nothing-here.ts'))).toBe(false);
  });

  it('says so when a read starts past the end of the file', () => {
    const message = box().readFile(TARGET, 900);
    expect(message).toContain('past the end');
    expect(message).toContain('3 lines');
  });

  it('refuses to allow a secret name before the run starts', () => {
    expect(refused(() => new Sandbox({ root: repo, allow: ['.env'], profile: PROFILE }))).toBe(true);
    expect(refused(() => new Sandbox({ root: repo, allow: ['src/../.env'], profile: PROFILE }))).toBe(true);
    expect(refused(() => new Sandbox({ root: repo, allow: ['keys/x.key'], profile: PROFILE }))).toBe(true);
  });

  it('has a second door: a secret name forced into the allow set is refused at write time', () => {
    // The constructor is the first door. This reaches past it, the way a future
    // refactor might, and insists `resolve` still refuses on its own. A guard
    // with only one door is one careless change away from being no guard.
    const forced = new Sandbox({ root: repo, allow: [TARGET], profile: PROFILE });
    (forced as unknown as { allow: Set<string> }).allow.add('.env');
    expect(refused(() => forced.createFile('.env', 'x'))).toBe(true);
    expect(refused(() => forced.replaceInFile('.env', 'TOKEN', 'x'))).toBe(true);
    expect(refused(() => forced.readFile('.env'))).toBe(true);
  });

  it('explains a miss with the line and the text the file actually has', () => {
    const result = box().replaceInFile(TARGET, '    export const a = 1;', 'x');
    expect(result).toContain('whitespace');
    expect(result).toContain('export const a = 1;');
    expect(result).toContain('line 1');
  });

  it('says which line of a replacement is wrong when nothing matches', () => {
    const result = box().replaceInFile(TARGET, 'export const a = 1;\nexport const b = 9;', 'x');
    expect(result).toContain('Line 2 of what you sent');
    expect(result).toContain('b = 9');
  });

  it('lists the lines when the old text is ambiguous', () => {
    fs.writeFileSync(path.join(repo, 'src', 'd.ts'), 'const k = 1;\nconst k = 1;\n');
    const withD = new Sandbox({ root: repo, allow: ['src/d.ts'], profile: PROFILE });
    const result = withD.replaceInFile('src/d.ts', 'const k = 1;', 'x');
    expect(result).toContain('appears 2 times');
    expect(result).toContain('Lines 1, 2');
  });

  it('leaves the file untouched when it refuses', () => {
    // A refusal that half-applied would be worse than either outcome.
    box().replaceInFile(TARGET, 'export const b = 9;', 'x');
    box().createFile(TARGET, 'overwritten');
    expect(fs.readFileSync(path.join(repo, TARGET), 'utf8')).toBe(CONTENT);
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
