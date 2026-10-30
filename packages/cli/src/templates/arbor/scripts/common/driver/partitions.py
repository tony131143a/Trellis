"""
Multi-partition waves, the git side.

A wave naming more than one partition (or any partition other than
``default``) runs each partition on its own branch in its own worktree:

    branch    arbor/<task>--<partition>
    worktree  <root>/<task>-<partition>

created from the task branch HEAD when the wave starts, merged back into the
task branch with ``--no-ff`` (in wave order) when every partition is done,
then removed. The state of the wave lives in ``task.json`` (see
``state.py``); this module only touches git.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from ..arbor_config import get_worktree_config
from ..contract import Contract
from ..git import run_git
from ..worktree import (
    WorktreeError,
    _worktree_branch,
    add_worktree,
    is_ancestor,
    merge_no_ff,
    partition_branch,
    partition_worktree_path,
    remove_worktree,
    run_setup,
)
from .gate import auto_checks


@dataclass(frozen=True)
class WaveMerge:
    merged: list[tuple[str, str]]  # (partition, sha of HEAD after its merge)
    conflict: dict | None  # {partition, files, branch, into}


def first_step(contract: Contract, partition: str) -> str:
    """``test`` when the partition owns an auto check's file, else ``implement``."""
    spec = contract.partition(partition)
    if spec is None:
        return "implement"
    return "test" if auto_checks(contract, spec.paths) else "implement"


def _rev(worktree: Path, ref: str) -> str:
    rc, out, err = run_git(["rev-parse", "--verify", ref], cwd=worktree)
    if rc != 0:
        raise WorktreeError(f"git rev-parse {ref} failed: {err.strip()}")
    return out.strip()


def create_partition(main: Path, config: dict, task: str, partition: str, start_point: str) -> dict:
    """Branch + worktree (+ ``worktree.setup``) for one partition; returns
    ``{branch, worktree, base}``. A pair left by an interrupted wave start is
    reused as long as it has no commits of its own."""
    branch = partition_branch(task, partition)
    path = partition_worktree_path(main, config, task, partition)
    if path.exists() and _worktree_branch(main, path) == branch:
        base = _rev(main, branch)
        if not is_ancestor(main, base, start_point):
            raise WorktreeError(f"{branch} already exists with commits of its own; remove it first")
        return {"branch": branch, "worktree": str(path.resolve()), "base": base}
    rc, _, _ = run_git(["rev-parse", "--verify", "--quiet", f"refs/heads/{branch}"], cwd=main)
    if rc == 0:
        raise WorktreeError(f"branch {branch} already exists")
    if path.exists():
        raise WorktreeError(f"worktree path already exists: {path}")
    add_worktree(main, path, branch, start_point)
    if run_setup(path, get_worktree_config(config).get("setup")) != 0:
        raise WorktreeError(f"worktree.setup failed in {path}")
    return {"branch": branch, "worktree": str(path.resolve()), "base": start_point}


def merge_partitions(task_worktree: Path, task: str, wave: int, order: list[str],
                     records: dict[str, dict]) -> WaveMerge:
    """Merge every not-yet-merged partition branch into the task branch, in
    ``order``; stop at the first conflict (the merge is aborted)."""
    merged: list[tuple[str, str]] = []
    for name in order:
        rec = records[name]
        if rec.get("merged"):
            continue
        branch = rec["branch"]
        if is_ancestor(task_worktree, branch):
            merged.append((name, _rev(task_worktree, "HEAD")))
            continue
        result = merge_no_ff(task_worktree, branch, f"arbor({task}): merge wave {wave} partition {name}")
        if not result.ok:
            into = run_git(["symbolic-ref", "-q", "--short", "HEAD"], cwd=task_worktree)[1].strip()
            return WaveMerge(merged, {"partition": name, "files": result.conflicts, "branch": branch,
                                      "into": into})
        merged.append((name, result.sha or _rev(task_worktree, "HEAD")))
    return WaveMerge(merged, None)


def remove_partitions(main: Path, records: dict[str, dict]) -> list[str]:
    """Remove the partition worktrees and branches; returns warnings for what
    git refused to remove (a worktree with untracked files is never forced)."""
    warnings: list[str] = []
    for rec in records.values():
        path = Path(rec["worktree"])
        try:
            if path.exists():
                remove_worktree(main, path, delete_branch=True)
            else:
                run_git(["worktree", "prune"], cwd=main)
                run_git(["branch", "-D", rec["branch"]], cwd=main)
        except WorktreeError as e:
            warnings.append(str(e))
    return warnings
