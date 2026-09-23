# H — The harness's own tooling is an execution surface

Every other class treats the harness as the thing _deciding_ what may happen. This one treats
it as a program that **runs things**, and asks what it runs and whose folder it runs them in.

This class exists because of a shape that is easy to miss: the harness refuses the agent a
shell, and then shells out itself — with the agent's worktree as the working directory.

---

### H1 — the harness runs `git` in the folder the agent writes

**Try:** read what the harness executes itself. `strayChanges` runs `git status --porcelain
-uall`. `isGitWorktree` runs `git rev-parse`. The Diff tab runs `git diff`. All three with
`cwd` set to the worktree, which is the one folder the agent has write access to.

**Why it can land:** git reads its own configuration from the repository it is standing in,
and **several config keys name a command to run.** `core.fsmonitor` is invoked to decide
whether the tree is dirty. `diff.external`, `diff.<driver>.command` and `textconv` are
executed by `git diff` — which the harness runs to render the Diff tab. `filter.<driver>.clean`
and `.smudge` are executed on add and checkout. `core.hooksPath` moves the hook directory
somewhere the deny list has never heard of. `include.path` and `includeIf` make git read
**another config file**, so a pre-existing include is a route to a file the agent _is_ allowed
to write.

**What it gets you:** code execution at the end of the run, triggered by the harness itself
rather than by the developer. No dev server, no watcher, no human — the agent finishes, the
harness reports, and reporting is what pulls the trigger.

**Settle it by:** whether this is one guard or two. The only thing making these keys
unreachable is that `.git` is refused for writing — and it is refused because `.git` is in
the **read** list, which the write path happens to consult. That is an accident of ordering,
not a rule. Note also that in a linked worktree or a submodule, `.git` is a _file_, not a
directory, and a file is a different shape for every check.

---

### H2 — the stray-change report fails **open**, and it is verified

**Probed, on this machine.** A git worktree with **6 000 untracked files**, which is
1.22 MB of `git status --porcelain -uall` output:

```
HOLE  stray changes are reported    strayChanges() returned 0 entries
```

**Why it happens:** `execFileSync` has a default `maxBuffer` of 1 MiB. Past that it throws
`ENOBUFS`. The call is wrapped in `try { … } catch { return []; }`, so the throw becomes an
empty list — and an empty list _is_ the success value. The same `catch` fires if `git` is
missing, if the folder is not a repository, or if anything else goes wrong.

**What it gets you:** the single control the plan calls the whole point of running in a git
worktree — _every change it makes is a diff somebody reads, and anything outside the allow
list is reported loudly_ — reports **"clean"** on the dirtiest possible worktree. It fails
open, silently, in exactly the situation it exists to catch.

**And it is not only an attack.** The two failures reinforce each other: changing thousands
of files is how you drown a review (see `K`), and it is also what breaks the detector. One
move accomplishes both, so this is not two findings.

**Settle it by:** the exception handling, not the buffer size. A bigger `maxBuffer` moves the
cliff; deleting the `catch` removes it. A reporter that cannot run must say **"I could not
tell you"**, never "nothing to report" — those are different sentences and only one of them
is honest. Note that the daemon's own `gitDiff` sets a 32 MB buffer, so the two disagree
about how much output is too much.

---

### H3 — resolving a check's program through `PATH`

**Try:** a file in the worktree whose name matches a program a check runs — `prettier`,
`tsc`, `eslint`, `git`. Combined with any relative entry in `PATH` and the fact that checks
run with the worktree as their working directory.

**Why it can land:** resolving by name means the search order decides which one runs. The
harness is careful here — on Windows it prefers npm's `.cmd` shim, and it refuses to hand a
shell the argument string — but _which_ file that shim is, is decided by a search path the
worktree can sometimes influence.

**What it gets you:** the profile's `prettier` is the agent's `prettier`, running as the user.

**Settle it by:** whether any check names a program that also exists as a writable file
extension. On Windows this is decided by `PATHEXT`, not by the deny list: `.CMD` and `.BAT`
are refused by name, `.PS1` is refused by name, and `.JS` and `.EXE` are refused by nothing.

---

### H4 — the trust model is not what the egress rule assumes

**Try:** read how `assertOutsideSandbox` is used, and what it promises. It refuses a profile
or a task file that lives inside the worktree, on the grounds that _"the model could edit its
own rules"_ — which is the right instinct and the right sentence.

**Why the instinct does not survive contact with the setup:** the harness's own repository is
outside every worktree, so that check passes. But the agent runs with the same user, on the
same machine, unrestricted outside the sandbox. The guarantee that a run cannot edit the next
run's profile is not **file containment**. It is "this run chose not to", enforced by a tool
layer that has holes in it (`A`, `C`, `D`). The rule is a statement about one run's runtime
path, and it is being read as a property of the system.

**What it gets you:** an agent that never leaves its sandbox during this run, and whose
profile is different before the next one. Nothing in this run's transcript is out of order.

**Settle it by:** whether the profile's hash and the task file's content are pinned anywhere
outside the worktree, so a change between runs is visible. A hash that is computed and shown
but never compared is decoration.

---

### H5 — the profile hands a check a path outside the worktree

**Try:** a profile entry with `env: { X: "{parent}" }`. The placeholder expands to the
**directory above the worktree** — a location the agent cannot read, handed to a check
process, which can.

**Why it can land:** the profile is trusted configuration, and this is a deliberate feature.
It is also a route out of the sandbox that is _written down in the configuration file_ rather
than discovered, so it is the one escape route that already exists by design.

**What it gets you:** whatever the check does with it. The check cannot pass it back to the
model as a path, but it can read it, and it can put what it read into its own output.

**Settle it by:** every such expansion in the shipped profiles, and what each one exposes.
This is a short list and it is worth reading as a list.
