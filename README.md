# Emil's DeepSeek Minimal Harness

So I got a DeepSeek key, and the idea is simple: Claude writes a small, exact plan, DeepSeek does the typing, and Claude checks the result before anything gets committed. Way cheaper than burning Claude usage on implementation.

The catch is you don't just hand a model a shell and hope. So this is a tiny harness where DeepSeek gets a handful of tools I wrote myself, and that's it. No shell, no network, no key.

## What DeepSeek is allowed to do

- **Read** files inside the worktree you give it. Not `.git`, `target`, `node_modules`, `_private`, `dist`, or anything that looks like a secret.
- **Change** only the files you list with `--allow`, by exact-match replace. Build scripts, manifests, lockfiles, configs, CI and shell scripts get refused even if you allow them by mistake.
- **Run checks** by name. The profile decides what each name actually runs, the model never gets to pass an argument. Keep profiles to static checks (typecheck, lint, formatter), nothing that runs the code it just wrote.
- **Format** its files through the profile's formatters, so it never has to guess what prettier is unhappy about. (It did guess once. It reverted its own correct work trying. Hence this.)
- **Finish** with a summary.

Every call gets logged next to the task file, and at the end the harness checks git for anything changed outside the allowed files.

The profile and the harness both have to live outside the worktree, otherwise the model could edit its own rules. It refuses to start if they don't.

## Using it

The key lives in `~/.deepseek/api_key`, just the key, nothing else.

```
python dsx.py F:/vsCode/esap-ds-1 task.md --profile profiles/esap.json --allow ui/mark.spec.ts --turns 12
```

The worktree has to be a git worktree, so whatever it does is a diff you can read. After it runs: read the diff, run the real tests yourself (it can't), and only then commit.

## Checking the sandbox actually holds

```
python tests/test_sandbox.py
```

Tries to get past every guard without calling DeepSeek at all. Worth running after touching `dsx.py`, because the first version had a bug where `lstrip("./")` ate the dot off `.git` and `.env` and both walked straight past the deny list... only found it by actually trying.

## Why not just point Claude Code at DeepSeek?

Tried that first, headless with `--bare` and auto-accepted edits. The permission classifier blocked it as an unsafe agent, and honestly it was right: `--bare` skips your hooks and settings, which are the whole safety net. This way the rules are small enough to read in one go.
