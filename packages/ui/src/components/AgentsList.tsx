import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { durationOf, money, shortPath, speed, tokens } from '../format';
import { isTerminal, type RunSummary } from '../types';
import { StatusPill } from './Status';

export function AgentsList({ onOpen }: { onOpen: (runId: string) => void }) {
  const runs = useQuery({ queryKey: ['runs'], queryFn: api.runs, refetchInterval: 5000 });
  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats, refetchInterval: 15_000 });

  if (runs.isPending) return <div className="empty">loading…</div>;
  if (runs.isError)
    return <div className="empty">the daemon did not answer: {(runs.error as Error).message}</div>;
  if (runs.data.length === 0) {
    return (
      <div className="empty">
        <h2>No runs yet</h2>
        <p>Start one from a shell, and watch it here.</p>
        <pre>dsh run task.json</pre>
      </div>
    );
  }

  const models = stats.data?.models ?? [];
  const going = runs.data.filter((run) => !isTerminal(run.status)).length;
  // Cost is only worth a column once a price table has been filled in; a column
  // of dashes is a column of nothing.
  const anyCost = runs.data.some((run) => run.totals.costUsd !== null);
  // A model run under two measurement methods has two rows. Name the method only
  // when that is the case, so the usual one reads as plain as it always did.
  const methodCount = new Map<string, number>();
  for (const model of models) methodCount.set(model.model, (methodCount.get(model.model) ?? 0) + 1);

  return (
    <div className="scroller">
      <div className="section-head">
        <h1>Agents</h1>
        <span className="sub">
          {runs.data.length} run{runs.data.length === 1 ? '' : 's'}
          {going > 0 ? ` · ${going} going` : ''}
        </span>
      </div>

      {models.length > 0 && (
        <div className="stat-row">
          {models.map((model) => (
            /* A line of facts, not a hero metric. The number matters but it is
               not the point of the page, so it sits at the same size as its
               own label. */
            <div className="stat" key={`${model.model}:${model.metricsVersion}`}>
              <span className="who">
                {model.model}
                {(methodCount.get(model.model) ?? 0) > 1 ? ` m${model.metricsVersion}` : ''}
              </span>
              <span className="value">{speed(model.generationTokensPerSecond)}</span>
              <span className="label">generating</span>
              <span className="sep">·</span>
              <span className="value">{model.calls}</span>
              <span className="label">calls</span>
              <span className="sep">·</span>
              <span className="value">{tokens(model.promptTokens + model.completionTokens)}</span>
              <span className="label">tokens</span>
              {model.costUsd !== null && (
                <>
                  <span className="sep">·</span>
                  <span className="value">{money(model.costUsd)}</span>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="pane">
        <table className="runs">
          <thead>
            <tr>
              <th>Run</th>
              <th>Status</th>
              <th style={{ textAlign: 'right' }}>Turns</th>
              <th style={{ textAlign: 'right' }}>Speed</th>
              <th style={{ textAlign: 'right' }}>Tokens</th>
              {anyCost && <th style={{ textAlign: 'right' }}>Cost</th>}
              <th style={{ textAlign: 'right' }}>Took</th>
            </tr>
          </thead>
          <tbody>
            {runs.data.map((run) => (
              <Row key={run.id} run={run} onOpen={onOpen} showCost={anyCost} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Row({
  run,
  onOpen,
  showCost,
}: {
  run: RunSummary;
  onOpen: (runId: string) => void;
  showCost: boolean;
}) {
  return (
    <tr
      onClick={() => onOpen(run.id)}
      tabIndex={0}
      onKeyDown={(event) => event.key === 'Enter' && onOpen(run.id)}
    >
      {/* The model and the worktree are context for the name, not columns of
          their own: a full temp path in its own cell is the widest thing on
          the page and tells you nothing at a glance. */}
      <td className="name">
        <span className="title">{run.name}</span>
        <span className="under mono" title={run.worktree}>
          {run.model} · {shortPath(run.worktree)}
        </span>
      </td>
      <td>
        <StatusPill status={run.status} detail={run.detail} />
      </td>
      <td className="num">{run.turns}</td>
      <td className="num">
        {run.totals.generationTokensPerSecond === null
          ? '-'
          : run.totals.generationTokensPerSecond.toFixed(0)}
      </td>
      <td className="num">{tokens(run.totals.completionTokens)}</td>
      {showCost && <td className="num">{money(run.totals.costUsd)}</td>}
      <td className="num">{durationOf(run.startedAt, run.endedAt)}</td>
    </tr>
  );
}
