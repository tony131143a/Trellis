---
sources:
  - packages/cli/src/templates/arbor/scripts/*.py
  - packages/cli/src/templates/arbor/scripts/common/__init__.py
  - packages/cli/src/templates/arbor/scripts/common/io.py
  - packages/cli/src/templates/arbor/scripts/common/log.py
  - packages/cli/src/templates/arbor/scripts/common/git.py
  - packages/cli/src/templates/arbor/scripts/common/types.py
  - packages/cli/src/templates/arbor/scripts/common/paths.py
  - packages/cli/src/templates/arbor/scripts/common/developer.py
  - packages/cli/src/templates/arbor/scripts/common/config.py
  - packages/cli/src/templates/arbor/scripts/common/arbor_config.py
  - packages/cli/src/templates/arbor/scripts/common/execution.py
  - packages/cli/src/templates/arbor/scripts/common/safe_commit.py
  - packages/cli/src/templates/arbor/config.yaml
  - packages/cli/src/templates/arbor/index.ts
  - packages/cli/src/configurators/shared.ts
  - packages/cli/src/templates/extract.ts
last_verified: 2026-11-13
---
# Script Conventions

> Standards for Python scripts in the `.arbor/scripts/` directory.

---

## Overview

All workflow scripts target **Python 3.9+** for cross-platform compatibility (matches macOS system `python3`; covers Ubuntu 22.04 LTS and newer). Scripts use only the standard library (no external dependencies). PEP 604 union annotations (`str | None`) are allowed only when the file declares `from __future__ import annotations` — see the Cross-Platform Compatibility section below.

---

## Directory Structure

The shipped set is exactly `getAllScripts()` in
`packages/cli/src/templates/arbor/index.ts`:

```
.arbor/scripts/
├── __init__.py
├── arbor.py              # Task driver CLI (new/start/sync/review/finish/status/...)
├── add_session.py        # Session recording (journal + index + auto-commit)
├── spec.py               # Entry shim → common/spec_lint.py (lint / verify / init-meta)
├── init_developer.py     # Developer initialization
├── get_developer.py      # Print current developer
└── common/
    ├── __init__.py       # Windows stdio encoding fix (centralized) + paths re-exports
    ├── paths.py          # Path constants, repo root, developer resolution
    ├── developer.py      # init_developer / ensure_developer
    ├── io.py             # read_json / read_json_checked / write_json / write_text_atomic
    ├── log.py            # Colors, colored(), log_info/log_success/log_warn/log_error
    ├── git.py            # run_git() and git helpers
    ├── types.py          # TaskData / TaskInfo / AgentRecord (no importers; see below)
    ├── config.py         # .arbor/config.yaml typed accessors
    ├── arbor_config.py   # parse_simple_yaml + read_arbor_config + driver section getters
    ├── safe_commit.py    # Scoped git-add helpers for the session auto-commit
    ├── execution.py      # `git: true` package repositories
    ├── contract.py       # contract.md parse / validate / hash
    ├── worktree.py       # Task worktrees
    ├── invariants.py     # Post-run invariants, checked with git
    ├── spec_meta.py      # Spec frontmatter parse / rewrite
    ├── spec_lint.py      # spec.py lint / verify / init-meta
    ├── spec_trace.py     # Spec change traceability
    └── driver/           # arbor.py internals — see driver.md
```

The driver package (`common/driver/{executor,orca,gate,lock,plan,repos,sync,finish,prompt}.py`)
is documented in [Driver](./driver.md); this doc covers the conventions every
script shares.

---

## Two script trees, one content

### 1. Scope / Trigger

Every file above exists **twice**: `packages/cli/src/templates/arbor/scripts/**`
is what ships to users and is the source; `.arbor/scripts/**` is this repo's
installed (dogfood) copy of it. Two physical copies of one thing drift, and
this pair did: PR #390 changed an update hint in the template copy only, and
the dogfood copy sat on the old wording for a month.

That is now a build failure.

### 2. Signatures

No API — the contract is a test, `packages/cli/test/regression.test.ts` →
`describe("regression: .arbor/scripts stays byte-identical to templates/arbor/scripts")`,
built on `listPyFiles(root)` (recursive, skips `__pycache__`, sorted).

### 3. Contracts

- **Identical path sets.** `listPyFiles()` over both roots must produce the same array. A script added to or deleted from one tree must be mirrored in the other.
- **Byte-identical content.** One test case per `.py` file, `Buffer.equals`. Not a text diff — line endings and trailing whitespace count.
- The file list is derived from the filesystem at describe-time, so a new script is covered the moment it is added. Never hard-code it.
- Scope is **`.py` files only** (`listPyFiles` filters on the extension). Both trees are pure Python today; if a non-`.py` file is ever added, decide its rule then rather than assuming this test covers it.
- A new shipped script must also be registered in `getAllScripts()`; the parity test does not check that list.

### 4. Validation & Error Matrix

| Condition | Failure |
| --- | --- |
| A `.py` file exists in one tree only | "both trees hold the same set of .py files" — the array compare shows which |
| Contents differ by any byte | "`<path>` has drifted … Edit both copies, never one." |
| `__pycache__` in either tree | Skipped |
| Someone edits `packages/cli/dist/**` instead | Not covered; `dist/` is generated. Never hand-edit it |

### 5. Good / Base / Bad Cases

- **Good** — a fix lands in the template and is mirrored in the same commit.
- **Bad** — "keep the dogfood copy's local drift." There is no acceptable drift.

### 6. Tests Required

Self-extending; do not add per-file tests.

### 7. Wrong vs Correct

Wrong: edit only the copy you happened to open (`.arbor/scripts/...`).
Correct: edit the template, mirror it, confirm silence:

```bash
$EDITOR packages/cli/src/templates/arbor/scripts/common/safe_commit.py
rsync -av --delete --exclude='__pycache__' \
  packages/cli/src/templates/arbor/scripts/ .arbor/scripts/
diff -rq .arbor/scripts packages/cli/src/templates/arbor/scripts -x __pycache__
```

---

## Script Types

### Library Modules (`common/*.py`)

Shared utilities imported by other scripts. **Never run directly.**

| Layer | Modules | Role |
|------|---------|------|
| **Foundation** | `io.py`, `log.py`, `git.py`, `arbor_config.py` | No imports from the package; used by everything |
| **Paths / identity** | `paths.py` (imports `git.py`; lazy-imports `config.py`), `developer.py` | Repo root, path constants, developer name |
| **Config** | `config.py` (imports `paths.py`, `arbor_config.py`) | Typed accessors over `.arbor/config.yaml` |
| **Git staging** | `safe_commit.py` | Scoped auto-commit paths |
| **Task / driver** | `contract.py`, `execution.py`, `worktree.py`, `invariants.py`, `driver/` | Used by `arbor.py` |
| **Spec tooling** | `spec_meta.py`, `spec_lint.py`, `spec_trace.py` | Used by `spec.py` |

### Entry Scripts (`*.py`)

CLI tools that users run directly: shebang, a module docstring with usage
(and exit codes), `from __future__ import annotations`, imports from
`common.*`, a `main() -> int`, and `sys.exit(main())` under
`if __name__ == "__main__":`. See Argument Parsing and Error Handling below
for the `arbor.py` shape.

---

## Coding Standards

### Type Hints

Use PEP 604 / builtin-generic syntax, made safe on 3.9 by
`from __future__ import annotations`:

```python
# Good
def read_json(path: Path) -> dict | None:
    ...

# Bad - old style
from typing import Optional, Dict
def read_json(path: Path) -> Optional[Dict]:
    ...
```

### Path Handling

Always use `pathlib.Path`:

```python
# Good
from pathlib import Path

def read_file(path: Path) -> str:
    return path.read_text(encoding="utf-8")

config_path = repo_root / DIR_WORKFLOW / "config.yaml"

# Bad - string concatenation
config_path = repo_root + "/" + DIR_WORKFLOW + "/config.yaml"
```

### JSON Operations

Use `common/io.py` (below). Never inline `json.loads(path.read_text())` /
`path.write_text(json.dumps(...))` in a script: the inline write is not
atomic and the inline read does not distinguish its failure modes.

### Subprocess Execution

- Git goes through `common/git.py:run_git` (below).
- Other commands: `subprocess.run(argv_list, capture_output=True, text=True,
  encoding="utf-8", errors="replace")`, plus `timeout=` for anything that can
  hang (`driver/orca.py` bounds every Orca call this way).
- `shell=True` only for commands a person wrote (`gate.commands` and the
  contract's verification-map commands in `driver/gate.py`, `worktree.setup`
  in `worktree.py`); never for argv the script assembles itself.

---

## Shared Module API Reference

### `common/io.py` — File I/O

The single source of truth for all JSON file operations. It also owns `write_text_atomic`, the same never-truncate-in-place guarantee for the Markdown state files (`journal-*.md`, `index.md`) that hold durable session state, and for spec docs rewritten by `spec.py verify`.

| Function | Signature | Returns | Error Behavior |
|----------|-----------|---------|----------------|
| `read_json` | `(path: Path) -> dict \| None` | Parsed value, or `None` | Returns `None` on `FileNotFoundError`, `JSONDecodeError`, `OSError`, `UnicodeDecodeError` |
| `read_json_checked` | `(path: Path) -> tuple[dict \| None, str \| None]` | `(data, None)`, or `(None, reason)` | `reason` is one of the `JSON_READ_*` constants; compare against the constant, never the literal |
| `describe_json_read_failure` | `(path: Path, reason: str \| None) -> tuple[str, str]` | `(what happened, what to do)` | Never raises; unknown reasons get a generic pair |
| `write_json` | `(path: Path, data: dict) -> bool` | `True` on success | Delegates to `write_text_atomic` |
| `write_text_atomic` | `(path: Path, text: str, newline: str \| None = None) -> bool` | `True` on success | Returns `False` on `OSError`; unlinks the temp file and re-raises on `BaseException` (Ctrl-C) |

`newline=None` translates `\n` to `os.linesep` like `Path.write_text`; pass
`newline=""` to write the text byte-for-byte (spec rewrites that must keep the
file's own line endings).

`read_json_checked` reasons (compare against the constant): `JSON_READ_MISSING`
`"missing"` (`FileNotFoundError`), `JSON_READ_UNDECODABLE` `"undecodable"`
(`UnicodeDecodeError`), `JSON_READ_UNREADABLE` `"unreadable"` (any other
`OSError`), `JSON_READ_INVALID` `"invalid"` (`JSONDecodeError`),
`JSON_READ_NOT_OBJECT` `"not-object"` (top level not a dict),
`JSON_READ_EMPTY` `"empty"` (parsed to `{}` — carries none of the fields
callers read).

**Contracts**:
- Always `encoding="utf-8"`, `ensure_ascii=False`, `indent=2`. No exceptions for I/O failure — callers check the return value.
- **Tolerant vs safety-sensitive reads.** `read_json` is for *optional* reads only: it collapses missing, invalid and unreadable into one `None`. A caller about to overwrite the file it read, or whose failure the user must act on, uses `read_json_checked` and names the file and the failure class (`driver/repos.py:load_data` raises a `DriverError` built from `describe_json_read_failure`).
- **Every `write_json` return is checked.** Writes are atomic, so a failed write left the old content in place; printing success after an unchecked write is a false report. `driver/repos.py` raises `DriverError("cannot write <task.json>")` on `False`; `arbor.py new` removes the half-created task dir and refuses.
- **Atomic.** Temp file in `path.parent` (`tempfile.mkstemp`), then `os.replace(tmp, path)`; never `path.write_text()` over the target. A crash or Ctrl-C mid-write leaves the existing file intact. See [Filesystem Safety](./filesystem-safety.md#1-atomic-writes--never-truncate-a-state-file-in-place).
- **Write back the dict you read.** Modify the dict the read returned and pass that same dict to `write_json`; never rebuild one from selected fields — JSON state files may carry fields this version does not know, and a rebuilt dict drops them.

### `common/log.py` — Terminal Output

`Colors` (ANSI `RED`, `GREEN`, `YELLOW`, `BLUE`, `CYAN`, `DIM`, `NC`),
`colored(text, color)`, and `log_info` / `log_success` / `log_warn` /
`log_error` (`[INFO]` blue, `[SUCCESS]` green, `[WARN]` yellow, `[ERROR]`
red). All `log_*` functions print to **stdout**; use
`print(..., file=sys.stderr)` for stderr output.

### `common/git.py` — Git Command Wrapper

```python
def run_git(args: list[str], cwd: Path | None = None, timeout: float | None = None) -> tuple[int, str, str]
```

- Prepends `git -c i18n.logOutputEncoding=UTF-8`; decodes with `encoding="utf-8", errors="replace"`.
- Returns `(1, "", error_message)` on any exception, including a timeout — never raises.
- `timeout` is for best-effort probes (`add_session.py` bounds its ref scans with `GIT_PROBE_TIMEOUT`); normal operations stay unbounded.

| Helper | Behavior |
|---|---|
| `run_git_retry_index_lock(args, cwd=None, timeout=None)` | Retries **only** while stderr names `index.lock` (`stderr_indicates_index_lock`), sleeping `INDEX_LOCK_RETRY_BACKOFF = (0.5, 1.0)`; any other failure returns at once |
| `index_lock_path(repo_root) -> str` | `rev-parse --git-path index.lock` (right file in a worktree); falls back to `.git/index.lock` |
| `resolve_default_branch(repo_root) -> str \| None` | Local `refs/remotes/origin/HEAD` first, then `git remote show origin` (**may hit the network**); `None` if neither. Hot paths resolve locally instead (`add_session.py:_default_branch_local`: `origin/HEAD`, then `main`/`master`) |
| `branch_exists_locally(branch, repo_root) -> bool` | `rev-parse --verify --quiet refs/heads/<branch>`; empty name is `False` |
| `current_branch_name(repo_root) -> str \| None` | `branch --show-current`; detached HEAD and "not a repo" are both `None` — treat them the same |
| `has_git_remote(repo_root) -> bool` | `git remote` is non-empty |
| `main_worktree_root(repo_root) -> Path \| None` | Main working tree's root when `repo_root` is a **linked** worktree; `None` in the main tree, outside git, and for a worktree of a bare repo. Memoized per `repo_root` |

`main_worktree_root` takes the main root from the **first record of
`git worktree list --porcelain`** compared with `rev-parse --show-toplevel`
(a `bare` attribute on that record is the bare case). Do **not** derive it
from the parent of `--git-common-dir`: for a bare repo nested in an unrelated
checkout (`~/repos/project.git` under a `~/repos` that is itself a repo) that
parent is a real checkout with a real `.developer`, and identity leaks between
repositories. `paths.get_developer` and `worktree.main_checkout` call it.

#### Developer identity resolution

`.arbor/.developer` is gitignored on purpose — it carries a personal identity
and **no tracked file may carry one** — so a fresh `git worktree add` has none.
`paths.get_developer()` resolves, first hit wins: (1) `ARBOR_DEVELOPER`
(non-empty after strip); (2) `.arbor/.developer` in this checkout; (3)
`.arbor/.developer` in the main checkout when this is a linked worktree
(`main_worktree_root()`). Step 3 **reads and never copies** — a copy would go
stale. When step 1 hits, no git subprocess runs.
`developer.ensure_developer` (used by `add_session.py`) appends
`paths.DEVELOPER_HINT` (the env var and the worktree inheritance) to its
"Developer not initialized" error.

### `common/types.py` — Typed Data Model

Defines `TaskData` (`TypedDict(total=False)`), `TaskInfo` (frozen dataclass
with a `.raw` dict) and `AgentRecord`. No shipped script imports it; the
driver works on the raw `task.json` dict (`driver/repos.py`). Do not build on
it without first reconciling its fields with the task.json the driver writes
(see [Driver](./driver.md)).

---

## Cross-Platform Compatibility

### CRITICAL: Windows stdio Encoding (stdout + stdin)

On Windows, Python's stdout AND stdin default to the system code page (e.g., GBK/CP936 in China, CP1252 in Western locales):

- stdout: subprocess output with special characters is replaced with U+FFFD; `print(json.dumps(..., ensure_ascii=False))` then raises `UnicodeEncodeError: 'gbk' codec can't encode character`.
- stdin: an agent pipes UTF-8 through a heredoc (`cat << 'EOF' | python3 add_session.py --stdin ...`); `sys.stdin.read()` decodes it as GBK and the text arrives garbled or raises `UnicodeDecodeError`. Users on Windows reported exactly this with `add_session.py`.

**Root Cause**: Even if you set `PYTHONIOENCODING` in subprocess calls, the **parent process's stdio** still uses the system code page.

**Rule**: the fix lives in one place, `common/__init__.py`, which runs `_configure_stream` (`reconfigure(encoding="utf-8", errors="replace")`, falling back to rewrapping `detach()` in a `TextIOWrapper`) on **stdout, stderr and stdin** when `sys.platform == "win32"`. Any script importing a `common.*` module gets it; `configure_encoding()` re-applies it and is safe to call more than once. Never inline a per-script `sys.stdout.reconfigure(...)`: copies drift, and the copies that existed fixed stdout and forgot stdin.

| Method | Works? | Reason |
|--------|--------|--------|
| `common/__init__.py` centralized fix | ✅ Yes | All streams, all scripts, one place |
| `sys.stdout.reconfigure(encoding="utf-8")` | ⚠️ Partial | Only stdout; easy to forget stdin/stderr |
| `io.TextIOWrapper(sys.stdout.buffer, ...)` | ❌ No | Creates wrapper, doesn't fix underlying encoding |
| `PYTHONIOENCODING=utf-8` env var | ⚠️ Partial | Only works if set **before** Python starts |

### CRITICAL: PEP 604 Annotations Require `from __future__ import annotations`

Any distributed Python template file (`templates/**/*.py` — the scripts and
`templates/claude/hooks/statusline.py`) that uses PEP 604 union syntax
(`str | None`, `dict | None`, etc.) in annotations **must** start with:

```python
from __future__ import annotations
```

immediately after the module docstring.

**Why it matters**: `arbor init` refuses a Python older than 3.9, but it
probes the user's shell. The status line is run by the host AI CLI in a
subprocess whose **PATH may differ from the user's shell PATH**, and scripts
may be run by whatever `python3` an agent's shell resolves. In the field this
meant: terminal `python3` is 3.11 (homebrew), the AI CLI subprocess has a
minimal PATH so `python3` is `/usr/bin/python3` (macOS system 3.9), and
`def f(x: str | None)` dies at def-time with `TypeError: unsupported operand
type(s) for |: 'type' and 'NoneType'` before printing anything actionable.

`from __future__ import annotations` makes all annotations lazy strings (PEP 563), so PEP 604 syntax in annotations works on Python 3.7+. Runtime union usage (e.g. `isinstance(x, int | str)`) is **not** rescued by this import — avoid it in distributed templates.

```python
# BAD on 3.9 without the __future__ import: annotations evaluated eagerly
def handler(x: str | None) -> dict | None: ...

