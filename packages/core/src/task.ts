import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { profileProblems, profileSchema, type Profile } from './profile.js';

/**
 * A task is a JSON file. Strict: an unknown key is an error, not something the
 * daemon quietly ignores.
 */
export const limitsSchema = z
  .object({
    turns: z.number().int().positive().optional(),
    wallSeconds: z.number().int().positive().optional(),
    outputTokens: z.number().int().positive().optional(),
    totalTokens: z.number().int().positive().optional(),
    contextTokens: z.number().int().positive().optional(),
    askSeconds: z.number().int().positive().optional(),
  })
  .strict();

export const taskFileSchema = z
  .object({
    name: z.string().min(1),
    worktree: z.string().min(1),
    profile: z.string().min(1),
    model: z.string().min(1),
    allow: z.array(z.string().min(1)).min(1),
    checks: z.array(z.string().min(1)).optional(),
    task: z.string().optional(),
    taskFile: z.string().optional(),
    limits: limitsSchema.optional(),
  })
  .strict();

export type TaskFile = z.infer<typeof taskFileSchema>;

export interface RunLimits {
  turns: number;
  wallSeconds: number;
  outputTokens: number;
  /** Prompt plus completion, in all. The bound on what a run costs. */
  totalTokens: number;
  /**
   * The request budget, well under the model's real ceiling.
   *
   * Measured at 1,048,576 tokens, which is the whole window including the reply.
   * This is deliberately lower: it is the point at which the harness forgets old
   * tool results rather than sending a request the API will refuse.
   */
  contextTokens: number;
  askSeconds: number;
}

export const DEFAULT_LIMITS: RunLimits = {
  turns: 12,
  wallSeconds: 900,
  outputTokens: 40_000,
  // Above every per-run figure the catalogue's arms use, so it only fires on a
  // runaway: `outputTokens` counts what the model wrote, and a tool-using run's
  // bill is mostly the prompt it reads back every turn, which nothing else caps.
  totalTokens: 2_000_000,
  // Below the model's 1,048,576, so there is room for the reply and for the
  // estimate in `context.ts` being an estimate. Hitting this compacts; it does
  // not end the run.
  contextTokens: 700_000,
  askSeconds: 3_600,
};

/**
 * The task exactly as the run used it. Stored with the run and shown in the UI,
 * because a run must never change its own rules halfway.
 */
export interface ResolvedRunConfig {
  name: string;
  worktree: string;
  profile: string;
  profileHash: string;
  model: string;
  allow: string[];
  checks: string[];
  task: string;
  limits: RunLimits;
  /**
   * The task text file, when the task file pointed at one.
   *
   * Null for a task whose text is inline in the JSON, which is the common case.
   * Not the thing to re-read to continue a run: see `configPath`.
   */
  sourcePath: string | null;
  /**
   * The task JSON this run was resolved from.
   *
   * What `dsh continue` needs. A continuation re-resolves the worktree, profile
   * and checks from the same file rather than copying them out of the old run,
   * so a task file that has since been corrected is not continued from a stale
   * copy. `sourcePath` cannot be used for this: it is null whenever the task
   * text is inline, which is most of them, and it means something else.
   */
  configPath: string;
  raw: unknown;
  resolvedProfile: Profile;
  /**
   * The run this one carries on from, when it is a continuation.
   *
   * Part of the config rather than a column of its own: `runs` has no migration
   * mechanism and this is genuinely something the run was told, so it belongs
   * with the task file's own fields rather than in a schema change.
   */
  continues?: string | null;
}

export interface TaskProblem {
  path: string;
  message: string;
  file: string | null;
}

export class TaskError extends Error {
  readonly problems: TaskProblem[];
  constructor(problems: TaskProblem[]) {
    super(problems.map((problem) => `${problem.path}: ${problem.message}`).join('\n'));
    this.name = 'TaskError';
    this.problems = problems;
  }
}

function zodProblems(error: z.ZodError, file: string | null): TaskProblem[] {
  const problems: TaskProblem[] = [];
  for (const issue of error.issues) {
    // Strict means an unknown key is an error, so name the key rather than the root.
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) problems.push({ path: key, message: 'unknown key', file });
      continue;
    }
    problems.push({ path: issue.path.join('.') || '(root)', message: issue.message, file });
  }
  return problems;
}

/** Every problem at once, each with the path of the bad field. */
export function loadRunConfig(taskPath: string): ResolvedRunConfig {
  const absolute = path.resolve(taskPath);
  if (!fs.existsSync(absolute)) {
    throw new TaskError([{ path: 'task', message: `no such task file: ${absolute}`, file: null }]);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(absolute, 'utf8'));
  } catch (error) {
    throw new TaskError([{ path: '(json)', message: (error as Error).message, file: absolute }]);
  }

  const parsed = taskFileSchema.safeParse(raw);
  if (!parsed.success) throw new TaskError(zodProblems(parsed.error, absolute));
  const task = parsed.data;

  const problems: TaskProblem[] = [];
  if (task.task === undefined && task.taskFile === undefined) {
    problems.push({ path: 'task', message: 'give either task or taskFile', file: absolute });
  }
  if (task.task !== undefined && task.taskFile !== undefined) {
    problems.push({ path: 'taskFile', message: 'give task or taskFile, not both', file: absolute });
  }

  const profilePath = path.resolve(path.dirname(absolute), task.profile);
  let profile: Profile | null = null;
  let profileHash = '';
  if (!fs.existsSync(profilePath)) {
    problems.push({ path: 'profile', message: `no such profile file: ${profilePath}`, file: absolute });
  } else {
    const text = fs.readFileSync(profilePath, 'utf8');
    profileHash = createHash('sha256').update(text).digest('hex');
    try {
      const parsedProfile = profileSchema.safeParse(JSON.parse(text));
      if (parsedProfile.success) profile = parsedProfile.data;
      else problems.push(...(profileProblems(parsedProfile.error, profilePath) as TaskProblem[]));
    } catch (error) {
      problems.push({ path: '(json)', message: (error as Error).message, file: profilePath });
    }
  }

  let taskText = task.task ?? '';
  let sourcePath: string | null = null;
  if (task.taskFile !== undefined) {
    sourcePath = path.resolve(path.dirname(absolute), task.taskFile);
    if (!fs.existsSync(sourcePath)) {
      problems.push({ path: 'taskFile', message: `no such file: ${sourcePath}`, file: absolute });
    } else {
      taskText = fs.readFileSync(sourcePath, 'utf8');
    }
  }

  if (problems.length > 0) throw new TaskError(problems);

  const available = Object.keys(profile?.checks ?? {});
  for (const name of task.checks ?? []) {
    if (name === 'format') continue;
    if (!available.includes(name)) {
      problems.push({
        path: 'checks',
        message: `the profile has no check called ${name}; it has ${available.join(', ') || '(none)'}`,
        file: absolute,
      });
    }
  }
  if (problems.length > 0) throw new TaskError(problems);

  return {
    name: task.name,
    worktree: path.resolve(path.dirname(absolute), task.worktree),
    profile: profilePath,
    profileHash,
    model: task.model,
    allow: task.allow,
    checks: task.checks ?? available,
    task: taskText,
    limits: { ...DEFAULT_LIMITS, ...(task.limits ?? {}) },
    sourcePath,
    configPath: absolute,
    raw,
    resolvedProfile: profile as Profile,
  };
}
