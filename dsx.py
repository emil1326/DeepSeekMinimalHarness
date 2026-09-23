"""Emil's DeepSeek Minimal Harness.

A sandboxed executor: DeepSeek implements a small plan inside a git worktree,
through a closed set of tools this harness defines, and nothing else.

    python dsx.py <worktree> <task.md> --profile profiles/<name>.json
                  --allow path [path ...] [--model deepseek-flash] [--turns 12]

What DeepSeek can do, and all it can do:
    read_file / list_dir / search   anywhere under <worktree>, except .git,
                                    target, node_modules, _private, dist and
                                    anything that looks like a secret
    replace_in_file / create_file   only the paths given with --allow, and
                                    never build scripts, manifests, lockfiles,
                                    configs, CI or shell scripts, even if they
                                    are allowed by mistake
    run_check <name>                a command from the profile; the model picks
                                    a name, never an argument. Profiles should
                                    hold static checks only, nothing that runs
                                    the code the model wrote. Tests are for
                                    whoever reviews the diff afterwards.
    finish <summary>                stop

It has no shell, no network and never sees the key. Check processes run with
the secrets stripped from their environment. Every call is logged beside the
task as JSON lines, and at the end the worktree is checked for any change
outside the allowed files.

The profile is trusted configuration, written by whoever plans the work. It has
to live outside the worktree, and so does this file, or the model could edit
its own rules; the harness refuses to start otherwise.
"""

import argparse
import fnmatch
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.request

API = "https://api.deepseek.com/chat/completions"
KEY_FILE = pathlib.Path.home() / ".deepseek" / "api_key"

NEVER_READ_DIRS = {".git", "target", "node_modules", "_private", "dist"}
SECRET_NAMES = [".env", ".env.*", "*.pem", "*.pfx", "*.p12", "*.key", "api_key", "*secret*", "*credential*"]
# Refused for writing even when allowed: anything that runs at build time, sets
# up the toolchain, or reaches outside the code under change.
NEVER_WRITE = [
    "build.rs", "*/build.rs", "Cargo.toml", "*/Cargo.toml", "Cargo.lock", "package.json",
    "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "*.config.*", "tsconfig*.json",
    ".github/*", ".claude/*", ".cargo/*", "rust-toolchain*", "*.ps1", "*.cmd", "*.bat", "*.sh",
    "setup.py", "pyproject.toml", "Makefile", "Dockerfile",
]
SECRET_ENV = re.compile(r"(DEEPSEEK|ANTHROPIC|CLAUDE|TOKEN|SECRET|PASSWORD|API_KEY|_KEY$)", re.I)
READ_LINES = 1500
RESULT_CHARS = 8000


def exe(name: str) -> str:
    """The program to run, preferring the `.cmd` shim npm installs on Windows."""
    found = shutil.which(name + ".cmd") or shutil.which(name)
    return found or name


def inside(path: pathlib.Path, root: pathlib.Path) -> bool:
    return path == root or root in path.parents


