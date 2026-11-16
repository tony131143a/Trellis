---
sources:
  - packages/cli/src/templates/arbor/index.ts
  - packages/cli/src/templates/arbor/scripts/arbor.py
  - packages/cli/src/templates/arbor/scripts/common/__init__.py
  - packages/cli/src/templates/arbor/scripts/common/io.py
  - packages/cli/src/templates/arbor/scripts/common/git.py
  - packages/cli/src/templates/arbor/scripts/common/safe_commit.py
  - packages/cli/src/templates/arbor/scripts/common/config.py
  - packages/cli/src/templates/arbor/scripts/common/arbor_config.py
  - packages/cli/src/configurators/shared.ts
last_verified: 2026-11-16
---
# Script Conventions

> Rules for the Python scripts in `.arbor/scripts/`.

## Scope

Workflow scripts target Python 3.9+ (the macOS system `python3`) and use only the standard library. Entry scripts sit at the top of `scripts/`; library modules in `common/` are never run directly; the driver package `common/driver/` is covered in [Driver](./driver.md). The shipped set is `getAllScripts()` in `packages/cli/src/templates/arbor/index.ts`: a new shipped script must be registered there.

Foundation modules (`io.py`, `log.py`, `git.py`, `arbor_config.py`) import nothing from the package and are used by everything; `paths.py` and `developer.py` sit above them, `config.py` above `paths.py`. Task and driver modules serve `arbor.py`; `spec_meta.py` and `spec_lint.py` serve `spec.py`.

## Two script trees, one content

- `packages/cli/src/templates/arbor/scripts/**` is what ships and is the source; `.arbor/scripts/**` is this repo's installed copy. Both trees hold the same set of `.py` files with byte-identical content: edit the template, mirror it in the same change, never edit one copy. There is no acceptable drift.
- Guard: `packages/cli/test/regression.test.ts` → "regression: .arbor/scripts stays byte-identical to templates/arbor/scripts". Its file list is derived from the filesystem, so do not add per-file tests. It covers `.py` files only and does not check `getAllScripts()`.
- `packages/cli/dist/**` is generated; never hand-edit it.

## Coding standards

- Annotations use PEP 604 and builtin generics (`dict | None`), not `typing.Optional` / `Dict`.
- Paths are `pathlib.Path`, never string concatenation or `os.path` where `pathlib` works; take directory names from the constants in `common/paths.py`. Convert with `.as_posix()` when a path is written into a file or compared as a git pathspec.
- Every file operation passes `encoding="utf-8"`.
- JSON goes through `common/io.py`. Never inline `json.loads(path.read_text())` or `path.write_text(json.dumps(...))`: the inline write is not atomic and the inline read does not distinguish its failure modes.
- `read_json` is for optional reads only. A caller about to overwrite the file it read, or whose failure the user must act on, uses `read_json_checked` and names the file and the failure class (`driver/repos.py`).
- Every `write_json` return is checked: a failed atomic write left the old content in place, so printing success after an unchecked write is a false report.
- Write back the dict you read; never rebuild one from selected fields, because state files may carry fields this version does not know.
- Git goes through `common/git.py:run_git`. Other commands use `subprocess.run` with an argv list, `capture_output=True, text=True, encoding="utf-8", errors="replace"`, and `timeout=` for anything that can hang (`driver/orca.py:call`).
- `shell=True` only for commands a person wrote (`gate.commands` in `driver/gate.py`, `worktree.setup` in `worktree.py`); never for argv the script assembles itself.
- Never `.strip()` command output before parsing it: many tools encode status in leading whitespace (`git submodule status`, `git status --porcelain`). Parse the structure first, then clean individual values.

## Cross-platform

- Windows stdio encoding is fixed in one place, `common/__init__.py` (`_configure_stream` on stdout, stderr and stdin), which every script importing `common.*` gets. Never inline a per-script `sys.stdout.reconfigure(...)`: copies drift, and the copies that existed fixed stdout and forgot stdin.
- A distributed template `.py` (`packages/cli/src/templates/**/*.py`) that uses PEP 604 syntax in annotations starts with `from __future__ import annotations` right after the module docstring. The host AI CLI may run scripts with a PATH whose `python3` is the macOS system 3.9, where an eager `str | None` fails at def-time. Runtime unions (`isinstance(x, int | str)`) are not rescued by the import; avoid them in distributed templates.
- User-facing command strings (docstrings, help text, error messages) write the literal `python3`; `replacePythonCommandLiterals` (`configurators/shared.ts`) rewrites it to the detected command at install. Never write `{{PYTHON_CMD}}` in a `.py` file (scripts do not pass through `resolvePlaceholders`), and never print `sys.executable` as a command for the user to type.
- `.arbor/.developer` is gitignored on purpose: no tracked file may carry a personal identity.