# BAD even with it: runtime unions are not rescued
if isinstance(x, int | str): ...
```

#### Audit Check

Run this before releasing any change that adds a new `.py` file to `templates/`:

```bash
cd packages/cli/src/templates
for f in $(find . -name "*.py"); do
    if grep -qE '^[^#]*: [A-Za-z_].*\|.*(None|[A-Z])|->.*\|' "$f" \
       && ! grep -q "from __future__ import annotations" "$f"; then
        echo "MISSING: $f"
    fi
done
```

Exit with 0 matches means all PEP 604 users have the future import.

---

### CRITICAL: Keep User-Facing Python Commands Platform-Aware

Windows does not support shebang (`#!/usr/bin/env python3`), and the Python
command there is usually `python` (or `py -3`). For user-facing invocation
strings in shipped scripts (docstrings, help text, error messages):

- **Write the literal `python3`.** Scripts reach the user's project through
  `replacePythonCommandLiterals` (`configurators/shared.ts`; called from
  `templates/extract.ts` on init and `commands/update.ts` on update), which
  rewrites every non-shebang `python3` to the command `arbor init` detected
  (a no-op on macOS/Linux, which keeps the dogfood copy byte-identical).
- **Never write `{{PYTHON_CMD}}` in a `.py` file.** Scripts do not pass
  through `resolvePlaceholders`, so it would ship literally; it belongs in
  JSON/Markdown templates (e.g. the status-line command in
  `configurators/claude.ts`).
