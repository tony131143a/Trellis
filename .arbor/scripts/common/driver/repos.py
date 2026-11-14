"""
A task and the repositories it works in.

A repo key is ``.`` (the control repository) or a ``packages.<name>`` entry
with ``git: true``. Each (task, repo) gets one integration branch
``<branch_prefix><task>`` in an Orca workspace ``<task>`` when its first
writer node starts; node branches are cut from it and merged back into it.
A package's ``execution`` section replaces the control repository's gate and
worktree settings (it is not merged with them).
"""

from __future__ import annotations

import sys
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator

from ..arbor_config import get_gate_commands, get_worktree_config
from ..config import _is_true_config_value
from ..contract import Contract, ContractError, contract_hash, find_contract, load_contract
from ..execution import ExecutionError, frozen_execution, package_root
from ..git import run_git
from ..io import describe_json_read_failure, read_json_checked, write_json
from ..paths import DIR_TASKS, DIR_WORKFLOW, FILE_TASK_JSON
from ..worktree import WorktreeError, add_worktree, branch_prefix, remove_worktree, run_setup
from .executor import Executor, resolve_executor
from .lock import task_lock

SCHEMA = 3
RUNTIME = f"{DIR_WORKFLOW}/.runtime"


class DriverError(RuntimeError):
    pass


@dataclass
class Task:
    main: Path  # the control repository's main checkout
    config: dict  # its .arbor/config.yaml: also names the Orca CLI for every repo
    dir: Path
    data: dict

    @property
    def name(self) -> str:
        return self.dir.name

    @property
    def executor(self) -> Executor:
        return resolve_executor(self.config)

    def reload(self) -> None:
        self.data = load_data(self.dir)

    def save(self) -> None:
        if not write_json(self.dir / FILE_TASK_JSON, self.data):
            raise DriverError(f"cannot write {self.dir / FILE_TASK_JSON}")

    @contextmanager
    def edit(self) -> Iterator[dict]:
        """Hold the task lock around a fresh read, the change and the save."""
        with task_lock(self.dir):
            self.reload()
            yield self.data
            self.save()

    def contract(self) -> Contract:
        path = find_contract(self.dir)
        if path is None:
            raise DriverError(f"{self.dir}/contract.md is missing")
        try:
            return load_contract(path)
        except ContractError as e:
            raise DriverError(f"contract.md: {e}") from None

    def contract_changed(self) -> bool:
        path = find_contract(self.dir)
        recorded = self.data.get("contract_hash")
        return bool(recorded) and (path is None or contract_hash(path) != recorded)

    def runtime(self, *parts: str) -> Path:
        path = self.main.joinpath(RUNTIME, *parts)
        path.mkdir(parents=True, exist_ok=True)
        return path


def load_data(task_dir: Path) -> dict:
    data, reason = read_json_checked(task_dir / FILE_TASK_JSON)
    if data is None:
        raise DriverError(". ".join(describe_json_read_failure(task_dir / FILE_TASK_JSON, reason)))
    if data.get("schema") != SCHEMA:
        raise DriverError(f"{task_dir.name} was started by arbor < 1.0: finish it with that version")
    return data


def tasks_dir(main: Path) -> Path:
    return main / DIR_WORKFLOW / DIR_TASKS


def repo_keys(config: dict) -> list[str]:
    packages = config.get("packages")
    packages = packages if isinstance(packages, dict) else {}
    return ["."] + sorted(name for name, entry in packages.items()
                          if isinstance(entry, dict) and _is_true_config_value(entry.get("git")))


@dataclass(frozen=True)
class RepoSettings:
    root: Path
    gate: list[str]
    setup: str
    prefix: str
    base_ref: str
    merge_target: str


def settings(main: Path, config: dict, key: str) -> RepoSettings:
    if key == ".":
        root, policy, start = main, config, {}
    else:
        try:
            root, entry = package_root(main, config, key)
        except ExecutionError as e:
            raise DriverError(f"repo {key}: {e}") from None
        policy = frozen_execution(entry)
        start = entry.get("execution")
        start = start if isinstance(start, dict) else {}
    return RepoSettings(root, get_gate_commands(policy), str(get_worktree_config(policy).get("setup") or ""),
                        branch_prefix(policy), str(start.get("base_ref") or "").strip(),
                        str(start.get("merge_target") or "").strip())


def git(cwd: Path, *args: str) -> str:
    rc, out, err = run_git(list(args), cwd=cwd)
    if rc != 0:
        raise DriverError(f"git {' '.join(args)} in {cwd} failed: {err.strip()}")
    return out.strip()


def head(worktree: Path) -> str:
    return git(worktree, "rev-parse", "HEAD")


def create_integration(task: Task, key: str) -> dict:
    """The (task, repo) integration branch and worktree, cut from the repo's
    ``base_ref`` (no fetch) or the main checkout's HEAD."""
    s = settings(task.main, task.config, key)
    base = git(s.root, "rev-parse", "--verify", f"{s.base_ref or 'HEAD'}^{{commit}}")
    target = s.merge_target
    if not target:
        rc, out, _ = run_git(["symbolic-ref", "--quiet", "--short", "HEAD"], cwd=s.root)
        target = out.strip() if rc == 0 else ""
    if not target:
        raise DriverError(f"repo {key}: the main checkout is detached; set packages.<repo>.execution.merge_target "
                          "or check out the branch the task merges into")
    branch = f"{s.prefix}{task.name}"
    try:
        path = add_worktree(task.config, s.root, task.name, branch, base, s.root)
    except WorktreeError as e:
        raise DriverError(str(e)) from None
    if run_setup(path, s.setup) != 0:
        try:
            remove_worktree(task.config, s.root, path, delete_branch=True, force=True)
        except WorktreeError as e:
            print(f"note: {e}", file=sys.stderr)
        raise DriverError(f"repo {key}: worktree.setup failed in the integration worktree")
    return {"root": str(s.root), "branch": branch, "worktree": str(path), "base": base, "base_ref": s.base_ref or "HEAD",
            "merge_target": target, "head": base, "gate": None, "merged": False}
