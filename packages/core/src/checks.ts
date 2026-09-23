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
 * Whether a check passed.
 *
 * A refusal is not a pass, a non-zero exit is not a pass, and one failure
 * anywhere among several formatters is not a pass. "Nothing to do" is a pass:
 * `nothing to format` means the formatters had nothing to change, which is the
 * good outcome, and reading it as a failure would train a reader to ignore the
 * column.
 */
export function checkPassed(result: string): boolean {
  const trimmed = result.trim();
  if (trimmed.startsWith('refused') || trimmed.startsWith('failed')) return false;
  // Ran out of time is not a pass.
  if (trimmed.startsWith('the check ran past')) return false;
  const codes = exitCodes(trimmed);
  if (codes.length === 0) return true;
  return codes.every((code) => code === 0);
}