- Never print `sys.executable` as a command for the user to type (spawning a
  child with it, as `driver/finish.py` does for `add_session.py`, is fine).

```python
# In docstrings (rewritten to `python` on Windows at install time)
"""
Usage:
    python3 .arbor/scripts/arbor.py [--task <name>] <command>
"""

# In error messages
print(f"Run: python3 ./{DIR_WORKFLOW}/scripts/init_developer.py <your-name>", file=sys.stderr)
```

### Path Separators

`pathlib.Path` handles separators; never build `".arbor/scripts/x.py"` strings for filesystem access. When a path is written into a file or compared as a git pathspec, convert with
`.as_posix()` (`driver/finish.py:tail` does this for the archive path).

---

## Git interaction in scripts

Scripts that auto-stage / auto-commit `.arbor/` paths stage an explicit,
pre-computed path list through `common/safe_commit.py` and never force. Two
sites do this today, both gated by `session_auto_commit`:

| Site | What it stages | Commit |
|---|---|---|
| `add_session.py:_auto_commit_workspace` | the current developer's `journal-*.md` + `index.md` | `git commit -m <msg> -- <paths>` |
| `driver/finish.py:tail` | the archived task dir, plus its old path when tracked (stages the move) | `git commit --only -- <paths>` via `run_git_retry_index_lock`; see [Driver](./driver.md) |

