import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, liveNotices } from './api';
import { AgentsList } from './components/AgentsList';
import { AgentPage } from './components/AgentPage';
import { isTerminal } from './types';

type Choice = 'dark' | 'light';

function useTheme(): [Choice, () => void] {
  const [choice, setChoice] = useState<Choice>(() =>
    window.localStorage.getItem('dsh.theme') === 'light' ? 'light' : 'dark',
  );

  useEffect(() => {
    document.documentElement.dataset.theme = choice;
    window.localStorage.setItem('dsh.theme', choice);
  }, [choice]);

  return [choice, () => setChoice((current) => (current === 'dark' ? 'light' : 'dark'))];
}

function useRoute(): [string | null, (runId: string | null) => void] {
  const read = (): string | null => /^#\/runs\/(.+)$/.exec(window.location.hash)?.[1] ?? null;
  const [runId, setRunId] = useState<string | null>(read);

  useEffect(() => {
    const onHash = (): void => setRunId(read());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  return [
    runId,
    (next) => {
      window.location.hash = next === null ? '' : `#/runs/${next}`;
    },
  ];
}

export function App() {
  const [choice, cycle] = useTheme();
  const [runId, go] = useRoute();
  const queryClient = useQueryClient();

  const runs = useQuery({ queryKey: ['runs'], queryFn: api.runs, refetchInterval: 10_000 });
  const health = useQuery({ queryKey: ['health'], queryFn: api.health, staleTime: Infinity });

  useEffect(
    () =>
      liveNotices((changed) => {
        // The list, which is now cheap: 84 KB for 104 runs rather than 695 KB,
        // because the daemon stopped sending every run's whole config with it.
        void queryClient.invalidateQueries({ queryKey: ['runs'] });
        // The run that changed, so an open run's header keeps up with it.
        //
        // Not its events: those arrive over the run's own socket now, and
        // refetching the whole log several times a second is what made the chat
        // look like it updated once a turn. Not its diff either — that one runs
        // git, and four a second would be four git processes a second, which is
        // why it has an interval of its own and no nudge.
        if (changed !== null) void queryClient.invalidateQueries({ queryKey: ['run', changed] });
        // And deliberately not `['stats']`. That one aggregates every call in the
        // history — 3,158 of them here, 77 ms a go — to produce numbers that move
        // imperceptibly during a run: cumulative tokens, a mean speed, a total
        // spend. Its own fifteen-second interval is already more often than it
        // needs, and refreshing it on every event was the largest single cost in
        // the daemon.
      }),
    [queryClient],
  );

  const going = (runs.data ?? []).filter((run) => !isTerminal(run.status)).length;

  return (
    <div className="shell">
      <header className="topbar">
        <h1 className="wordmark">
          <a href="/" title="back to the top">
            Emil's DeepSeek Harness
          </a>
        </h1>
        <span className="count">
          {runs.data === undefined ? '' : going === 0 ? 'all quiet' : `${going} going`}
        </span>
        <span className="topbar-spacer" />
        <button className="quiet" onClick={cycle} title="switch between the dark and light themes">
          {choice === 'dark' ? 'light mode' : 'dark mode'}
        </button>
      </header>

      <main className="main">
        {runId === null ? <AgentsList onOpen={go} /> : <AgentPage runId={runId} onBack={() => go(null)} />}
      </main>

      <footer className="footer">
        <span>sandboxed DeepSeek agents in a git worktree</span>
        <span className="sep">·</span>
        <span className="mono">
          {health.data === undefined ? 'daemon ?' : `127.0.0.1:${health.data.port}`}
        </span>
        <span className="push" />
        <a href="https://emils-work.freesite.online/">Emil's work</a>
        <span className="sep">·</span>
        <a href="https://github.com/emil1326">GitHub</a>
      </footer>
    </div>
  );
}
