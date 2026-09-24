import type {
  ChatMessage,
  PriceTable,
  ResolvedRunConfig,
  RunEvent,
  RunEventBody,
  RunLimits,
  RunStatus,
  Speaker,
  TimingSnapshot,
} from '@emilswork/harness-core';

/** An event as the worker writes it: the daemon stamps the sequence and the run. */
export type EmittedEvent = Omit<RunEvent, 'seq' | 'runId'> & { seq?: number; runId?: string };

export interface WorkerStart {
  type: 'start';
  runId: string;
  config: ResolvedRunConfig;
  /** Where to reach DeepSeek. Overridable so tests can point at a fake. */
  baseUrl: string;
  /**
   * Prices to bill against, as written in `config.json`.
   *
   * The whole table rather than the one price for this run's model, because
   * DeepSeek charges half during off-peak hours: the price of a call depends on
   * when it was made, so it is resolved once per call in the loop. Anything the
   * table does not name falls back to the published prices in `core/pricing.ts`.
   */
  prices?: PriceTable;
  /**
   * The conversation to carry on from, for a continuation.
   *
   * Whatever this run's own `runId` is, the transcript it was given came from
   * the run it continues, so the daemon reads that one out and hands it over.
   */
  resume?: ChatMessage[];
  /**
   * The files the runs this one continues wrote, for a continuation.
   *
   * The baseline is `git status` at the start, and a continuation's start is
   * its parent's end, so without this every file the parent changed was
   * reported as "already changed before this run started" and left out of the
   * report, which is the whole of the work when a run is carried on.
   */
  inherited?: string[];
}

export type DaemonToWorker =
  | WorkerStart
  | { type: 'message'; text: string; by: Speaker }
  | { type: 'answer'; id: string; text: string; by: Speaker }
  | { type: 'cancel'; reason: string }
  /**
   * More room, granted while the run is going.
   *
   * The alternative was to let a limit be a hard wall: an agent that had spent
   * forty turns on a repo and could see the last one coming had to stop and lose
   * the thread. Now it can ask, and the person who launched it can say yes and
   * have that mean something before the next model call rather than after the
   * run has already ended.
   */
  | { type: 'limits'; limits: Partial<RunLimits> };

export type WorkerToDaemon =
  | { type: 'ready'; pid: number; runId: string }
  | { type: 'event'; body: RunEventBody; at: string }
  /**
   * What the worker's stopwatch has recorded, cumulative.
   *
   * Sent at every turn boundary and once before the run reports itself done, and
   * the daemon *replaces* this run's rows rather than adding to them: the
   * figures are cumulative, so a flush arriving twice must not double them, and
   * a flush arriving late must not leave a stale row behind.
   */
  | { type: 'timings'; snapshot: TimingSnapshot }
  | { type: 'done'; status: RunStatus; summary: string | null }
  | { type: 'fatal'; message: string };
