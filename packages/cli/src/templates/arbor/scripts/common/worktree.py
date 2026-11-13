"""
Task and partition worktrees.

A started task owns one git worktree on its own branch; parallel partitions
get sub-worktrees on sibling branches. Naming:

    task branch       arbor/<task>               Orca workspace <task>
    partition branch  arbor/<task>--<partition>  Orca workspace <task>-<partition>

(`arbor/<task>/<partition>` is impossible: git cannot hold a ref `a/b` next
to `a/b/c`.) Orca creates and removes every worktree (``orca worktree create``
/ ``orca worktree rm``) and chooses its path; a worktree is found again by the
branch it has checked out.
"""

from __future__ import annotations

import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

from .arbor_config import get_worktree_config
from .driver import orca
from .driver.executor import ExecutorError, resolve_executor
from .git import main_worktree_root, run_git

TASK_BRANCH_PREFIX = "arbor/"
PARTITION_SEPARATOR = "--"
SETUP_TAIL_LINES = 20


class WorktreeError(RuntimeError):
    """A git worktree operation failed; the message carries git's stderr."""


@dataclass(frozen=True)
class MergeResult:
    ok: bool
    conflicts: list[str]
    sha: str | None


@dataclass(frozen=True)
class TaskWorktree:
    path: Path
    branch: str
    base_sha: str


def list_worktrees(repo_root: Path) -> list[Path]:
    """Resolved roots of every non-bare worktree registered for this repo
    (the main checkout included). Empty outside a git repository."""
    rc, out, _ = run_git(["worktree", "list", "--porcelain"], cwd=repo_root)
    if rc != 0:
        return []

    roots: list[Path] = []
    current: Path | None = None
    bare = False
    for line in [*out.splitlines(), ""]:
        if line.startswith("worktree "):
            current = Path(line[len("worktree "):].strip())
            bare = False
        elif line.strip() == "bare":
            bare = True
        elif not line.strip():
            if current is not None and not bare:
                try:
                    roots.append(current.resolve())
                except OSError:
                    pass
            current = None
    return roots


def main_checkout(repo_root: Path) -> Path:
    """The main working tree, whether ``repo_root`` is it or a linked worktree."""
    return main_worktree_root(repo_root) or repo_root.resolve()


def branch_prefix(config: dict) -> str:
    """``worktree.branch_prefix`` (default ``arbor/``): a repository whose
    branch namespace already holds ``arbor`` sets another prefix."""
    value = str(get_worktree_config(config).get("branch_prefix") or TASK_BRANCH_PREFIX).strip()
    return value if value.endswith("/") or value.endswith("-") else value + "/"


def task_branch(task_name: str, prefix: str = TASK_BRANCH_PREFIX) -> str:
    return f"{prefix}{task_name}"


def partition_branch(task_name: str, partition: str, prefix: str = TASK_BRANCH_PREFIX) -> str:
    return f"{prefix}{task_name}{PARTITION_SEPARATOR}{partition}"


def is_ancestor(worktree: Path, commit: str, of: str = "HEAD") -> bool:
    """True when ``commit`` is reachable from ``of``."""
    rc, _, _ = run_git(["merge-base", "--is-ancestor", commit, of], cwd=worktree)
    return rc == 0


ORCA_WORKTREE_TIMEOUT_S = 120


def _orca(config: dict, args: list[str]) -> tuple[dict, str | None]:
    """One ``orca worktree`` command: (its result, why it failed)."""
    try:
        return orca.call(resolve_executor(config), args, ORCA_WORKTREE_TIMEOUT_S)
    except ExecutorError as e:
        return {}, str(e)


def add_worktree(config: dict, repo_root: Path, name: str, branch: str, start_point: str,
                 parent: Path | None) -> Path:
    """Create ``branch`` at ``start_point`` in a new Orca workspace ``name``
    (a child workspace of ``parent``) and return the path Orca gave it.
    ``config`` is the control checkout's: it names the Orca CLI."""
    result, error = _orca(config, [
        "worktree", "create", "--repo", f"path:{repo_root}", "--name", name, "--branch", branch,
        "--base-branch", start_point,
        *(["--parent-worktree", f"path:{parent}"] if parent else ["--no-parent"])])
    made = result.get("worktree")
    if error or not isinstance(made, dict) or not made.get("path"):
        if error and error.startswith("repo_not_found"):
            error = f"{repo_root} is not a project in Orca (`orca repo add --path {repo_root}`)"
        raise WorktreeError(f"orca worktree create {name} failed: {error or 'no path in the answer'}")
    path = Path(made["path"])
    got = str(made.get("branch") or "").removeprefix("refs/heads/")
    if got != branch:
        # Orca suffixes a taken workspace name or branch instead of refusing.
        _orca(config, ["worktree", "rm", "--worktree", f"path:{path}", "--force"])
        run_git(["branch", "-D", got], cwd=repo_root)
        raise WorktreeError(f"Orca already has a workspace or branch named {name} / {branch} "
                            f"(it offered {got}); remove the old one first")
    return path.resolve()