## Git interaction

- Never blanket-stage: no `git add -A`, `git add .` or `git add .arbor/`, by any script, person or agent. Stage by precise path, and never with `-f`. Unscoped `.arbor` staging has swept dirty task dirs, backups, worktrees and runtime caches into unrelated commits.
- Scripted auto-commits stage an explicit, pre-computed path list through `common/safe_commit.py` (`safe_git_add`), and the commit carries the same pathspec as the add, so the developer's own pre-staged work stays out of the chore commit.
- `add_session.py` never stages a task directory; a task directory is committed only by the driver when it archives that task.
- `ignored by .gitignore` is a configured skip, not a failure to retry: `.arbor/` in `.gitignore` is an explicit "do not track this", and there is no `-f` retry anywhere in the auto-commit path.
- `print_gitignore_warning` is the single source of that warning, and its text names `git add -f .arbor/` as a labelled negative example. When a warning invites an obvious bypass, print the bypass as a negative example, from one helper.
- Auto-commit is gated by `session_auto_commit`, read only through `config.get_session_auto_commit`.
- Guards: `packages/cli/test/scripts/add-session.integration.test.ts` and `regression.test.ts` → "regression: safe auto-commit when .arbor/ is gitignored".

## Config

- Every `.arbor/config.yaml` key is read through `common/config.py` or `common/arbor_config.py`; never write a custom reader, even a small one. A hand-rolled `split(":")` reads `key: false  # opt out` as `"false  # opt out"`.
- `parse_simple_yaml` lives in `arbor_config.py` and nowhere else; `regression.test.ts` asserts `config.py` has no `def parse_simple_yaml(`.
- Each key gets its own `get_<key>` accessor owning its `DEFAULT_<KEY>` constant, its type coercion and a stderr-warned fallback on invalid values. Config errors never raise: a bad config line should not block scripts.
- Every boolean value goes through `coerce_config_bool`. One helper for every key, because an accepted-here, rejected-there split is worse than a narrow set applied consistently.
- Every key the scripts read is documented in `packages/cli/src/templates/arbor/config.yaml` with its effect and accepted values.
- Accessor tests cover the absent key, a value with an inline comment, quoted values, and an invalid value that falls back without raising.

## Entry scripts, errors and exit codes

- An entry script has a shebang, a usage docstring with its exit codes, `from __future__ import annotations`, a `main(argv: list[str] | None = None) -> int`, and `sys.exit(main())` under `if __name__ == "__main__":`.
- Exit codes: 0 success, 1 error or refused, 2 usage error (argparse exits 2).
- `main()` returns the exit code; helpers do not call `sys.exit`. Errors go to stderr with context; the `common/log.py` `log_*` helpers print to stdout, so errors use `print(..., file=sys.stderr)`.
- Library modules raise a module-specific exception whose message the entry script prints as-is. Lower-layer exceptions are translated at the driver boundary (`driver/repos.py` re-raises them as `DriverError`), so `arbor.py:main` catches only the types it names.
- `spec.py lint` is advisory by design: nothing gates a commit or a task finish on its result. Adding such a gate is a product decision, not a script change.
- Argument parsing uses `argparse` subparsers with `set_defaults(func=...)` dispatch (`arbor.py:build_parser`); repeatable values use `action="append"`; machine-readable output is an explicit `--json` flag, not a separate script.

## Imports and module splits

- `from __future__ import annotations` first, then the standard library, then local imports, each group separated by a blank line.
- Root-level scripts import `from common.<module>`; modules inside `common/` use relative imports.
- A user-facing script that grows too large stays a thin entry shim over a library module (`spec.py` → `common.spec_lint.main`), so the path that docs and skills reference stays stable.
- Import inside a function body only for a true circular dependency (`paths.py:get_spec_dir` imports `config`); restructure first if you can.
- When several functions need the same file, read it once and pass the parsed data.