class Sandbox:
    def __init__(self, root: pathlib.Path, allow: list[str], log: pathlib.Path, profile: dict):
        self.root = root.resolve()
        self.allow = {self.rel_norm(a) for a in allow}
        for path in self.allow:
            if any(fnmatch.fnmatch(path, pat) for pat in NEVER_WRITE):
                raise SystemExit(f"refusing to allow {path}: it is on the never-write list")
        self.log = log
        self.profile = profile
        self.checks: dict = profile.get("checks", {})

    def rel_norm(self, path: str) -> str:
        # Only a literal "./" prefix goes. `lstrip("./")` was here first and
        # stripped every leading dot too, so ".git" became "git" and ".env"
        # became "env" and neither matched the lists meant to refuse them.
        path = path.replace("\\", "/")
        while path.startswith("./"):
            path = path[2:]
        return pathlib.PurePosixPath(path).as_posix()

    def resolve(self, path: str) -> pathlib.Path:
        full = (self.root / self.rel_norm(path)).resolve()
        if not inside(full, self.root):
            raise PermissionError(f"{path} is outside the sandbox")
        rel = full.relative_to(self.root)
        if any(part in NEVER_READ_DIRS for part in rel.parts):
            raise PermissionError(f"{path} is in a directory the sandbox does not show")
        if any(fnmatch.fnmatch(rel.name.lower(), pat) for pat in SECRET_NAMES):
            raise PermissionError(f"{path} looks like a secret and is not shown")
        return full

    def writable(self, path: str) -> pathlib.Path:
        rel = self.rel_norm(path)
        if rel not in self.allow:
            raise PermissionError(f"{rel} is not one of the files this task may change: {sorted(self.allow)}")
        return self.resolve(rel)

    # --- the tools -------------------------------------------------------

    def read_file(self, path: str, start: int = 1, end: int | None = None) -> str:
        text = self.resolve(path).read_text(encoding="utf8", errors="replace").replace("\r\n", "\n")
        lines = text.split("\n")
        start = max(1, int(start))
        end = min(len(lines), int(end) if end else start + READ_LINES - 1)
        body = "\n".join(f"{n}\t{lines[n - 1]}" for n in range(start, end + 1))
        more = f"\n[{len(lines)} lines in all; read more with start/end]" if end < len(lines) else ""
        return body + more

    def list_dir(self, path: str = ".") -> str:
        full = self.resolve(path)
        rows = [c.name + ("/" if c.is_dir() else "") for c in sorted(full.iterdir()) if c.name not in NEVER_READ_DIRS]
        return "\n".join(rows) or "(empty)"

    def search(self, pattern: str, path: str = ".") -> str:
        regex = re.compile(pattern)
        base = self.resolve(path)
        if base.is_dir():
            files = []
            for folder, dirs, names in os.walk(base):
                # Pruned here, not just refused per file: node_modules is often a
                # junction to a whole dependency tree and target holds gigabytes.
                dirs[:] = [d for d in dirs if d not in NEVER_READ_DIRS]
                files.extend(pathlib.Path(folder) / n for n in names)
        else:
            files = [base]
        hits = []
        for file in files:
            if not file.is_file() or file.stat().st_size > 2_000_000:
                continue
            try:
                shown = self.resolve(str(file.relative_to(self.root)))
                text = shown.read_text(encoding="utf8", errors="ignore")
            except (PermissionError, OSError):
                continue
            for n, line in enumerate(text.splitlines(), 1):
                if regex.search(line):
                    hits.append(f"{file.relative_to(self.root).as_posix()}:{n}: {line.strip()[:200]}")
                    if len(hits) >= 80:
                        return "\n".join(hits) + "\n[stopped at 80 hits]"
        return "\n".join(hits) or "(no matches)"

    def replace_in_file(self, path: str, old: str, new: str) -> str:
        full = self.writable(path)
        raw = full.read_text(encoding="utf8")
        nl = "\r\n" if "\r\n" in raw else "\n"
        text = raw.replace("\r\n", "\n")
        old, new = old.replace("\r\n", "\n"), new.replace("\r\n", "\n")
        count = text.count(old) if old else 0
        if count != 1:
            return f"refused: the old text matched {count} times; it must match exactly once"
        text = text.replace(old, new, 1)
        full.write_text(text.replace("\n", nl) if nl != "\n" else text, encoding="utf8")
        return "replaced"

    def create_file(self, path: str, content: str) -> str:
        full = self.writable(path)
        if full.exists():
            return "refused: the file exists; use replace_in_file"
        full.parent.mkdir(parents=True, exist_ok=True)
        full.write_text(content, encoding="utf8")
        return "created"

    def command(self, spec: dict) -> list[str] | None:
        """A profile entry made into argv, `{allowed}` standing for the allowed
        files it applies to. None when it applies to none of them."""
        when = spec.get("when")
        files = sorted(p for p in self.allow if not when or p.endswith(tuple(when)))
        if when and not files:
            return None
        argv = []
        for part in spec["run"]:
            argv.extend(files if part == "{allowed}" else [part])
        return [exe(argv[0]), *argv[1:]]

    def run_check(self, name: str) -> str:
        if name == "format":
            results = []
            for spec in self.profile.get("format", []):
                argv = self.command(spec)
                if argv:
                    results.append(f"{pathlib.Path(argv[0]).stem}: " + self.run(argv))
            return "\n".join(results) or "nothing to format"
        spec = self.checks.get(name)
        if spec is None:
            return f"refused: no check called {name}; there are {sorted(self.checks) + ['format']}"
        argv = self.command(spec)
        if argv is None:
            return "nothing to check: no allowed file of that kind"
        return self.run(argv)

    def run(self, argv: list[str]) -> str:
        env = {k: v for k, v in os.environ.items() if not SECRET_ENV.search(k)}
        for k, v in self.profile.get("env", {}).items():
            env[k] = v.replace("{parent}", str(self.root.parent))
        try:
            done = subprocess.run(argv, cwd=self.root, env=env, capture_output=True, text=True,
                                  encoding="utf8", errors="replace", timeout=900)
        except subprocess.TimeoutExpired:
            return "the check ran past 15 minutes and was stopped"
        except OSError as failed:
            return f"could not start {argv[0]}: {failed}"
        out = (done.stdout + "\n" + done.stderr).strip()
        if len(out) > RESULT_CHARS:
            out = out[:2000] + "\n[...]\n" + out[-(RESULT_CHARS - 2000):]
        return f"exit {done.returncode}\n{out}"

    def record(self, entry: dict) -> None:
        with self.log.open("a", encoding="utf8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")


