import type {
  DiffResponse,
  RunDetail,
  RunEvent,
  RunReport,
  RunSummary,
  RunTimings,
  Speaker,
  StatsResponse,
  TimingsResponse,
} from './types';

async function get<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`${path} answered ${response.status}`);
  return (await response.json()) as T;
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) {
    const parsed = text === '' ? {} : (JSON.parse(text) as { error?: string });
    throw new Error(parsed.error ?? `${path} answered ${response.status}`);
  }
  return (text === '' ? {} : JSON.parse(text)) as T;
}

export const api = {
  health: () => get<{ ok: boolean; pid: number; port: number }>('/health'),
  runs: () => get<{ runs: RunSummary[] }>('/runs').then((body) => body.runs),
  run: (id: string) => get<RunDetail>(`/runs/${id}`),
  events: (id: string, after = 0) =>
    get<{ events: RunEvent[] }>(`/runs/${id}/events?after=${after}`).then((body) => body.events),
  diff: (id: string) => get<DiffResponse>(`/runs/${id}/diff`),
  stats: () => get<StatsResponse>('/stats'),
  /** One run's instrumented readings: what the harness itself spent. */
  timings: (id: string) => get<RunTimings>(`/runs/${id}/timings`),
  /** The same readings added up over every run, plus the daemon's own. */
  allTimings: () => get<TimingsResponse>('/timings'),
  tell: (id: string, text: string) =>
    post<{ ok: boolean }>(`/runs/${id}/messages`, { text, by: 'emil' satisfies Speaker }),
  answer: (id: string, text: string) =>
    post<{ ok: boolean }>(`/runs/${id}/answers`, { text, by: 'emil' satisfies Speaker }),
  cancel: (id: string) => post<{ ok: boolean }>(`/runs/${id}/cancel`),
  /**
   * Raise a live run's budgets. Absolute figures, not deltas, so a click that
   * somehow arrived twice cannot compound.
   */
  setLimits: (id: string, limits: Record<string, number>) =>
    post<{ ok: boolean; limits: Record<string, number> }>(`/runs/${id}/limits`, limits),
  report: (id: string) => get<{ report: RunReport }>(`/runs/${id}/report`).then((body) => body.report),
  /**
   * Carry on a stopped run as a new one.
   *
   * A new run rather than a resurrection: the record of what happened keeps
   * saying "stopped at a limit", which is the whole point of having a report.
   */
  continueRun: (id: string, taskPath: string, limits: Record<string, number>) =>
    post<{ id: string }>('/runs', { taskPath, continueFrom: id, limits, detached: true }),
};

/**
 * The daemon nudges on every event; the UI fetches what changed.
 *
 * Batched, because a streaming run sends a nudge every fifty milliseconds and
 * refetching on each one would be silly.
 */
export function liveNotices(onChange: (runId: string | null) => void): () => void {
  let socket: WebSocket | null = null;
  let retry = 0;
  let closed = false;
  let pending = new Set<string | null>();
  let timer: number | null = null;

  const flush = (): void => {
    timer = null;
    const batch = pending;
    pending = new Set();
    for (const runId of batch) onChange(runId);
  };

  const connect = (): void => {
    if (closed) return;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(`${protocol}//${location.host}/events`);
    socket.onopen = () => {
      retry = 0;
    };
    socket.onmessage = (message: MessageEvent<string>) => {
      const parsed = JSON.parse(message.data) as { type: string; runId: string | null };
      if (parsed.type !== 'notice') return;
      pending.add(parsed.runId);
      if (timer === null) timer = window.setTimeout(flush, 250);
    };
    socket.onclose = () => {
      socket = null;
      if (closed) return;
      retry += 1;
      window.setTimeout(connect, Math.min(5000, 300 * retry));
    };
    socket.onerror = () => socket?.close();
  };

  connect();
  return () => {
    closed = true;
    if (timer !== null) window.clearTimeout(timer);
    socket?.close();
  };
}
