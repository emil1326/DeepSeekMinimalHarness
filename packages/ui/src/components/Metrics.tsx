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
 * those four answer the only question worth asking at a glance: is this moving,
 * and is it cheap. End-to-end speed and the exact prompt/completion split are
 * real and worth keeping, but they are for later, so they sit one click in
 * rather than making a nine-item row nobody reads.
 */
export function MetricsStrip({ call, totals }: { call: CallMetrics | null; totals: RunTotals }) {
  const generation = call?.generationTokensPerSecond ?? totals.generationTokensPerSecond;
  const firstToken = call?.timeToFirstTokenMs ?? totals.timeToFirstTokenMs;
  const endToEnd = call?.endToEndTokensPerSecond ?? totals.endToEndTokensPerSecond;

  return (
    <details className="metrics">
      <summary className="metrics-strip">
        <Metric label="first token" value={seconds(firstToken)} />
        <Metric label="generating" value={speed(generation)} />
        <Metric label="cache" value={hitRate(totals.promptTokens, totals.cacheHitTokens)} />
        <Metric label="tokens" value={tokens(totals.promptTokens + totals.completionTokens)} />
        {totals.costUsd !== null && <Metric label="cost" value={money(totals.costUsd)} />}
      </summary>
      <dl className="metrics-strip metrics-more">
        <Metric label="end to end" value={speed(endToEnd)} />
        <Metric label="sent" value={tokens(totals.promptTokens)} />
        <Metric label="written" value={tokens(totals.completionTokens)} />
        <Metric label="from cache" value={tokens(totals.cacheHitTokens)} />
        <Metric label="calls" value={String(totals.calls)} />
        {totals.costUsd !== null && <Metric label="cost" value={money(totals.costUsd)} />}
      </dl>
    </details>
  );
}
