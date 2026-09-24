/**
 * The workspace: everything a task file should not have to repeat.
 *
 * A task file is one backlog line. The worktree, the model, the files it may
 * touch, what to do. But 55 real runs on one project showed what actually
 * happens without a layer above that: the same eight project rules, the same
 * check list, the same build setup and the same "here is how you run a test"
 * preamble got copied into every task file by hand. Which means every task file
 * was a chance to copy one of them wrong, and there was nowhere to write down
 * something true about the project rather than about one line of it.
 *
 * So: a workspace file, found once, applied to every run in that project.
 *
 *     dsh.workspace.json
 *     {
 *       "name": "esap",
 *       "profiles": { "default": "profiles/esap.json" },
 *       "env": { "CARGO_TARGET_DIR": "{worktree}-target" },
 *       "rules": "esap.rules.md",
 *       "commands": { "run_test": { ... } }
 *     }
 *
 * **Where it lives.** In the worktree, or above it, found by walking up. The
 * rule that keeps a model from editing its own rules is not "this file is
 * outside the worktree" — that never held, because a check can write anywhere
 * its process can reach. It is that the file's own name is on the never-write
 * list, so no tool the agent can call will touch it. See `WORKSPACE_FILES`.
 *
 * **Nothing about a project lives in the harness.** Every key here is either
 * plumbing (a path, an environment variable) or a description of this project's
 * own tools. There is no `cargo`, no `vitest`, no `playwright` anywhere in this
 * package, and adding one would be the bug.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { COMMAND_NAME, RESERVED_TOOL_NAMES, declaredCommandSchema } from './commands.js';
import { checkSpecSchema } from './profile.js';

/**
 * The file names a workspace may have.
 *
 * Both are on `NEVER_WRITE`, which is what makes it safe for one to sit inside
 * the worktree — and it should be able to, because that is where a project
 * keeps its own configuration and asking somebody to put it elsewhere would be
 * asking them to keep it somewhere they will forget.
 */
export const WORKSPACE_FILES = ['dsh.workspace.json', '.dsh/workspace.json'];

/** A command the project runs itself, rather than one the agent may call. */
export const setupStepSchema = z
  .object({
    /** Only run when the worktree has a file matching one of these. */
    when: z.array(z.string().min(1)).optional(),
    run: z.array(z.string().min(1)).min(1),
    timeoutSeconds: z.number().int().positive().max(3600).optional(),
  })
  .strict();

export const workspaceSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    /**
     * Profiles by name, so a task says `"profile": "default"`.
     *
     * A task may still give a path, and a name that is not a key here is read as
     * a path, so nothing written before this existed stops working.
     */
    profiles: z.record(z.string().min(1)).optional(),
    /** The profile a task gets when it names none. */
    defaultProfile: z.string().min(1).optional(),
    /** The model a task gets when it names none. */
    model: z.string().min(1).optional(),
    /**
     * Environment for every check and command.
     *
     * `{worktree}`, `{parent}`, `{name}` and `{home}` are substituted. The
     * first of those is the one that mattered in practice: two worktrees of one
     * project shared a `CARGO_TARGET_DIR`, so a check in one printed the other's
     * compile errors and a run concluded, wrongly, that the work it was given
     * did not build.
     */
    env: z.record(z.string()).optional(),
    /** Checks every profile in this workspace gets. */
    checks: z.record(checkSpecSchema).optional(),
    /** Tools the agent may call, defined entirely by this file. See `commands.ts`. */
    commands: z.record(declaredCommandSchema).optional(),
    /**
     * Notes appended to every task in this workspace, as a markdown file.
     *
     * A path, relative to this file. The point is to write a trap down once
     * instead of in every brief: the project whose ids must never be assumed to
     * come out in order wrote that sentence into every task file it had.
     *
     * Read at run start and stored in the run's config, so it is fixed for the
     * life of the run. That matters for a continuation, which replays the
     * conversation verbatim: rules that had changed underneath it would leave the
     * agent working to the old ones with nothing saying so.
     *
     * There is a second field for short notes and it is not a convenience.
     * Letting one field be a path when the file exists and text when it does not
     * reads well and is a trap: a path with a typo in it is a file that does not
     * exist, so the rules quietly become the path itself and the run works to
     * `notes.m` as an instruction. Two fields cannot be misread.
     */
    rules: z.string().min(1).optional(),
    /** The notes themselves, for a project with a sentence or two to say. */
    rulesText: z.string().min(1).optional(),
    /** Files outside the plan that a task may still change. See `SOFT_ALLOW`. */
    soft: z.array(z.string().min(1)).optional(),
    /** Run once per worktree, before any agent starts there. */
    setup: z.array(setupStepSchema).optional(),
    /**
     * Told who to notify when the agent asks a question.
     *
     * The question arrives on stdin and `DSH_RUN` and `DSH_QUESTION` in the
     * environment. There is no answer channel: this is a notification, and it
     * exists because a run that asked a question and waited an hour for nobody
     * is a run that wasted an hour. What to do about it is the launcher's
     * business — wake up, or send `dsh reply`, or nothing.
     */
    onAsk: setupStepSchema.optional(),
    /** What `limits.askSeconds` becomes when a task does not say. */
    askSeconds: z.number().int().positive().optional(),
  })
  .strict();

