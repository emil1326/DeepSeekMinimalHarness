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
  askSeconds: number;
}

export const DEFAULT_LIMITS: RunLimits = {
  turns: 12,
  wallSeconds: 900,
  outputTokens: 40_000,
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
  sourcePath: string | null;
  raw: unknown;
  resolvedProfile: Profile;
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
    raw,
    resolvedProfile: profile as Profile,
  };
}
