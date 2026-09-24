/**
 * Commands the project declares, which the harness turns into tools without
 * knowing anything about them.
 *
 * The harness runs static checks and nothing else, on purpose: everything it
 * executes is code somebody wrote, and the whole guarantee is that the agent
 * produces text and a diff shows every character of it. But that rule turned out
 * to cost far more than it saved. Measured over 55 real runs on one project:
 * only 3 or 4 of 16 backlog lines passed its gate untouched, and roughly half
 * the corrections were tests the agent had written that failed the first time
 * they ran — failures it had no way to see, so it could not fix them. It was
 * asked to write tests it was forbidden to run.
 *
 * The answer is not for the harness to learn what a test is. It is for the
 * *project* to say how to run one, and for the harness to offer exactly that and
 * nothing more. So a workspace declares commands:
 *
 *     "commands": {
 *       "run_test": {
 *         "description": "Run one test target that this task owns.",
 *         "args": { "target": { "description": "a target", "values": ["core:comments"] } },
 *         "run": ["cargo", "test", "-p", "{target}"],
 *         "timeoutSeconds": 90,
 *         "executes": true
 *       }
 *     }
 *
 * and the agent gets a `run_test` tool that can do exactly that one thing. The
 * harness still has no idea what cargo is. Change the project and nothing here
 * changes.
 *
 * **Why an argument has to be a closed set.** This is the load-bearing decision.
 * A declared command's argv is assembled from arguments the *model* chose, and
 * `process.ts` goes to a lot of trouble to make sure a model-written string
 * never reaches a command interpreter. A free-text argument would hand that back
 * one layer up: `["cargo", "test", "-p", "{target}"]` with an unconstrained
 * `target` is a shell by another name, and `--target-dir=../../..` is an
 * argument, not a path the sandbox can see. So every argument names either the
 * exact values it accepts or a pattern they must match, and a command with an
 * argument that does neither is refused when the workspace is read rather than
 * when the model first calls it. A project that needs a free-form command can
 * write a wrapper script and declare the arguments that script accepts.
 *
 * **Why a placeholder must be a whole argv element.** `{target}` standing alone
 * between two commas is a substitution. `--package={target}` is refused, because
 * splitting a prefix off one end of a model-chosen string and checking the other
 * end is the kind of "escaping" that reads as safe and is not.
 */

import { z } from 'zod';

/** What a project may say about one argument of one command. */
export const commandArgSchema = z
  .object({
    /** Shown to the model in the tool description, so it knows what to pass. */
    description: z.string().min(1),
    /** The exact set of values accepted. The preferred form. */
    values: z.array(z.string().min(1)).min(1).optional(),
    /** A regular expression the value must match in full, for a set too long to list. */
    pattern: z.string().min(1).optional(),
    /** Whether the model may leave it out. */
    optional: z.boolean().optional(),
  })
  .strict();

export const declaredCommandSchema = z
  .object({
    description: z.string().min(1),
    args: z.record(commandArgSchema).optional(),
    /** The argv, with `{name}` standing alone where an argument goes. */
    run: z.array(z.string().min(1)).min(1),
    /**
     * Seconds before the process tree is killed.
     *
     * Shorter than a check's 15 minutes on purpose: a command is something the
     * agent calls in the middle of a run, and a run has a wall clock of its own.
     */
    timeoutSeconds: z.number().int().positive().max(3600).optional(),
    /**
     * Keep only output lines matching this, plus the two lines on either side.
     *
     * The reason this exists: a test runner prints a hundred lines of "ok" and
     * four of failure, and the four are the whole message. `RESULT_CHARS` keeps
     * the head and the tail of everything, which for a passing run is the
     * hundred lines. A pattern is how the project says what matters about its
     * own tool's output — and the harness still does not have to know what a
     * failure looks like.
     */
    keep: z.string().min(1).optional(),
    /**
     * A pattern the output must match for this to count as a pass.
     *
     * The exit code is not enough, and that is not a theory: `cargo test -p x
     * --test y <filter>` where the filter matches no test exits **0** and prints
     * "0 passed; 0 failed". A command like that reads as a green tick having run
     * nothing at all, which is the same class of mistake as a control that
     * reports clean because it could not read the tree.
     *
     * Found in a real workspace: a command was declared to run one test by name,
     * the name was a helper function rather than a test, and the command
     * reported success for months' worth of runs while executing nothing.
     *
     * Tested against the output **before** `keep` trims it, because `keep` is a
     * pattern for what a reader wants to see and the line that proves a command
     * did something is very often not interesting to read.
     *
     * The harness still knows nothing about the tool: the project says what
     * proof looks like in its own words. `test result: ok\\. [1-9]` for cargo,
     * `Tests\\s+[1-9]\\d* passed` for vitest.
     */
    expect: z.string().min(1).optional(),
    /**
     * True when the command runs code from the worktree.
     *
     * Not a refusal, and not a permission: the project declared it, so the
     * project decided. It is recorded on the event and shown in the report,
     * because a reader deciding whether to trust a run needs to know that some
     * of its turns executed code the agent wrote rather than read it.
     */
    executes: z.boolean().optional(),
  })
  .strict();

