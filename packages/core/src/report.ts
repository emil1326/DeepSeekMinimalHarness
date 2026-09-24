/**
 * What actually happened in a run, in one page.
 *
 * The reason this exists: seven of the nine runs on this machine ended at a
 * limit, and there was no way to find that out except by reading the event log
 * by hand. `stopped_at_limit` appeared in a status column next to `finished`,
 * the summary was the agent's own cheerful closing paragraph, and the
 * commissioner had to reconstruct what had gone wrong from a chat transcript.
 *
 * A report is a different kind of document from a log. It says what the run was
 * asked to do, whether it finished, what it changed, what the checks said the
 * last time they ran, and — when it did not finish — exactly how much room it
 * had and what was left undone. The point is that somebody who did not watch the
 * run can decide whether to accept it, continue it, or throw it away.
 *
 * Everything here is derived from the event log plus git, and none of it is a
 * judgement the harness invents: `finished` means the agent called `finish`, and
 * the report says separately whether the checks agreed.
 */

import { checkOutcome, type CheckOutcome } from './checks.js';
import type { RunEvent, RunStatus, RunTotals } from './events.js';
import { elapsedSeconds, formatLimit, limitUse, type LimitUse } from './limits.js';
import { relNorm } from './paths.js';
import type { RunLimits } from './task.js';

/** The last result of each check the run ran. */
export interface CheckResult {
  name: string;
  /** Passed, failed, or could not be run at all. */
  outcome: CheckOutcome;
  /** Its output, trimmed to something a report can carry. */
  output: string;
  /**
   * Whether this was a profile check or a command the project declared.
   *
   * Kept apart because they are different kinds of evidence. A profile check is
   * something the harness was told to run and largely knows the shape of; a
   * declared command is the project's own verification, which is the strongest
   * thing here and used to be invisible. A run that verified its own work with
   * the project's test command reported "no check called ..." and nothing else,
   * which is the wrong story entirely.
   */
  kind: 'check' | 'command';
}

export interface RunReport {
  id: string;
  name: string;
  status: RunStatus;
  /** One sentence, the thing a person needs first. */
  headline: string;
  /** The task exactly as the agent was given it. */
  task: string;
  model: string;
  turns: number;
  totals: RunTotals;
  limits: RunLimits;
  /** Every cumulative limit, as used of budget. */
  used: LimitUse[];
  /** The limit that ended the run, when one did. */
  stoppedAt: LimitUse | null;
  /** The agent's own closing words, if it got that far. */
  claim: string | null;
  /**
   * Whether the checks back the claim up.
   *
   * Null when the agent never claimed anything. False when it said it was done
   * and the last thing a check said was that it was not.
   */
  claimSupported: boolean | null;
  /**
   * The files the agent said it changed, when it said so at all.
   *
   * Null is "it listed none", which is different from an empty list and is said
   * differently below.
   */
  claimed: string[] | null;
  /**
   * Claimed files that nothing in this run accounts for.
   *
   * The finding that made this exist: a run wrote "`ui/add.spec.ts` rewritten"
   * in its summary when the file had not changed at all, and the only way
   * anybody found out was reading the diff by hand at the gate. A file can also
   * change without a write call — a check that regenerates something did it in a
   * real run — so the wording is "nothing in this run accounts for it" and the
   * evidence checked is named on the report.
   */
  claimGaps: string[];
  /**
   * Files that changed and were not claimed.
   *
   * The benign direction — a run that mentions six of the eight files it touched
   * is being terse, not dishonest — so it is a note rather than a headline.
   */
  unclaimed: string[];
  /**
   * Lines added and removed, from the run's own write calls.
   *
   * Derived from what the run wrote rather than from git, for the same reason
   * `changed` is: it has to survive the worktree being committed or reset. It is
   * what makes `dsh stats` able to say what a run cost per line that landed,
   * which is the only cost figure that means anything.
   */
  lines: { added: number; removed: number };
  checks: CheckResult[];
  /** Files the run was allowed to change, for reference. */
  allowed: string[];
  /** Files the run's own write tools touched. See the note on `changed`. */
  changed: string[];
  /**
   * Files git sees a change in, read when the report was built.
   *
   * Deliberately separate from `changed`. `changed` comes from the run's own
   * tool calls, so it is what the run did and does not change afterwards; this
   * one is the worktree as it stands. They disagree whenever somebody reset the
   * tree or committed the work, and a reader is told when they do rather than
   * being shown one of them and left to guess.
   */
  onDisk: string[];
  /** Changed files that were not allowed. */
  stray: string[];
  /**
   * Changed files the task said it might need, which are outside its plan.
   *
   * Not a failure. Reported because a reader deciding whether to trust a run
   * should see that it grew past what it was asked to touch, and because the
   * alternative was to refuse the write and stop a run that was nearly done.
   */
  offPlan: string[];
  /** Files that were already changed when the run started, so not its doing. */
  preExisting: string[];
  /** Why the worktree could not be read, if it could not be. */
  strayFailure: string | null;
  /** Questions the run asked, and whether they were answered. */
  questions: { question: string; answer: string | null }[];
  /** True when the harness warned the agent before a limit, and how often. */
  warnings: number;
  /**
   * Which limits it was warned about, in the order they were first mentioned.
   *
   * A run that was warned and then chose to stop is a different story from one
   * that was stopped: the agent wrote its own summary and knew what it had not
   * done. "Warned once" does not say whether that was about turns or about
   * money, and the difference decides whether continuing is worth it.
   */
  warnedAbout: string[];
}

