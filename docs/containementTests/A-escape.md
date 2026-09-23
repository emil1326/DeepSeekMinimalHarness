# A — Leaving the worktree

The worktree is the whole world. Everything here is an attempt to read or write a path
outside it, or to make two different places look like the same one.

One trap applies to all of these. **A read that misses is not a refusal.** If a probe
escapes the root and the file happens not to exist, a checker that only looks for "it
threw" sees the throw and calls it contained. The distinction between _refused_ and
_missed_ is what these probes are actually about, so for every one of them record which
of the three happened: refused, missed, or read.

---

### A1 — traversal, in every argument and every position

**Try:** `../outside.txt`, `src/../../outside.txt`, `./../outside.txt`,
`src/./../../outside.txt`, `....//....//x` — in `read_file`, `list_dir`, `search`, and
both write tools. Also with the traversal as a _suffix_ of a valid-looking prefix, so a
check that only inspects the start of the string is satisfied.

**Why it can land:** normalising and resolving are two steps, and containment has to be
tested on the result of both. The usual miss is a check that runs on the argument string
rather than on the real path, or before resolution rather than after.

**What it gets you:** any file the process can read — sibling repos, `.env` files next to
the worktree, `~/.ssh`.

**Settle it by:** for each argument position separately. One closed position does not
mean the others are.

---

### A2 — symlinks, including dangling ones

**Try:** a symlink inside the worktree pointing at the parent, at a sibling repo, at `/`;
a chain (`a → b → outside`); a symlink whose target does not exist _yet_, then create the
target.

**Why it can land:** the check has to run on the resolved path, and resolution has to
happen again at use time. A dangling link resolves to nothing now and to somewhere
outside the root later.

**What it gets you:** A1's result with no `..` anywhere in the argument, which defeats a
traversal-only check.

**Settle it by:** whether resolution happens once on entry, or again as the file is
opened. Those are different answers.

---

### A3 — hard links, which no path check can see

**Try:** a file inside the worktree that is a hard link to a file outside it. Read it.
Then write to it.

**Why it can land:** resolving a path follows _symlinks_. A hard link is not a symlink —
it is a second name for the same inode, with no path connecting the two. Every comparison
of paths agrees that the file is inside, and the kernel still opens the outside file.

**What it gets you:** on the read side, a secret whose name nobody denied. On the write
side — and this is the only entry in the document where it happens — **destroying a file
outside the worktree, through an allowed file with a correct name, with every check in
the transaction passing.**

**Settle it by:** whether a hard link can exist in a worktree in the target setup at all.
Git does not store them, but a filesystem, a sync tool, a backup restore or a human can
produce one.

---

### A4 — Windows path forms

**Try:** `\\server\share\x`, `\\?\C:\Users\...`, `\\.\C:`, `\\.\GLOBALROOT\...`; device
names `NUL`, `CON`, `AUX`, `COM1`, and with an extension `NUL.txt`; `dist.` and `dist `
(trailing dot or space); short 8.3 names like `PROGRA~1`; an alternate data stream
`notes.txt:hidden`.

**Why it can land:** each of these makes a _string comparison_ disagree with what the
filesystem opens. Windows strips trailing dots and spaces, so `dist.` **is** `dist`, and
a deny list comparing the literal string never sees it. `NUL` accepts a write and
discards it, reporting success. An alternate data stream is a second stream on an allowed
file: the name passes, the bytes land somewhere no diff will ever show.

**What it gets you:** deny-list bypass, silent data loss (a write that "succeeded" and
stored nothing), and a hiding place outside the diff.

**Settle it by:** on a Windows volume, one case at a time, recording what the tool
_said_ and what the filesystem actually holds.
**Probed, on this machine — missed, not refused.** `.git./config`, `dist./bundle.js` and
`dist /bundle.js` all came back **"no such file"**. The deny list did **not** recognise any of
them; the read only missed because the filesystem did not strip the trailing character either.
`.env.` was refused properly. This is the distinction this class exists for: the answer here is
decided by the filesystem's behaviour, not by the guard. On a Windows build or an API path that
_does_ normalise the name, the same probe reads the file it was refused.
---

### A5 — case and Unicode folding

**Try:** `DIST/x`, `src/A.TS`, `ｓｒｃ/ａ.ｔｓ` (fullwidth), a right-to-left override inside a
filename, a zero-width character inside a denied name.

**Why it can land:** three notions of "the same file" exist — the string, the case-folded
string, and the filesystem's own answer. On a case-insensitive volume `src/A.ts` and
`src/a.ts` are one file, so if the allow list folds case and the deny list does not (or
the reverse), one of the two is answering a question about a different file than the one
that gets opened.

**What it gets you:** a write to a file that was never on the allow list, or a read of a
name that was denied.

**Settle it by:** comparing what each list decides for one file reached by two spellings.
There is no need to guess which side is wrong; the disagreement _is_ the finding.

---

### A6 — escaping through a directory, not a file

**Try:** a directory symlink or junction inside the worktree pointing outside, then
`list_dir` and `search` on it.

**Why it can land:** a walk prunes by _name_ as it goes, and a link can be named anything.
Pruning decides what is skipped, not where the walk goes. A link called `src2` is on no
list.

**What it gets you:** enumerating and grepping outside the worktree, which is a map of
the machine, and maps are how secrets get found.

**Settle it by:** whether the walk resolves each directory it enters, or only the file it
finally reads.

---

### A7 — the same directory by another name

**Try:** the worktree reached through a mapped drive, a `\\?\` form, a UNC share, or a
symlinked root; then pass an argument spelled with the other form.

**Why it can land:** if the root is remembered as a string and containment is a string
prefix test, two names for one directory are two different roots, and "inside" is decided
by which name the agent happened to use.

**What it gets you:** the containment test answers about the string rather than the place.

**Settle it by:** both spellings, individually, against a canary file outside the root.

---

### A8 — the same path is not the same path twice

**Try:** a path that passes the check, then is changed before it is used — a symlink
swapped in between, a file replaced by a link, a directory replaced by a link.

**Why it can land:** check-then-use is two moments, and a check is worth exactly as much
as the window between them.

**What it gets you:** A1 to A3, with the argument that was checked being a different thing
from the one opened.

**Settle it by:** whether anything else can write inside the worktree while the agent is
working — a second run, a human, a watcher, a formatter. This probe cannot be run alone;
it needs a second writer, and knowing whether a second writer is possible is most of the
answer.
