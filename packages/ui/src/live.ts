/**
 * One run's events, as they arrive.
 *
 * The chat used to be a query on a three-second poll, and that is why it looked
 * like it updated once a turn: three seconds is about how long a turn takes, so
 * the conversation arrived in chunks the size of a turn rather than as it was
 * written. Two things were wrong underneath it.
 *
 * The nudge the daemon sends on every event carried `runId: null`, so the branch
 * that refreshed an open run was dead code and the poll was the only thing moving
 * it. And the query it refreshed fetched the **whole** log every time — capped at
 * 5,000 events, and the longest run here has 6,933 — which is not something to do
 * five times a second either.
 *
 * So this streams instead. `WS /runs/:id/watch` is the same socket `dsh watch`
 * uses: it sends what the run has already done and then every event as it happens,
 * and it owns nothing, so opening one can neither start nor cancel anything.
 *
 * What arrives is accumulated in a map keyed by `seq` and handed to React five
 * times a second. The map is what makes the three overlapping sources safe — the
 * `hello` message, the pages fetched past its cap, and the live events — and the
 * five-a-second part is because a streaming model emits a delta every few tens of
 * milliseconds, so re-rendering the whole conversation on each one would spend
 * more time in the browser than the model spends writing.
 */

import { useEffect, useState } from 'react';
import { api } from './api';
import type { RunEvent, RunStreamMessage } from './types';

/** How often what has arrived is handed to React. Five times a second. */
export const RENDER_MS = 200;

/**
 * A ceiling on the seed pages, so a run producing events faster than this pages
 * cannot spin for ever. A hundred pages is far past any run in the history.
 */
const MAX_SEED_PAGES = 100;

/**
 * Everything known about one run, keyed by `seq`.
 *
 * A `Map` rather than an array because three sources feed it and they overlap:
 * the `hello` carries the log up to the moment of connecting — capped, see
 * `useLiveEvents` — the pages fetched past that cap carry the rest, and the live
 * messages carry what happens next. Keyed by `seq`, a duplicate is impossible and
 * no arrival order has to be reasoned about; the sort on read is the only order,
 * and it is the order things happened in.
 */
export class EventLog {
  private readonly known = new Map<number, RunEvent>();

  /** Whether anything was new, so a caller can leave a re-render alone. */
  merge(incoming: readonly RunEvent[]): boolean {
    let changed = false;
    for (const event of incoming) {
      if (this.known.has(event.seq)) continue;
      this.known.set(event.seq, event);
      changed = true;
    }
    return changed;
  }

  /** The highest `seq` seen, which is where an incremental read starts. */
  get highest(): number {
    let most = 0;
    for (const seq of this.known.keys()) if (seq > most) most = seq;
    return most;
  }

  get size(): number {
    return this.known.size;
  }

  /** In `seq` order. */
  ordered(): RunEvent[] {
    return [...this.known.values()].sort((left, right) => left.seq - right.seq);
  }
}

/**
 * A run's events, live, and whether any have arrived yet.
 *
 * `ready` exists because an empty log and a log that has not been read yet look
 * identical from the outside, and the view has to say two different things. The
 * socket's first message carries the whole history, so this is a few hundred
 * milliseconds after mount — but it is long enough to read a wrong sentence, and
 * "nothing has happened yet" is wrong when the run has forty turns in it.
 */
export interface LiveEvents {
  events: RunEvent[];
  ready: boolean;
}

/**
 * A run's events, live, rendered at most five times a second.
 *
 * A caller that wants the status can read the last `status` event, and one that
 * wants the current totals can read the last `metrics` event, which is where the
 * header gets them anyway.
 */
export function useLiveEvents(runId: string): LiveEvents {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const log = new EventLog();
    let dirty = false;
    let stopped = false;
    let finished = false;
    let socket: WebSocket | null = null;
    let retry = 0;
    let retryTimer: number | null = null;

    setEvents([]);
    setReady(false);

    const flush = window.setInterval(() => {
      if (!dirty) return;
      dirty = false;
      setEvents(log.ordered());
      setReady(true);
    }, RENDER_MS);

    const merge = (incoming: readonly RunEvent[]): void => {
      if (log.merge(incoming)) dirty = true;
    };

    /**
     * Everything the `hello` was too small to carry.
     *
     * The daemon caps that first message at the store's page size, so a long run's
     * opening message is its first 5,000 events rather than its whole log — and a
     * chat missing its middle is worse than one that is slow to appear. This asks
     * for what comes after what is known until a read comes back **empty**, rather
     * than short: "short" would mean this knows the server's page size, which it
     * has no business knowing.
     *
     * It runs after the first paint rather than before it, so a long run shows its
     * beginning immediately instead of waiting for its end.
     */
    const seed = async (): Promise<void> => {
      for (let page = 0; page < MAX_SEED_PAGES; page += 1) {
        const more = await api.events(runId, log.highest);
        if (stopped || more.length === 0) return;
        merge(more);
      }
    };

    const connect = (): void => {
      if (stopped || finished) return;
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(`${protocol}//${location.host}/runs/${runId}/watch`);

      socket.onopen = () => {
        // Reset on a good connection, not on a successful message, so one flaky
        // open does not push the next retry out to five seconds.
        retry = 0;
      };

      socket.onmessage = (message: MessageEvent<string>) => {
        const parsed = JSON.parse(message.data) as RunStreamMessage;
        if (parsed.type === 'hello') {
          merge(parsed.events);
          void seed();
          return;
        }
        if (parsed.type === 'event') {
          merge([parsed.event]);
          return;
        }
        // Terminal, so nothing more is coming and a reconnect would only re-read a
        // log that will not change. This is what stops a finished run from keeping
        // a socket alive for as long as the tab is open.
        finished = true;
        socket?.close();
      };

      socket.onclose = () => {
        socket = null;
        if (stopped || finished) return;
        retry += 1;
        retryTimer = window.setTimeout(connect, Math.min(5000, 300 * retry));
      };

      socket.onerror = () => socket?.close();
    };

    connect();

    return () => {
      stopped = true;
      window.clearInterval(flush);
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      socket?.close();
    };
  }, [runId]);

  return { events, ready };
}
