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

It is also told the whole budget **before it starts**, in minutes rather than
seconds, and told that the clock does not pause while it waits for an answer:

```
How long you have: at most 15 minutes of wall clock and 12 model calls, whichever
arrives first, and $0.05 to spend. The clock does not pause while you wait for an
answer to ask, and every command you run is on it, so spend neither on anything
you do not need. Finishing less and saying so beats being stopped mid-change.
```

Of nine real runs, seven stopped at a limit and in every case the agent had no
idea which clock was about to run out. A run that knows it has fifteen minutes
plans differently from one that assumes it has an hour — and the wall clock was
the one figure the task message never mentioned.

## The workspace, which is the bit that makes it usable

A task file is one backlog line. There are things that are true of the _project_
and were being copied into every task file by hand — the same rules, the same
check list, the same "here is how you run a test" — and every copy was a chance
to lose one.

So a project gets one file, found by walking up from the worktree. This one is
`profiles/esap.workspace.json`, a worked example — and it is loaded by a test, so
it cannot drift into being wrong:

```json
{
  "name": "esap",
  "model": "deepseek-flash",
  "profiles": { "default": "esap.json" },
  "defaultProfile": "default",
  "env": { "CARGO_TARGET_DIR": "{worktree}-target" },
  "rules": "esap.rules.md",
  "soft": ["ui/*.spec.ts"],
  "setup": [{ "run": ["cargo", "build", "-p", "emils-planner-avoid"], "timeoutSeconds": 1800 }],

  "commands": {
    "run_test": {
      "description": "Run one Rust integration test file.",
      "args": {
        "crate": { "description": "the crate", "values": ["emils-planner-core"] },
        "test": { "description": "the file's name under tests/", "pattern": "^[a-z][a-z0-9_]*$" }
      },
      "run": ["cargo", "test", "-p", "{crate}", "--test", "{test}"],
      "timeoutSeconds": 1800,
      "keep": "^(error|failures|test result)",
      "expect": "test result: ok\\. [1-9]",
      "executes": true
    }
  }
}
```

Note what is _not_ in there: `/profiles/`, twice. Every path in a workspace file
is relative to the workspace file, and an example that lives beside its profile is
exactly where that is easiest to get wrong.

**`commands` is the one that matters.** It is how the agent gets to run the
project's own tests, and the whole point is that **the harness does not know what
a test is.** `commands.ts` contains no `cargo`, no `vitest`, no `playwright`;
every name in it came from a file somebody wrote. One mechanism covers running
tests, running a single UI spec, and running project scripts.

**`expect` is the one that makes a green tick mean something.** A real workspace
declared a command to run one test by name; the name was a helper function rather
than a test, `cargo test -p core --test registry some_filter` exited **0** and
printed `0 passed; 0 failed`, and the command reported success for months of runs
while executing nothing. The exit code cannot catch that, because the exit code is
right. So a command may say what proof looks like in its own tool's words —
`test result: ok\. [1-9]` for cargo, `Tests\s+[1-9]\d* passed` for vitest — and a
call whose output does not match is reported as `[harness] not proven:` and does
not count as a pass. It is tested against the output before `keep` trims it,
because `keep` is a pattern for what a reader wants and the line that proves a
command ran is usually not interesting to read. An `expect` that is not a regular
expression fails closed: a typo in a config file must not be able to become a
green tick.

**A task may narrow a command; it may not invent one.** A workspace lists the test
targets it knows about, and which of them a task owns is a fact about the backlog
line rather than about the project:

```json
"commands": { "run_test": { "args": { "crate": { "values": ["emils-planner-core"] } } } }
```

Only the arguments are overridable, never the `run` argv, because everything
dangerous lives in the argv and it stays in the workspace where the project can be
read as a whole. An override that names a command or an argument that does not
exist is refused rather than ignored, and so is one that would leave an argument
with no values and no pattern — all three would otherwise do nothing silently.

The security decision, stated plainly: an argument must be a **closed set**
(`values`, or a `pattern` it must match whole), and a placeholder must be a
**whole argv element**. Your test command's argv is assembled from arguments the
model chose, and `--target-dir=../../..` is an argument rather than a path the
sandbox can see. A free-text argument would hand that back one layer up, so an
unconstrained one is refused when the workspace is _read_ — not when the model
first calls it.

A workspace can live inside the worktree, because its own filename is on the
never-write list, and so is the rest of `.dsh/**`. The rule that protects a config
was never "keep it outside the worktree"; a check can write anywhere its process
reaches. It is that no tool the agent can call will touch the name — and a profile
is exactly the thing the agent must not be able to edit, because a check it can
rewrite is a check that cannot refuse it.

`dsh tools <task.json>` lists exactly what that run gets, project commands
included. Everything else in the file — `rules`, `soft`, `setup`, `onAsk`,
`env` — is written up in `docs/feedback/REPONSES_AUX_14_POINTS.md`.

### The presets in `profiles/`

Those three files are not documentation. They are a working configuration for one
real project, and they are meant to be copied:

```
profiles/esap.json            a profile: the checks and the formatters
profiles/esap.rules.md        the project's standing notes, appended to every task
profiles/esap.workspace.json  the workspace, which ties the two together
```

`dsh.workspace.json` in a project, pointing at its own copies of the other two,
is the whole setup. Every `emils-planner-*` name in there is esap's and has to be
replaced — the harness has no idea what those crates are, and that is the point
rather than a limitation.

They are loaded by a test, in `workspace.test.ts`, so a file a reader copies
cannot quietly stop working. The first version of the workspace example was wrong
in six ways at once and none of them were visible by reading it: a doubled profile
path, a crate that does not exist, `crate:test` passed to `cargo -p`, a fixed
target list, a command that exited 0 having run nothing, and an `onAsk` pointing
at a script nobody had written.

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

### Watching a run without owning it

`dsh run` is a claim. It starts a run that was queued, and the run is cancelled
when the last attached connection goes away — right for whoever launched it, and
wrong for everybody else, because closing a terminal window would then cancel
somebody else's work.

```
dsh watch <run>                                    follow it, own nothing
dsh watch <run> --quiet                            only questions, limits, strays, the end
dsh watch <run> --on-question "notify-send dsh"    something tells you when it asks
dsh watch <run> --json                             events and an exit line, for a script
```

A watcher sees every event an owner does, plus the whole history it missed —
which is the normal case, because you start a run, notice it has been quiet, and
want to know why. It cannot start a run and it cannot stop one. Closing it is
just closing a window.

`--on-question` is the reason the command exists. When a workspace declares
`onAsk`, that process runs **inside the sandbox**, with a stripped environment and
no shell, because everything it executes is code somebody wrote. This runs on your
own machine, from a string you typed, so it gets a shell — the question arrives on
**stdin**, and `DSH_RUN` and `DSH_QUESTION` are in the environment for anything
that wants to answer rather than merely shout:

```sh
dsh watch run-1a2b --on-question 'while read -r q; do notify-send "dsh is asking" "$q"; done'
```

One line on stdin, so anything that reads it works: a `notify-send`, a `curl` at a
webhook, a script that logs it and answers for you.

A notifier that fails is swallowed on purpose: the watcher's job is to survive and
keep reporting, and a broken `notify-send` must not take it down with it. A
question that has already been answered is not announced, so a watcher started
after somebody replied does not send you a notification you cannot act on.

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