TOOL_NAMES = {"read_file", "list_dir", "search", "replace_in_file", "create_file", "run_check"}


def tool_specs(check_names: list[str]) -> list[dict]:
    tools = [
        ("read_file", "Read a file under the repository, with line numbers.",
         {"path": "string", "start": "integer", "end": "integer"}, ["path"]),
        ("list_dir", "List a directory under the repository.", {"path": "string"}, []),
        ("search", "Search file contents under a directory with a regular expression.",
         {"pattern": "string", "path": "string"}, ["pattern"]),
        ("replace_in_file", "Replace text that occurs exactly once in an allowed file.",
         {"path": "string", "old": "string", "new": "string"}, ["path", "old", "new"]),
        ("create_file", "Create a new allowed file.", {"path": "string", "content": "string"}, ["path", "content"]),
        ("run_check", "Run a named check: " + ", ".join(check_names)
         + ", or format, which applies the formatters to the files you may change.", {"name": "string"}, ["name"]),
        ("finish", "Stop, with a short summary of what changed and anything not done.",
         {"summary": "string"}, ["summary"]),
    ]
    return [{"type": "function", "function": {
        "name": name, "description": desc,
        "parameters": {"type": "object", "properties": {k: {"type": t} for k, t in props.items()}, "required": req}}}
        for name, desc, props, req in tools]


SYSTEM = """You implement one small, fully specified change in an existing repository, inside a sandbox.

You can read anything in the repository, but you may change only the files the task lists. You have no shell.
You can run named checks; you cannot run tests.

Work like this: read the files you need, make the smallest correct change with replace_in_file, run the checks that
apply, fix what they report, then call finish. Match the surrounding code's style, naming and comment density. Do not
reformat or reorder code you were not asked to change. For formatting, never hand-edit to satisfy a formatter: run the
format check, which applies the formatters to your files, then re-run the checks.

If a check still fails and you cannot see why after two attempts, stop and call finish saying so. Never undo an edit
you made correctly in order to make a check pass. Once every check that applies passes, call finish straight away.
If something in the task cannot be done within these limits, say so in finish rather than working around it."""