export interface ReportInput {
  id: string;
  name: string;
  status: RunStatus;
  model: string;
  task: string;
  allowed: string[];
  /**
   * The names of the commands this run's project declared.
   *
   * Needed rather than inferred. A first version of this treated "a tool result
   * that is not a read" as a declared command, which swept up `replace_in_file`
   * and `finish` and listed them as the run's verification — found by reading a
   * real report against a real run, and not findable any other way. What a
   * project declared is a fact the workspace file holds and nothing can work
   * out from the log alone.
   */
  commands?: string[];
  limits: RunLimits;
  turns: number;
  totals: RunTotals;
  summary: string | null;
  events: RunEvent[];
  /**
   * Files git sees a change in, read when the report was built.
   *
   * Two jobs. It is the fallback file list for a run whose log holds no writes,
   * and it is half of the claimed-versus-actual comparison: a file can change
   * with no write call behind it, because a check the run ran can regenerate
   * something. A real run reported a stray change the agent never made for
   * exactly that reason, so a claim that only the worktree backs up is honest
   * and the report must not call it a lie.
   */
  changed: string[];
  stray: string[];
  /** Files on the soft list that changed. See `RunReport.offPlan`. */
  offPlan?: string[];
  /** Files already changed when the run started. */
  preExisting?: string[];
  strayFailure: string | null;
}

/**
 * A limit's name as a person writes it.
 *
 * `costUsd` is a field name, and "the harness warned it about costUsd" is what
 * comes out otherwise.
 */
export function limitName(which: string): string {
  return which === 'costUsd' ? 'cost' : which;
}

/**
 * The headline, plus two things a `finished` run can still be hiding.
 *
 * **Over budget anyway.** A call's cost is only known once it has been paid for,
 * so the last turn of a run with a small dollar budget can carry it well past
 * the ceiling and call `finish` in the same turn. Measured live: a run told it
 * had a tenth of a cent left spent four times that on one long answer and
 * reported itself as finished, which is the one word a reader skims. Strictly
 * past, not merely at: reaching a limit exactly is the normal happy path, and
 * saying a run went over would be crying wolf on every run that finishes on its
 * last turn.
 *
 * **Files it says it changed, that nothing accounts for.** Measured: a run wrote
 * "`ui/add.spec.ts` rewritten" in its summary when the file had not changed, and
 * the only way anybody found out was reading the diff by hand at the gate. The
 * wording is careful — a file can change with no write call behind it, because a
 * check the run ran can regenerate something, and a real run did exactly that —
 * so it says what was checked rather than accusing.
 */
