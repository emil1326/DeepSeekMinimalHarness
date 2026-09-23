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
        void queryClient.invalidateQueries({ queryKey: ['runs'] });
        void queryClient.invalidateQueries({ queryKey: ['stats'] });
        if (changed !== null) {
          void queryClient.invalidateQueries({ queryKey: ['run', changed] });
          void queryClient.invalidateQueries({ queryKey: ['events', changed] });
          void queryClient.invalidateQueries({ queryKey: ['diff', changed] });
        }
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
