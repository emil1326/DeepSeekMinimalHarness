import type {
  Price,
  ResolvedRunConfig,
  RunEvent,
  RunEventBody,
  RunStatus,
  Speaker,
} from '@emilswork/harness-core';

/** An event as the worker writes it: the daemon stamps the sequence and the run. */
export type EmittedEvent = Omit<RunEvent, 'seq' | 'runId'> & { seq?: number; runId?: string };

export interface WorkerStart {
  type: 'start';
  runId: string;
  config: ResolvedRunConfig;
  /** Where to reach DeepSeek. Overridable so tests can point at a fake. */
  baseUrl: string;
  price?: Price;
}

export type DaemonToWorker =
  | WorkerStart
  | { type: 'message'; text: string; by: Speaker }
  | { type: 'answer'; id: string; text: string; by: Speaker }
  | { type: 'cancel'; reason: string };

export type WorkerToDaemon =
  | { type: 'ready'; pid: number; runId: string }
  | { type: 'event'; body: RunEventBody; at: string }
  | { type: 'done'; status: RunStatus; summary: string | null }
  | { type: 'fatal'; message: string };
