import type { CallMetrics, RunTotals } from '../types';
import { hitRate, money, seconds, speed, tokens } from '../format';

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/**
 * The passive speed numbers for one run.
 *
 * Four on the surface, because four is about what a person holds at once, and
 * they answer the only question worth asking at a glance: is this moving, and
 * is it cheap. Everything else is one click in.
 *
 * "Speed" is output tokens over the whole call. That is the number a vendor
 * advertises and the one that answers "how long did this take". The decode-only
 * figure is in the detail list and is deliberately not the headline: measured
 * against the live API, one call spent 6.7 s waiting for its first token and
 * 1.2 s decoding, so quoting the decode rate would claim 1229 tokens a second
 * for a call that delivered 183.
 */
export function MetricsStrip({ call, totals }: { call: CallMetrics | null; totals: RunTotals }) {
  const whole = call?.endToEndTokensPerSecond ?? totals.endToEndTokensPerSecond;
  const firstToken = call?.timeToFirstTokenMs ?? totals.timeToFirstTokenMs;
  const decode = call?.generationTokensPerSecond ?? totals.generationTokensPerSecond;
  const said = Math.max(0, totals.completionTokens - totals.reasoningTokens);

  return (
    <details className="metrics">
      <summary className="metrics-strip">
        <Metric label="first token" value={seconds(firstToken)} />
        <Metric label="speed" value={speed(whole)} />
        <Metric label="cache" value={hitRate(totals.promptTokens, totals.cacheHitTokens)} />
        <Metric label="tokens" value={tokens(totals.promptTokens + totals.completionTokens)} />
        {totals.costUsd !== null && <Metric label="cost" value={money(totals.costUsd)} />}
      </summary>
      <dl className="metrics-strip metrics-more">
        <Metric label="said" value={tokens(said)} />
        {totals.reasoningTokens > 0 && (
          <Metric label="thought, not said" value={tokens(totals.reasoningTokens)} />
        )}
        <Metric label="sent" value={tokens(totals.promptTokens)} />
        <Metric label="from cache" value={tokens(totals.cacheHitTokens)} />
        <Metric label="calls" value={String(totals.calls)} />
        {/* Reported only when the stream spanned enough to measure one, which is
            not always: a bursty tool-call turn cannot say. */}
        {decode !== null && <Metric label="decode only" value={speed(decode)} />}
        {totals.costUsd !== null && <Metric label="cost" value={money(totals.costUsd)} />}
      </dl>
    </details>
  );
}
