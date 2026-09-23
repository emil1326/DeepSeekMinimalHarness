/**
 * Diagnosing a failure, and the two things that make it worth doing.
 *
 * These messages are the harness's main lever on how fast an agent works. A
 * model that is told "matched 0 times" re-reads the file and guesses; a model
 * that is told "it is there at line 42 if whitespace is ignored, and here is
 * what the file actually has" fixes it on the next turn. So the wording is
 * tested, not just the branch.
 *
 * The controls are the point of the second half: for each diagnostic, a case
 * where it must say nothing, so a diagnostic that fires on everything (and
 * therefore teaches nothing) fails the suite.
 */

import { describe, expect, it } from 'vitest';
import {
  closestNames,
  distance,
  escapeLiteral,
  explainAmbiguous,
  explainMissing,
  findMatches,
  findNearMatches,
  loosePattern,
} from '@emilswork/harness-core';

const FILE = [
  "import { expect, test } from '@playwright/test';",
  '',
  "test('marks land on the board', async ({ page }) => {",
  '  await openBoard(page);',
  '',
  '  await expect(page.getByTestId("mark-dot")).toBeVisible();',
  '  await expect(page.getByTestId("mark-count")).toHaveText("0");',
  '});',
  '',
].join('\n');

const LINES = FILE.split('\n').length;

describe('explaining a miss', () => {
  it('names the line when only the whitespace differs', () => {
    // Four spaces instead of two, which is the classic way a model misses.
    const wrong = '    await expect(page.getByTestId("mark-dot")).toBeVisible();';
    const message = explainMissing('ui/mark.spec.ts', FILE, wrong);

    expect(message).toContain('line 6');
    expect(message).toContain('whitespace');
    // It shows what the file really has, so the model can copy it.
    expect(message).toContain('await expect(page.getByTestId("mark-dot")).toBeVisible();');
    expect(message.startsWith('refused:')).toBe(true);
  });

  it('survives a change in line endings', () => {
    const crlf = FILE.replace(/\n/g, '\r\n');
    // The sandbox normalises before it compares, so a CRLF needle is the same text.
    const message = explainMissing('ui/mark.spec.ts', FILE, crlf.trim());
    // Trimmed it is a prefix of the file, not an exact hit, so this must explain
    // rather than claim success.
    expect(message.startsWith('refused:')).toBe(true);
  });

  it('names the lines when a loose match lands in more than one place', () => {
    const repeated = `const a = 1;\nconst b = 2;\nconst a = 1;\n`;
    const message = explainMissing('src/x.ts', repeated, 'const  a = 1;');
    expect(message).toContain('lines 1, 3');
  });

  it('names the exact line of the replacement that is wrong', () => {
    const message = explainMissing(
      'src/x.ts',
      FILE,
      'await expect(page.getByTestId("mark-dot")).toBeVisible(3)',
    );
    expect(message).toContain('Line 1 of what you sent');
    expect(message).toContain('toBeVisible(3)');
  });

  it('picks the wrong line out of a multi-line replacement', () => {
    const message = explainMissing(
      'src/x.ts',
      FILE,
      ['  await openBoard(page);', '  await expect(page.getByTestId("nope")).toBeVisible();'].join('\n'),
    );
    // The first line is in the file; the second is not, and it is line 2 of the needle.
    expect(message).toContain('Line 2 of what you sent');
    expect(message).toContain('nope');
  });

  it('says so when every line is present but the block is not', () => {
    const message = explainMissing(
      'src/x.ts',
      FILE,
      ['  await expect(page.getByTestId("mark-count")).toHaveText("0");', '  await openBoard(page);'].join(
        '\n',
      ),
    );
    expect(message).toContain('not in that order');
  });

  it('says how long the file is when there is no resemblance at all', () => {
    const message = explainMissing('src/x.ts', FILE, 'this text is nowhere at all');
    expect(message).toContain('not in src/x.ts');
    expect(message).toContain(`${LINES} lines`);
    // It has to tell the model what to do next, not just that it failed.
    expect(message).toMatch(/Read the file and copy/);
  });

  it('explains an empty needle instead of claiming a match', () => {
    const message = explainMissing('src/x.ts', FILE, '');
    expect(message).toContain('no old text was given');
    expect(message).toContain(`${LINES} lines`);
  });

  it('does not pretend a loose match is an exact one', () => {
    // The control: when the text really is there, the loose search must still
    // find it, but the caller only reaches this on a miss. So the message must
    // always tell the model to copy the exact text.
    const message = explainMissing('src/x.ts', FILE, '  await openBoard(page);');
    expect(message).toMatch(/Copy that text exactly|Copy the text exactly/);
  });
});

