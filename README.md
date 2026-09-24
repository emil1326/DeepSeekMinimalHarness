# Emil's DeepSeek Harness

So I got a DeepSeek key and the idea is simple: Claude writes a small, exact plan,
DeepSeek does the typing, and Claude checks the result before anything gets
committed. Wayyy cheaper than burning Claude usage on implementation.

The catch is you don't just hand a model a shell and hope. So this is a harness
where DeepSeek gets a handful of tools I wrote myself, and that's it. No shell, no
network, no key. It's the Python prototype (`legacy/dsx.py`) grown up into a
daemon, a CLI and a UI, because the prototype could only do one thing at a time
and I couldn't watch it work.

## What DeepSeek is allowed to do

- **Read** files inside the worktree you give it. Not `.git`, `target`, `node_modules`, `_private`, `dist`, or anything that looks like a secret.
- **Change** only the files you list in the task, by exact-match replace. Build scripts, manifests, lockfiles, configs, CI and shell scripts get refused even if you allow them by mistake.
- **Run checks** by name. The profile decides what each name actually runs, the model never gets to pass an argument. Keep profiles to static checks (typecheck, lint, formatter), nothing that runs the code it just wrote.
- **Format** its files through the profile's formatters, so it never has to guess what prettier is unhappy about. (It did guess once. It reverted its own correct work trying. Hence this.)
- **Ask** you a question and wait for an answer, when the task is genuinely ambiguous.
- **Finish** with a summary.

Reads are checked on the real path, so a symlink or a Windows junction can't point
outside. The profile and the harness both have to live outside the worktree,
otherwise the model could edit its own rules, and it refuses to start if they
don't. Check processes get the secrets stripped out of their environment. At the
end, `git status` is compared with the allowed files and anything stray is
reported loudly.

### "Static" checks are not always static

Worth knowing, because it is the one place this design is softer than it looks.
A check runs a program with your privileges, and some of those programs run code
that is sitting in the repository:

- `cargo check` and `cargo clippy` build every crate in the workspace, and a
  **proc-macro crate's code is executed during that build**. So a task may not
  allow a file inside a proc-macro crate, and it will refuse to start if it does.
  Nothing else in a Rust workspace is affected.
- **Prettier, ESLint, Babel and Stylelint** resolve the plugins and configs they
  are told about, and a JavaScript config file is itself a program. So those
  config files are refused too: `.prettierrc*`, `.eslintrc*`, `.babelrc*`,
  `.stylelintrc*`, `*.config.*` and the rest.
- **npm and yarn** read `.npmrc` and `.yarnrc*` before fetching anything, so
  those are refused as well.

What that does not cover is a check whose program lives in the worktree and is
not named by any of those: a `Makefile` target, a `setup.py`, a test runner that
loads your source, a build script in a language nobody wrote a rule for. A name
list can only ever be as complete as the last person's imagination. If you point
a profile at something that executes the repository, the sandbox will not save
you from it.

Reads are checked on the real path, so a symlink or a Windows junction can't point
outside. The profile and the harness both have to live outside the worktree,
otherwise the model could edit its own rules, and it refuses to start if they
don't. Check processes get the secrets stripped out of their environment. At the
end, `git status` is compared with the allowed files and anything stray is
reported loudly.

## Getting it running

```
npm install
npm run build
```

The key lives in `~/.deepseek/api_key`. Just the key, nothing else.

## Working on it

```
npm run dev
```

Rebuilds on save, restarts the daemon when its code changes, and serves the UI
with hot reload on `http://localhost:5173`. It takes over your real daemon, so it
interrupts whatever was running; `-- --home X` gives it one of its own instead.
A save in the UI is instant, a save in the daemon's code is about a second, and
both beat the 14 seconds of running `npm run build:server` by hand. How it works
and what it gets wrong is in `docs/dev.md`.

