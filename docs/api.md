# The daemon's API

Plain JSON over HTTP on `127.0.0.1`, plus two WebSockets. Every request needs
the token from `daemon.json` as `Authorization: Bearer <token>`, except the two
static routes and the one-time UI session link.

Three checks run before anything else on every request and every upgrade:

- the `Host` header must be `127.0.0.1:<port>` or `localhost:<port>`
- an `Origin`, if present, must be the daemon's own
- the token must be in the `Authorization` header or the session cookie

A localhost server is reachable from any web page, so without the first two a
random site could drive agents. Without the third, so could any other program.

## HTTP

| Method | Route                      | Body                      | Returns                                          |
| ------ | -------------------------- | ------------------------- | ------------------------------------------------ |
| `GET`  | `/health`                  |                           | `{ ok, pid, port }`                              |
| `POST` | `/runs`                    | `{ taskPath, detached? }` | `201 { id, detail }`, or `400` with `problems[]` |
| `GET`  | `/runs`                    |                           | `{ runs: RunSummary[] }`, newest first           |
| `GET`  | `/runs/:id`                |                           | `RunDetail`, or `404`                            |
| `GET`  | `/runs/:id/events?after=n` |                           | `{ events: RunEvent[] }` with `seq > n`          |
| `GET`  | `/runs/:id/diff`           |                           | `{ diff, stray[] }`                              |
| `POST` | `/runs/:id/messages`       | `{ text, by? }`           | `{ ok }`                                         |
| `POST` | `/runs/:id/answers`        | `{ id?, text, by? }`      | `{ ok, id }`, or `409` when it is not waiting    |
| `POST` | `/runs/:id/cancel`         |                           | `{ ok }`                                         |
| `GET`  | `/stats`                   |                           | `{ runs, models: ModelStats[] }`                 |
| `POST` | `/ui/ticket`               |                           | `{ ticket }`, single use, 60 s                   |
| `GET`  | `/ui/session?ticket=`      |                           | `302` with the session cookie, or `403`          |
| `POST` | `/daemon/stop`             |                           | `{ ok }`, then it stops                          |
| `GET`  | `/` and `/assets/*`        |                           | the built UI, no token                           |

`by` is `claude`, `emil` or `agent`, and only decides the label in the UI. An
answer with no `id` goes to the question the run is currently waiting on.

A bad task file comes back as `400` with every problem at once, each naming the
field:

```json
{
  "error": "the task file is not valid",
  "problems": [
    { "path": "worktree", "message": "Required", "file": "F:/tasks/mark-timeouts.json" },
    {
      "path": "checks.2",
      "message": "the profile has no check called lint",
      "file": "F:/tasks/mark-timeouts.json"
    }
  ]
}
```

## WebSockets

Both take the token the same way, either as a bearer header or as `?token=` for
a client that cannot set headers.

**`WS /runs/:id/attach`** streams one run and owns it. The daemon pings every
5 s and cancels the run after 15 s with no pong, so a half-open connection (a
process killed hard, a closed terminal) still ends the agent inside the second.
If more than one client attaches, the run ends when the last one goes.

| Message                             | Meaning                               |
| ----------------------------------- | ------------------------------------- |
| `{ type: 'hello', detail, events }` | on connect, with the whole log so far |
| `{ type: 'event', event }`          | one new event                         |
| `{ type: 'bye', status }`           | the run reached a terminal status     |

**`WS /events`** is a nudge channel for the UI. Every event on every run, and
every status change, sends `{ type: 'notice', runId }`. The payload is not
included: the UI batches these for 250 ms and then refetches what changed, so a
streaming run does not push a hundred messages a second.

## Events

One append-only list per run, numbered by `seq`, and the only copy of the truth.
The chat view, the CLI stream, `dsh logs` and a resume after a restart are all
readers of it.

```ts
type RunEvent = { seq: number; runId: string; at: string } & (
  | { type: 'status'; status: RunStatus; detail?: string }
  | { type: 'turn.start'; turn: number }
  | { type: 'text.delta'; turn: number; text: string }
  | { type: 'tool.call'; turn: number; id: string; name: string; args: unknown }
  | { type: 'tool.result'; turn: number; id: string; name: string; ok: boolean; result: string }
  | { type: 'question'; id: string; question: string }
  | { type: 'answer'; id: string; answer: string; by: Speaker }
  | { type: 'message'; by: Speaker; text: string }
  | { type: 'metrics'; turn: number; call: CallMetrics; totals: RunTotals }
  | { type: 'summary'; text: string }
  | { type: 'limit'; which: 'turns' | 'wallSeconds' | 'outputTokens' | 'askSeconds'; detail: string }
  | { type: 'stray'; files: string[] }
  | { type: 'error'; message: string }
);
```

Statuses are `queued`, `running`, `waiting`, `finished`, `failed`, `cancelled`,
`interrupted` and `stopped_at_limit`. The last five are terminal, and a run that
just went quiet is not one of them: the log always ends with a terminal status,
so a reader can tell a finished run from a dead connection.

`text.delta` is streamed and arrives in small batches, so a client appends it to
the current turn's text rather than treating each one as a paragraph.

## Exit codes

`dsh run` exits `0` finished, `1` failed, `2` cancelled, `3` stopped at a limit,
`4` bad task file, `5` the daemon could not be reached.
