# The dev loop

```
npm run dev
```

One command. It builds once, starts the daemon, starts Vite, and then watches
everything. Save a file and the thing that runs your change has it.

```
npm run dev -- --no-ui      daemon and workers only, no Vite
npm run dev -- --no-open    do not open a browser
npm run dev -- --home X     a scratch harness home instead of the real one
```

By default it takes over the **real daemon**. It stops whatever is on
`daemon.json` and becomes that daemon, so `npx dsh list` in another terminal
finds it through the same file and runs the code you just saved. The cost of
that is honest and worth knowing before you run it: **starting the loop
interrupts any run that was going**, because a run's worker is a child of the
daemon. Use `--home` when you want a `runs.db` and a `daemon.json` of your own.

## What it does

| Piece                             | How                                                     | Speed                                  |
| --------------------------------- | ------------------------------------------------------- | -------------------------------------- |
| `core`, `worker`, `daemon`, `cli` | `tsc --watch --incremental`, one per package            | ~1 s for the first package, less after |
| `ui` types                        | `tsc --watch --noEmit`, because Vite does not typecheck | ~1 s                                   |
| the daemon                        | restarted when built JavaScript changes                 | ~1 s, once per save                    |
| the UI                            | Vite dev server, HMR, proxying the API to the daemon    | ~350 ms to start, then instant         |

A save in `packages/ui/src` is the fast path: Vite replaces the module and
nothing restarts. A save in the daemon's own code is the slow path, and it is
still about a second.

For comparison, `npm run build:server` — what you would otherwise run by hand —
takes about **14 s** on this machine. Nearly all of that is `npx` starting up
four times and each `tsc` building a program from cold. The loop uses the local
`node_modules/typescript/bin/tsc` directly and keeps the programs warm, which is
where the second comes from.

## Why `dist/` is still in the loop

The packages import each other through `node_modules` symlinks that resolve to
`dist/index.js`, and the supervisor `fork`s the worker from a path under
`dist/`. Running the sources directly would need either a resolver hook for
`.js` imports that point at `.ts` files, or a `development` export condition in
every package's `exports`.

Two things ruled both out. Node 22's own type stripping is on by default
(`process.features.typescript === 'strip'`) and it still does **not** map
`./loop.js` to `./loop.ts`, so the sources do not run as they are written.
`tsx` and `esbuild` are not dependencies here. Keeping `dist/` hot costs about a
second and adds no new dependency, so that is what this does.

## What restarts what

`packages/core`, `packages/worker` and `packages/daemon` are what the running
daemon loads. A change to any of their built `.js` files restarts it.
`packages/cli` is **not** on that list: the CLI runs from whatever terminal you
started it in, so it picks up your change the next time you press enter.

Two details that are easy to get wrong, and are handled:

- **Only changed bytes restart anything.** `tsc --watch` re-emits all of its
  output on its first pass whether or not anything changed. Watching for writes
  alone means the daemon restarts twice at startup, for nothing. The loop
  digests the built `.js` files and compares, so an identical rewrite is a
  no-op, and so is a source map or a `.d.ts`.
- **The port moves.** The daemon binds a random free port each time it starts,
  so a restart gives it a new one. Vite's proxy target is fixed when Vite
  starts, so Vite is restarted too — around 400 ms, and the browser reloads.
  This is the one rough edge in the loop, and it is the price of a random port.

## The UI's proxy

`tools/vite.dev.config.mjs` is only used by `npm run dev`; the real build is
still `packages/ui/vite.config.ts`. The proxy does two things that are not
optional:

- rewrites `Host` to `127.0.0.1:<daemon port>`, because the daemon only answers
  its own host;
- rewrites `Origin` the same way, because the daemon refuses any origin that is
  not its own, and from Vite the UI's origin is `localhost:5173`.

Without the second one the UI logs in and then sees nothing but 403s. The
WebSocket routes carry `ws: true`, which is what makes the live view work at all
through the proxy; `npm run dev` was checked against `/events` upgrading
successfully, because a broken upgrade there fails quietly.

The proxy is the one place allowed to speak for the daemon, and it does not
weaken anything: a foreign `Origin` sent straight to the daemon is still refused
(`403`), and through the proxy the session cookie is `SameSite=Strict`, so a
cross-site page still gets a `401`.

## Signing in

`npm run dev` prints a one-time URL:

```
sign in  http://localhost:5173/ui/session?ticket=...
```

That is the normal login, just rewritten to the Vite origin. The ticket is good
once and for a minute.

## Gotchas

- **Deleting or renaming a source file leaves its old `.js` in `dist/`.** `tsc
--watch` does not clean up after a file it no longer builds, so a removed
  module can linger. `npm run build:server` clears it.
- **`npm run test` never needs a build.** `vitest.config.ts` aliases the three
  packages straight to their `src/index.ts`, so tests always run the current
  source. That also means a passing test suite says nothing about whether
  `dist/` is up to date — which is the trap the loop exists to remove.
- **Ctrl+C in the loop stops everything it started**, including the daemon. If
  it is killed without running its handler, the daemon it spawned can survive;
  `npx dsh daemon stop` is the way out.

## Seeing the UI full of runs, without the loop

```
node tools/preview.mjs
```

A throwaway worktree, a fake DeepSeek playing a scripted six-turn run, and a
private daemon on its own temp home. It prints a URL like the loop does. Nothing
it does touches your real key or your real harness folder, and it spends no
tokens. Use it when you want the chat view, folded tool calls and the speed
numbers on screen without an agent doing anything real.