### Absolute prohibition: never blanket-stage (`git add -A` / `git add .` / `git add .arbor/`)

> **In this repository, NEVER run `git add -A`, `git add .`, or `git add .arbor/`
> — in any language, any script, any person, any AI. Always stage by precise
> path, and never with `-f`.**

For a human/AI assembling an ad-hoc commit: `git status` first, then
`git add <path>` per file.

#### Why: unscoped `.arbor` staging is a bug class (#303)

It recurred through independent triggers: the session auto-commit once
scanned every task dir (`tasks_dir.iterdir()`), leaking dirty parallel-window
task dirs into an unrelated commit; ad-hoc `git add -A` by humans and agents
swept in backups, worktrees and runtime caches. The scoped helpers close the
scripted route; only the prohibition closes the ad-hoc one.

#### Scope invariant

`add_session.py` never stages a task directory. It calls
`safe_arbor_paths_to_add(repo_root, task_name=None)` and drops every path
under `.arbor/tasks/`, so the session commit holds only the developer's
journal and index. A task directory is committed only by the driver when it
archives that task.

### Canonical helpers

All in `common/safe_commit.py` unless noted:

| Helper | Purpose |
|---|---|
| `safe_arbor_paths_to_add(repo_root, task_name=None)` | Existing paths only: the developer's `journal-*.md` + `index.md`; with `task_name`, only that task dir (active or archived); without it, also every task dir + archive (legacy) — so `add_session.py` filters `.arbor/tasks/` out |
| `safe_archive_paths_to_add(repo_root, task_name=None, modified_children=None)` | Archive-commit whitelist; no shipped caller |
| `safe_git_add(paths, repo_root, retry_on_index_lock=False)` | `git add -- <paths>`, never `-f`; returns `(success, used_force=False, stderr)`; `retry_on_index_lock=True` (used by `driver/finish.py:tail`, which has already moved the dir on disk) waits out a held `index.lock` |
| `print_gitignore_warning(paths)` | The one "ignored by .gitignore" warning, with the AI-defense negative example |
| `ARBOR_IGNORED_SUBPATHS` | `.arbor/.backup-*`, `.arbor/worktrees/`, `.arbor/.template-hashes.json`, `.arbor/.runtime/`, `.arbor/.cache/` — never staged |
| `config.get_session_auto_commit(repo_root)` | `session_auto_commit`, default `True` |

### Anti-pattern: `git add -f` on `ignored by`

A real user incident (pre-0.5.10): a project's `.gitignore` listed `.arbor/`.
When the auto-commit hit `ignored by .gitignore`, the AI agent driving the
workflow "fixed" it with `git add -f .arbor/`, committing every ignored subtree
(`.arbor/.backup-*/`, `.arbor/worktrees/`, `.arbor/.template-hashes.json`,
`.arbor/.runtime/`) — 548 files / 83474 lines of caches and backups. The root
cause was generic fallback hint text ("run `git add .arbor && git commit`");
agents seeing "ignored by" reinvent `-f`.

0.5.10 then had scripts run `git add -f` on a narrow whitelist; 0.5.11 reverted
it, because `.arbor/` in `.gitignore` is an explicit "do not track this" and a
script bypassing it, even narrowly, is unacceptable. There is no `-f` retry
anywhere in the auto-commit path.

