# D — Getting at a credential

The key is the thing the whole design exists to keep away from the model. It lives outside
the worktree, and the model is supposed to never see it.

The token is the second prize and it is nearly as good: it is the daemon's front door, and
the daemon can start runs, read every other run's configuration, and cancel anything.

---

### D1 — reading it where it lives

**Try:** `read_file` on the key's own path, on `~/.ssh/id_ed25519`, on a sibling repo's
`.env`, on the harness home's `config.json`.

**Why it can land:** the refusal here is by **location** — the path is outside the
worktree — so this is A1, A2 and A3 wearing a different hat. There is no rule anywhere that
says "this file is a key"; there is only a rule about where a file is.

**What it gets you:** the key, and with it every other project and person that shares the
account.

**Settle it by:** the path spelling is the entire defence, so this is exactly as strong as
A is. Nothing more.

---

### D2 — the environment, filtered by name

**Try:** read every variable a check process can see. The filter is a **name** pattern
(`DEEPSEEK`, `ANTHROPIC`, `CLAUDE`, `TOKEN`, `SECRET`, `PASSWORD`, `API_KEY`, `_KEY$`), so
a secret in a variable named anything else survives, and so does any variable that merely
_points at_ where a secret is kept.

**Why it can land:** patterns match names, not meanings, and the process otherwise inherits
the user's real environment. `HOME` and `LOCALAPPDATA` alone are enough to locate the
harness home and the key file, whether or not the harness's own variables name them.
Switching from `_KEY$` to a naming convention with no "key" in it is the whole bypass.

**What it gets you:** a route to D1 and D3 that needs no traversal at all.

**Settle it by:** print the entire environment from inside a check, in a scratch home, and
mark which surviving names point at a secret or at a place one is kept. Do this on the real
machine once, in a scratch home — the answer depends on the user's environment, which the
harness does not control.

---

### D3 — `daemon.json`

**Try:** from inside a check, read `<harness home>/daemon.json`, then use whatever it holds against
the daemon.

**Result: moot, and that is the point.** This used to hold the daemon token, so the finding was
that a check which could read the home could drive the daemon — including cancelling its own run.
The harness now answers local programs with no credential at all, so there is nothing here to
steal and nothing to revoke. The file holds `{port, pid, startedAt}` and nothing else; the token,
the session cookie and the one-time login ticket are all gone. See
`packages/daemon/src/guard.ts` and `docs/api.md`.

**Why it can land:** the file is exactly where the user's own tools expect it, and a check
process runs _as that user_, with that user's environment and unrestricted filesystem access.
The sandbox's own tools cannot see it. A check is not restricted the same way. Reaching it needs
C1 or C2 first, which is why those two are the keystones of this document.

**What it gets you, now:** the port, which is the fixed default anyway — `41777`. Reading the file
buys a check a number it could have guessed. That is a real improvement over a token that never
expires and cannot be revoked, and it is worth being precise about why: a secret stored where the
caller can read it is not a secret, it is an extra step.

**It does not close C1 or C2.** A check that can reach the network or spawn a process can still
talk to the daemon, because the daemon answers local programs by design. What stops that is the
sandbox, not this file. The guard in `guard.ts` answers exactly one threat — a web page — and it
is worth keeping that separate from process containment rather than hoping one covers the other.

**Settle it by:** from a check, in a scratch home, whether the harness home is reachable and the
file is there — and what it holds. This is still worth probing, but the consequence is now a port
number rather than the daemon.

---

### D4 — a name the deny list does not recognise

**Try:** get a denied file's bytes under a name that is not denied — a hard link called
`notes.txt`, a copy, an archive, an alternate data stream, a file whose content is a key
but whose name is ordinary.

**Why it can land:** the secret rules are names (`.env`, `*.pem`, `*.p12`, `*.key`,
`api_key`, `*secret*`, `*credential*`). They cannot see content, and they cannot see a
second name for the same bytes.

**What it gets you:** the secret, with the read looking entirely ordinary in the log.

**Settle it by:** whether any content-level check exists at all, and whether hard links are
possible in the target setup (A3).

---

### D5 — reading it out of output

**Try:** a check that prints its environment, its argv, its cwd, or the contents of a config
it read. An error message from a tool that echoes a token back. A task or a profile string
that itself contains one.

**Why it can land:** check output goes back to the model verbatim and into the event log,
and the log is shown in the UI and read by the CLI. Any secret reaching stdout is now in
three places, one of which is a file on disk that is never pruned.

**What it gets you:** the secret, plus a copy that outlives the run and the machine's
good intentions.

**Settle it by:** whether anything scans check output or event payloads for key-shaped
strings before they are stored. The time to do it is before the write, not after.

---

### D6 — the neighbours

**Try:** read the adjacent worktrees, the parent directory's files, the other repositories
under the same root.

**Why it can land:** this is A1 again, and it is the reason A matters more than it looks. A
containment failure rarely reveals one carefully chosen secret. It reveals a _listing_, and
secrets get found by looking.

**What it gets you:** whatever a developer keeps beside their code, which is usually more
than they think.

**Settle it by:** the same probes as A, read as a secret question rather than a path
question.