describe('near matches', () => {
  it('does not let leading whitespace match backwards into a blank line', () => {
    // The bug this guards: with the indentation left on the needle, the opening
    // `\s+` swallowed the blank line above and reported line 3 with no text.
    const found = findNearMatches(FILE, '  await openBoard(page);');
    expect(found).toEqual([{ line: 4, text: 'await openBoard(page);' }]);
  });

  it('finds text that differs only in whitespace, and says where', () => {
    expect(findNearMatches(FILE, '  await openBoard(page);')).toEqual([
      { line: 4, text: 'await openBoard(page);' },
    ]);
    expect(findNearMatches(FILE, '    await openBoard(page);')).toEqual([
      { line: 4, text: 'await openBoard(page);' },
    ]);
    expect(findNearMatches(FILE, 'await   openBoard(page);')).toEqual([
      { line: 4, text: 'await openBoard(page);' },
    ]);
    expect(findNearMatches(FILE, '\t\tawait openBoard(page);\n')).toEqual([
      { line: 4, text: 'await openBoard(page);' },
    ]);
  });

  it('finds nothing when nothing is close, which is the control', () => {
    expect(findNearMatches(FILE, 'a line that is not in this file')).toEqual([]);
  });

  it('refuses to search for an absurdly long needle', () => {
    const huge = 'x'.repeat(9000);
    expect(loosePattern(huge)).toBeNull();
    expect(findNearMatches(FILE, huge)).toEqual([]);
  });

  it('treats a regex-special needle as literal text, not a pattern', () => {
    const special = 'expect(page.getByTestId("mark-dot")).toBeVisible();';
    // The unescaped form would be a pattern with groups and could not match.
    expect(findNearMatches(FILE, special).length).toBe(1);
    expect(escapeLiteral('a.b*c(d)')).toBe('a\\.b\\*c\\(d\\)');
  });

  it('stops at the limit rather than returning every match', () => {
    const many = Array.from({ length: 20 }, () => 'same line').join('\n');
    expect(findNearMatches(many, 'same line', 3)).toHaveLength(3);
  });
});

describe('explaining an ambiguous match', () => {
  it('lists the distinct lines and tells the model how to disambiguate', () => {
    const file = 'a\nconst x = 1;\nb\nconst x = 1;\nc\n';
    const message = explainAmbiguous('src/x.ts', file, 'const x = 1;', 2);
    expect(message).toContain('appears 2 times');
    expect(message).toContain('Lines 2, 4');
    expect(message).toContain('Include the lines above or below');
  });

  it('does not repeat one line twice when several matches share it', () => {
    const file = 'const x = 1; const x = 1;\n';
    const message = explainAmbiguous('src/x.ts', file, 'const x = 1;', 2);
    expect(message).toContain('All 2 of them are on line 1');
    expect(message).not.toContain('1, 1');
  });
});

describe('finding the match lines', () => {
  it('counts lines from one, deduped', () => {
    expect(findMatches('a\nb\na\n', 'a')).toEqual([1, 3]);
    expect(findMatches('aa\n', 'a')).toEqual([1]);
  });

  it('says nothing for an empty needle', () => {
    expect(findMatches('anything', '')).toEqual([]);
  });
});

describe('suggesting a filename', () => {
  const names = ['mark.spec.ts', 'helpers.ts', 'boxes.ts', 'index.ts', 'README.md'];

  it('suggests the obvious candidate', () => {
    expect(closestNames('mark.spec.ts', names)).toContain('mark.spec.ts');
    expect(closestNames('helpers.t', names)[0]).toBe('helpers.ts');
    expect(closestNames('box.ts', names)).toContain('boxes.ts');
  });

  it('suggests nothing when nothing is close, which is the control', () => {
    expect(closestNames('something-entirely-different.json', names)).toEqual([]);
    expect(closestNames('zzzzzzzzzzzzzzzz', names)).toEqual([]);
  });

  it('measures edit distance the usual way', () => {
    expect(distance('abc', 'abc')).toBe(0);
    expect(distance('', 'abc')).toBe(3);
    expect(distance('abc', '')).toBe(3);
    expect(distance('abc', 'abd')).toBe(1);
    expect(distance('kitten', 'sitting')).toBe(3);
  });

  it('returns at most the limit', () => {
    expect(closestNames('a.ts', ['a.ts', 'a.js', 'a.tsx', 'a.jsx'], 2)).toHaveLength(2);
  });
});