export type Workspace = z.infer<typeof workspaceSchema>;
export type SetupStep = z.infer<typeof setupStepSchema>;

export interface WorkspaceRef {
  /** The absolute path of the file, for the run's config and the UI. */
  path: string;
  config: Workspace;
  /** Of the file's text, so a run records which version of the rules it used. */
  hash: string;
}

/**
 * The workspace for a run, or null when the project has none.
 *
 * A missing workspace is not a problem and must not be one: every run before
 * this existed had none, and a single-repo project does not need one.
 */
export function findWorkspace(input: {
  /** An explicit path from the task file, relative to the task file. */
  explicit?: string | undefined;
  /** Where to look, when there is no explicit path. */
  worktree: string;
  taskPath: string;
}): string | null {
  if (input.explicit !== undefined && input.explicit !== '') {
    const given = path.resolve(path.dirname(input.taskPath), input.explicit);
    // Null rather than the path when it is not there, so the caller can say "no
    // such workspace file" instead of failing while trying to read one. The walk
    // below is deliberately not reached either: a task that named a workspace
    // and got the path wrong should hear that, not be quietly given a different
    // project's rules because one happened to be further up the tree.
    return fs.existsSync(given) ? given : null;
  }
  // The worktree first, then upwards, then the task file's own directory: the
  // project's own config is next to the project, and a task file kept in a
  // harness folder somewhere else should not have to say so.
  for (const start of [input.worktree, path.dirname(input.taskPath)]) {
    const found = walkUp(start);
    if (found !== null) return found;
  }
  return null;
}

function walkUp(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    for (const name of WORKSPACE_FILES) {
      const candidate = path.join(dir, ...name.split('/'));
      if (fs.existsSync(candidate)) return candidate;
    }
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

export interface WorkspaceProblem {
  path: string;
  message: string;
  file: string | null;
}

/**
 * Read a workspace, with every problem at once.
 *
 * Throws on a bad file rather than returning null, because a workspace that
 * exists and does not parse is not "no workspace": continuing without it would
 * silently drop the project's rules and run the agent to the wrong instructions.
 */
export function loadWorkspace(file: string): WorkspaceRef {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new WorkspaceError([{ path: '(json)', message: (error as Error).message, file }]);
  }
  const parsed = workspaceSchema.safeParse(raw);
  if (!parsed.success) throw new WorkspaceError(problemsOf(parsed.error, file));
  const problems = validateNames(parsed.data, file);
  if (problems.length > 0) throw new WorkspaceError(problems);
  return {
    path: path.resolve(file),
    config: parsed.data,
    hash: createHash('sha256').update(fs.readFileSync(file, 'utf8')).digest('hex'),
  };
}

export function problemsOf(error: z.ZodError, file: string): WorkspaceProblem[] {
  const problems: WorkspaceProblem[] = [];
  for (const issue of error.issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) problems.push({ path: key, message: 'unknown key', file });
      continue;
    }
    problems.push({ path: issue.path.join('.') || '(root)', message: issue.message, file });
  }
  return problems;
}

/**
 * The checks that catch a command or profile name that cannot work.
 *
 * All of these could be left to the moment the model calls one, and that is
 * exactly the wrong moment: a name that collides with `read_file`, or an
 * argument with no values and no pattern, is a mistake in a config file that
 * somebody typed. Saying so when the file is read costs nothing and says it to
 * the person who can fix it.
 */
