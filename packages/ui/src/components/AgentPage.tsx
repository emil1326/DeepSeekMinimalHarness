import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { durationOf, shortPath, statusWord } from '../format';
import { isTerminal } from '../types';
import { Chat } from './Chat';
import { ConfigView } from './Config';
import { DiffView } from './Diff';
import { Limits } from './Limits';
import { MetricsStrip } from './Metrics';
import { Report } from './Report';
import { StatusPill, TagPill } from './Status';
import { Timings } from './Timings';

type Tab = 'chat' | 'report' | 'config' | 'diff' | 'timing';

/**
 * How long the run has been going, in seconds, for the wall-clock ring.
 *
 * To the run's own end when it has one, and to now only while it is still
 * going: a finished run's clock must not keep climbing while nobody is looking
 * at it, which is how the CLI came to report 15,000 of its 3,600 seconds used
 * on a run that took three minutes.
 */
function wallSeconds(startedAt: string | null, endedAt: string | null): number {
  if (startedAt === null) return 0;
  const from = Date.parse(startedAt);
  if (!Number.isFinite(from)) return 0;
  const to = endedAt === null ? Date.now() : Date.parse(endedAt);
  if (!Number.isFinite(to)) return 0;
  return Math.max(0, Math.round((to - from) / 1000));
}

export function AgentPage({ runId, onBack }: { runId: string; onBack: () => void }) {
  const [tab, setTab] = useState<Tab>('chat');
  const queryClient = useQueryClient();

  const run = useQuery({ queryKey: ['run', runId], queryFn: () => api.run(runId), refetchInterval: 4000 });
  const events = useQuery({
    queryKey: ['events', runId],
    queryFn: () => api.events(runId),
    refetchInterval: 3000,
  });
  const diff = useQuery({
    queryKey: ['diff', runId],
    queryFn: () => api.diff(runId),
    enabled: tab === 'diff',
    refetchInterval: tab === 'diff' ? 4000 : false,
  });

  if (run.isPending) return <div className="empty">loading…</div>;
  if (run.isError) return <div className="empty">no such run: {(run.error as Error).message}</div>;
  const detail = run.data;
  const live = !isTerminal(detail.status);

  const metrics = (events.data ?? []).filter((event) => event.type === 'metrics');
  const lastCall = metrics.length === 0 ? null : metrics[metrics.length - 1].call;

  const cancel = async (): Promise<void> => {
    await api.cancel(runId);
    await queryClient.invalidateQueries();
  };

  return (
    <div className="page">
      <div className="run-head">
        <div className="run-title">
          <button className="quiet" onClick={onBack}>
            ‹ all agents
          </button>
          <h1>{detail.name}</h1>
          <StatusPill status={detail.status} detail={detail.detail} />
          <TagPill tag={detail.tag} note={detail.tagNote} />
          <span className="push" />
          {live && (
            <button
              className="danger"
              onClick={() => void cancel()}
              title="aborts the model call and kills the worker and every check it started"
            >
              cancel
            </button>
          )}
        </div>
        {/* One quiet line, not six. The full worktree path and the run id are
            both long and both rarely needed, so they live in tooltips. */}
        <div className="run-meta">
          <span title={detail.worktree}>{shortPath(detail.worktree)}</span>
          <span title={detail.id}>{detail.id}</span>
          <span>
            {detail.turns} turn{detail.turns === 1 ? '' : 's'}
          </span>
          <span>{durationOf(detail.startedAt, detail.endedAt)}</span>
          <span>{detail.model}</span>
          {detail.detached && <span>detached</span>}
        </div>
        <MetricsStrip call={lastCall} totals={detail.totals} />
        <Limits
          runId={runId}
          turns={detail.turns}
          totals={detail.totals}
          limits={detail.limits}
          wallSeconds={wallSeconds(detail.startedAt, detail.endedAt)}
          priced={detail.priced === true}
          status={detail.status}
        />
      </div>

      {detail.detail !== null && (
        <div
          className="banner"
          data-tone={
            detail.status === 'failed' || detail.status === 'interrupted'
              ? 'bad'
              : detail.status === 'stopped_at_limit'
                ? 'warn'
                : 'info'
          }
        >
          {statusWord(detail.status)}: {detail.detail}
        </div>
      )}

      <div className="tabs" role="tablist">
        <button className="tab" role="tab" aria-selected={tab === 'chat'} onClick={() => setTab('chat')}>
          chat
        </button>
        {/* Not hidden when the run is going: a limit stop is the thing most
            worth reading, and it is exactly when there is a report to read. */}
        <button
          className="tab"
          role="tab"
          aria-selected={tab === 'report'}
          onClick={() => setTab('report')}
          data-loud={!live && detail.status !== 'finished'}
        >
          report
        </button>
        <button className="tab" role="tab" aria-selected={tab === 'config'} onClick={() => setTab('config')}>
          config
        </button>
        <button className="tab" role="tab" aria-selected={tab === 'diff'} onClick={() => setTab('diff')}>
          diff
        </button>
        {/* Its own tab rather than a strip in the header: a run's readings are
            twenty-odd rows of six columns read with intent, not a glance. */}
        <button className="tab" role="tab" aria-selected={tab === 'timing'} onClick={() => setTab('timing')}>
          timing
        </button>
      </div>

      {tab === 'report' && <Report runId={runId} live={live} taskPath={detail.config.configPath} />}

      {tab === 'timing' && <Timings runId={runId} />}

      {tab === 'chat' && <Chat runId={runId} events={events.data ?? []} live={live} />}

      {tab === 'config' && <ConfigView config={detail.config} />}

      {tab === 'diff' && (
        <div className="scroller">
          {diff.data !== undefined && diff.data.stray.length > 0 && (
            <div className="banner" data-tone="bad" style={{ margin: 0 }}>
              changed outside the allowed files: {diff.data.stray.join(', ')}
            </div>
          )}
          <div className="pane">
            <h2>
              worktree diff <span className="where">{detail.worktree}</span>
            </h2>
            {diff.isPending ? (
              <pre className="diff">loading…</pre>
            ) : (
              <DiffView diff={diff.data?.diff ?? ''} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