export type CommandArg = z.infer<typeof commandArgSchema>;
export type DeclaredCommand = z.infer<typeof declaredCommandSchema>;

/** Built-in tool names a command may not take, because it would shadow one. */
export const RESERVED_TOOL_NAMES = new Set([
  'read_file',
  'list_dir',
  'search',
  'replace_in_file',
  'create_file',
  'run_check',
  'ask',
  'finish',
]);

/** A tool name, which is what a command key becomes. */
export const COMMAND_NAME = /^[a-z][a-z0-9_]{0,40}$/;

/**
 * The values an argument accepts, or a refusal saying why it cannot be called.
 *
 * Returns the refusal as a string rather than throwing: the caller is the agent
 * loop answering a tool call, and "the value you gave is not one of these" is a
 * message the model can act on in one turn where an exception is not.
 */
export function checkCommandArg(name: string, arg: CommandArg, value: unknown): string | null {
  if (value === undefined || value === null || value === '') {
    if (arg.optional === true) return null;
    return `refused: ${name} is required, and must be ${describeArg(arg)}`;
  }
  if (typeof value !== 'string') {
    return `refused: ${name} must be a string, and must be ${describeArg(arg)}`;
  }
  if (arg.values !== undefined) {
    if (!arg.values.includes(value)) {
      return `refused: ${name} is ${JSON.stringify(value)}, which is not one of: ${arg.values.join(', ')}`;
    }
    return null;
  }
  if (arg.pattern !== undefined) {
    let regex: RegExp;
    try {
      regex = new RegExp(arg.pattern);
    } catch {
      // The workspace declared a pattern that is not one. Refusing here means a
      // typo in a config file cannot be worked around by guessing a value.
      return `refused: the workspace's own pattern for ${name} is not a regular expression`;
    }
    if (!regex.test(value)) {
      return `refused: ${name} is ${JSON.stringify(value)}, which does not match ${arg.pattern}`;
    }
    return null;
  }
  return `refused: the workspace declares no values or pattern for ${name}, so it cannot be called`;
}

/** How an argument is described to the model, in a refusal and in the tool list. */
export function describeArg(arg: CommandArg): string {
  if (arg.values !== undefined) return `one of: ${arg.values.join(', ')}`;
  if (arg.pattern !== undefined) return `a string matching ${arg.pattern}`;
  return 'an argument the workspace did not constrain';
}

export interface BuiltCommand {
  /** The argv, ready to spawn. Never built here: see `commandArgv`. */
  command: string;
  args: Record<string, string>;
}

/**
 * The argv for one call, or a refusal.
 *
 * Every placeholder must be a whole element and every value must have passed
 * `checkCommandArg` already, so this only has to assemble. It refuses rather
 * than throws for the same reason as above: the caller is answering a tool call.
 */
export function commandArgv(
  command: DeclaredCommand,
  given: Record<string, unknown>,
): { argv: string[] } | { refusal: string } {
  const declared = command.args ?? {};
  const args: Record<string, string> = {};

  for (const [name, arg] of Object.entries(declared)) {
    const refusal = checkCommandArg(name, arg, given[name]);
    if (refusal !== null) return { refusal };
    if (given[name] !== undefined && given[name] !== null && given[name] !== '') {
      args[name] = String(given[name]);
    }
  }

  // An argument the command never declared. Refused rather than ignored, so a
  // model that invents `--force` is told so instead of quietly not getting it.
  for (const name of Object.keys(given)) {
    if (!(name in declared)) {
      return { refusal: `refused: ${name} is not an argument of this command` };
    }
  }

  const argv: string[] = [];
  for (const part of command.run) {
    const whole = /^\{([A-Za-z0-9_]+)\}$/.exec(part);
    if (whole === null) {
      // Splice detection, on purpose. A `{name}` that is not the whole element
      // is a config mistake: it would mean a model-chosen string having one end
      // of it checked and the other end pasted into an argv.
      if (part.includes('{')) {
        return {
          refusal: `refused: the workspace's command has ${part} in it, and a placeholder must be a whole argument`,
        };
      }
      argv.push(part);
      continue;
    }
    const name = whole[1] as string;
    const value = args[name];
    if (value === undefined) {
      if (declared[name]?.optional === true) continue;
      return { refusal: `refused: no value was given for {${name}}` };
    }
    argv.push(value);
  }
  return argv.length === 0 ? { refusal: 'refused: the command has no argv' } : { argv };
}

/**
 * The output of a command, trimmed to what the caller asked to keep.
 *
 * A pattern that matches nothing leaves the output alone rather than emptying
 * it: "I asked to keep the failures and there are none" has to look like a pass,
 * and an empty result would read as "this command printed nothing", which is a
 * different and much more worrying thing.
 */