function validateNames(config: Workspace, file: string): WorkspaceProblem[] {
  const problems: WorkspaceProblem[] = [];

  for (const [name, command] of Object.entries(config.commands ?? {})) {
    if (!COMMAND_NAME.test(name)) {
      problems.push({
        path: `commands.${name}`,
        message: 'a command name has to be lowercase letters, digits and underscores',
        file,
      });
    }
    if (RESERVED_TOOL_NAMES.has(name)) {
      problems.push({
        path: `commands.${name}`,
        message: `a command may not be called ${name}: that is a tool the harness already has`,
        file,
      });
    }
    for (const [arg, spec] of Object.entries(command.args ?? {})) {
      if (spec.values === undefined && spec.pattern === undefined) {
        problems.push({
          path: `commands.${name}.args.${arg}`,
          message:
            'give values or pattern: an argument the model can put any text into is a shell by another name',
          file,
        });
      }
    }
    const placeholders = new Set(
      command.run.flatMap((part) => {
        const whole = /^\{([A-Za-z0-9_]+)\}$/.exec(part);
        return whole === null ? [] : [whole[1] as string];
      }),
    );
    for (const part of command.run) {
      if (part.includes('{') && !/^\{[A-Za-z0-9_]+\}$/.test(part)) {
        problems.push({
          path: `commands.${name}.run`,
          message: `${part} has a placeholder in the middle of it; a placeholder must be a whole argument`,
          file,
        });
      }
    }
    for (const arg of Object.keys(command.args ?? {})) {
      if (!placeholders.has(arg)) {
        problems.push({
          path: `commands.${name}.args.${arg}`,
          message: `declared but never used: no {${arg}} anywhere in run`,
          file,
        });
      }
    }
    for (const used of placeholders) {
      if (!(used in (command.args ?? {}))) {
        problems.push({
          path: `commands.${name}.run`,
          message: `uses {${used}}, which is not a declared argument`,
          file,
        });
      }
    }

    // An optional placeholder is dropped when the model leaves it out, and that
    // is only safe when dropping it leaves a command. `["cargo","test","-p",
    // "{target}"]` with an optional target becomes `cargo test -p`, which is a
    // flag hanging off the end of an argv — not "no target", which is what was
    // asked for. Found by writing the optional case down as a test: the harness
    // was producing that argv and calling it fine.
    //
    // The rule is narrow on purpose. It fires only when the element before an
    // optional placeholder is a literal beginning with `-`, which is a fact
    // about those two elements rather than a guess about the tool. A command
    // that wants an optional package writes `["cargo","test","{package}"]` and
    // puts `-p core` in the values, or declares two commands.
    for (const [at, part] of command.run.entries()) {
      const whole = /^\{([A-Za-z0-9_]+)\}$/.exec(part);
      if (whole === null) continue;
      const arg = (command.args ?? {})[whole[1] as string];
      if (arg?.optional !== true) continue;
      const before = command.run[at - 1];
      if (before !== undefined && /^-/.test(before)) {
        problems.push({
          path: `commands.${name}.run`,
          message:
            `${before} ${part} cannot be optional: leaving the value out would run ${before} with nothing after it. ` +
            `Write the flag and the value as one argument's values, or declare two commands`,
          file,
        });
      }
    }
  }
  if (config.defaultProfile !== undefined && config.profiles?.[config.defaultProfile] === undefined) {
    problems.push({
      path: 'defaultProfile',
      message: `there is no profile called ${config.defaultProfile} in profiles`,
      file,
    });
  }
  return problems;
}

export class WorkspaceError extends Error {
  readonly problems: WorkspaceProblem[];
  constructor(problems: WorkspaceProblem[]) {
    super(problems.map((problem) => `${problem.path}: ${problem.message}`).join('\n'));
    this.name = 'WorkspaceError';
    this.problems = problems;
  }
}

/**
 * What the placeholders in an environment value become.
 *
 * `{worktree}` is the one that earns its keep: two worktrees of one project
 * sharing a build directory is how a check in one printed the other's errors.
 */
export interface Interpolation {
  worktree: string;
  /** The directory above the worktree, which is what `{parent}` has always meant. */
  parent: string;
  /** The run's name. */
  name: string;
  /** The harness home. */
  home: string;
}

export function interpolate(value: string, into: Interpolation): string {
  return value
    .replace(/\{worktree\}/g, into.worktree)
    .replace(/\{parent\}/g, into.parent)
    .replace(/\{name\}/g, into.name)
    .replace(/\{home\}/g, into.home);
}

/**
 * The rules text, from `rulesText` or from the file `rules` names.
 *
 * A path that is not there is a problem, not an empty result. Rules that vanish
 * are worse than rules that were never written, because the run's own config
 * records that it had them and the agent worked without them.
 */
export function readRules(workspace: WorkspaceRef): { text: string } | { problem: WorkspaceProblem } {
  const inline = workspace.config.rulesText;
  const named = workspace.config.rules;
  if (named === undefined || named.trim() === '') return { text: (inline ?? '').trim() };
  const asFile = path.resolve(path.dirname(workspace.path), named);
  if (!fs.existsSync(asFile)) {
    return {
      problem: { path: 'rules', message: `no such rules file: ${asFile}`, file: workspace.path },
    };
  }
  try {
    return { text: fs.readFileSync(asFile, 'utf8') };
  } catch (error) {
    return {
      problem: { path: 'rules', message: (error as Error).message, file: workspace.path },
    };
  }
}
