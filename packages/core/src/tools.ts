import type { ToolSpec } from './deepseek.js';
import { describeArg, type DeclaredCommand } from './commands.js';

/** What a run's tool set is built from. */
export interface ToolContext {
  /** The check names this run may use. */
  checkNames: string[];
  /** Commands the project declared. See `commands.ts`. */
  commands?: Record<string, DeclaredCommand>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  properties: Record<string, string>;
  required: string[];
}

function toSpec(definition: ToolDefinition): ToolSpec {
  const properties: Record<string, { type: string }> = {};
  for (const [name, type] of Object.entries(definition.properties)) properties[name] = { type };
  return {
    type: 'function',
    function: {
      name: definition.name,
      description: definition.description,
      parameters: { type: 'object', properties, required: definition.required },
    },
  };
}

/**
 * The tools, as they are handed to the model.
 *
 * Exported so that `dsh tools` and the docs can print the same list the agent is
 * given rather than a second copy of it that drifts. The catalogue below is the
 * only thing that knows how to render them; this is the only thing that knows
 * what they are.
 */
export function toolDefinitions(context: ToolContext): ToolDefinition[] {
  const checkNames = context.checkNames;
  const checks = [...checkNames, 'format'];
  return [
    {
      name: 'read_file',
      description: 'Read a file under the repository, with line numbers.',
      properties: { path: 'string', start: 'integer', end: 'integer' },
      required: ['path'],
    },
    {
      name: 'list_dir',
      description: 'List a directory under the repository.',
      properties: { path: 'string' },
      required: [],
    },
    {
      name: 'search',
      description: 'Search file contents under a directory with a regular expression.',
      properties: { pattern: 'string', path: 'string' },
      required: ['pattern'],
    },
    {
      name: 'replace_in_file',
      description: 'Replace text that occurs exactly once in an allowed file.',
      properties: { path: 'string', old: 'string', new: 'string' },
      required: ['path', 'old', 'new'],
    },
    {
      name: 'create_file',
      description: 'Create a new allowed file.',
      properties: { path: 'string', content: 'string' },
      required: ['path', 'content'],
    },
    {
      name: 'run_check',
      description:
        (checkNames.length === 0
          ? 'Run a named check from the profile, or `format`. '
          : `Run a named check: ${checks.join(', ')}. `) +
        'format applies the formatters to the files you may change, so never hand-edit for a formatter.',
      properties: { name: 'string' },
      required: ['name'],
    },
    {
      name: 'ask',
      description:
        'Ask the person who launched you a question, and stop until they answer. ' +
        'Use it when the task is genuinely ambiguous and a wrong guess would waste the turn.',
      properties: { question: 'string' },
      required: ['question'],
    },
    {
      name: 'finish',
      description: 'Stop, with a short summary of what changed and anything not done.',
      properties: { summary: 'string' },
      required: ['summary'],
    },
    // The project's own commands, last, after the tools the harness guarantees.
    // Each one is described from the workspace file, so the model is told what
    // this project means by a target name without the harness knowing either.
    ...Object.entries(context.commands ?? {}).map(([name, command]) => ({
      name,
      description: describeCommand(command),
      properties: Object.fromEntries(Object.keys(command.args ?? {}).map((arg) => [arg, 'string'])),
      required: Object.entries(command.args ?? {})
        .filter(([, arg]) => arg.optional !== true)
        .map(([arg]) => arg),
    })),
  ];
}

/**
 * A declared command, told to the model in its own terms.
 *
 * The argument list is the load-bearing part: a model that is told a target must
 * be one of four names gets it right, and one that is told "a test target"
 * guesses, calls the tool, is refused, and spends the turn anyway.
 */
function describeCommand(command: DeclaredCommand): string {
  const described = Object.entries(command.args ?? {}).map(
    ([name, arg]) =>
      `${name} (${describeArg(arg)}${arg.optional === true ? ', optional' : ''}): ${arg.description}`,
  );
  const body = command.description.trim();
  const args = described.length === 0 ? '' : `\nArguments: ${described.join('; ')}.`;
  return `${body}${args}`;
}

export function toolSpecs(context: ToolContext): ToolSpec[] {
  return toolDefinitions(context).map(toSpec);
}