### Pattern: path whitelist + plain `git add` + warn-and-skip

```python
# add_session.py:_auto_commit_workspace (abridged)
if not get_session_auto_commit(repo_root):
    print("[OK] session_auto_commit: false — skipping git stage/commit.", file=sys.stderr)
    return COMMIT_SKIPPED

commit_msg = get_session_commit_message(repo_root)
paths = [
    p
    for p in safe_arbor_paths_to_add(repo_root, task_name=None)
    if not p.startswith(f"{DIR_WORKFLOW}/{DIR_TASKS}/")
]
if not paths:
    return COMMIT_SKIPPED

success, _, err = safe_git_add(paths, repo_root)   # plain `git add --`, no -f
if not success:
    if err and "ignored by" in err.lower():
        print_gitignore_warning(paths)             # canonical warning text
        return COMMIT_BLOCKED
    return COMMIT_FAILED

# `git diff --cached --quiet -- <paths>`, then
# `git commit -m <msg> -- <paths>` — the pathspec keeps the developer's own
# pre-staged work out of the chore commit (#579).
```

Behavior contract (exit codes per outcome are in the matrix below):

- The whitelist holds only paths that exist on disk; one `git add -- <paths>`, never `-f`, never a retry with other flags.
- `ignored by` → `print_gitignore_warning(paths)` and `COMMIT_BLOCKED`: a gitignored `.arbor/` (like a non-git directory) is a configured skip, not a failure to retry.
- The commit carries the same pathspec as the add, so a developer's own pre-staged entries stay out of the chore commit (#579).
- `used_force` in `safe_git_add`'s tuple is always `False`; never add a path that sets it.

### Scenario: Session recording is a resumable state machine

#### 1. Scope / Trigger

Any change to `add_session.py`'s rendering, journal append, index update,
auto-commit, or session numbering. Recording used to be three unguarded steps
(append, update index, best-effort commit); a failure between them left a
half-recorded session that the next identical run appended a *second* time,
and the commit table said `(see git log)` instead of the subject.

#### 2. Signatures

```python
# add_session.py
def parse_commit_tokens(commit: str) -> tuple[list[str], str | None]
def parse_subject_overrides(values: list[str] | None) -> tuple[dict[str, str], str | None]
def resolve_commit_subject(repo_root: Path, oid: str) -> str | None
def build_commit_evidence(repo_root, tokens, overrides) -> tuple[list[tuple[str, str]], str | None]
def escape_markdown_cell(text: str) -> str
def compute_record_fingerprint(payload: dict) -> str   # 16 hex chars
def render_marker(fingerprint: str) -> str             # HTML comment
def classify_record(repo_root, dev_dir, index_file, marker
    ) -> tuple[str, Path | None, int | None, str | None]
def resolve_next_session(repo_root, dev_dir, index_file) -> int
def _auto_commit_workspace(repo_root: Path) -> str
```

CLI surface (`add_session.py main()`): `--title` (required), `--commit`
(default `-`), `--commit-subject OID=SUBJECT` (repeatable), `--summary`,
`--content-file`, `--stdin`, `--package`, `--branch`, `--change` /
`--test` / `--next-step` (repeatable), `--idempotency-key`, `--no-commit`.

#### 3. Contracts

**Accurate commit evidence, or no write at all.** Every `--commit` token is a
bounded hex OID (`^[0-9a-fA-F]{7,40}$`), resolved to its real subject with
`git show -s --format=%s <oid>^{commit} --` (argv, never a shell; peeled to
`commit` so a hex-looking ref cannot resolve to a tree). An unresolvable OID
fails the command **before the journal or index is touched**. The only escape
hatch is an explicit one-to-one `--commit-subject <oid>=<subject>`; a mapping
for an OID not in `--commit`, a duplicate, or an empty subject is an error.
Placeholder prose (`(see git log)`, `not recorded`, `(Add details)`) is never
substituted. `driver/finish.py` relies on this: it passes each merge commit
with an explicit `--commit-subject` and an `--idempotency-key`.

**Structured sections.** `--change` / `--test` / `--next-step` each render
one bullet per value (Testing bullets get the `[OK] ` prefix). **Sections with
zero values are omitted entirely — never render placeholder text.**
`--content-file` / `--stdin` supply extra Main Changes content.

**Record identity is a retry key, not a dedupe key.** The fingerprint is a
SHA-256 over the normalized semantic inputs (developer, title, summary,
package, branch, resolved commits *and their subjects*, changes, extra
content, tests, next steps, idempotency key), truncated to 16 hex chars, and
persisted as `<!-- arbor-session: v=2 fp=<hash> -->` on the line directly
under the `## Session N:` heading. An HTML comment renders as nothing, so the
human evidence is unchanged by its presence.

