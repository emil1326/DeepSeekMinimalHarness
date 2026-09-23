/**
 * Reading a check's output, and the bug that made this necessary.
 *
 * `tool.result.ok` was true for a check that exited 1. `ok` only ever meant "the
 * call was not refused", so `dsh` painted a failing typecheck in the same dim
 * green as a passing one, and any report built on `ok` would have read the worst
 * outcome as the best. Found by reading what the real runs recorded, not by a
 * test, which is why there is one now.
 */

import { describe, expect, it } from 'vitest';
import { checkPassed, exitCodes } from '@emilswork/harness-core';

describe('reading a check result', () => {
  it('is a pass when the check exited zero', () => {
    expect(checkPassed('exit 0\nAll matched files use Prettier code style!')).toBe(true);
  });

  it('is not a pass when the check exited non-zero, however cheerful its output', () => {
    // The bug, in one line: a failing typecheck reported `ok: true`.
    expect(checkPassed('exit 1\nsrc/a.ts(3,5): error TS2322: Type is not assignable')).toBe(false);
    expect(checkPassed('exit 2\nboom')).toBe(false);
  });

  it('is not a pass when it was refused or could not start', () => {
    expect(checkPassed('refused: no check called tsc; there are format, verify')).toBe(false);
    expect(checkPassed('failed: spawn ENOENT')).toBe(false);
  });

  it('is not a pass when it ran out of time', () => {
    expect(checkPassed('the check ran past 15 minutes and was stopped')).toBe(false);
  });

  it('is a pass when there was nothing to do', () => {
    // `nothing to format` means the formatters found nothing to change, which is
    // the good outcome. Reading it as a failure would train a reader to ignore
    // the column, which is how a loud control stops being one.
    expect(checkPassed('nothing to format')).toBe(true);
    expect(checkPassed('nothing to check: no allowed file of that kind')).toBe(true);
    expect(checkPassed('(empty)')).toBe(true);
  });

  it('needs every formatter to pass, not just the last one', () => {
    // `format` runs several formatters and prints a line each, so one failure in
    // the middle is a failure of the whole check.
    const result = ['prettier: exit 1', 'eslint: exit 0'].join('\n');
    expect(checkPassed(result)).toBe(false);
    expect(checkPassed(['prettier: exit 0', 'eslint: exit 0'].join('\n'))).toBe(true);
  });

  it('finds every exit code, in order', () => {
    expect(exitCodes('exit 0')).toEqual([0]);
    expect(exitCodes('prettier: exit 1\neslint: exit 0')).toEqual([1, 0]);
    expect(exitCodes('nothing to do')).toEqual([]);
    // A negative code is a signal, and not a pass.
    expect(exitCodes('exit -1')).toEqual([-1]);
  });

  it("is not fooled by the word exit in a check's own output", () => {
    // A check that prints "exit 0" as part of explaining what it did must not be
    // read as having exited zero when its real code was different. The real code
    // is always the first line of a `run_check` result, and it is the one that
    // counts.
    const result = 'exit 1\nthe test expected exit 0 but got 3';
    expect(checkPassed(result)).toBe(false);
  });
});
