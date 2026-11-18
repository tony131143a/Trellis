"""
Safe git-add helpers for Arbor-owned paths.

Why this module exists
----------------------
A real user incident: a project's `.gitignore` listed `.arbor/` (company-wide
template / personal habit). When the auto-commit of `add_session.py` or of
the task archive ran and `git add` failed with `ignored by .gitignore`, the AI
agent driving the workflow "fixed" it by retrying with
`git add -f .arbor/` — which fan-out-included every ignored subtree
(`.arbor/.backup-*/`, `.arbor/.template-hashes.json`, `.arbor/.runtime/`),
committing 548 files / 83474 lines of caches/backups.

Design
------
- Scripts only stage SPECIFIC product paths (journal files, index.md, an
  archived task dir and its old path). Never the whole `.arbor/` tree.
- If plain `git add <specific>` fails with "ignored by", DO NOT retry with
  ``-f``. The presence of `.arbor/` in `.gitignore` is treated as user
  intent ("keep .arbor/ local-only"). The script warns and skips the
  auto-commit; users who want auto-staging can either fix their `.gitignore`
  or set ``session_auto_commit: false`` and manage git themselves.
- The warning includes a negative example: ``Do NOT use `git add -f .arbor/` ...``
  so any AI rereading the log doesn't reinvent the bug.

History note: 0.5.10 introduced an automatic ``git add -f`` retry on the
specific paths. That was reverted in 0.5.11 — auto-forcing into a tree the
user had gitignored violates user intent even when the path list is narrow.
The wider-grain forbidden command stays forbidden, and the narrow-grain auto
``-f`` is gone too.
"""

from __future__ import annotations

import sys
from pathlib import Path

from .git import run_git, run_git_retry_index_lock
from .paths import (
    DIR_WORKFLOW,
    DIR_WORKSPACE,
    FILE_JOURNAL_PREFIX,
    get_developer,
)


# Paths under .arbor/ that must NEVER be auto-staged. Listed here so the
# warning to the user can show concrete subpaths to ignore individually
# instead of ignoring the whole `.arbor/` tree.
ARBOR_IGNORED_SUBPATHS = (
    ".arbor/.backup-*",
    ".arbor/.template-hashes.json",
    ".arbor/.runtime/",
)


def safe_arbor_paths_to_add(repo_root: Path) -> list[str]:
    """The repo-relative paths the session auto-commit stages: the current
    developer's ``.arbor/workspace/<developer>/journal-*.md`` and
    ``index.md``, those that exist on disk.

    Never task directories (#303: dirty task dirs must not be bundled into
    the session auto-commit) nor the ignored subpaths in
    ``ARBOR_IGNORED_SUBPATHS``. The caller checks ``git diff --cached``
    afterwards.
    """
    developer = get_developer(repo_root)
    if not developer:
        return []
    ws = repo_root / DIR_WORKFLOW / DIR_WORKSPACE / developer
    if not ws.is_dir():
        return []
    rel = f"{DIR_WORKFLOW}/{DIR_WORKSPACE}/{developer}"
    paths = [f"{rel}/{f.name}" for f in sorted(ws.glob(f"{FILE_JOURNAL_PREFIX}*.md")) if f.is_file()]
    if (ws / "index.md").is_file():
        paths.append(f"{rel}/index.md")
    return paths


def safe_git_add(
    paths: list[str], repo_root: Path, retry_on_index_lock: bool = False
) -> tuple[bool, str]:
    """Run `git add` on specific paths; never retry with -f.

    Returns ``(success, stderr)``.

    Behavior:
      - No paths passed → success, empty stderr.
      - Plain ``git add -- <paths>`` succeeds → return success.
      - Plain fails (any reason — ignored or otherwise) → return failure with
        the stderr. Callers should inspect the stderr (see
        :func:`print_gitignore_warning`) and skip the auto-commit.

    ``retry_on_index_lock`` opts into the bounded backoff-retry for a held
    ``.git/index.lock`` (see :func:`~.git.run_git_retry_index_lock`). It is
    off by default: only the archive path, which has already moved the task
    directory on disk by the time it stages, needs to wait out a transient
    lock rather than fail.
    """
    if not paths:
        return True, ""

    runner = run_git_retry_index_lock if retry_on_index_lock else run_git
    rc, _, err = runner(["add", "--", *paths], cwd=repo_root)
    if rc == 0:
        return True, ""
    return False, err


def print_gitignore_warning(paths: list[str]) -> None:
    """Explain to the user (and any AI reading the log) what to do.

    CRITICAL: includes the negative example
    ``Do NOT use `git add -f .arbor/``` — agents reading the warning are
    known to invent that command, which fans out to ignored caches/backups.
    """
    print(
        "[WARN] git add failed because .arbor/ paths are ignored by your .gitignore.",
        file=sys.stderr,
    )
    print(
        "[WARN] Skipping auto-commit. The journal/task files were still written to disk;",
        file=sys.stderr,
    )
    print(
        "[WARN] git was not touched.",
        file=sys.stderr,
    )
    print("[WARN]", file=sys.stderr)
    print(
        "[WARN] Arbor manages these specific paths and they should be tracked:",
        file=sys.stderr,
    )
    for p in paths:
        print(f"[WARN]   {p}", file=sys.stderr)
    print("[WARN]", file=sys.stderr)
    print(
        "[WARN] Recommended: change your .gitignore from `.arbor/` to specific",
        file=sys.stderr,
    )
    print(
        "[WARN] subpaths that should remain ignored, e.g.:",
        file=sys.stderr,
    )
    for sub in ARBOR_IGNORED_SUBPATHS:
        print(f"[WARN]   {sub}", file=sys.stderr)
    print("[WARN]", file=sys.stderr)
    print(
        "[WARN] Or, if you intentionally keep .arbor/ local-only, set in",
        file=sys.stderr,
    )
    print(
        "[WARN] .arbor/config.yaml:",
        file=sys.stderr,
    )
    print(
        "[WARN]   session_auto_commit: false",
        file=sys.stderr,
    )
    print(
        "[WARN] so the scripts skip git entirely and you can review / commit",
        file=sys.stderr,
    )
    print(
        "[WARN] manually with `git status` / `git add` / `git commit`.",
        file=sys.stderr,
    )
    print("[WARN]", file=sys.stderr)
    print(
        "[WARN] Do NOT use `git add -f .arbor/` — it pulls in backups and",
        file=sys.stderr,
    )
    print(
        "[WARN] runtime caches that should never be committed.",
        file=sys.stderr,
    )