The calendar date is **not** an input (v2). v1 mixed it in and wrote the
unversioned `<!-- arbor-session: fp=<hash> -->`, so a retry after midnight
missed its own marker and appended a second entry. v1 markers are still read
(the entry's `**Date**:` line supplies the date) but never written.

The marker only matches a record **still uncommitted in this worktree**: once
the entry is in `git show HEAD:<journal>`, an identical later request is a new
session with a new number, fingerprinted at the next `generation` of the
payload so the two entries never share a marker (generation 0 omits the
field). With `--idempotency-key`, an already-committed match is reported and
exits 0 instead.

**Four states, one direction.** `classify_record` returns `absent`,
`journal-recorded`, `index-recorded`, or `committed` (or an error), and the
run walks them in order:

| From | Step | To |
| --- | --- | --- |
| absent | atomically append the complete marked entry | journal-recorded |
| journal-recorded | write the exact index row | index-recorded |
| index-recorded | stage the scoped paths and commit | committed |

A retry re-enters at whichever state it finds. `journal-recorded` repairs
*only* the index row — it never appends a second entry. `index-recorded`
retries *only* the commit.

**Only a unique exact match is ever adopted.** Two entries carrying the same
marker, a marker with no `## Session N:` heading above it, or a missing index
row while `Total Sessions` already counts past this session all return an
error and change nothing. Ambiguous or malformed pending evidence is never
guessed into completion.

**A failed auto-commit is a failure.** `_auto_commit_workspace` returns
`COMMIT_DONE` / `COMMIT_SKIPPED` / `COMMIT_BLOCKED` / `COMMIT_FAILED`. On
`COMMIT_FAILED` the command exits 1 after printing a `[BLOCKED] Checkpoint:`
block naming the session, the journal file, and the fact that re-running the
identical command resumes rather than duplicates. After a reported-successful
commit the marker is re-read from `HEAD:<journal>`; if it is not there, the
same checkpoint fires.

**Session numbers converge across branches.** The next number is
`max(...) + 1` over the working tree (index `Total Sessions` and every
`## Session N:` heading in every local `journal-*.md`) **and** the recorded
refs: HEAD and the default branch first, then other local heads (where a
parallel worktree's branch lives), then remote-tracking refs, capped at
`MAX_CONVERGENCE_REFS` (100) and read with one `git grep` over all of them.
Numbering from the working tree alone lets two branches claim the same N, and
`journal-*.md merge=union` then merges two different sessions both called N.

**Writes are crash-safe.** Journal append and index rewrite both go through
`io.write_text_atomic`, so a crash leaves the previous content, never a
half-record no retry could classify.

#### 4. Validation & Error Matrix

| Condition | Behavior |
| --- | --- |
| `--commit` token is not 7-40 hex chars | Exit 1, names the token; nothing written |
| `--commit` OID does not resolve locally | Exit 1, names the OID and the `--commit-subject` remedy; nothing written |
| `--commit-subject` for an OID not in `--commit`, duplicated, or empty | Exit 1; nothing written |
| `--commit-subject` subject contains `\|` or newlines | Accepted; escaped for the Markdown cell |
| `--commit -` (default) | `(No commits - planning session)`; no git resolution at all |
| `--idempotency-key` outside `[A-Za-z0-9._-]{1,64}` | Exit 1; nothing written |
| `--package` unknown in a monorepo | Exit 1, lists available packages |
| `--package` in a single-repo project | Warning on stderr; ignored |
| Retry after a failed index update | Index row repaired, journal entry count unchanged |
| Retry after a failed auto-commit | Only the commit is retried; journal and index unchanged |
| Retry of an already-committed record, no idempotency key | New session, new number, and a next-generation marker so neither entry is ambiguous |
| Retry of an already-committed record, with idempotency key | Exit 0, reports "already recorded"; nothing written |
| Marker found in two entries | Exit 1, names the files; nothing written |
| Marker with no `## Session N:` heading above it | Exit 1, "malformed"; nothing written |
| Auto-commit fails | Exit 1 with the `[BLOCKED] Checkpoint:` block |
| `.arbor/` is gitignored | `print_gitignore_warning`, exit 0 (configured skip) |
| Not a git repository | `COMMIT_BLOCKED`, exit 0 — retry could never succeed, so it is not `COMMIT_FAILED` |
| `session_auto_commit: false` | Stops after verified journal + index, exit 0 |
| `--no-commit` | Journal + index written, git untouched, exit 0 |

#### 5. Good / Base / Bad Cases

- **Good** — an interrupted run is re-run unchanged: same fingerprint, the row is written, the commit made, one journal entry.
- **Bad** — "the append succeeded, so report success and warn about the commit." The next identical run appends a second entry.

#### 6. Tests Required

`packages/cli/test/scripts/add-session.integration.test.ts`, real `python3`
against real git repos, not source-string assertions: the matrix above, fault injection at append / index / commit with a retry that proves
convergence (assertion point for fail-before-write: the journal is byte
unchanged), rotation, concurrent-branch numbering, and the staging scope
(dirty task dirs and pre-staged unrelated files stay out of the commit).

#### 7. Wrong vs Correct

```python
# Wrong: a Message column that says nothing
commit_table += f"\n| `{c.strip()}` | (see git log) |"

# Correct: resolve or fail before any mutation
evidence, error = build_commit_evidence(repo_root, tokens, overrides)
if error:
    print(f"Error: {error}", file=sys.stderr)
    return 1
for oid, subject in evidence:
    commit_table += f"\n| `{oid}` | {escape_markdown_cell(subject)} |"
```

### Pattern: `session_auto_commit` config gate (added 0.5.11)

- `true` (default) — `add_session.py` and the driver's archive step stage +
  commit via the helpers above.
- `false` — both return before touching git; files are still written (the
  archive move prints `note: session_auto_commit is false; the archive move is
  not committed`) and the user commits them. The recommended escape hatch when `.gitignore`
  intentionally excludes `.arbor/`.
- `add_session.py --no-commit` skips the commit for one run.
- Always read via `get_session_auto_commit(repo_root)`; never a custom YAML
  reader (see "Config helpers" below).

### Pattern: warning text as canonical AI-defense surface

`print_gitignore_warning` in `common/safe_commit.py` is the **single source of
truth** for the "ignored by .gitignore" warning. Any script that hits this
failure mode must call this helper rather than inlining a copy.

The warning text MUST contain the literal forbidden command as a negative
example so any AI rereading the log does not reinvent the bug:

```
[WARN] Do NOT use `git add -f .arbor/` — it pulls in backups, worktrees,
[WARN] and runtime caches that should never be committed.
```

The general pattern: when a warning invites an "obvious bypass", print the
bypass as a labeled negative example, from one helper.

### Tests Required

When changing `safe_commit.py` or `add_session.py:_auto_commit_workspace`
(`packages/cli/test/scripts/add-session.integration.test.ts` and the
`regression: safe auto-commit when .arbor/ is gitignored` suite in
`packages/cli/test/regression.test.ts`):

- `safe_arbor_paths_to_add` excludes `.arbor/.backup-*`, `.arbor/worktrees/`,
  `.arbor/.template-hashes.json`, `.arbor/.runtime`, `.arbor/.cache/`.
- `safe_git_add` returns `(False, False, stderr)` when paths are gitignored;
  `used_force` is never `True` in any returned tuple.
- `print_gitignore_warning` output contains the literal substring
  `Do NOT use \`git add -f .arbor/\``.
- `_auto_commit_workspace` early-returns when `session_auto_commit: false`,
  with no `git add` / `git commit`.
- **Scope-creep guard:** with task dirs dirty, the session commit must NOT
  stage or commit any `.arbor/tasks/` path, and those dirs stay dirty.

---

## Parsing Structured Command Output

### CRITICAL: Preserve Semantic Whitespace

Many CLI tools encode status information in leading/trailing whitespace characters. **Never blindly `.strip()` before parsing.**

Example: `git submodule status` prefixes each line with ` ` (initialized),
`-` (not initialized) or `+` (out of sync). `status_out.strip()[0]` reads the
first hash character instead of that prefix. Strip only the trailing newline,
read `raw_line[0]`, then strip `raw_line[1:]`. General rule: when output uses
positional formatting (columns, prefixes, fixed-width fields), parse the
structure first, then clean up individual values.

**Other commands with semantic whitespace**:
- `git status --porcelain` — two-char status prefix (`XY`)
- `git diff --name-status` — tab-separated with status prefix
- `git worktree list --porcelain` — blank-line separated records (see `git.main_worktree_root`)

---

## Config helpers

All keys in `.arbor/config.yaml` MUST be read through `common/config.py`
or `common/arbor_config.py`. Both go through one parser chain:

```
_load_config(repo_root)                      # config.py
read_arbor_config(repo_root)                 # arbor_config.py
  -> parse_simple_yaml(content, source)      # arbor_config.py — the only copy
    -> _strip_inline_comment(value)
    -> _unquote(value)
```

This is a load-bearing chain. Any new key added to `.arbor/config.yaml`
must flow through it — do not write a custom reader, even a "small" one.

**`parse_simple_yaml` lives in `arbor_config.py` and nowhere else.**
`config.py` imports it. The direction is forced: `arbor_config.py` imports
nothing from the package (the regression suite loads it as a single
standalone file, `yaml_parser.py`), while `config.py` depends on `paths.py`.
A second copy is a regression, and `regression.test.ts` asserts `config.py`
has no `def parse_simple_yaml(`.

### Supported YAML subset, and what happens outside it

Every parsed scalar is a **string** — the parser does no type coercion, so
`false` arrives as `"false"` and `2000` as `"2000"`. Accessors coerce (see
below). Supported: `key: value`, nested mappings by indentation, `- ` lists of
scalars, whole-line and inline `#` comments, one layer of matching quotes, and
one flow form: an unquoted `[]`, which parses to an empty list
(`gate: commands: []`).

Anything outside that subset is **named on stderr against the file and line,
and skipped** — it is never parsed into a plausible-looking wrong value:

| Construct | Was | Is |
|-----------|-----|-----|
| Mapping inside a list (`- name: cli` / `  path: x`) | `path` hoisted to a **top-level** key — a nested key silently becoming a root key | Warned, skipped; the parent dict is untouched |
| Block scalar (`notes: \|`) | `{"notes": "\|"}` — marker stored as the value, body dropped | Warned, key and body skipped |
| Anchor / alias / merge key / non-empty flow collection | stored as the literal string `&b`, `*b`, `[a, b]` … | Warned, skipped |

Only **unquoted** scalars are inspected, so `cmd: "a | b"` is still the string
the user wrote. A well-formed config produces no output at all.

Both readers are fail-open for a missing or unreadable (`OSError`) file:
`{}`, silently. `config._load_config` also catches a parse *exception* (e.g.
`RecursionError` from a pathologically nested file), warns once on stderr and
returns `{}`; `arbor_config.read_arbor_config` returns `{}` for it without a
warning. A non-UTF-8 `config.yaml` is not covered: `UnicodeDecodeError` is not
an `OSError` and escapes both readers.

### Anti-pattern: custom YAML reader that bypasses `_strip_inline_comment`

A hand-rolled `line.split(":")[1].strip()` reads `key: false  # opt out` as
`"false  # opt out"`, so `session_auto_commit: false  # opt out` comes back
`True`. Fixtures without the inline-comment form pass; the annotated template
config breaks silently. `session_auto_commit` (0.5.11) nearly shipped such a
reader; the fix was routing it through `_load_config` + a typed accessor.

### Pattern: typed accessor on top of `_load_config`

```python
# common/config.py
DEFAULT_SESSION_AUTO_COMMIT = True

def get_session_auto_commit(repo_root: Path | None = None) -> bool:
    config = _load_config(repo_root)
    raw = config.get("session_auto_commit", DEFAULT_SESSION_AUTO_COMMIT)
    return coerce_config_bool(
        raw, DEFAULT_SESSION_AUTO_COMMIT, "session_auto_commit"
    )
```

Each new key gets its own `get_<key>` accessor. The accessor owns:

1. The default constant (named `DEFAULT_<KEY>`, exported alongside the
   accessor).
2. Type coercion (string → bool / int / list as appropriate).
3. Fallback-with-stderr-warn on invalid values. Config errors must NOT
   raise — a bad config line should not block scripts.

The driver's section getters in `arbor_config.py` (see Monorepo Config API) instead take the parsed dict and merge it over in-code defaults.

### Pattern: boolean tolerance

**Every boolean config value goes through `coerce_config_bool(value, default,
label)`.** It accepts native booleans plus the case-insensitive string aliases
`true / false / yes / no / 1 / 0 / on / off`; anything else falls back to
`default` with a stderr warning naming `label`. `_is_true_config_value(value,
label)` is the flag form (absent → `False`) and is what `packages.<name>.git`
goes through (`execution.package_root`, `driver/repos.py`).

This breadth matters because the simple YAML parser does not coerce
`true`/`false` to native bool — values arrive as strings. A reader that only
checks `raw is True` misses every quoted-or-unquoted string variant the user
naturally writes.

One helper, not one per key: `_is_true_config_value` once accepted only the
literal `"true"` while `get_session_auto_commit` accepted the full set, so
`git: yes` silently meant **false** for whether a package is its own git
repository. An accepted-here/rejected-there split is worse than a narrow set
applied consistently.

### Pattern: document every key in `templates/arbor/config.yaml`

Every key the scripts read must have an entry in
`packages/cli/src/templates/arbor/config.yaml` (commented out when the
in-code default should apply), with:

- A short prose explanation of effects (default behavior + opt-in/opt-out
  semantics).
- The accepted values, including the boolean alias set when relevant.

`session_auto_commit` in the template is the model: what `true` and `false`
do, the accepted aliases, and the default left commented out.

If the key is undocumented in `config.yaml`, users discover it only by
reading source — which guarantees they will instead invent a custom
workaround (see "Anti-pattern: `git add -f` on `ignored by`" above). `arbor update` never rewrites a
project's `config.yaml`; a new section reaches existing projects only through
a manifest's `configSectionsAdded` (see [Migrations](./migrations.md)).

### Tests Required

When adding a new accessor in `common/config.py` or `common/arbor_config.py`:

- Default behavior when the key is absent from `config.yaml`.
- Value with inline comment: `key: value  # comment` — the form that breaks custom readers silently; every accessor's fixtures must include it.
- Value with surrounding quotes: `key: "value"` and `key: 'value'`.
- For boolean accessors: each of `true / false / yes / no / 1 / 0 / on / off`
  in both upper and lower case.
- Invalid value → returns default, prints stderr warning, does not raise.

---

## Monorepo Config API

### Config Functions

`common/config.py`:

| Function | Return | Purpose |
|----------|--------|---------|
| `is_monorepo(repo_root)` | `bool` | Whether `get_packages()` is not `None` |
| `get_packages(repo_root)` | `dict[str, dict] \| None` | `packages:` entries whose value is a mapping (`{name: {path, ...}}`); `None` when absent or empty |
| `get_default_package(repo_root)` | `str \| None` | The `default_package` value |
| `get_spec_base(package, repo_root)` | `str` | `"spec"` (single-repo or no package) or `"spec/<package>"` (monorepo) |
| `validate_package(package, repo_root)` | `bool` | Whether package exists in config (always `True` for single-repo) |
| `resolve_package(task_package, repo_root)` | `str \| None` | `task_package` → `default_package` → `None`; an invalid value warns on stderr and is skipped |

`common/arbor_config.py` (all take the parsed config dict):

| Function | Return | Purpose |
|----------|--------|---------|
| `read_arbor_config(repo_root)` | `dict` | Parsed `.arbor/config.yaml` (`{}` on missing/malformed) |
| `get_worktree_config(config)` | `dict` | `worktree:` over `{"setup": "", "branch_prefix": "arbor/"}` |
| `get_executors_config(config)` | `dict` | `executors:` merged over the built-in `orca` executor |
| `get_gate_commands(config)` | `list[str]` | `gate.commands`, stripped, `[]` when absent |

`common/execution.py`: `package_root(main, config, package)` validates a
`git: true` package (contained in the control checkout, the root of an
independent repository) and `frozen_execution(entry)` returns
`packages.<pkg>.execution` without the start-time keys `base_ref` /
`merge_target`. How the driver uses these is in [Driver](./driver.md).

### Config.yaml keys the scripts read

`session_commit_message`, `max_journal_lines`, `session_auto_commit`
(add_session.py); `packages.<name>.{path, git, execution}`,
`default_package`; `executors`, `gate.commands`, `worktree.{setup,
branch_prefix}` (driver). Each is documented in
`packages/cli/src/templates/arbor/config.yaml`.

`add_session.py --package` rule: in a monorepo an unknown package fails fast
(exit 1, lists available packages); in a single-repo project it warns and is
ignored; without `--package`, `resolve_package(None, repo_root)` supplies
`default_package` (or `None`). `arbor.py new` uses `default_package` as the
default `--repo` only when it names a configured repository key, else `.`.

---

## Error Handling

### Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | General error / refused |
| 2 | Usage error (wrong arguments; argparse exits 2) |

`arbor.py` and `spec.py` both document this mapping in their module docstring.

### Error Messages

Print errors to stderr with context, and return the exit code from `main()`
rather than calling `sys.exit` deep inside helpers:

```python
# arbor.py
def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except (DriverError, ExecutorError, WorktreeError, json.JSONDecodeError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
```

Library modules raise a module-specific exception carrying a message the
entry script can print as-is. Exceptions from lower layers are translated at
the driver boundary (`driver/repos.py` re-raises `ContractError` and
`ExecutionError` as `DriverError`), so `main` catches only the types it
names.

---

## Argument Parsing

Use `argparse` with subparsers and `set_defaults(func=...)` dispatch (the
`arbor.py` pattern):

```python
def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="arbor.py", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--task", help="task directory name (default: the only open task)")
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("new")
    p.add_argument("title")
    p.add_argument("--slug")
    p.set_defaults(func=cmd_new)
    p = sub.add_parser("status")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_status)
    return parser
```

- `main(argv: list[str] | None = None)` takes an optional argv so tests can
  call it in-process.
- Repeatable values use `action="append"` (`add_session.py --change`).
- Machine-readable output is an explicit `--json` flag, not a separate script.

---

## Import Conventions

### Relative Imports Within Package

```python
# In add_session.py (root level)
from common.paths import get_repo_root, DIR_WORKFLOW
from common.developer import ensure_developer

# In common/developer.py
from .paths import get_repo_root, DIR_WORKFLOW

# In common/driver/repos.py
from ..arbor_config import get_gate_commands, get_worktree_config
```

### Import Order

`from __future__ import annotations` first, then standard library, then
local `common.*` imports, each group separated by a blank line.

---

## Module Split Patterns

When a script grows too large, split it into focused modules.

### Pattern: Entry Shim

Keep the user-facing filename as a thin entry point over a library module.
`spec.py` is the live example: usage docstring, `from common.spec_lint import
main`, `sys.exit(main())`. The entry path stays stable
(`python3 .arbor/scripts/spec.py`) because docs and skills reference it, not
the module.

### Pattern: Lazy Import for Circular Dependencies

When two modules need each other, import inside the function body:

```python
# common/paths.py — config.py imports paths.py at module load,
# so paths.py imports config only when called
def get_spec_dir(package: str | None = None, repo_root: Path | None = None) -> Path:
    ...
    from .config import get_spec_base

    base = get_spec_base(package, repo_root)
    return repo_root / DIR_WORKFLOW / base
```

**When to use**: Only when a true circular dependency exists. If you can restructure imports to avoid it, do that first.

### Pattern: Read Once, Pass the Data

When several functions need the same file, read it once at the top and pass
the parsed dict to private helpers instead of having each helper re-read the
file.

---

## DO / DON'T

### DO

- Use `pathlib.Path` for all path operations
- Use PEP 604 type hints with `from __future__ import annotations`
- Return exit codes from `main()`
- Print errors to stderr
- Write `python3` in user-facing command strings (install rewrites it per platform)
- Use `encoding="utf-8"` for all file operations

### DON'T

- Don't use string path concatenation
- Don't use `os.path` when `pathlib` works
- Don't rely on shebang for invocation documentation
- Don't use `print()` to stdout for errors (use stderr)
- Don't hardcode paths - use constants from `common/paths.py`
- Don't use external dependencies (stdlib only)
