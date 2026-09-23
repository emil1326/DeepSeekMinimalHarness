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
  "limits": { "turns": 12, "wallSeconds": 900, "outputTokens": 40000 }
}
```

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
```

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
token, generation speed (decode only, which is the number people mean), end to
end speed, and DeepSeek's cache hits. `dsh stats` adds them up per model.

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
