"""
Two-level merge: a parent task's integration branch, and the checks every
automatic merge passes.

A parent task (one with children) is never started. When its first child
starts, the driver creates the parent's integration branch
``<branch_prefix><parent>`` from the branch checked out in the main checkout
(the baseline) plus a worktree ``<worktree.root>/<parent>``. Every child is
cut from the integration branch and ``arbor finish`` merges it back with
``--no-ff`` itself, without asking, once the merge checks hold. The only
human merge is the integration branch into the baseline; until then the
baseline is never touched (the children's journal entries are written once,
by ``arbor children --cleanup`` after that merge).

    parent task.json  integration: {branch, worktree, base_branch, base, created,
                                    merged: [{task, title, tip, merge_commit, summary}],
                                    cleaned?}
    child task.json   base_branch = the integration branch, base_branch_source:
                      "integration", integration_target: {parent, branch, worktree}

Merge checks, applied before any automatic merge (a partition into its task
branch, a child into its integration branch, a task into its baseline under
``mandate merge=auto``):

- scope: every changed file lies inside the declared paths (contract
  ``## Partitions`` globs, the test paths, the task directory, ``.arbor/spec/``);
  a contract without partitions declares no scope, so nothing is enforced;
- review binding (tasks only): the last review covers the branch tip; after it
  only merge commits from the target branch and task-directory / spec commits
  may follow.
"""

from __future__ import annotations

from pathlib import Path
from typing import Sequence

from ..arbor_config import get_worktree_config
from ..contract import path_matches
from ..git import run_git
from ..io import read_json_checked, write_json
from ..paths import DIR_TASKS, DIR_WORKFLOW, FILE_TASK_JSON
from ..worktree import WorktreeError, add_worktree, branch_prefix, remove_worktree, run_setup, task_branch, worktree_root
from .executor import utc_now

SPEC_PREFIX = f"{DIR_WORKFLOW}/spec/"
UNSCOPED = ("**", "**/*")


class IntegrationError(RuntimeError):
    pass


def _git(cwd: Path, *args: str) -> tuple[int, str]:
    rc, out, _ = run_git(list(args), cwd=cwd)
    return rc, out.strip()


# =============================================================================
# Where a branch is checked out
# =============================================================================


def checkout_of(repo: Path, branch: str) -> Path | None:
    """The worktree (the main checkout included) that has ``branch`` checked out."""
    rc, out = _git(repo, "worktree", "list", "--porcelain")
    if rc != 0:
        return None
    path: Path | None = None
    for line in out.splitlines():
        if line.startswith("worktree "):
            path = Path(line[len("worktree "):])
        elif line == f"branch refs/heads/{branch}" and path is not None:
            return path
    return None


# =============================================================================
# The integration branch
# =============================================================================


def parent_dir(main: Path, data: dict) -> Path | None:
    """The unstarted parent task of ``data`` in the main checkout, if any."""
    name = data.get("parent")
    if not name:
        return None
    path = main / DIR_WORKFLOW / DIR_TASKS / str(name)
    return path if (path / FILE_TASK_JSON).is_file() else None


