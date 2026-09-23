import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { tokens } from '../format';
import type { RunTotals, RunLimits, RunStatus } from '../types';

/**
 * The four budgets that accumulate, and how much of each is gone.
 *
 * Before this there was no way to see them from the UI at all. A run that read a
 * large repository reported "6m tokens" and nothing to compare it to, so the
 * question anybody actually has — how much room is left, and will it stop before
 * it finishes — could not be answered from anywhere but the task file.
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
  status,
}: {
  runId: string;
  turns: number;
  totals: RunTotals;
  limits: RunLimits;
  status: RunStatus;
}) {
  const queryClient = useQueryClient();
  const [extra, setExtra] = useState('20');

  const grant = useMutation({
    mutationFn: (patch: Record<string, number>) => api.setLimits(runId, patch),
    onSuccess: () => void queryClient.invalidateQueries(),
  });

  const live = status === 'running' || status === 'waiting' || status === 'queued';
  const rows: { label: string; used: number; budget: number }[] = [
    { label: 'turns', used: turns, budget: limits.turns },
    { label: 'billed tokens', used: totals.billedTokens, budget: limits.totalTokens },
    { label: 'output tokens', used: totals.completionTokens, budget: limits.outputTokens },
  ];

  return (
    <div className="limits">
      {rows.map((row) => {
        const ratio = row.budget > 0 ? row.used / row.budget : 1;
        return (
          <div className="limit-row" key={row.label}>
            <span className="limit-name">{row.label}</span>
            <span className="limit-bar" aria-hidden="true">
              <span
                className="limit-fill"
                data-tone={ratio >= 0.8 ? 'warn' : 'ok'}
                style={{ width: `${Math.min(100, Math.round(ratio * 100))}%` }}
              />
            </span>
            <span className="limit-numbers">
              {tokens(row.used)} of {tokens(row.budget)}
            </span>
          </div>
        );
      })}

      <div className="limit-row dim">
        <span className="limit-name">prompt sent</span>
        <span className="limit-bar" aria-hidden="true" />
        <span className="limit-numbers">
          {tokens(totals.promptTokens)}
          <span className="quiet">
            {' '}
            · {tokens(totals.cacheHitTokens)} from cache, billed at about a tenth
          </span>
        </span>
      </div>

      {live && (
        <div className="limit-grant">
          <label>
            grant
            <input
              type="number"
              min={1}
              value={extra}
              onChange={(event) => setExtra(event.target.value)}
              aria-label="turns to add"
            />
            more turns
          </label>
          <button
            onClick={() => grant.mutate({ turns: limits.turns + Number(extra || '0') })}
            disabled={grant.isPending || Number(extra) <= 0}
            title="The agent is told at its next turn boundary, and picks the new budget up on the next model call."
          >
            grant
          </button>
          {grant.isError && <span className="quiet">{(grant.error as Error).message}</span>}
        </div>
      )}
    </div>
  );
}