If `http://localhost:5173` is not how you want to type it, `uiHosts` in the
harness home's `config.json` puts it on a name of your own, `EmilsHarnessUI`
say. Two steps, and the first one needs an administrator.

Point the name at this machine, in an elevated shell:

```powershell
Add-Content "$env:SystemRoot\System32\drivers\etc\hosts" "127.0.0.1`tEmilsHarnessUI"
```

(On Linux or macOS that is the same line in `/etc/hosts`:
`echo "127.0.0.1 EmilsHarnessUI" | sudo tee -a /etc/hosts`.)

Then name it in the config, `%LOCALAPPDATA%\EmilsDeepSeekHarness\config.json` on
Windows. The daemon writes that file the first time it runs, so start it once if
it is not there yet:

```json
{ "prices": {}, "uiHosts": ["EmilsHarnessUI"] }
```

`prices` is an override, and an empty one is the normal state: the harness knows
DeepSeek's published prices, including the cheaper rate for input served from its
cache, and works out what each call cost from the hour it was made. Name a model
in there — `{ "deepseek-flash": { "inputPerMillion": 0.3, "outputPerMillion": 1.2 } }`
— and that figure is used for it instead, which is how to correct a price or
price a model the harness has never heard of.

Nothing needs any of this, mind. `localhost:5173` is the default and works out of
the box; the name only changes what `npm run dev` and `dsh ui` open. `docs/dev.md`
has the details, and the three ways it can go wrong.

## Using it

A task is a JSON file:

```json
{
  "name": "mark-timeouts",
  "worktree": "F:/vsCode/esap-ds-1",
  "profile": "F:/vsCode/DeepSeekMinimalHarness/profiles/esap.json",
  "model": "deepseek-flash",
  "allow": ["ui/mark.spec.ts"],
  "checks": ["typecheck", "prettier"],
  "task": "Give mark.spec.ts's three polls a timeout of their own...",
  "limits": { "turns": 12, "wallSeconds": 900, "outputTokens": 40000, "costUsd": 0.05 }
}
```

`costUsd` is the one to think about: it is the only limit counted in the thing
you are actually spending, five cents by default. The agent is told when a fifth
of any limit is left, so it can finish what it is on, ask for more room, or stop
and say what is left — rather than being cut off mid-file.

## The workspace, which is the bit that makes it usable

A task file is one backlog line. There are things that are true of the _project_
and were being copied into every task file by hand — the same rules, the same
check list, the same "here is how you run a test" — and every copy was a chance
to lose one.

So a project gets one file, found by walking up from the worktree. This one is
`profiles/esap.workspace.json`, a worked example:

```json
{
  "name": "esap",
  "model": "deepseek-flash",
  "profiles": { "default": "profiles/esap.json" },
  "defaultProfile": "default",
  "env": { "CARGO_TARGET_DIR": "{worktree}-target" },
  "rules": "esap.rules.md",
  "soft": ["ui/*.spec.ts"],
  "setup": [{ "run": ["cargo", "build", "-p", "emils-planner-avoid"] }],
  "onAsk": { "run": ["node", "notify.mjs"] },

  "commands": {
    "run_test": {
      "description": "Run one Rust test target that this task owns.",
      "args": { "target": { "description": "a target", "values": ["plain-core:comments"] } },
      "run": ["cargo", "test", "-p", "{target}"],
      "timeoutSeconds": 90,
      "keep": "^(error|FAIL|test result)"
    }
  }
}
```

**`commands` is the one that matters.** It is how the agent gets to run the
project's own tests, and the whole point is that **the harness does not know what
a test is.** `commands.ts` contains no `cargo`, no `vitest`, no `playwright`;
every name in it came from a file somebody wrote. One mechanism covers running
tests, running a single UI spec, and running project scripts.

The security decision, stated plainly: an argument must be a **closed set**
(`values`, or a `pattern` it must match whole), and a placeholder must be a
**whole argv element**. Your test command's argv is assembled from arguments the
model chose, and `--target-dir=../../..` is an argument rather than a path the
sandbox can see. A free-text argument would hand that back one layer up, so an
unconstrained one is refused when the workspace is _read_ — not when the model
first calls it.

A workspace can live inside the worktree, because its own filename is on the
never-write list. The rule that protects a config was never "keep it outside the
worktree"; a check can write anywhere its process reaches. It is that no tool the
agent can call will touch the name.

`dsh tools <task.json>` lists exactly what that run gets, project commands
included. Everything else in the file — `rules`, `soft`, `setup`, `onAsk`,
`env` — is written up in `docs/feedback/REPONSES_AUX_14_POINTS.md`.

Then:

```
dsh run task.json          start it and watch it until it ends
dsh run task.json --json   the same, one JSON event per line
dsh ui                     open the UI, already logged in
```

The daemon starts itself the first time, on a random port, and stays up. Killing
`dsh run` kills the agent, including every check process it started. Ctrl+C asks
politely first.

Because it streams, whoever launched it can talk to it mid-run:

```
dsh send <run> "also rename the constant"    arrives at the next turn
dsh reply <run> "the ts one"                 answers the question it's stuck on
dsh cancel <run>                             stop it and everything it started
dsh list | show <run> | logs <run> | diff <run> | stats
dsh timings [run]                            where the time actually went
```

And the four that are about the run rather than about watching it:

```
dsh report <run>                 what happened, for somebody who did not watch
dsh patch <run> [--out f.patch]  the run's changes as a patch for git apply --3way
dsh tag <run> landed|fixed|dropped --note "…"
                                 what happened to the work, after your own gate