def ensure(main: Path, config: dict, parent: Path) -> dict:
    """The parent's live integration record; created (branch + worktree +
    ``worktree.setup``) from the main checkout's branch when there is none."""
    json_path = parent / FILE_TASK_JSON
    data, reason = read_json_checked(json_path)
    if data is None:
        raise IntegrationError(f"cannot read {json_path}: {reason}")
    if data.get("worktree_path") or data.get("state"):
        raise IntegrationError(f"parent {parent.name} is in its integration review (task.py integrate); "
                               "no new child can join it (create one with --base-branch <branch> instead)")
    record = data.get("integration")
    if isinstance(record, dict) and not record.get("cleaned"):
        if not Path(record["worktree"]).is_dir():
            raise IntegrationError(f"integration worktree {record['worktree']} is missing; recreate it with "
                                   f"`git worktree add {record['worktree']} {record['branch']}`")
        return record
    rc, base_branch = _git(main, "symbolic-ref", "-q", "--short", "HEAD")
    if rc != 0 or not base_branch:
        raise IntegrationError("the main checkout is on a detached HEAD; check out the baseline branch first")
    _, base = _git(main, "rev-parse", "HEAD")
    branch = task_branch(parent.name, branch_prefix(config))
    path = worktree_root(main, config) / parent.name
    if _git(main, "rev-parse", "--verify", "--quiet", f"refs/heads/{branch}")[0] == 0:
        raise IntegrationError(f"branch {branch} already exists; remove it or link the children elsewhere")
    if path.exists():
        raise IntegrationError(f"worktree path already exists: {path}")
    try:
        add_worktree(main, path, branch, base)
    except WorktreeError as e:
        raise IntegrationError(str(e)) from None
    if run_setup(path, get_worktree_config(config).get("setup")) != 0:
        remove_worktree(main, path, delete_branch=True)
        raise IntegrationError(f"worktree.setup failed in {path}; integration branch removed")
    record = {"branch": branch, "worktree": str(path.resolve()), "base_branch": base_branch, "base": base,
              "created": utc_now(), "merged": []}
    data["integration"] = record
    if not write_json(json_path, data):
        raise IntegrationError(f"failed to write {json_path}")
    return record


def record_merged(parent: Path, entry: dict) -> None:
    """Append one merged child to the parent's integration record (idempotent per task)."""
    json_path = parent / FILE_TASK_JSON
    data, reason = read_json_checked(json_path)
    if data is None:
        raise IntegrationError(f"cannot read {json_path}: {reason}")
    record = data.get("integration")
    if not isinstance(record, dict):
        raise IntegrationError(f"{parent.name} has no integration record")
    merged = [m for m in record.get("merged") or [] if m.get("task") != entry.get("task")]
    record["merged"] = [*merged, entry]
    if not write_json(json_path, data):
        raise IntegrationError(f"failed to write {json_path}")


# =============================================================================
# Merge checks
# =============================================================================


def scope_globs(paths: Sequence[str], task_rel: str) -> tuple[str, ...] | None:
    """The globs a branch may change; None when ``paths`` declares no scope."""
    declared = tuple(p.strip() for p in paths if p and p.strip())
    if not declared or any(p.removeprefix("./") in UNSCOPED for p in declared):
        return None
    return (*declared, f"{task_rel}/**", f"{SPEC_PREFIX}**")


def changed_paths(repo: Path, range_spec: str) -> list[str]:
    rc, out = _git(repo, "diff", "--name-only", "--no-renames", range_spec)
    if rc != 0:
        raise IntegrationError(f"git diff {range_spec} failed")
    return sorted({line for line in out.splitlines() if line.strip()})


def out_of_scope(repo: Path, range_spec: str, globs: Sequence[str] | None) -> list[str]:
    """Files ``range_spec`` changes outside ``globs`` (none when there is no scope)."""
    if globs is None:
        return []
    return [p for p in changed_paths(repo, range_spec) if not path_matches(p, globs)]


def review_binding_problem(worktree: Path, reviewed: str | None, target: str, task_rel: str) -> str | None:
    """Why the last review no longer covers HEAD (None when it does)."""
    if not reviewed:
        return "no review recorded for this branch"
    if _git(worktree, "merge-base", "--is-ancestor", reviewed, "HEAD")[0] != 0:
        return f"the reviewed head {reviewed[:12]} is no longer part of the branch"
    rc, out = _git(worktree, "rev-list", "--parents", f"{reviewed}..HEAD", "--not", target)
    if rc != 0:
        return f"cannot list the commits after the last review (target {target})"
    meta = (f"{task_rel}/", SPEC_PREFIX)
    for line in out.splitlines():
        sha, *parents = line.split()
        if len(parents) > 1:
            continue  # a merge from the target branch (catch-up); its own content is excluded above
        _, files = _git(worktree, "diff-tree", "--no-commit-id", "--name-only", "-r", sha)
        product = [f for f in files.splitlines() if f.strip() and not f.startswith(meta)]
        if product:
            _, subject = _git(worktree, "log", "-1", "--format=%s", sha)
            return (f"commit {sha[:12]} ({subject}) changed {', '.join(product[:5])} after the last review; "
                    "review the delta first")
    return None
