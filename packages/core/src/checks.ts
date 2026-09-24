/**
 * Reading a check's own output, so "it ran" and "it passed" are not the same
 * thing.
 *
 * Found by looking at what the real runs recorded. `tool.result.ok` was true for
 * a check that exited 1, because `ok` only ever meant "the call was not
 * refused". So `dsh` painted a failing typecheck in the same dim green as a
 * passing one, and a report built on `ok` would have read the worst outcome as
 * the best.
 *
 * A check prints `exit N` and then its output. `format` runs several
 * formatters and so prints one `name: exit N` line each. Anything with no exit
 * line at all is informational — "nothing to format" — which is not a failure.
 */

/** Every `exit N` in the result, in order. */
export function exitCodes(result: string): number[] {
  const codes: number[] = [];
  const pattern = /(?:^|\n)(?:[^\n]*?:\s*)?exit (-?\d+)/g;
  for (;;) {
    const found = pattern.exec(result);
    if (found === null) break;
    const code = Number(found[1]);
    if (Number.isFinite(code)) codes.push(code);
  }
  return codes;
}

/**
 * The harness's own verdict on a command whose output proved nothing.
 *
 * The exit code is not enough. `cargo test -p x --test y <filter>` where the
 * filter matches no test exits **0** and prints "0 passed; 0 failed", and a
 * command like that reads as a green tick having executed nothing. Found in a
 * real workspace: a command was declared to run one test by name, the name was a
 * helper rather than a test, and it reported success for a long time while
 * running nothing at all.
 *
 * A project says what proof looks like for its own tool (`expect` on a declared
 * command), and `sandbox.ts` writes this marker in front of the output when the
 * proof is missing. The marker is a constant rather than a magic string in two
 * files so the writer and the reader cannot drift.
 */
export const NOT_PROVEN = '[harness] not proven:';

/**
 * How a check ended, in three states rather than two.
 *
 * "It failed" and "it could not be run" are different facts, and a report that
 * prints `FAIL` for both misleads in the direction that matters. Found by
 * running it: a live run asked for `lint` and `typecheck` in a profile that has
 * only `format`, both were refused, and the report listed two FAILs against a
 * run that had done nothing wrong — which makes a reader distrust the section
 * that is supposed to be the trustworthy one.
 */
export type CheckOutcome = 'pass' | 'fail' | 'unavailable';

/**
 * Whether a check passed.
 *
 * A non-zero exit is a failure. A refusal is not: the harness would not run it,
 * so it says nothing about the code. "Nothing to do" is a pass — `nothing to
 * format` means the formatters had nothing to change, which is the good outcome,
 * and reading it as a failure would train a reader to ignore the column.
 */
export function checkOutcome(result: string): CheckOutcome {
  const trimmed = result.trim();
  // Refused by the sandbox, or named a check that is not in the profile. Both
  // mean the check did not run, so neither says anything about the change.
  if (trimmed.startsWith('refused')) return 'unavailable';
  if (trimmed.startsWith('failed')) return 'fail';
  // Ran out of time. It did run and it did not finish, which is a failure.
  if (/^the (check|command) ran past/.test(trimmed)) return 'fail';
  // The harness, saying the project's own proof of work was missing. Read before
  // the exit codes below, because the whole point is that they say zero.
  if (trimmed.startsWith(NOT_PROVEN)) return 'fail';
  const codes = exitCodes(trimmed);
  if (codes.length === 0) return 'pass';
  return codes.every((code) => code === 0) ? 'pass' : 'fail';
}

/** The two-state answer, for callers that only need pass or not-pass. */
export function checkPassed(result: string): boolean {
  return checkOutcome(result) === 'pass';
}