function withOverspend(status: RunStatus, text: string, used: LimitUse[], claimGaps: string[]): string {
  if (status !== 'finished') return text;
  const clauses: string[] = [];

  const over = used.filter((use) => use.used > use.budget);
  if (over.length > 0) {
    const them = over
      .map(
        (use) =>
          `${limitName(use.which)} budget (${formatLimit(use.which, use.used)} of ${formatLimit(use.which, use.budget)})`,
      )
      .join(' and ');
    clauses.push(`It went past its ${them} on the way`);
  }

  if (claimGaps.length > 0) {
    clauses.push(
      `It says it changed ${claimGaps.join(', ')}, and nothing in this run accounts for ` +
        `${claimGaps.length === 1 ? 'that file' : 'those files'} changing: no write that succeeded, ` +
        `and no change in the worktree now`,
    );
  }

  if (clauses.length === 0) return text;
  return `${text} ${clauses.join('. ')}. Judge the claim below in that light.`;
}

export function buildReport(input: ReportInput): RunReport {
  const checks = lastCheckOutcomes(input.events, input.commands ?? []);
  const questions = askedQuestions(input.events);
  const writes = writesOf(input.events);
  const written = [...writes.keys()].sort();
  const claimed = claimedFiles(input.events);
  const finished = claimed !== null;
  // Everything this run has an explanation for: a write it made, or a change
  // visible in the worktree that was not already there when it started.
  const accounted = new Set([...written, ...input.changed]);
  const claimGaps = finished ? (claimed as string[]).filter((file) => !accounted.has(relNorm(file))) : [];
  const unclaimed = finished ? written.filter((file) => !(claimed as string[]).includes(file)) : [];
  const warnings = input.events.filter((event) => event.type === 'warning').length;
  const warnedAbout = [
    ...new Set(
      input.events.filter((event) => event.type === 'warning').map((event) => limitName(event.which)),
    ),
  ];
  const stopped = [...input.events].reverse().find((event) => event.type === 'limit');

  const used = limitUse(
    {
      turns: input.turns,
      // From the events, so the wall clock stops when the run did rather than
      // growing for as long as nobody looks at it.
      elapsedSeconds: elapsedBetween(input.events),
      totals: input.totals,
    },
    input.limits,
  );
  const stoppedAt: LimitUse | null =
    stopped === undefined || stopped.type !== 'limit'
      ? null
      : {
          which:
            stopped.which === 'contextTokens' || stopped.which === 'askSeconds' ? 'turns' : stopped.which,
          used: stopped.used,
          budget: stopped.budget,
          remaining: Math.max(0, stopped.budget - stopped.used),
          ratio: stopped.budget > 0 ? stopped.used / stopped.budget : 1,
        };

  const failed = checks.filter((check) => check.outcome === 'fail');
  const claim = input.summary === null || input.summary === '' ? null : input.summary;

  return {
    id: input.id,
    name: input.name,
    status: input.status,
    headline: withOverspend(input.status, headline(input, checks, failed, stopped), used, claimGaps),
    task: input.task,
    model: input.model,
    turns: input.turns,
    totals: input.totals,
    limits: input.limits,
    used,
    // A limit that stopped the run is already in `used`; this is the same row,
    // named, so a reader does not have to compare every row to a ceiling.
    stoppedAt: stopped === undefined ? null : stoppedAt,
    claim,
    claimSupported: claim === null ? null : failed.length === 0,
    claimed,
    claimGaps,
    unclaimed,
    lines: lineCounts(writes),
    checks,
    allowed: input.allowed,
    changed: written.length > 0 ? written : input.changed,
    onDisk: input.changed,
    stray: input.stray,
    offPlan: input.offPlan ?? [],
    preExisting: input.preExisting ?? [],
    strayFailure: input.strayFailure,
    questions,
    warnings,
    warnedAbout,
  };
}

