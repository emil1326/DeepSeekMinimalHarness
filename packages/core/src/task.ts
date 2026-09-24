import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { DeclaredCommand } from './commands.js';
import { commandOverrideSchema, mergeCommands } from './commands.js';
import { harnessHome } from './config.js';
import { profileProblems, profileSchema, type Profile } from './profile.js';
import {
  WorkspaceError,
  findWorkspace,
  interpolate,
  loadWorkspace,
  readRules,
  type SetupStep,
  type WorkspaceRef,
} from './workspace.js';

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
    /**
     * Dollars, and so not an integer: the default is five cents.
     *
     * The only limit here that is counted in money. Tokens and turns are
     * proxies; this is the thing being spent, and it is the one a person can
     * actually set without knowing what a token is worth.
     */
    costUsd: z.number().positive().optional(),
  })
  .strict();

export const taskFileSchema = z
  .object({
    name: z.string().min(1),
    worktree: z.string().min(1),
    /**
     * A profile, by name or by path.
     *
     * A name is looked up in the workspace's `profiles`, and anything that is
     * not a key there is read as a path relative to this file. Optional when the
     * workspace names a `defaultProfile`, which is the point of having one.
     */
    profile: z.string().min(1).optional(),
    /** Optional when the workspace names a model for the project. */
    model: z.string().min(1).optional(),
    allow: z.array(z.string().min(1)).min(1),
    checks: z.array(z.string().min(1)).optional(),
    task: z.string().optional(),
    taskFile: z.string().optional(),
    limits: limitsSchema.optional(),
    /** The workspace to use, relative to this file. Found by walking up otherwise. */
    workspace: z.string().min(1).optional(),
    /**
     * Files this run may change that are outside the plan.
     *
     * Added to whatever the workspace declares. See `ResolvedRunConfig.soft`.
     */
    soft: z.array(z.string().min(1)).optional(),
    /**
     * Narrowings of the commands the workspace declared.
     *
     * A workspace lists the test targets it knows about; whether a given task
     * owns all of them is a fact about the task. This lets a task say which one
     * its run may point at, without being able to invent a command. See
     * `mergeCommands` in `commands.ts` for why the argv is not in here.
     */
    commands: z.record(commandOverrideSchema).optional(),
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
  /**
   * What the run may spend, in dollars.
   *
   * Five cents by default, which is deliberate: small enough that a task file
   * that forgot to think about money cannot burn a balance, and large enough for
   * a real multi-file edit on Flash at the cache rate. The other limits are
   * guesses at this one, and a guess is a poor substitute for the number itself.
   */
  costUsd: number;
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
  costUsd: 0.05,
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
  /**
   * The workspace this run resolved against, when the project has one.
   *
   * Recorded rather than re-derived, so the UI and the report can say which
   * version of a project's rules a run worked to, and so a workspace that is
   * corrected afterwards does not rewrite the history of a run that used the
   * older one.
   */
  workspace: { path: string; name: string; hash: string } | null;
  /**
   * The project's own notes, appended to the task text.
   *
   * Fixed at run start and stored here, so a continuation replays the same
   * words. Rules that changed underneath a continuation would leave the agent
   * working to the old ones with nothing anywhere saying so.
   */
  rules: string;
  /**
   * Files this run may change that are outside the plan.
   *
   * The middle ground between `allow` and a refusal. A test file sitting next to
   * the one a task modifies has to be touched almost every time and is forgotten
   * in the task file almost every time, and the choice was between stopping the
   * run and loosening a rule. Files here are writable and every change to one is
   * reported at the end as outside the plan.
   */
  soft: string[];
  /** Tools this project declared. See `commands.ts`. */
  commands: Record<string, DeclaredCommand>;
  /**
   * Environment for every check and command, already interpolated.
   *
   * Resolved here rather than in the sandbox so that `{worktree}` and `{name}`
   * mean the same thing everywhere, and so the UI can show what a run actually
   * ran with.
   */
  env: Record<string, string>;
  /** Run once per worktree before any agent starts there. */
  setup: SetupStep[];
  /** Told when the agent asks a question. Never answered by the harness. */
  onAsk: SetupStep | null;
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

  const worktree = path.resolve(path.dirname(absolute), task.worktree);

  // The workspace first, because it can supply the profile and the model that
  // the rest of this resolution needs. Its own path comes from the task file
  // when one is given and from walking up from the worktree otherwise, so a
  // project's config is found once and every task in it inherits.
  let workspace: WorkspaceRef | null = null;
  const workspacePath = findWorkspace({
    explicit: task.workspace,
    worktree,
    taskPath: absolute,
  });
  if (workspacePath !== null) {
    try {
      workspace = loadWorkspace(workspacePath);
    } catch (error) {
      if (error instanceof WorkspaceError) throw new TaskError(error.problems as TaskProblem[]);
      throw error;
    }
  } else if (task.workspace !== undefined) {
    problems.push({
      path: 'workspace',
      message: `no such workspace file: ${path.resolve(path.dirname(absolute), task.workspace)}`,
      file: absolute,
    });
  }

  const named = task.profile ?? workspace?.config.defaultProfile;
  if (named === undefined) {
    problems.push({
      path: 'profile',
      message: 'give a profile, or name a defaultProfile in the workspace',
      file: absolute,
    });
  }

  // A profile is a key in the workspace when the workspace has one by that name,
  // and a path otherwise. That is what makes `"profile": "default"` work without
  // stopping every task file that already spells out a path.
  const fromWorkspace = named === undefined ? undefined : workspace?.config.profiles?.[named];
  const profilePath =
    named === undefined
      ? absolute
      : path.resolve(path.dirname(workspace?.path ?? absolute), fromWorkspace ?? named);

  let profile: Profile | null = null;
  let profileHash = '';
  if (named !== undefined && !fs.existsSync(profilePath)) {
    problems.push({
      path: 'profile',
      message:
        fromWorkspace !== undefined || workspace?.config.profiles?.[named] !== undefined
          ? `the workspace names ${named}, but there is no file at ${profilePath}`
          : `no such profile file: ${profilePath}`,
      file: absolute,
    });
  } else if (named !== undefined) {
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

  // The workspace's own checks go in first, so one project can define a check
  // once and every profile in it can use it. A profile's entry wins on a clash:
  // the more specific file is the one nearer the task.
  const checks: Record<string, { when?: string[]; run: string[] }> = {
    ...(workspace?.config.checks ?? {}),
    ...(profile?.checks ?? {}),
  };

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

  const model = task.model ?? workspace?.config.model;
  if (model === undefined) {
    problems.push({ path: 'model', message: 'give a model, or name one in the workspace', file: absolute });
  }

  if (problems.length > 0) throw new TaskError(problems);

  const available = Object.keys(checks);
  for (const name of task.checks ?? []) {
    if (name === 'format') continue;
    if (!available.includes(name)) {
      problems.push({
        path: 'checks',
        message: `there is no check called ${name}; there is ${available.join(', ') || '(none)'}`,
        file: absolute,
      });
    }
  }
  if (problems.length > 0) throw new TaskError(problems);

  const home = harnessHome();
  const into = { worktree, parent: path.dirname(worktree), name: task.name, home };
  // The workspace's environment first so a profile can override one variable
  // without restating the rest.
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries({
    ...(workspace?.config.env ?? {}),
    ...(profile?.env ?? {}),
  })) {
    env[key] = interpolate(value, into);
  }

  let rulesText = '';
  if (workspace !== null) {
    const rules = readRules(workspace);
    if ('problem' in rules) problems.push(rules.problem as TaskProblem);
    else rulesText = rules.text;
  }
  if (problems.length > 0) throw new TaskError(problems);

  // The task's narrowing, folded into the workspace's commands. Refused rather
  // than ignored at every step: an override that names a command or an argument
  // that does not exist would silently do nothing, and a model told it may pass
  // one value while every value is still accepted is being lied to.
  const merged = mergeCommands(workspace?.config.commands ?? {}, task.commands ?? {});
  if ('problems' in merged) {
    throw new TaskError(merged.problems.map((problem) => ({ ...problem, file: absolute })));
  }

  return {
    name: task.name,
    worktree,
    profile: profilePath,
    profileHash,
    model: model as string,
    allow: task.allow,
    checks: task.checks ?? available,
    task: taskText,
    limits: {
      ...DEFAULT_LIMITS,
      ...(workspace?.config.askSeconds === undefined ? {} : { askSeconds: workspace.config.askSeconds }),
      ...(task.limits ?? {}),
    },
    sourcePath,
    configPath: absolute,
    raw,
    resolvedProfile: profile === null ? { checks: {} } : { ...profile, checks },
    workspace:
      workspace === null ? null : { path: workspace.path, name: workspace.config.name, hash: workspace.hash },
    rules: rulesText,
    soft: [...(workspace?.config.soft ?? []), ...(task.soft ?? [])],
    commands: merged.commands,
    env,
    setup: workspace?.config.setup ?? [],
    onAsk: workspace?.config.onAsk ?? null,
  };
}