def branch_worktree(repo_root: Path, branch: str) -> Path | None:
    """The worktree (the main checkout included) that has ``branch`` checked out."""
    rc, out, _ = run_git(["worktree", "list", "--porcelain"], cwd=repo_root)
    if rc != 0:
        return None
    current: Path | None = None
    for line in out.splitlines():
        if line.startswith("worktree "):
            current = Path(line[len("worktree "):].strip())
        elif line.strip() == f"branch refs/heads/{branch}" and current is not None:
            return current
    return None


def _worktree_branch(repo_root: Path, path: Path) -> str | None:
    """Branch checked out in the registered worktree at ``path``, if any."""
    rc, out, _ = run_git(["worktree", "list", "--porcelain"], cwd=repo_root)
    if rc != 0:
        return None
    target = path.resolve()
    current: Path | None = None
    for line in out.splitlines():
        if line.startswith("worktree "):
            current = Path(line[len("worktree "):].strip()).resolve()
        elif line.startswith("branch ") and current == target:
            return line[len("branch "):].strip().removeprefix("refs/heads/")
    return None


def remove_worktree(config: dict, repo_root: Path, path: Path, *, delete_branch: bool = False,
                    force: bool = False) -> None:
    """Remove a worktree through Orca; optionally delete the branch it had
    checked out. ``config`` is the control checkout's.

    Not forced by default: Orca (like git) refuses a worktree with modified or
    untracked files, which is the point — removal must never discard
    uncommitted work. ``force`` is for a worktree the caller just made.
    """
    branch = _worktree_branch(repo_root, path) if delete_branch else None
    _, error = _orca(config, ["worktree", "rm", "--worktree", f"path:{path}", *(["--force"] if force else [])])
    if error:
        raise WorktreeError(f"orca worktree rm {path} failed: {error}")
    if branch:
        rc, _, err = run_git(["branch", "-D", branch], cwd=repo_root)
        if rc != 0:
            raise WorktreeError(f"git branch -D {branch} failed: {err.strip()}")


def run_setup(path: Path, command: str | None) -> int:
    """Run ``worktree.setup`` in a fresh worktree; returns its exit code.

    Output is captured; on failure its last lines go to stderr so the caller
    can fail with the reason in view.
    """
    if not command or not command.strip():
        return 0
    try:
        proc = subprocess.run(
            command,
            shell=True,
            cwd=path,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    except OSError as e:
        print(f"worktree.setup could not run: {e}", file=sys.stderr)
        return 1
    if proc.returncode != 0:
        tail = proc.stdout.splitlines()[-SETUP_TAIL_LINES:]
        print(
            f"worktree.setup exited {proc.returncode}: {command}",
            file=sys.stderr,
        )
        for line in tail:
            print(f"  {line}", file=sys.stderr)
    return proc.returncode


def merge_no_ff(into_worktree: Path, branch: str, message: str) -> MergeResult:
    """``git merge --no-ff`` ``branch`` into the branch checked out at
    ``into_worktree``. A conflicted merge is aborted, never left half-done;
    the result then lists the conflicting paths."""
    rc, _, _ = run_git(
        ["merge", "--no-ff", "--no-edit", "-m", message, branch],
        cwd=into_worktree,
    )
    if rc == 0:
        rc, out, _ = run_git(["rev-parse", "HEAD"], cwd=into_worktree)
        return MergeResult(True, [], out.strip() if rc == 0 else None)

    _, out, _ = run_git(["diff", "--name-only", "--diff-filter=U"], cwd=into_worktree)
    conflicts = sorted(line for line in out.splitlines() if line.strip())
    rc, _, _ = run_git(["rev-parse", "-q", "--verify", "MERGE_HEAD"], cwd=into_worktree)
    if rc == 0:
        run_git(["merge", "--abort"], cwd=into_worktree)
    return MergeResult(False, conflicts, None)


def create_task_worktree(repo_root: Path, task_dir: Path, config: dict,
                         start_point: str = "HEAD", parent: Path | None = None) -> TaskWorktree:
    """Create ``<branch_prefix><task>`` at ``start_point`` (the current HEAD, or a
    parent's integration branch) and its worktree, an Orca workspace under
    ``parent`` (default: the main checkout). Refuses when the branch exists."""
    name = task_dir.name
    main = main_checkout(repo_root)
    branch = task_branch(name, branch_prefix(config))

    rc, out, err = run_git(["rev-parse", "--verify", f"{start_point}^{{commit}}"], cwd=repo_root)
    if rc != 0:
        raise WorktreeError(f"no commit to start from (git rev-parse {start_point}: {err.strip()})")
    base_sha = out.strip()

    rc, _, _ = run_git(["rev-parse", "--verify", "--quiet", f"refs/heads/{branch}"], cwd=main)
    if rc == 0:
        raise WorktreeError(f"branch {branch} already exists")

    path = add_worktree(config, main, name, branch, base_sha, parent or main)
    return TaskWorktree(path, branch, base_sha)