/**
 * One sentence.
 *
 * Written to lead with the thing that went wrong rather than the thing that
 * happened last, because a run that spent forty turns on a repo and then ran out
 * of budget is not a run that "said something at the end".
 */
function headline(
  input: ReportInput,
  checks: CheckResult[],
  failed: CheckResult[],
  stopped: RunEvent | undefined,
): string {
  const turns = `${input.turns} turn${input.turns === 1 ? '' : 's'}`;
  if (input.status === 'stopped_at_limit' && stopped?.type === 'limit') {
    return (
      `STOPPED at the ${limitName(stopped.which)} limit after ${turns} ` +
      `(${formatLimit(stopped.which, stopped.used)} of ${formatLimit(stopped.which, stopped.budget)}). ` +
      `The work is partial: judge it as unfinished, not as a change to review.`
    );
  }
  if (input.status === 'failed') {
    return `FAILED after ${turns}: ${input.summary ?? 'no summary'}`;
  }
  if (input.status === 'cancelled') return `CANCELLED after ${turns}.`;
  if (input.status === 'interrupted') {
    return `INTERRUPTED after ${turns}: the daemon went away mid-run, so nothing here was finished or cleaned up.`;
  }
  if (input.status === 'finished' && failed.length > 0) {
    return (
      `Finished after ${turns}, but its last run of ${failed.map((check) => check.name).join(', ')} ` +
      `did NOT pass, so the claim below is not backed by a check.`
    );
  }
  if (input.status === 'finished' && checks.length === 0) {
    return `Finished after ${turns}, and ran no checks, so nothing verified it.`;
  }
  if (input.status === 'finished' && checks.every((check) => check.outcome === 'unavailable')) {
    // Only checks that could not be run. Saying "every check it ran passed" over
    // an empty set of real results would be true and completely misleading.
    return `Finished after ${turns}, but not one of its checks could be run, so nothing verified it.`;
  }
  if (input.status === 'finished') {
    return `Finished after ${turns}, and every check it ran passed.`;
  }
  if (input.status === 'running' || input.status === 'queued' || input.status === 'waiting') {
    return `Still going, ${turns} in.`;
  }
  return `Ended after ${turns} as ${input.status}.`;
}

/**
 * The last result of each check and each declared command the run ran.
 *
 * `commandNames` is what the run's project declared, passed in rather than
 * worked out. A first version of this called "a tool result that is not a read"
 * a declared command, which swept up `replace_in_file` and `finish` and listed
 * them as the run's verification — found by reading a real report against a real
 * run, and not findable any other way. What a project declared is a fact the
 * workspace file holds and nothing else can infer.
 */
function lastCheckOutcomes(events: RunEvent[], commandNames: string[]): CheckResult[] {
  const declared = new Set(commandNames);
  const names = new Map<string, { name: string; kind: 'check' | 'command' }>();
  for (const event of events) {
    if (event.type !== 'tool.call') continue;
    if (event.name === 'run_check') {
      const args = event.args as { name?: unknown } | null;
      const name = typeof args?.name === 'string' ? args.name : '(unnamed)';
      names.set(event.id, { name, kind: 'check' });
      continue;
    }
    if (declared.has(event.name)) names.set(event.id, { name: event.name, kind: 'command' });
  }

  const order: string[] = [];
  const latest = new Map<string, CheckResult>();
  for (const event of events) {
    if (event.type !== 'tool.result') continue;
    const called = names.get(event.id);
    if (called === undefined) continue;
    const key = `${called.kind}:${called.name}`;
    if (!order.includes(key)) order.push(key);
    latest.set(key, {
      name: called.name,
      kind: called.kind,
      outcome: checkOutcome(event.result),
      output: trim(event.result),
    });
  }
  return order.map((key) => latest.get(key)).filter((entry): entry is CheckResult => entry !== undefined);
}

