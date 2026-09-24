# The dev loop

```
npm run dev
```

One command. It builds once, starts the daemon, starts Vite, and then watches
everything. Save a file and the thing that runs your change has it.

```
npm run dev                 its own harness home, so nothing of yours is disturbed
npm run dev -- --no-ui      daemon and workers only, no Vite
npm run dev -- --no-open    do not open a browser
npm run dev -- --real-home  take over the real daemon instead
npm run dev -- --home X     some other harness home entirely
```

It runs against its **own** harness home by default: a `-dev` directory next to
whatever `harnessHome()` answers, so on Windows
`%LOCALAPPDATA%\EmilsDeepSeekHarness-dev`. Its own `runs.db`, its own
`daemon.json`, its own daemon on its own random port. Nothing you have running is
touched, which matters because a run's worker is a child of the daemon:
**starting the loop against the real home interrupts any run that was going.**

That used to be the default. It was the right call while the harness was being
built and the wrong one once it was being used, so it is now opt-in.

`--real-home` is the opt-in. Use it when what you want is `npx dsh list` in
another terminal finding this daemon through the same `daemon.json` and running
the code you just saved. `--home X` overrides both.

One consequence of the default worth knowing: a fresh home has no `config.json`,
so it has no UI name and no prices. The loop says so on startup and prints the
one-line copy that fixes it.

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
(`403`), and a page that is not the UI cannot get past the header checks at all.

## No signing in

There is nothing to sign in to. The daemon serves the UI, the UI talks to the
daemon, and the only callers refused are web pages that are not this one. So
`npm run dev` just prints where to go:

```
UI       http://localhost:5173
```

The daemon itself is on a fixed port — `41777` unless `config.json` says
otherwise — which is what makes the address worth bookmarking.

## Calling the UI something else

`http://localhost:5173` is the default and stays the default. To reach the UI at
a name instead — `http://EmilsHarnessUI:5173` — two things have to happen, and the
first is not something any program here can do for you.

**The name has to point at this machine.** That is a line in the hosts file, and
the file is writable by administrators only, so it needs a terminal started as
one:

```powershell
Add-Content "$env:SystemRoot\System32\drivers\etc\hosts" "127.0.0.1`tEmilsHarnessUI"
```

On Linux or macOS the same line goes in `/etc/hosts`:

```sh
echo "127.0.0.1 EmilsHarnessUI" | sudo tee -a /etc/hosts
```

Only the IPv4 line, on purpose. The daemon and Vite both bind `127.0.0.1`, so an
`::1` entry would send the browser to an address nothing is listening on. Every
other name in a typical hosts file has both lines, which makes this one the easy
trap.

**Then name it in `config.json`**, in the harness home
(`%LOCALAPPDATA%\EmilsDeepSeekHarness\config.json`):

```json
{
  "prices": {},
  "uiHosts": ["EmilsHarnessUI"]
}
```

One field, three readers, all built from the same list:

| Who        | What it does with it                                           |
| ---------- | -------------------------------------------------------------- |
| the loop   | sends the browser there, and passes the name on to Vite        |
| Vite       | adds it to `server.allowedHosts`, or answers `Blocked request` |
| the daemon | adds it to its `Host` and `Origin` allowlist, or answers `403` |

That is honest rather than elegant: a name is only reachable if the address
resolves, the dev server accepts the `Host` header, _and_ the daemon accepts that
and the `Origin`. Miss one and the failure looks like a different bug each time —
a dead page, `Blocked request`, or an empty UI behind a `401`.

Three things worth knowing before you spend an evening on it:

- **It is one name, not a wildcard.** A configured name is added next to
  `127.0.0.1` and `localhost`, never instead of them. Everything else is still
  refused, which is the whole point of the check.
- **A session belongs to one name.** The cookie is set for the host the browser
  was sent to, so signing in at `localhost:5173` does not sign you in at
  `EmilsHarnessUI:5173`: that is a second, empty session, and the UI has no login
  screen to fix it with. Run the loop again — or `npx dsh ui` — and it signs in at
  the name it now knows.
- **Vite compares the name character for character.** Browsers send the `Host`
  header lowercased, so the config lowercases the name before handing it over. A
  capital in that list is a name that can never match.

The UI name comes from `uiHosts` in _the home the loop is running against_, so a
dev home has no name unless you put one in its `config.json`. When the name does
not resolve, the loop does not stop — nothing in it needs the name, since Vite
binds `127.0.0.1` and is asked there. It says so and sends the browser to the
address that always works, instead
of to a dead one that would look like a daemon that is not running:

```
UI       http://localhost:5173
         emilsharnessui is not in the hosts file, so it is not used yet
         add "127.0.0.1 emilsharnessui" to %SystemRoot%\System32\drivers\etc\hosts, as an administrator
```

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
