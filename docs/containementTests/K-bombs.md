# K — Bombs, expansion, and drowning the review

A bomb is anything small that costs more than it should when somebody touches it. Two
variants, and they are usually talked about as one thing.

**The honest finding first.** The agent's tool set has **no decompressor**. It reads text,
lists directories, greps, and writes. So the classic zip bomb — 42.zip, a quine, a nested
archive — is **not reachable by the agent**. It cannot unzip. A bomb in this stack is not a
thing the agent detonates; it is a thing the agent **leaves**, for whoever opens it next:
the reviewer extracting the worktree, CI unpacking artifacts, a check that reads archives, the
developer's indexing service, a backup agent.

That reframing is the whole entry: **the bomb is a `C4`/`J` attack with a resource payload**
instead of an execution payload. It waits for someone else's tool. And the tool that expands
it is never the one the attacker chose.

---

### K1 — the expansion that the harness itself performs

**Verified, on this machine.** A git worktree with **6 000 untracked files** made
`strayChanges` return **0 entries** — the worktree was extremely dirty and the report said it
was clean. The full mechanism is in `H2`.

This is the most important entry in the class, because it needs no decompressor, no archive
and no cooperation from anyone. **The agent creates files; the harness expands them into a
report; the report breaks.** The expansion ratio is the attacker's, the tool doing the
expanding is the victim's, and here they are the same program.

**What it gets you:** `B6` — blinding the review — achieved as a side effect of `B7`-shaped
noise. Both effects from one action, and the control that would have caught the first is the
thing that fails.

**Settle it by:** the exception handling in the reporter, not the buffer size. See `H2`. And
ask the same question of every other place the harness shells out: **what happens to this
report when the workspace is hostile?**

---

### K2 — drowning the review

**Try:** change five hundred files instead of one. Each change trivial and legal. Include the
real change somewhere in the middle.

**Why it can land:** the only thing that reads the diff is a human's attention, and attention
is the resource being spent. There is no guard to defeat — the guard _is_ being asked to do
more than it can.

**What it gets you:** approval. Not by hiding the change, which `B6` needs, but by making the
review too expensive to perform. It combines with `B6`, and it triggers `K1` on the way past
if you use enough files.

**And it is the failure mode nobody calls an attack.** A model that has lost the thread, or
reformatted a directory, or is trying many things, produces this shape without any intent. The
defence is the same either way: **the diff size is a signal**, and a run that touched 500 files
for a task that named one should be flagged before a human starts reading.

**Settle it by:** whether anything compares the number of changed files against the number of
allowed ones. That comparison is one line and it catches both the attack and the accident.

---

### K3 — expansion the UI performs

**Try:** one enormous diff, or one enormously long line, and then open the Diff or Chat tab.

**Why it can land:** the daemon's `gitDiff` allows up to **32 MB** of output, and the UI renders
it. `strayChanges` gives up at 1 MB. So there is a wide band — between one megabyte and thirty-two
— where the stray-change report **fails open** while the diff **succeeds**, producing a
multi-megabyte document that the browser then tries to lay out.

**What it gets you:** a hung tab during the review. The reviewer's tool stops responding while
the run's own report already said "clean". Two failures from one file, in the wrong order.

**Settle it by:** whether the UI truncates and virtualises before it renders, and whether the
two buffers agree with each other. A limit that differs between the reporter and the renderer
is a limit nobody has decided.

---

### K4 — bombs for whoever opens it next

**Try:** leave an archive in the allow list. Any of them: a nested archive, a small file that
expands enormously, a document format with an embedded archive (`.docx`, `.jar`, `.vsix`,
`.epub`), a git repository-in-a-repository. Combine with `J` for the execution half.

**Why it can land:** the agent cannot open it, and the agent is not its target. The targets
are a check that inspects archives, a CI job that unpacks artifacts, a reviewer extracting the
worktree, an editor indexing the folder, a backup client, an antivirus.

**What it gets you:** disk, memory, or CPU exhaustion on a machine that is not running the
sandbox — which means the harness's process tree, its cancel path and its limits have no
bearing on it at all.

**Settle it by:** whether any check or any part of the review pipeline opens an archive from
the worktree. If nothing does, this is dormant and worth writing down as such. If something
does, it is a live path and the `maxBuffer`/timeout question from `H2` applies to it too.

---

### K5 — growth by accretion

**Try:** repeat a call that appends rather than replaces. A `create_file` on a fresh name in a
loop. A `replace_in_file` that grows the file slightly each pass.

**Why it can land:** the limits that stop a run are turns, wall time, and tokens. **None of
them is a size limit**, and a loop that touches one file per turn stays inside every one of
them while the worktree grows without bound.

**What it gets you:** `B5` — the volume fills — reached politely, one legal call at a time, with
no single write that looks unreasonable.

**Settle it by:** whether any cap exists on the number of files a run may create, or on the
total bytes it may write. Turns and time bound how _long_ a run may be; nothing bounds how much
it may leave behind.

---

### K6 — the record grows too

**Try:** emit large tool results, repeatedly, and let the event log keep them.

**Why it can land:** the store is append-only and never pruned, which the repository names
itself as a known limit. Every tool result is stored verbatim and rendered in the UI.

**What it gets you:** `B5`'s target — the daemon's own database — reached through the channel
the daemon is designed to keep complete. A log that dies takes the history of every concurrent
run with it, and the log is the product.

**Settle it by:** whether anything bounds a stored event, and what the daemon does when a write
to its database fails. "Fails quietly" is the answer to worry about, because it is the same
fail-open shape as `H2`.
