"""The sandbox's refusals, checked without calling DeepSeek.

    python tests/test_sandbox.py

Builds a throwaway git repo with the things the sandbox must not show or
touch, then tries every one of them. These are the tests that matter: a guard
nobody has tried to get past is a guard that might not be there. The first
version of `rel_norm` stripped every leading dot, so `.git` and `.env` walked
straight past the deny lists, and only trying them found it.
"""

import json
import pathlib
import subprocess
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))
import dsx  # noqa: E402

PROFILE = {"checks": {"echo": {"run": [sys.executable, "-c", "print('ran')"]},
                      "ts_only": {"when": [".ts"], "run": [sys.executable, "-c", "print('ts')"]}},
           "format": []}

failures = []


def expect(label, ok):
    print(("ok    " if ok else "FAIL  ") + label)
    if not ok:
        failures.append(label)


def refused(fn):
    """Whether the sandbox refused. A read that fails because a file is not
    there is not a refusal: that is the sandbox letting it through and the
    path happening to miss, which is exactly how the lstrip bug hid."""
    try:
        fn()
    except (PermissionError, SystemExit):
        return True
    except OSError:
        return False
    return False


with tempfile.TemporaryDirectory() as tmp:
    root = pathlib.Path(tmp) / "repo"
    (root / "src").mkdir(parents=True)
    subprocess.run(["git", "init", "-q", str(root)], check=True)
    (root / "src" / "a.ts").write_text("export const a = 1;\n", encoding="utf8")
    (root / "src" / "b.ts").write_text("export const b = 2;\n", encoding="utf8")
    (root / ".env").write_text("TOKEN=nope\n", encoding="utf8")
    (root / "_private").mkdir()
    (root / "_private" / "hosting.md").write_text("secrets\n", encoding="utf8")
    (root / "target").mkdir()
    (root / "target" / "x").write_text("x\n", encoding="utf8")
    outside = pathlib.Path(tmp) / "outside.txt"
    outside.write_text("not yours\n", encoding="utf8")

    box = dsx.Sandbox(root, ["src/a.ts"], pathlib.Path(tmp) / "log.jsonl", PROFILE)

    expect("an ordinary file can be read", "export const a" in box.read_file("src/a.ts"))
    expect("a directory can be listed without .git", ".git" not in box.list_dir("."))
    expect(".git is not shown", refused(lambda: box.read_file(".git/config")))
    expect("./.git is not shown either", refused(lambda: box.read_file("./.git/HEAD")))
    expect(".env is not shown", refused(lambda: box.read_file(".env")))
    expect("_private is not shown", refused(lambda: box.read_file("_private/hosting.md")))
    expect("target is not shown", refused(lambda: box.read_file("target/x")))
    expect("../ cannot escape", refused(lambda: box.read_file("../outside.txt")))
    expect("an absolute path cannot escape", refused(lambda: box.read_file(str(outside))))
    expect("search skips what it may not show", "TOKEN" not in box.search("TOKEN|secrets"))
    expect("an allowed file can be changed", box.replace_in_file("src/a.ts", "= 1", "= 3") == "replaced")
    # "t" is in both "export" and "const", so it cannot say which one it means.
    expect("an ambiguous replace is refused", box.replace_in_file("src/a.ts", "t", "T").startswith("refused"))
    expect("a file not allowed cannot be changed", refused(lambda: box.replace_in_file("src/b.ts", "2", "4")))
    expect("a file not allowed cannot be created", refused(lambda: box.create_file("src/c.ts", "x")))
    expect("a check runs by name", "ran" in box.run_check("echo"))
    expect("a check the profile lacks is refused", box.run_check("rm -rf /").startswith("refused"))
    expect("a check for other kinds of file is skipped", "ts" in box.run_check("ts_only"))
    box_rs = dsx.Sandbox(root, ["src/a.ts"], pathlib.Path(tmp) / "log.jsonl",
                         {"checks": {"rs_only": {"when": [".rs"], "run": ["x"]}}})
    expect("a check with no allowed file of its kind does nothing", "nothing to check" in box_rs.run_check("rs_only"))
    for bad in ["Cargo.toml", "crates/x/build.rs", ".github/workflows/ci.yml", "vite.config.ts",
                "package.json", "tsconfig.json", "scripts/run.ps1"]:
        expect(f"allowing {bad} is refused", refused(lambda b=bad: dsx.Sandbox(root, [b], pathlib.Path(tmp) / "l", PROFILE)))

    # A check process must not inherit the key or any session token.
    import os
    os.environ["DEEPSEEK_TEST_KEY"] = "leak"
    os.environ["CLAUDE_CODE_TEST"] = "leak"
    leaky = dsx.Sandbox(root, ["src/a.ts"], pathlib.Path(tmp) / "log.jsonl", {"checks": {"env": {"run": [
        sys.executable, "-c", "import os; print([k for k in os.environ if 'LEAK' in os.environ[k].upper()])"]}}})
    expect("secrets are stripped from a check's environment", "[]" in leaky.run_check("env"))

    # The harness refuses a sandbox that contains its own rules.
    profile_inside = root / "profile.json"
    profile_inside.write_text(json.dumps(PROFILE), encoding="utf8")
    task = pathlib.Path(tmp) / "task.md"
    task.write_text("nothing\n", encoding="utf8")
    done = subprocess.run([sys.executable, str(HERE / "dsx.py"), str(root), str(task), "--profile",
                           str(profile_inside), "--allow", "src/a.ts"], capture_output=True, text=True)
    expect("a profile inside the sandbox is refused", "inside the sandbox" in (done.stdout + done.stderr))
    done = subprocess.run([sys.executable, str(HERE / "dsx.py"), str(HERE), str(task), "--profile",
                           str(HERE / "profiles" / "esap.json"), "--allow", "README.md"], capture_output=True, text=True)
    expect("sandboxing the harness's own tree is refused", "inside the sandbox" in (done.stdout + done.stderr))

print(f"\n{len(failures)} failed" if failures else "\nall refusals hold")
sys.exit(1 if failures else 0)
