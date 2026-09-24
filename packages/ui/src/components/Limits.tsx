import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { compactLimit, tokens } from '../format';
import type { RunTotals, RunLimits, RunStatus } from '../types';

/**
 * The budgets that accumulate, and how much of each is gone.
 *
 * Before this there was no way to see them from the UI at all. A run that read a
 * large repository reported "6m tokens" and nothing to compare it to, so the
 * question anybody actually has — how much room is left, and will it stop before
 * it finishes — could not be answered from anywhere but the task file.
 *
 * Drawn as a ring per budget rather than as a row of bars. The bar version put
 * the label at the far left and the numbers at the far right of a wide column,
 * so comparing two of them meant reading across two spans of empty space, and
 * the one thing worth knowing — the fraction — was a 3px line that was hard to
 * see and impossible to compare at a glance. A ring with `6/12` inside it says
 * the same thing in a square inch, and five of them sit in a row like gauges.
 *
 * `totalTokens` is billed tokens: prompt cache misses plus output. A real run on
 * this machine sent 7.96M prompt tokens of which 7.83M were cache hits, and was
 * stopped by a 2M budget it had not really spent. Showing prompt tokens here
 * would repeat that mistake in the interface.
 */
export function Limits({
  runId,
  turns,
  totals,
  limits,
  wallSeconds,
  priced,
  status,
}: {
  runId: string;
  turns: number;
  totals: RunTotals;
  limits: RunLimits;
  /**
   * The run's own wall clock, which only the caller can measure: it is the gap
   * between two stored timestamps rather than a number the daemon counts.
   */
  wallSeconds: number;
  /** Whether the run's model had a price. False means there is no cost to show. */
  priced: boolean;
  status: RunStatus;
}) {
  const queryClient = useQueryClient();
  const [moreTurns, setMoreTurns] = useState('20');
  const [moreCost, setMoreCost] = useState('');

  const grant = useMutation({
    mutationFn: (patch: Record<string, number>) => api.setLimits(runId, patch),
    onSuccess: () => void queryClient.invalidateQueries(),
  });

  const live = status === 'running' || status === 'waiting' || status === 'queued';
  const cost = totals.costUsd;
  const showCost = priced && typeof limits.costUsd === 'number' && limits.costUsd > 0 && cost !== null;

  const dials: { which: string; label: string; used: number; budget: number }[] = [
    { which: 'turns', label: 'turns', used: turns, budget: limits.turns },
    ...(showCost ? [{ which: 'costUsd', label: 'cost', used: cost, budget: limits.costUsd }] : []),
    { which: 'totalTokens', label: 'billed tokens', used: totals.billedTokens, budget: limits.totalTokens },
    {
      which: 'outputTokens',
      label: 'output tokens',
      used: totals.completionTokens,
      budget: limits.outputTokens,
    },
    { which: 'wallSeconds', label: 'wall clock', used: wallSeconds, budget: limits.wallSeconds },
  ];

  // Absolute figures, not deltas: two grants in a row cannot compound by
  // accident if the same message ever gets delivered twice.
  const wantedTurns = Number(moreTurns);
  const wantedCost = Number(moreCost);
  const patch: Record<string, number> = {};
  if (moreTurns.trim() !== '' && Number.isFinite(wantedTurns) && wantedTurns > 0) {
    patch.turns = limits.turns + wantedTurns;
  }
  if (moreCost.trim() !== '' && Number.isFinite(wantedCost) && wantedCost > 0) {
    // Rounded to a millionth, because adding five cents to a float budget is how
    // one ends up shown as 0.15000000000000002.
    patch.costUsd = Math.round(((limits.costUsd ?? 0) + wantedCost) * 1e6) / 1e6;
  }

  return (
    <div className="limits">
      <div className="rings">
        {dials.map((dial) => (
          <Ring key={dial.which} {...dial} />
        ))}
      </div>

      <div className="limits-foot">
        <span className="quiet">
          {tokens(totals.promptTokens)} prompt tokens sent · {tokens(totals.cacheHitTokens)} from cache
        </span>
        <span className="push" />
        {live && (
          <span className="limit-grant">
            <label>
              grant
              <input
                type="number"
                min={1}
                value={moreTurns}
                onChange={(event) => setMoreTurns(event.target.value)}
                aria-label="more turns"
              />
              turns
            </label>
            <label>
              <input
                type="number"
                min={0}
                step={0.01}
                placeholder="0.05"
                value={moreCost}
                onChange={(event) => setMoreCost(event.target.value)}
                aria-label="more dollars"
                className="wide"
              />
              dollars
            </label>
            <button
              onClick={() => grant.mutate(patch)}
              disabled={grant.isPending || Object.keys(patch).length === 0}
              title="The agent is told at its next turn boundary, and picks the new budget up on the next model call."
            >
              grant
            </button>
            {grant.isError && <span className="quiet">{(grant.error as Error).message}</span>}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * One budget: a ring that fills as it is used, with `used/budget` inside it.
 *
 * The ring is the fraction and the text is the amount, so neither has to do the
 * other's job. It turns amber at four fifths — the same threshold the agent is
 * warned at, so the page and the agent agree about when a run is in trouble —
 * and red once a budget has actually been gone past.
 *
 * Past, not merely at. Using a budget exactly is the normal happy path: a
 * four-turn run that finishes on its fourth turn has used all four of its turns,
 * and a red ring on it would be an alarm about nothing — which is how a person
 * learns to ignore the colour. Only a limit that was exceeded is a mistake.
 */
function Ring({
  which,
  label,
  used,
  budget,
}: {
  which: string;
  label: string;
  used: number;
  budget: number;
}) {
  const ratio = budget > 0 ? used / budget : 1;
  const tone = ratio > 1 ? 'over' : ratio >= 0.8 ? 'near' : 'ok';

  const size = 60;
  const stroke = 3.5;
  const radius = (size - stroke) / 2;
  const around = 2 * Math.PI * radius;
  // Clamped, so a run that went past its budget draws a full ring rather than an
  // arc that laps itself.
  const filled = Math.min(1, Math.max(0, ratio)) * around;
  const stated = `${label} ${compactLimit(which, used)} of ${compactLimit(which, budget)}`;

  return (
    <div className="ring" data-tone={tone}>
      <div className="ring-dial">
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={stated}>
          <title>{stated}</title>
          <circle className="ring-track" cx={size / 2} cy={size / 2} r={radius} strokeWidth={stroke} />
          <circle
            className="ring-arc"
            cx={size / 2}
            cy={size / 2}
            r={radius}
            strokeWidth={stroke}
            strokeDasharray={`${filled} ${around - filled}`}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        </svg>
        {/* The fraction, stacked. Side by side, `$0.0005/$0.0030` is twice as
            wide as the ring and runs into the one next to it; on two lines both
            halves fit inside, and it still reads as a fraction because of the
            slash rather than in spite of it. */}
        <span className="ring-read">
          <b>{compactLimit(which, used)}</b>
          <span>
            <i>/</i>
            {compactLimit(which, budget)}
          </span>
        </span>
      </div>
      <span className="ring-label">{label}</span>
    </div>
  );
}
