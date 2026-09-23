# C — Getting code to run

The sandbox refuses a shell. Nothing below needs one. **A check is a process, and a
process runs code** — the only question is who chose the code.

The model cannot change a profile's argv, because it picks a name and nothing else. So
every route here goes through a _file the check reads_. That makes this class the one
where a single careless profile entry, or a single allowed config file, becomes a shell —
and that shell inherits everything the user has, which is where D and B4 come from.

---

### C1 — the config file that is also a program

**Try:** for each check in the profile, find the files it loads, and check which of those
can be on the allow list. The familiar shapes: an `.eslintrc.js` with a `plugins` entry,
an ESLint flat config, a Babel or SWC config, a Prettier config with `plugins`, `tox.ini`,
`noxfile.py`, `conftest.py`, `setup.cfg`, `justfile`, `Taskfile.yml`, `compose.yaml`. A
JavaScript file named by a `plugins` / `require` / `extends` field is **imported and
executed** by the check.

**Why it can land:** a deny list is written against the names somebody thought of and is
matched as a string. `*.config.*` catches `eslint.config.js` and misses `.eslintrc.js`. It
catches nothing at all if a toolchain names its config something else this month. The list
is a snapshot; the space of "files a tool executes on load" is not.

**What it gets you:** arbitrary code inside the check process, with the user's environment
and the whole filesystem. Everything in D and B4 follows from here.

**Settle it by:** for each check, whether any file it executes can appear on an allow list.
This is the highest-value question in the document, and it is worth asking again every time
a check is added.

---

### C2 — taking a name out of PATH

**Try:** plant a program in the worktree whose name matches a program a check invokes, in a
directory that comes first on `PATH` — or rely on a relative entry in `PATH` together with
the fact that checks run with the worktree as their working directory.

**Why it can land:** resolving a program by name means the search order decides which one
runs, and a relative entry in `PATH` is what makes "inside the worktree" reachable at all.

**What it gets you:** the profile's `prettier` is the agent's `prettier`.

**Settle it by:** whether `PATH` is normalised for checks, and whether any extension the
agent can write is executable there. On Windows the answer depends on `PATHEXT`:
`.CMD` and `.BAT` may be refused by name while `.JS` and `.EXE` are not, and whether `.JS`
is executable is a property of the machine, not of the harness.

---

### C3 — handing the model's own file to an interpreter

**Try:** a profile entry shaped like `["node", "{allowed}"]`, `["python", "{allowed}"]`,
`["bash", "{allowed}"]`, or a formatter config pointing at an allowed file.

**Why it can land:** `{allowed}` expands to a path the model chose, into the argv of a
trusted program. The program is trusted. Its argument is not.

**What it gets you:** a shell, written down in a config file, with the auditor's blessing.

**Settle it by:** this is a rule to write down and audit against, not a probe:
**a profile must never pass a model-writable file to an interpreter.** Go through the
shipped profiles entry by entry with that sentence in hand.

---

### C4 — arranging for it to run later

The idea behind C1, moved in time. The code does not have to run during the run.

**Try:** a git hook that lives outside `.git` — `.husky/pre-commit` is a shell script with
**no extension**, so an extension-based deny list misses it. A Python file that runs on
interpreter start whenever the repo is on the path: `conftest.py`, `sitecustomize.py`,
`usercustomize.py`. An editor task: `.vscode/tasks.json` with `runOptions.runOn`, or
`.vscode/settings.json` naming a language server. A container or compose file:
`.devcontainer/devcontainer.json` with a `postCreateCommand`, `compose.yaml` with an
`entrypoint`. A package-manager setting: `.npmrc` with `script-shell` or a redirected
registry, `.yarnrc.yml`, `pnpm-workspace.yaml`. A submodule: `.gitmodules` pointing at a
repository of someone else's choosing. A build file the deny list has never heard of:
`justfile`, `Taskfile.yml`, `build.gradle`, `pom.xml`, `noxfile.py`.

**Why it can land:** the run ends, the worktree gets merged, and the trigger is somebody
else's next action — a commit, opening the folder in an editor, a test run, a container
build. The agent is long gone by then, and the diff was one config file.

**What it gets you:** code execution on the developer's machine, later, with no run in
flight. **Cancelling does not help**: a cancel kills a process tree, and this is a file
that is already written.

**Settle it by:** the length of that list is itself the argument for not maintaining a
list. The durable rule is _a file the agent may write must never be read as instructions by
anything that runs later_, and it has to be enforced on the reviewer's side of the fence,
because it cannot be enforced by refusing names.

---

### C5 — a check reading model-written output

**Try:** a `format` entry that rewrites `{allowed}` — which is its job — and then the same
file being read back as _configuration_ by the next check.

**Why it can land:** formatting a file the model wrote is the entire point of the check, so
a check reading model-written files is normal and expected. If one of those files is also,
to some other tool, a config, C1 is reached with no profile mistake anywhere.

**What it gets you:** C1, with no error to point at and nothing anomalous in the profile.

**Settle it by:** whether any profile's allowed extensions include one that some toolchain
reads as configuration.