/** One tool, as a person reads it. */
export interface CatalogueEntry {
  name: string;
  description: string;
  /** The arguments, as a single line. */
  args: string;
}

/**
 * Every tool an agent can call, for `dsh tools` and the docs.
 *
 * Deliberately derived from the same definitions the model is handed, so the
 * index a person reads and the index the agent works from cannot disagree. A
 * documentation page listing a tool that no longer exists is worse than none.
 */
export function toolCatalogue(context: ToolContext): CatalogueEntry[] {
  return toolDefinitions(context).map((definition) => ({
    name: definition.name,
    description: definition.description,
    args: Object.entries(definition.properties)
      .map(([name, type]) => `${name}: ${type}${definition.required.includes(name) ? '' : '?'}`)
      .join(', '),
  }));
}

/** The tools the harness itself provides, whatever a project declares. */
export const BUILTIN_TOOL_NAMES = [
  'read_file',
  'list_dir',
  'search',
  'replace_in_file',
  'create_file',
  'run_check',
  'ask',
  'finish',
] as const;

/**
 * Every tool this run can call: the built-ins, plus the project's commands.
 *
 * A function rather than a `Set`, because the set is no longer a property of the
 * harness. Two runs against two projects have different tools, and a constant
 * here would have been the one place a project-specific name crept in.
 */
export function toolNames(context: ToolContext): Set<string> {
  return new Set([...BUILTIN_TOOL_NAMES, ...Object.keys(context.commands ?? {})]);
}

export const SYSTEM_PROMPT = `You implement one small, fully specified change in an existing repository, inside a sandbox.

You can read anything in the repository, but you may change only the files the task lists. You have no shell.
You can run named checks; you cannot run tests.

Work like this: read the files you need, make the smallest correct change with replace_in_file, run the checks that
apply, fix what they report, then call finish. Match the surrounding code's style, naming and comment density. Do not
reformat or reorder code you were not asked to change. For formatting, never hand-edit to satisfy a formatter: run the
format check, which applies the formatters to your files, then re-run the checks.

Reading is cheap and can be batched: if you need several files, ask for them all in one turn, and reads, listings and
searches run together rather than one after another. Edits always apply in the order you send them, so a read after an
edit sees the edit.

When a tool refuses, read what it says. A replace that did not match tells you which line differs and what the file
actually has there, so copy that text rather than guessing again, and never re-read a file you were just told the
contents of. If a check still fails and you cannot see why after two attempts, stop and call finish saying so. Never
undo an edit you made correctly in order to make a check pass. Once every check that applies passes, call finish
straight away. Do not re-read work you have already finished. If something in the task cannot be done within these
limits, say so in finish rather than working around it.

Use ask when the task is genuinely ambiguous and guessing would waste a turn. It stops you until the person who
launched you answers, so use it sparingly and be specific about what you need.

This project may declare commands of its own, shown to you as tools. They are how you run its tests, its formatters
and anything else it says you may run, and each one only accepts the arguments the project declared. When a command
tells you the values it takes, pass one of those; do not invent a target and do not reach for a shell, because there
is none.`;

/**
 * The task text as the agent receives it.
 *
 * `rules` is the project's own notes, and it is appended rather than prepended:
 * the specific beats the general, and the task is the part that is about this
 * run. It is not put in the system prompt, because it is a different kind of
 * thing — the system prompt is what an agent is, and these are what this project
 * learned — and because a continuation replays it from the run's stored config,
 * which is what keeps it stable for the life of the run.
 */
export function taskMessage(args: {
  task: string;
  allow: string[];
  checks: string[];
  /** Files that may be changed but are outside the plan. */
  soft?: string[];
  /** The project's own notes. */
  rules?: string;
}): string {
  const lines = [args.task.trim(), '', `Files you may change: ${args.allow.join(', ')}`];
  if (args.checks.length > 0) lines.push(`Checks you may run: ${args.checks.join(', ')}`);
  if ((args.soft ?? []).length > 0) {
    lines.push(
      `Files outside the plan that you may still change if the change genuinely needs them: ${(args.soft ?? []).join(', ')}`,
      'Every change to one of those is reported, so stay off them unless the work is not correct without them.',
    );
  }
  const rules = (args.rules ?? '').trim();
  if (rules !== '') lines.push('', `Notes from this project, which apply to everything below:`, rules);
  return lines.join('\n');
}