dsh worktree new <name> --from <ref>    a worktree to run in, node_modules linked
dsh worktree reset <name> <ref>         put it back, refusing if a run is going
```

`dsh tag` is the one that changes what you can decide. `dsh stats` prints how
runs ended, and beside it what happened to the work afterwards, per model and per
project, with a cost per line that landed untouched:

```
MODEL               PROFILE        RUNS  FIN  LIMIT FAIL  LANDED FIXED DROPPED  LINES   $ PER LINE
deepseek-flash      esap.json        19    9      8    0       1     1       1     10      $0.0006
```

Only `landed` counts towards the cost per line. A run tagged `fixed` needed you
to finish it, so its lines are not this thing's output, and counting them would
make the one figure that matters flatter itself. An untagged run shows `-` rather
than `0`: nobody has judged it, which is not the same as it having produced
nothing.

That's built for how Claude works: it runs `dsh run` in the background, reads the
output, answers questions with a second command, and kills the job, which cancels
the agent properly.

## Watching it

`dsh ui` opens a page with every agent and a live view of what it's doing: the
conversation as it streams, tool calls folded away with their arguments and
results, check output, questions waiting for an answer with a reply box, and a
message box to tell the agent something. A config tab shows the task exactly as
the run used it, and a diff tab shows the worktree.

Every model call is measured in passing, no separate benchmark: time to first
token, speed over the whole call, and DeepSeek's cache hits. `dsh stats` adds them
up per model, with a cost column, and `dsh limits <run>` says what a run has used
of each of its budgets — dollars included, since that is the one anybody means.

Two things worth knowing about those numbers, because I got them wrong first:

- **The speed to look at is output tokens over the whole call.** That is the
  number a vendor advertises. There is also a decode-only figure, one click in,
  and it is usually higher and often blank: a call can spend six seconds waiting
  for its first token and one second decoding, so quoting the decode rate would
  claim 1229 tokens a second for a call that delivered 183.
- **The model thinks, and you pay for that.** Most of the billed output tokens
  are a reasoning channel that arrives before the answer. It shows up as a
  collapsed block under the turn it belongs to rather than being thrown away,
  and `dsh run --thinking` prints it as it streams.

## Where the time went

A run is mostly the model waiting to be read, so "how long did this take" is not
the interesting question. The interesting one is whether any of the rest of it is
slower than it should be, which nothing could answer until every call site in the
harness got a stopwatch. So they did:

```
dsh timings            every run added up
dsh timings <run>      one run, which is the per-chat view
```

The UI has the same thing as a `timing` tab on a run, and a folded-away table
under the agents list for all of them.

A few minutes of watching it turned up two things I would not have guessed:
`matchesGlob` builds a fresh `RegExp` for every directory entry it tests against
five pattern lists, and `resolveExecutable` walks `PATH` with a `statSync` per
candidate before any check can start. Both are still in there; they are
measurable now, which they were not before.

What the numbers mean, because a table like this is easy to misread:

- **Count, mean and p95 for each name**, so a call site that is fine on average
  and occasionally takes a second stands out. That is the one a person notices.
- **Share** of the run's own wall clock, model waiting included. Thirty lines of
  code at 12 ms is nothing; the same 12 ms on every one of 900 calls is not.
- **Bytes**, where a call has a size. A read of 4 kB that costs 3 ms is a fixed
  cost and there is nothing to fix. A read of 2 MB that costs 3 ms is fine, and
  the rate column is what tells the two apart.
- The shares **overlap on purpose**: `worker.tool.read_file` contains
  `core.sandbox.readFile`, which contains `core.sandbox.resolve`. They are not a
  partition and they do not add up to 100%.

Readings are flushed to the daemon once per turn, so a run that gets killed
still reports the turns it managed, and they live in `runs.db` next to everything
else rather than in a log file nobody reads.

## Checking the sandbox actually holds

```
npm test
```

The sandbox suite is the one that matters. It tries to get past every guard
without calling DeepSeek at all: `.git`, `.env`, `_private`, `target`, `../`,
absolute paths, ambiguous replaces, files it isn't allowed to touch, build
scripts it isn't allowed to touch even when allowed, and a junction pointing
outside the worktree.

It also has a control. The first version of the path normaliser stripped every
leading dot, so `.git` became `git` and `.env` became `env` and both walked
straight past the deny lists. A test puts that bug back and insists that exactly
the dot-dependent guards go red. A guard nobody has tried to get past is a guard
that might not be there, and that lstrip bug was only found by actually trying it.

## Checking the real API still matches

```
node tools/smoke.mjs
```

One real streaming call, with a tool on offer, that checks the three things
everything else assumes: that usage comes back at all, that
`prompt_cache_hit_tokens` is really spelled that way, and that tool calls stream
with their arguments reassembling properly. Every other test in here runs against
a fake server, which asserts what I believe DeepSeek does rather than what it
does. This is the one that would notice if that changed.

## Poking at the UI without spending a token

```
node tools/preview.mjs
```

Builds a throwaway worktree in a temp folder, points a private daemon at a fake
DeepSeek that plays a scripted run, and prints a URL. Nothing it does touches your
real key or your real harness folder.

## Why not just point Claude Code at DeepSeek?

Tried that first, headless with `--bare` and auto-accepted edits. The permission
classifier blocked it as an unsafe agent, and honestly it was right: `--bare`
skips your hooks and settings, which are the whole safety net. This way the rules
are small enough to read in one go.

## What's where

```
packages/core     the sandbox, the schemas, the DeepSeek client, the metrics
packages/worker   the agent loop, one child process per run
packages/daemon   HTTP + WebSocket, the supervisor, SQLite, serves the UI
packages/cli      the dsh command
packages/ui       the React front end
profiles/         the check profiles (outside any worktree)
legacy/           dsx.py and its tests, kept until the port passed them
tools/dev.mjs     the dev loop
tools/preview.mjs a scripted run to look at the UI with
docs/api.md       the daemon's API
docs/dev.md       the dev loop, and what it restarts
PLAN.md           what this was meant to be, and whether it got there
```

The UI's palette is lifted off my own site, [emils-work.freesite.online](https://emils-work.freesite.online),
so the two look like they came from the same person.