/**
 * The files the run's own write tools changed, with how much of each.
 *
 * Read from the events rather than from git, and that is the point. A report
 * built later asked git what had changed, so a worktree that had been reset or
 * committed in between reported nothing at all — the run's own record of two
 * edited files, replaced by the current state of a directory. Measured: a
 * finished run whose two edits had since been reverted reported "nothing
 * changed" and an empty file list.
 *
 * Only writes that **succeeded**. A `replace_in_file` whose old text did not
 * match changed nothing, and a run whose only attempt on a file was refused used
 * to be reported as having changed it.
 *
 * Falls back to git only when the log has no writes in it, so a run that wrote
 * something in a way not modelled here is still described rather than empty.
 */
function writesOf(events: RunEvent[]): Map<string, { added: number; removed: number }> {
  const attempts = new Map<string, { path: string; added: number; removed: number }>();
  for (const event of events) {
    if (event.type !== 'tool.call') continue;
    if (event.name !== 'replace_in_file' && event.name !== 'create_file') continue;
    const args = event.args as { path?: unknown; old?: unknown; new?: unknown; content?: unknown } | null;
    if (typeof args?.path !== 'string') continue;
    attempts.set(event.id, { path: relNorm(args.path), ...changedLines(event.name, args) });
  }

  const done = new Map<string, { added: number; removed: number }>();
  for (const event of events) {
    if (event.type !== 'tool.result') continue;
    const attempt = attempts.get(event.id);
    // `ok` is false for a refusal and for a failed match, and neither changed a
    // byte on disk.
    if (attempt === undefined || !event.ok) continue;
    const already = done.get(attempt.path);
    done.set(attempt.path, {
      added: (already?.added ?? 0) + attempt.added,
      removed: (already?.removed ?? 0) + attempt.removed,
    });
  }
  return done;
}

/** How many lines one write added and removed, from the text it was given. */
function changedLines(
  tool: string,
  args: { old?: unknown; new?: unknown; content?: unknown },
): { added: number; removed: number } {
  const count = (value: unknown): number =>
    typeof value === 'string' && value !== '' ? value.split('\n').length : 0;
  if (tool === 'create_file') return { added: count(args.content), removed: 0 };
  return { added: count(args.new), removed: count(args.old) };
}

function lineCounts(writes: Map<string, { added: number; removed: number }>): {
  added: number;
  removed: number;
} {
  let added = 0;
  let removed = 0;
  for (const entry of writes.values()) {
    added += entry.added;
    removed += entry.removed;
  }
  return { added, removed };
}

/**
 * The files the agent listed in `finish`, or null when it listed none.
 *
 * The last summary event wins, because there is one `finish` and a later one
 * would be the agent correcting itself.
 */
function claimedFiles(events: RunEvent[]): string[] | null {
  const summaries = events.filter((event) => event.type === 'summary');
  const last = summaries[summaries.length - 1];
  if (last === undefined || last.type !== 'summary') return null;
  const changed = last.changed;
  if (changed === undefined || changed.length === 0) return null;
  return [...new Set(changed.map((file) => relNorm(file)))].sort();
}

function askedQuestions(events: RunEvent[]): { question: string; answer: string | null }[] {
  const asked = new Map<string, { question: string; answer: string | null }>();
  for (const event of events) {
    if (event.type === 'question') asked.set(event.id, { question: event.question, answer: null });
    if (event.type === 'answer') {
      const entry = asked.get(event.id);
      if (entry !== undefined) entry.answer = event.answer;
    }
  }
  return [...asked.values()];
}

/** How long the event log spans, which is the run's own wall clock. */
function elapsedBetween(events: RunEvent[]): number {
  const first = events[0]?.at;
  const last = events[events.length - 1]?.at;
  if (first === undefined || last === undefined) return 0;
  return elapsedSeconds({ startedAt: first, endedAt: last });
}

function trim(text: string): string {
  const clean = text.trim();
  return clean.length > 600 ? `${clean.slice(0, 600)}\n[...]` : clean;
}
