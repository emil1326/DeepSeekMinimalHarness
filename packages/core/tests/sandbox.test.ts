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
  NEVER_WRITE,
  Sandbox,
  SandboxRefusal,
  covered,
  declaresProcMacro,
  isInside,
  matchesGlob,
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
    refused(() => Sandbox.assertOutsideOrProtected(profileInside, repo, 'the profile')),
  );
  // Except under `.dsh/`, which is on the never-write list, so no tool the
  // agent can call reaches it. The control is the refusal just above: the same
  // file one directory up is refused.
  fs.mkdirSync(path.join(repo, '.dsh'), { recursive: true });
  const profileProtected = path.join(repo, '.dsh', 'profile.json');
  fs.writeFileSync(profileProtected, JSON.stringify(PROFILE));
  let protectedAccepted = true;
  try {
    Sandbox.assertOutsideOrProtected(profileProtected, repo, 'the profile');
  } catch {
    protectedAccepted = false;
  }
  note('a profile under .dsh/ is accepted, because no tool writes there', protectedAccepted);
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

describe('search, as it behaves live', () => {
  const TARGET = 'src/searchable.ts';
  const box = (): Sandbox => new Sandbox({ root: repo, allow: [TARGET], profile: PROFILE });

  beforeEach(() => {
    fs.writeFileSync(
      path.join(repo, TARGET),
      [
        'const first = 1;',
        'const second = 2;',
        '// attempt, retry, retries, attempts, and retrying all on one line',
        'export const third = 3;',
        '',
      ].join('\n'),
    );
  });

  it('prints a line once however many times the pattern matches on it', () => {
    // Found live. A five-way alternation matched five times on one line, and
    // the line was printed five times: a seven-hit result came back as fifteen
    // lines, which reads as fifteen hits and spends the hit budget on one line.
    const result = box().search('attempt|retry|retries|attempts|retrying');
    const lines = result.split('\n').filter((line) => line.includes('searchable.ts'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('attempt, retry, retries, attempts, and retrying');
  });

  it('still reports the same line count when the pattern matches once per line', () => {
    // The control for the dedupe above: it must not swallow genuine hits. Lines
    // 1, 2 and 4 match; line 4 matches both alternatives and is still one line.
    const result = box().search('const|export');
    const lines = result.split('\n').filter((line) => line.includes('searchable.ts'));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain(':1:');
    expect(lines[2]).toContain(':4:');
    expect(lines[2]).toContain('export const third = 3;');
  });

  it('reads a leading (?i) as the i flag instead of refusing it', () => {
    // Found live. This is how every model that learned regex on Python writes a
    // case-insensitive search, and it cost a whole turn: the refusal said only
    // "Invalid group", so the model worked it out and rewrote the pattern.
    const result = box().search('(?i)SECOND');
    expect(result).toContain('const second = 2;');
    // The rewrite is stated, because the model asked for something and got
    // something equivalent. Silence would misreport what was searched for.
    expect(result).toContain("read the leading (?i) as the 'i' flag");
  });

  it('combines leading flags the way the equivalent RegExp would', () => {
    fs.writeFileSync(path.join(repo, TARGET), 'const a = 1;\nconst multiline = 2;\n');
    const insensitive = box().search('(?i)MULTILINE');
    expect(insensitive).toContain('const multiline = 2;');
    // `s` makes `.` cross a newline, which is what a model asking for `(?s)`
    // wants. Without it this cannot match.
    const dotAll = box().search('(?s)const a = 1;.const multiline');
    expect(dotAll).toContain('const a = 1;');
  });

  it('leaves a pattern with no inline flags completely alone', () => {
    const result = box().search('second');
    expect(result).not.toContain('read the leading');
    expect(result).toContain('const second = 2;');
  });

  it('names the fix when a flag cannot be rewritten, rather than saying Invalid group', () => {
    // A mid-pattern flag has no JavaScript equivalent, so it is refused, but the
    // refusal has to teach, or the model burns a turn exactly as it did live.
    const result = box().search('const(?i)second');
    expect(result).toContain('JavaScript has no inline flags');
    expect(result).toContain('[Aa]');
    expect(result).not.toBe('failed: that is not a valid regular expression');
  });

  it('says what to write instead for a pattern that is simply broken', () => {
    const result = box().search('const (');
    expect(result).toContain('not a valid regular expression');
    expect(result).toContain('JavaScript regex');
  });
});

describe('refusing to let a check run code the agent wrote', () => {
  const box = (allow: string[]): Sandbox => new Sandbox({ root: repo, allow, profile: PROFILE });

  beforeEach(() => {
    fs.mkdirSync(path.join(repo, 'crates', 'macros', 'src'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'crates', 'plain', 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, 'crates', 'macros', 'Cargo.toml'),
      ['[package]', 'name = "macros"', '', '[lib]', 'proc-macro = true', ''].join('\n'),
    );
    fs.writeFileSync(path.join(repo, 'crates', 'macros', 'src', 'lib.rs'), '// a macro\n');
    fs.writeFileSync(
      path.join(repo, 'crates', 'plain', 'Cargo.toml'),
      ['[package]', 'name = "plain"', '', '[dependencies]', ''].join('\n'),
    );
    fs.writeFileSync(path.join(repo, 'crates', 'plain', 'src', 'lib.rs'), '// ordinary\n');
  });

  it('refuses a file inside a proc-macro crate, wherever the crate is', () => {
    // `cargo check` and `clippy` compile and *run* the build-time code of every
    // crate in the workspace, and a proc-macro crate is exactly that. Allowing a
    // file in one would be allowing an agent to write code that runs the next
    // time a check runs, with nothing watching in between.
    expect(refused(() => box(['crates/macros/src/lib.rs']))).toBe(true);
    // And it says why, because the model reads refusals.
    let message = '';
    try {
      box(['crates/macros/src/lib.rs']);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('proc-macro');
    expect(message).toContain('build time');
  });

  it('leaves every other crate in the workspace alone', () => {
    // The control. A blanket "refuse anything in a Rust repo" would be useless,
    // and this is the shape a real workspace has: one macro crate, many others.
    expect(() => box(['crates/plain/src/lib.rs'])).not.toThrow();
    expect(box(['crates/plain/src/lib.rs']).writable('crates/plain/src/lib.rs')).toBeTruthy();
  });

  it('has a second door: a proc-macro file forced into the allow set is refused at write time', () => {
    const forced = box(['crates/plain/src/lib.rs']);
    (forced as unknown as { allow: Set<string> }).allow.add('crates/macros/src/lib.rs');
    expect(refused(() => forced.replaceInFile('crates/macros/src/lib.rs', 'a macro', 'x'))).toBe(true);
    expect(refused(() => forced.createFile('crates/macros/src/lib.rs', 'x'))).toBe(true);
    // Reading is not the risk, so it is not blocked: a model that cannot read
    // the crate cannot tell why its file was refused.
    expect(() => forced.readFile('crates/macros/src/lib.rs')).not.toThrow();
  });

  it('refuses tool configuration that a check loads and executes', () => {
    // Prettier, ESLint, Babel and Stylelint all accept a JavaScript config whose
    // plugins are resolved and then run. `*.config.*` covered the
    // `eslint.config.js` spelling; these are the dotfile spellings, which is what
    // the review found missing.
    for (const name of [
      '.prettierrc',
      '.prettierrc.cjs',
      '.prettierrc.json',
      '.eslintrc',
      '.eslintrc.cjs',
      '.babelrc',
      '.babelrc.js',
      '.stylelintrc.json',
      '.npmrc',
      '.yarnrc.yml',
    ]) {
      expect(
        refused(() => box([name])),
        name,
      ).toBe(true);
    }
  });

  it('still allows ordinary files, including ones that merely start with a dot', () => {
    // The control for the list above: the patterns are names, not "anything
    // dotted", and a tighter list is only better if it is still usable.
    for (const name of ['.editorconfig', '.gitignore', 'src/a.ts', 'prettier-notes.md']) {
      expect(
        refused(() => box([name])),
        name,
      ).toBe(false);
    }
  });
});

describe('reading a Cargo.toml for a proc-macro target', () => {
  it('is true only for proc-macro under [lib]', () => {
    expect(declaresProcMacro('[lib]\nproc-macro = true\n')).toBe(true);
    expect(declaresProcMacro('[lib]\nproc-macro=true\n')).toBe(true);
    // Not under [lib], so not a proc-macro crate.
    expect(declaresProcMacro('[package]\nproc-macro = true\n')).toBe(false);
    // A false value is not a declaration.
    expect(declaresProcMacro('[lib]\nproc-macro = false\n')).toBe(false);
    // Commented out is not a declaration, which is the one that would matter:
    // a commented line read as real would refuse a file for no reason.
    expect(declaresProcMacro('# proc-macro = true\n[lib]\n')).toBe(false);
    expect(declaresProcMacro('[lib]\n# proc-macro = true\n')).toBe(false);
    // A trailing comment on a real line is still a declaration.
    expect(declaresProcMacro('[lib]\nproc-macro = true # macros\n')).toBe(true);
    // Ordinary manifests, and the empty string, which is what a missing file
    // would look like if it ever got that far.
    expect(declaresProcMacro('[package]\nname = "x"\n\n[dependencies]\nserde = "1"\n')).toBe(false);
    expect(declaresProcMacro('')).toBe(false);
    // A later table must not un-declare an earlier one, or vice versa.
    expect(declaresProcMacro('[lib]\nproc-macro = true\n\n[dependencies]\n')).toBe(true);
    expect(declaresProcMacro('[dependencies]\nproc-macro = true\n')).toBe(false);
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

/**
 * Globs in the allow and soft lists, which silently did nothing.
 *
 * Found live rather than reasoned about. A task was run with
 * `"allow": ["docs/**"]` and a one-line instruction to create
 * `docs/watch-live.md`; the run was refused twice, reported "No files were
 * changed, so nothing is done", and spent its turns explaining that the file it
 * had been told to create was outside the area it had been told to write in.
 *
 * The cause was `allowed.has(path)` — string equality — with `matchesGlob`
 * sitting right there, working, and uncalled. So a glob permitted a file
 * literally named `docs/**` and nothing else, while the refusal printed the glob
 * back at the model as though globs were supported. Two nested directories away
 * the identical equality check in `stray.ts` would have reported the same file as
 * a change on no list at all.
 */
describe('a glob in the allow list', () => {
  const box = (allow: string[], soft?: string[]): Sandbox =>
    new Sandbox({ root: repo, allow, profile: PROFILE, ...(soft === undefined ? {} : { soft }) });

  it('permits a file that already exists anywhere the glob reaches', () => {
    expect(box(['src/**']).readFile('src/a.ts')).toContain('export const a');
    expect(box(['**/*.ts']).readFile('src/b.ts')).toContain('export const b');
  });

  it('permits a file that does not exist yet, which is the case that was broken', () => {
    // Creating a file is the one write where the path is not in any list of
    // names, so this is the case an exact-match check can never pass. It is also
    // the common case: most tasks create something.
    const created = box(['src/**']);
    expect(created.createFile('src/new.ts', 'export const c = 3;\n')).toBe('created');
    expect(fs.readFileSync(path.join(repo, 'src', 'new.ts'), 'utf8')).toBe('export const c = 3;\n');
    fs.rmSync(path.join(repo, 'src', 'new.ts'), { force: true });
  });

  it('still refuses a file the glob does not reach', () => {
    // The control. A glob has to widen the list, not dissolve it.
    const narrow = box(['src/*.ts']);
    expect(refused(() => narrow.createFile('other.ts', 'x\n'))).toBe(true);
    expect(refused(() => narrow.createFile('src/deep/new.ts', 'x\n'))).toBe(true);
  });

  it('refuses a never-read directory at write time rather than at construction', () => {
    // Two doors, deliberately, and this is the second one. The constructor
    // refuses a never-write name and a secret name before a run starts, because
    // both are mistakes in somebody's config and saying so to the person who
    // typed it costs nothing. A never-*read* directory is not refused there: it
    // is caught by `resolve`, which every read and every write goes through, so
    // naming one in `allow` produces a refusal at the moment of writing rather
    // than at the moment of loading.
    const leaky = box(['src/**', '_private/**', 'target/**']);
    expect(refused(() => leaky.readFile('_private/hosting.md'))).toBe(true);
    expect(refused(() => leaky.createFile('_private/x.md', 'x\n'))).toBe(true);
    expect(refused(() => leaky.createFile('target/x', 'x\n'))).toBe(true);
  });

  it('treats `**/` as zero or more directories, so a top-level file matches', () => {
    // Otherwise `**/*.ts` compiles to `.*/.*\.ts` and misses `a.ts` at the root:
    // the one file a rule written to cover "every TypeScript file" should cover.
    expect(matchesGlob('a.ts', '**/*.ts')).toBe(true);
    expect(matchesGlob('src/a.ts', '**/*.ts')).toBe(true);
    expect(matchesGlob('src/deep/a.ts', '**/*.ts')).toBe(true);
    expect(matchesGlob('a.js', '**/*.ts')).toBe(false);
  });

  it('counts a glob on the soft list as covered, and still reports it', () => {
    // Soft means writable and reported, so both halves have to see the glob.
    const wide = box(['src/a.ts'], ['crates/*/tests/**']);
    expect(wide.soft.has('crates/*/tests/**')).toBe(true);
    expect(covered(wide.soft, 'crates/one/tests/it.rs')).toBe(true);
    expect(covered(wide.soft, 'crates/one/src/lib.rs')).toBe(false);
  });

  it('keeps `{allowed}` as real files rather than patterns', () => {
    // A check handed a pattern is a check that examines nothing: eslint,
    // prettier and cargo fmt disagree about globs, and one of them would exit 0.
    // The expansion walks the tree, so it also has to skip what the sandbox
    // never shows.
    //
    // Asserted as an invariant rather than an exact list, because this fixture
    // repo is shared and some other describe in this file writes into it. The
    // invariant is the thing that matters and it does not depend on who ran
    // first.
    const expanded = box(['src/**', 'target/**', '_private/**']).command({
      when: ['.ts'],
      run: ['echo', '{allowed}'],
    });
    expect(expanded?.[0]).toBe('echo');
    const files = expanded?.slice(1) ?? [];
    expect(files).toContain('src/a.ts');
    expect(files).toContain('src/b.ts');
    for (const file of files) {
      // Every element is a file that exists, with nothing left as a pattern.
      expect(file).not.toContain('*');
      expect(fs.existsSync(path.join(repo, file))).toBe(true);
      expect(file.endsWith('.ts')).toBe(true);
      // And nothing from a directory the sandbox never shows, even though the
      // allow list named it.
      expect(file.startsWith('target/') || file.startsWith('_private/')).toBe(false);
    }
  });

  it('says there is nothing to check rather than passing a pattern on', () => {
    expect(box(['docs/**']).command({ when: ['.ts'], run: ['echo', '{allowed}'] })).toBeNull();
    // And with no `when`, an allow list that matches no existing file is still
    // an empty argv rather than a refusal to build one.
    expect(box(['docs/**']).command({ run: ['echo', '{allowed}'] })).toEqual(['echo']);
  });
});

/**
 * What each never-write entry still catches.
 *
 * This exists because the semantics of `*` changed under it. `NEVER_WRITE` used
 * to list a `*`-and-then-`build.rs` spelling and a bare `*.ps1`, which reached
 * every depth only because `*` crossed a slash — and that same quirk was making a
 * task's `"allow": ["src/*.ts"]` permit `src/deep/anything.ts`, a write
 * permission wider than what it said. Fixing the matcher meant respelling the deny
 * list, and a deny list respelled by hand is a deny list with a hole in it.
 *
 * So every entry is pinned from the other side: the paths it is there to catch,
 * named one by one. A rule that quietly stops matching fails here rather than in
 * a run.
 */
describe('the never-write list, entry by entry', () => {
  /** Every path each entry must refuse. One entry, one reason, one line. */
  const MUST_CATCH: [string, string[]][] = [
    // The build script of any crate, at any depth. This is the one that runs at
    // build time, so a check that runs it would be executing agent code.
    ['**/build.rs', ['build.rs', 'crates/x/build.rs', 'a/b/c/build.rs']],
    ['**/Cargo.toml', ['Cargo.toml', 'crates/x/Cargo.toml', 'a/b/Cargo.toml']],
    ['Cargo.lock', ['Cargo.lock']],
    ['package.json', ['package.json']],
    ['package-lock.json', ['package-lock.json']],
    ['pnpm-lock.yaml', ['pnpm-lock.yaml']],
    ['yarn.lock', ['yarn.lock']],
    // A JavaScript config whose plugins are resolved and then executed.
    ['**/*.config.*', ['eslint.config.js', 'packages/core/vite.config.ts', 'ui/next.config.mjs']],
    ['**/tsconfig*.json', ['tsconfig.json', 'packages/core/tsconfig.json', 'ui/tsconfig.app.json']],
    ['**/.prettierrc*', ['.prettierrc', '.prettierrc.json', 'ui/.prettierrc']],
    ['**/.eslintrc*', ['.eslintrc', '.eslintrc.cjs', 'ui/.eslintrc.json']],
    ['**/.babelrc*', ['.babelrc', 'ui/.babelrc.json']],
    ['**/.stylelintrc*', ['.stylelintrc', 'ui/.stylelintrc.json']],
    ['**/.markdownlint*', ['.markdownlint.json', 'docs/.markdownlint-cli2.jsonc']],
    // Read by npm and yarn before anything is fetched.
    ['**/.npmrc', ['.npmrc', 'ui/.npmrc']],
    ['**/.yarnrc*', ['.yarnrc', '.yarnrc.yml', 'ui/.yarnrc.yml']],
    // A workflow file is a script that runs on a push, which is to say out of
    // anybody's sight and after the run is over.
    ['.github/**', ['.github/workflows/ci.yml', '.github/dependabot.yml']],
    ['.claude/**', ['.claude/settings.json', '.claude/agents/x.md']],
    ['.cargo/**', ['.cargo/config.toml']],
    ['rust-toolchain*', ['rust-toolchain', 'rust-toolchain.toml']],
    // Shell and PowerShell: the point of the sandbox is that a model-written
    // string never reaches a command interpreter, and a script is that string
    // with somewhere to live.
    ['**/*.ps1', ['a.ps1', 'tools/build/x.ps1']],
    ['**/*.cmd', ['a.cmd', 'tools/x/a.cmd']],
    ['**/*.bat', ['a.bat', 'tools/x/a.bat']],
    ['**/*.sh', ['a.sh', 'scripts/deploy.sh']],
    ['setup.py', ['setup.py']],
    ['pyproject.toml', ['pyproject.toml']],
    ['Makefile', ['Makefile']],
    ['Dockerfile', ['Dockerfile']],
    // The files the harness reads to decide what a run may do.
    ['dsh.workspace.json', ['dsh.workspace.json']],
    ['.dsh/workspace.json', ['.dsh/workspace.json']],
    ['.dsh/**', ['.dsh/workspace.json', '.dsh/profile.json', '.dsh/rules.md']],
  ];

  it('catches a path it is there to catch, for every entry', () => {
    expect(NEVER_WRITE.sort()).toEqual(MUST_CATCH.map(([entry]) => entry).sort());
    for (const [entry, paths] of MUST_CATCH) {
      for (const target of paths) {
        expect(matchesGlob(target, entry), `${entry} should catch ${target}`).toBe(true);
      }
    }
  });

  it('leaves ordinary code alone', () => {
    // The other half, because a deny list that widened would refuse writes a
    // task is entitled to and the failure would look like a sandbox bug.
    for (const target of [
      'src/a.ts',
      'crates/x/src/lib.rs',
      'docs/notes.md',
      'ui/mark.spec.ts',
      'README.md',
    ]) {
      for (const entry of NEVER_WRITE) {
        expect(matchesGlob(target, entry), `${entry} should not catch ${target}`).toBe(false);
      }
    }
  });
});
