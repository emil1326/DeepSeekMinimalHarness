# Where the plan got to

`PLAN.md` is the spec, kept as written. This is the honest report against it.

## Milestones

| #   | What                                                                                 | State   |
| --- | ------------------------------------------------------------------------------------ | ------- |
| 1   | Scaffold: workspaces, TS strict, eslint, prettier, vitest, one `npm run check`       | done    |
| 2   | The sandbox, ported guard for guard, with realpath, junctions and the lstrip control | done    |
| 3   | DeepSeek client: streaming, tools, abort, backoff, metrics, fake server              | done    |
| 4   | Agent loop in a worker: closed tools, `ask`, queued messages, limits, `finish`       | done    |
| 5   | Daemon: API, auth, Host and Origin checks, supervisor, SQLite, crash recovery        | done    |
| 6   | CLI: attach and stream, `--json`, `send`, `reply`, `cancel`, exit codes              | done    |
| 7   | UI: list, chat, config, diff, metrics, reply, message, cancel, live                  | done    |
| 8   | A real run through `dsh` with the UI open, and the speed numbers recorded            | not run |
| 9   | Retire the prototype: README, `legacy/`, note for Claude                             | done    |

Milestone 8 is the gap. Everything is tested against a fake DeepSeek, and the one
real call is behind `DSH_SMOKE=1`, so nothing here has spent a token yet. The
first real run wants doing with the UI open so the number the plan asks for,
generation speed against the prototype's end-to-end figure, gets written down
somewhere.

## Where this went past the plan

- **`ask` and the message queue both exist and are tested end to end**, including
  a CLI test that answers a question from a second process while the first one is
  still streaming.
- **The metrics event carries its turn number**, so the UI folds each call's
  numbers into that turn instead of printing a line per turn.
- **`DSH_SMOKE`, `DSH_HOME`, `DSH_KEY_FILE` and `DSH_BASE_URL`** exist so tests
  and the preview can run without touching the real key or the real harness home.
- **`tools/preview.mjs`** is not in the plan. It was worth having: it gave a
  scripted six-turn run to look at while doing the UI.
- **The UI is denser than the plan's "dense, calm" suggests** after a pass on it,
  because the first version buried the conversation under its own numbers.

## Deliberate deviations

- **`node:http` rather than `fastify`.** The route table is small and the plan's
  list of things to check by hand (Host, Origin, bearer, cookie, ticket) is
  clearer written directly against the request than configured through a
  framework.
- **`better-sqlite3` rather than the built-in `node:sqlite`.** Node 22's is
  still flagged experimental and prints a warning on every start.
- **Vite 8, Vitest 5, plugin-react 6.** The first pairing (Vite 6 with Vitest 2)
  put two copies of Vite in the tree, which broke typechecking on the UI config,
  and the older Vite carried a dev-server advisory. One generation, no advisory.
- **`.cmd` shims are started through `cmd.exe`** with every argument validated,
  because Windows cannot start an npm shim directly. Everything else uses no
  shell at all.
- **The UI's palette is Emil's own site**, not an invented one: same surfaces,
  `#0d6efd`, same radii, same system font stack.

## Known limits

- Cost only appears once a price table is filled into `config.json` in the
  harness home. It is not hardcoded, on purpose, because prices move.
- The event log is append-only and never pruned. Fine at this scale, and a thing
  to know about before it runs for months.
- `dsh` assumes Node 22 or later.
