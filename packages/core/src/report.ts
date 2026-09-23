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

import { checkPassed } from './checks.js';
import type { RunEvent, RunStatus, RunTotals } from './events.js';
import { limitUse, type LimitUse } from './limits.js';
import type { RunLimits } from './task.js';

/** The last result of each check the run ran. */
export interface CheckOutcome {
  name: string;
  /** Whether the check's own output says it passed. */
  passed: boolean;
  /** Its output, trimmed to something a report can carry. */
  output: string;
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
  checks: CheckOutcome[];
  /** Files the run was allowed to change, for reference. */
  allowed: string[];
  /** Files git says actually changed. */
  changed: string[];
  /** Changed files that were not allowed. */
  stray: string[];
  /** Why the worktree could not be read, if it could not be. */
  strayFailure: string | null;
  /** Questions the run asked, and whether they were answered. */
  questions: { question: string; answer: string | null }[];
  /** True when the harness warned the agent before a limit, and how often. */
  warnings: number;
}

export interface ReportInput {
  id: string;
  name: string;
  status: RunStatus;
  model: string;
  task: string;
  allowed: string[];
  limits: RunLimits;
  turns: number;
  totals: RunTotals;
  summary: string | null;
  events: RunEvent[];
  changed: string[];
  stray: string[];
  strayFailure: string | null;
}

export function buildReport(input: ReportInput): RunReport {
  const checks = lastCheckOutcomes(input.events);
  const questions = askedQuestions(input.events);
  const warnings = input.events.filter((event) => event.type === 'warning').length;
  const stopped = [...input.events].reverse().find((event) => event.type === 'limit');

  const used = limitUse(
    {
      turns: input.turns,
      elapsedSeconds: elapsedSecondsOf(input.events),
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
          ratio: stopped.budget > 0 ? stopped.used / stopped.budget : 1,
        };

  const failed = checks.filter((check) => !check.passed);
  const claim = input.summary === null || input.summary === '' ? null : input.summary;

  return {
    id: input.id,
    name: input.name,
    status: input.status,
    headline: headline(input, checks, failed, stopped),
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
    checks,
    allowed: input.allowed,
    changed: input.changed,
    stray: input.stray,
    strayFailure: input.strayFailure,
    questions,
    warnings,
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
  checks: CheckOutcome[],
  failed: CheckOutcome[],
  stopped: RunEvent | undefined,
): string {
  const turns = `${input.turns} turn${input.turns === 1 ? '' : 's'}`;
  if (input.status === 'stopped_at_limit' && stopped?.type === 'limit') {
    return `STOPPED at the ${stopped.which} limit after ${turns} (${stopped.used} of ${stopped.budget}). The work is partial: judge it as unfinished, not as a change to review.`;
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
  if (input.status === 'finished') {
    return `Finished after ${turns}, and every check it ran passed.`;
  }
  if (input.status === 'running' || input.status === 'queued' || input.status === 'waiting') {
    return `Still going, ${turns} in.`;
  }
  return `Ended after ${turns} as ${input.status}.`;
}

/** The last result of each check, in the order the checks were first run. */
function lastCheckOutcomes(events: RunEvent[]): CheckOutcome[] {
  const names = new Map<string, { name: string; callId: string }>();
  for (const event of events) {
    if (event.type !== 'tool.call' || event.name !== 'run_check') continue;
    const args = event.args as { name?: unknown } | null;
    const name = typeof args?.name === 'string' ? args.name : '(unnamed)';
    names.set(event.id, { name, callId: event.id });
  }
  const order: string[] = [];
  const latest = new Map<string, CheckOutcome>();
  for (const event of events) {
    if (event.type !== 'tool.result') continue;
    const called = names.get(event.id);
    if (called === undefined) continue;
    if (!order.includes(called.name)) order.push(called.name);
    latest.set(called.name, {
      name: called.name,
      passed: checkPassed(event.result),
      output: trim(event.result),
    });
  }
  return order.map((name) => latest.get(name)).filter((entry): entry is CheckOutcome => entry !== undefined);
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

function elapsedSecondsOf(events: RunEvent[]): number {
  const first = events[0]?.at;
  const last = events[events.length - 1]?.at;
  if (first === undefined || last === undefined) return 0;
  return Math.max(0, (Date.parse(last) - Date.parse(first)) / 1000);
}

function trim(text: string): string {
  const clean = text.trim();
  return clean.length > 600 ? `${clean.slice(0, 600)}\n[...]` : clean;
}
