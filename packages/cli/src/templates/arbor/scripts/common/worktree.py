"""
Task and partition worktrees.

A started task owns one git worktree on its own branch; parallel partitions
get sub-worktrees on sibling branches. Naming:

    task branch       arbor/<task>               worktree <root>/<task>
    partition branch  arbor/<task>--<partition>  worktree <root>/<task>-<partition>

(`arbor/<task>/<partition>` is impossible: git cannot hold a ref `a/b` next
to `a/b/c`.) `<root>` comes from ``worktree.root`` in config.yaml, resolved
relative to the main checkout; ``{repo}`` expands to its directory name.
"""

from __future__ import annotations

import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

from .arbor_config import get_worktree_config
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


def worktree_root(repo_root: Path, config: dict) -> Path:
    """Directory holding task worktrees (default ``../<repo-basename>-wt``)."""
    main = main_checkout(repo_root)
    template = str(get_worktree_config(config).get("root") or "").strip()
    root = Path(template.format(repo=main.name)).expanduser()
    if not root.is_absolute():
        root = main / root
    return root.resolve()


def task_branch(task_name: str) -> str:
    return f"{TASK_BRANCH_PREFIX}{task_name}"


def partition_branch(task_name: str, partition: str) -> str:
    return f"{TASK_BRANCH_PREFIX}{task_name}{PARTITION_SEPARATOR}{partition}"


def partition_worktree_path(repo_root: Path, config: dict, task_name: str, partition: str) -> Path:
    return worktree_root(repo_root, config) / f"{task_name}-{partition}"


def is_ancestor(worktree: Path, commit: str, of: str = "HEAD") -> bool:
    """True when ``commit`` is reachable from ``of``."""
    rc, _, _ = run_git(["merge-base", "--is-ancestor", commit, of], cwd=worktree)
    return rc == 0


def add_worktree(repo_root: Path, path: Path, branch: str, start_point: str) -> None:
    """Create ``branch`` at ``start_point`` and check it out at ``path``."""
    path.parent.mkdir(parents=True, exist_ok=True)
    rc, _, err = run_git(
        ["worktree", "add", "-q", "-b", branch, str(path), start_point],
        cwd=repo_root,
    )
    if rc != 0:
        raise WorktreeError(f"git worktree add {path} failed: {err.strip()}")


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


def remove_worktree(repo_root: Path, path: Path, *, delete_branch: bool = False) -> None:
    """Remove a clean worktree; optionally delete the branch it had checked out.

    Not forced: git refuses a worktree with modified or untracked files, which
    is the point — removal must never discard uncommitted work.
    """
    branch = _worktree_branch(repo_root, path) if delete_branch else None
    rc, _, err = run_git(["worktree", "remove", str(path)], cwd=repo_root)
    if rc != 0:
        raise WorktreeError(f"git worktree remove {path} failed: {err.strip()}")
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


def create_task_worktree(repo_root: Path, task_dir: Path, config: dict) -> TaskWorktree:
    """Create ``arbor/<task>`` at the current HEAD and its worktree under the
    configured root. Refuses when the branch or the target path exists."""
    name = task_dir.name
    main = main_checkout(repo_root)
    branch = task_branch(name)
    path = worktree_root(main, config) / name

    rc, out, err = run_git(["rev-parse", "--verify", "HEAD"], cwd=repo_root)
    if rc != 0:
        raise WorktreeError(f"no commit to start from (git rev-parse HEAD: {err.strip()})")
    base_sha = out.strip()

    rc, _, _ = run_git(["rev-parse", "--verify", "--quiet", f"refs/heads/{branch}"], cwd=main)
    if rc == 0:
        raise WorktreeError(f"branch {branch} already exists")
    if path.exists():
        raise WorktreeError(f"worktree path already exists: {path}")

    add_worktree(main, path, branch, base_sha)
    return TaskWorktree(path.resolve(), branch, base_sha)