def ask(model: str, messages: list[dict], tools: list[dict]) -> dict:
    body = json.dumps({"model": model, "messages": messages, "tools": tools, "temperature": 0}).encode()
    request = urllib.request.Request(API, data=body, method="POST")
    request.add_header("Authorization", "Bearer " + KEY_FILE.read_text(encoding="utf8").strip())
    request.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(request, timeout=900) as reply:
            return json.loads(reply.read())
    except urllib.error.HTTPError as error:
        raise SystemExit(f"DeepSeek answered {error.code}: {error.read().decode(errors='replace')[:500]}")


def main() -> None:
    ap = argparse.ArgumentParser(description="Emil's DeepSeek Minimal Harness")
    ap.add_argument("worktree")
    ap.add_argument("task")
    ap.add_argument("--profile", required=True, help="JSON file of checks, outside the worktree")
    ap.add_argument("--allow", nargs="+", required=True)
    ap.add_argument("--model", default="deepseek-flash")
    ap.add_argument("--turns", type=int, default=12)
    args = ap.parse_args()

    root = pathlib.Path(args.worktree).resolve()
    if not (root / ".git").exists():
        raise SystemExit("the sandbox must be a git worktree, so every change it makes is a diff")
    profile_path = pathlib.Path(args.profile).resolve()
    for trusted, what in ((pathlib.Path(__file__).resolve(), "the harness"), (profile_path, "the profile")):
        if inside(trusted, root):
            raise SystemExit(f"{what} is inside the sandbox, where the model could edit its own rules")
    profile = json.loads(profile_path.read_text(encoding="utf8"))

    task_path = pathlib.Path(args.task)
    log = task_path.with_suffix(".log.jsonl")
    log.unlink(missing_ok=True)
    box = Sandbox(root, args.allow, log, profile)
    tools = tool_specs(sorted(box.checks))

    messages = [
        {"role": "system", "content": SYSTEM},
        {"role": "user", "content": task_path.read_text(encoding="utf8")
         + "\n\nFiles you may change: " + ", ".join(sorted(box.allow))},
    ]
    spent = {"in": 0, "out": 0}
    summary, turn = None, 0
    for turn in range(1, args.turns + 1):
        answer = ask(args.model, messages, tools)
        usage = answer.get("usage", {})
        spent["in"] += usage.get("prompt_tokens", 0)
        spent["out"] += usage.get("completion_tokens", 0)
        message = answer["choices"][0]["message"]
        messages.append({k: v for k, v in message.items() if k in ("role", "content", "tool_calls")})
        calls = message.get("tool_calls") or []
        if not calls:
            summary = message.get("content") or "(stopped without calling finish)"
            break
        for call in calls:
            name = call["function"]["name"]
            try:
                params = json.loads(call["function"]["arguments"] or "{}")
            except json.JSONDecodeError:
                params = {}
            if name == "finish":
                summary, result = params.get("summary", ""), "ok"
            elif name in TOOL_NAMES:
                try:
                    result = getattr(box, name)(**params)
                except PermissionError as refused:
                    result = f"refused: {refused}"
                except (OSError, TypeError, ValueError, re.error) as failed:
                    result = f"failed: {failed}"
            else:
                result = f"no tool called {name}"
            box.record({"turn": turn, "tool": name, "args": params,
                        "result": result if len(result) < 600 else result[:600] + "..."})
            messages.append({"role": "tool", "tool_call_id": call["id"], "content": result})
        if summary is not None:
            break

    # Anything changed outside the allowed files is reported, whatever caused it.
    status = subprocess.run(["git", "status", "--porcelain"], cwd=root, capture_output=True, text=True).stdout
    changed = [line[3:].strip().strip('"') for line in status.splitlines() if line.strip()]
    stray = [c for c in changed if box.rel_norm(c) not in box.allow]
    print(f"turns {turn} | tokens in {spent['in']}, out {spent['out']} | log {log.name}")
    print("changed:", ", ".join(changed) or "(nothing)")
    if stray:
        print("STRAY CHANGES OUTSIDE THE ALLOWED FILES:", ", ".join(stray))
    print("--- summary ---")
    print(summary or "(ran out of turns)")


if __name__ == "__main__":
    main()
