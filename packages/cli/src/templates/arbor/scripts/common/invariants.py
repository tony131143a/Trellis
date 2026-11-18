"""
Working-tree and commit observations of a worktree, read with git.

:func:`snapshot_refs` records the paths ``git status --porcelain`` reports
dirty; :func:`changed_files` lists the paths a commit range changed.
"""

from __future__ import annotations

from dataclasses import dataclass

from .git import run_git


@dataclass(frozen=True)
class RefSnapshot:
    """Working-tree state of one worktree at one moment."""

    dirty: frozenset[str] = frozenset()  # paths `git status --porcelain` reports

    @property
    def clean(self) -> bool:
        return not self.dirty


def _git_out(args: list[str], worktree) -> str | None:
    rc, out, _ = run_git(args, cwd=worktree)
    return out if rc == 0 else None


def _dirty_paths(worktree) -> frozenset[str]:
    out = _git_out(["status", "--porcelain", "-z", "--untracked-files=all"], worktree) or ""
    paths: set[str] = set()
    entries = out.split("\0")
    i = 0
    while i < len(entries):
        entry = entries[i]
        i += 1
        if len(entry) < 4:
            continue
        status, path = entry[:2], entry[3:]
        paths.add(path)
        if "R" in status or "C" in status:
            # -z prints the rename/copy source as the next entry.
            if i < len(entries) and entries[i]:
                paths.add(entries[i])
            i += 1
    return frozenset(paths)


def snapshot_refs(worktree) -> RefSnapshot:
    """Porcelain status of ``worktree``."""
    return RefSnapshot(_dirty_paths(worktree))


def changed_files(worktree, range_spec: str) -> list[str]:
    """Paths changed in ``range_spec`` (``<a>..<b>``), renames as both sides."""
    out = _git_out(["diff", "--name-only", "--no-renames", range_spec], worktree) or ""
    return sorted({line for line in out.splitlines() if line.strip()})
