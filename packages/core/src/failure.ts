/**
 * Why a call failed, in a form a launcher can branch on.
 *
 * The distinction that earns this file: **an account with no money on it and a
 * model that answered badly both look like `failed`**. One of them means stop
 * launching, and the other means try again, and an orchestrator that cannot tell
 * them apart will keep starting runs against a dead account — each one failing
 * after a few seconds, for as long as somebody leaves it running. Telling them
 * apart in prose is not telling them apart.
 *
 * So the causes are a closed set, they ride on the terminal `status` event where
 * a launcher already looks, and the CLI turns one of them into an exit code.
 *
 * Nothing here matches on a message a human wrote. The HTTP status is checked
 * first, and the text only as a fallback, because the one thing worth knowing
 * for certain is that DeepSeek answered `402`.
 */

import { DeepSeekError } from './deepseek.js';
import type { FailureCause } from './events.js';

/**
 * Phrases that mean "the account is out of money", when the status is not enough.
 *
 * Deliberately narrow. Every one of these is unambiguous on its own, and nothing
 * as loose as a bare `/balance/` is here: a 400 whose body happens to contain
 * the word would then stop a launcher over a request the provider refused for
 * some other reason entirely, which is a worse outcome than missing the case
 * this exists for. A missed one keeps failing loudly; a false one stops work
 * that would have carried on.
 */
const BALANCE_HINTS = [
  /insufficient\s+balance/i,
  /insufficient\s+quota/i,
  /insufficient\s+funds/i,
  /no\s+credit/i,
  /account\s+has\s+no\s+money/i,
];

/** And the same for a key the provider will not accept. */
const AUTH_HINTS = [
  /invalid\s+api\s*key/i,
  /api\s*key\s+is\s+(invalid|missing)/i,
  /authentication\s+fails?/i,
];

/**
 * What a model call's failure was.
 *
 * `status === 0` is the client's own code for "no answer at all", which after
 * its retries is a network failure rather than a refusal.
 */
export function causeOf(error: unknown): FailureCause {
  if (error instanceof DeepSeekError) {
    if (error.status === 402) return 'provider_balance';
    if (error.status === 401 || error.status === 403) return 'provider_auth';
    if (error.status === 0) return 'provider_unreachable';
    // A 400 is the model asking for something that is not allowed, which is a
    // refusal rather than an outage, and it is not retryable for that reason.
    // The text is consulted only here: DeepSeek answers a spent account with 400
    // rather than 402 in some cases, and "Insufficient Balance" is worth catching
    // wherever it arrives.
    if (BALANCE_HINTS.some((hint) => hint.test(error.message))) return 'provider_balance';
    if (AUTH_HINTS.some((hint) => hint.test(error.message))) return 'provider_auth';
    if (error.status === 400 || error.status === 404 || error.status === 422) return 'provider_refused';
    if (error.status >= 500) return 'provider_unreachable';
    return 'provider_refused';
  }
  // Anything else came from the harness: a worktree that is not a git checkout,
  // a sandbox refusal, a bug. Not the provider's fault and not a reason to stop
  // launching.
  return 'harness';
}

/** Whether a cause means "do not start another run until somebody looks". */
export function needsAttention(cause: FailureCause | undefined): boolean {
  return cause === 'provider_balance' || cause === 'provider_auth';
}

/** How a cause is said to a person. */
export function describeCause(cause: FailureCause): string {
  switch (cause) {
    case 'provider_balance':
      return 'the DeepSeek account has no credit left';
    case 'provider_auth':
      return 'DeepSeek refused the key';
    case 'provider_refused':
      return 'DeepSeek refused the request';
    case 'provider_unreachable':
      return 'DeepSeek could not be reached';
    case 'harness':
      return 'the harness failed';
  }
}