export function trimOutput(text: string, keep: string | undefined, context = 2): string {
  if (keep === undefined) return text;
  let regex: RegExp;
  try {
    regex = new RegExp(keep);
  } catch {
    return text;
  }
  const lines = text.split('\n');
  const wanted = new Set<number>();
  for (const [at, line] of lines.entries()) {
    // Matched with its colour codes taken out. A test runner that colours its
    // output puts an escape before `FAIL` or `Error`, so a pattern anchored at
    // the start of a line matched nothing, the whole output came back, and on
    // a long one the failure was past where anyone reads.
    if (!regex.test(line.replace(ANSI, ''))) continue;
    for (let near = Math.max(0, at - context); near <= Math.min(lines.length - 1, at + context); near += 1) {
      wanted.add(near);
    }
  }
  if (wanted.size === 0) return text;
  const kept: string[] = [];
  let gap = false;
  for (const [at, line] of lines.entries()) {
    if (wanted.has(at)) {
      if (gap && kept.length > 0) kept.push('[...]');
      kept.push(line);
      gap = false;
    } else {
      gap = true;
    }
  }
  return kept.join('\n');
}

/** A terminal colour or cursor code, which a pattern should never have to spell. */
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

/**
 * Why a command's output does not prove it did anything, or null when it does.
 *
 * See `expect` on the schema. A pattern that is not a regular expression counts
 * as unproven rather than as a pass: a typo in a config file must not be able to
 * turn into a green tick.
 */
export function unproven(command: DeclaredCommand, output: string): string | null {
  const expected = command.expect;
  if (expected === undefined) return null;
  let regex: RegExp;
  try {
    regex = new RegExp(expected);
  } catch {
    return `this command's expect pattern is not a regular expression, so it can never pass: ${expected}`;
  }
  if (regex.test(output)) return null;
  return (
    `nothing it printed matches /${expected}/, and this workspace says a run that prints nothing ` +
    `matching that has not proved anything — so it does not count as a pass`
  );
}

/**
 * What a task file may say about a command the workspace declared.
 *
 * The gap this closes: a workspace lists the test targets it knows about, and a
 * task that owns one crate could only ever run those four. The list is a fact
 * about the project and which of them a run may touch is a fact about the line
 * of backlog, so the task says so.
 *
 * The argv is deliberately **not** overridable. A task narrows what a command
 * may be pointed at; it does not get to invent a command. Everything dangerous
 * about this mechanism lives in the argv, and it stays in the workspace where
 * the project can be read as a whole.
 */
export const commandArgOverrideSchema = z
  .object({
    values: z.array(z.string().min(1)).min(1).optional(),
    pattern: z.string().min(1).optional(),
    optional: z.boolean().optional(),
  })
  .strict();

export const commandOverrideSchema = z.object({ args: z.record(commandArgOverrideSchema) }).strict();

export type CommandOverride = z.infer<typeof commandOverrideSchema>;

export interface MergeProblem {
  path: string;
  message: string;
}

/**
 * A workspace's commands with a task's overrides folded in.
 *
 * Refuses rather than ignores, at every step, because every way of getting this
 * wrong is silent: an override naming a command that does not exist would do
 * nothing, an override naming an argument that does not exist would do nothing,
 * and a narrowed command that ends up with no constraint at all would turn into
 * a shell. All three are config mistakes and all three are said out loud when
 * the task is read.
 */
export function mergeCommands(
  declared: Record<string, DeclaredCommand>,
  overrides: Record<string, CommandOverride>,
): { commands: Record<string, DeclaredCommand> } | { problems: MergeProblem[] } {
  const problems: MergeProblem[] = [];
  const commands: Record<string, DeclaredCommand> = { ...declared };

  for (const [name, override] of Object.entries(overrides)) {
    const base = declared[name];
    if (base === undefined) {
      problems.push({
        path: `commands.${name}`,
        message: `this task narrows a command called ${name}, which the workspace does not declare`,
      });
      continue;
    }

    const args: Record<string, CommandArg> = { ...(base.args ?? {}) };
    for (const [arg, patch] of Object.entries(override.args)) {
      const was = base.args?.[arg];
      if (was === undefined) {
        problems.push({
          path: `commands.${name}.args.${arg}`,
          message: `${name} has no argument called ${arg}`,
        });
        continue;
      }
      // One constraint or the other, never both: `checkCommandArg` prefers
      // `values`, so a narrowed command carrying the workspace's old `pattern`
      // alongside it would quietly ignore the narrowing.
      const values = patch.values ?? (patch.pattern === undefined ? was.values : undefined);
      const pattern = patch.pattern ?? (patch.values === undefined ? was.pattern : undefined);
      if (values === undefined && pattern === undefined) {
        problems.push({
          path: `commands.${name}.args.${arg}`,
          message: 'that leaves the argument with no values and no pattern, which is a shell by another name',
        });
        continue;
      }
      args[arg] = {
        description: was.description,
        ...(values === undefined ? {} : { values }),
        ...(pattern === undefined ? {} : { pattern }),
        ...((patch.optional ?? was.optional) === undefined
          ? {}
          : { optional: (patch.optional ?? was.optional) as boolean }),
      };
    }
    commands[name] = { ...base, args: Object.keys(args).length === 0 ? undefined : args } as DeclaredCommand;
  }

  return problems.length > 0 ? { problems } : { commands };
}
