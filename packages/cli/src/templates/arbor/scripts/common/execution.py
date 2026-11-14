"""Package repositories: ``packages.<name>`` entries with ``git: true`` are
independent git repositories below the control checkout."""
from __future__ import annotations

from pathlib import Path

from .config import _is_true_config_value
from .git import run_git


class ExecutionError(RuntimeError):
    pass


def git(root: Path, *args: str) -> str:
    rc, out, err = run_git(list(args), cwd=root)
    if rc:
        raise ExecutionError(err.strip() or f"git failed in {root}")
    return out.strip()


def identity(root: Path) -> str:
    return str(Path(git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir')).resolve())


def package_root(main: Path, config: dict, package: str) -> tuple[Path, dict]:
    entry = (config.get('packages') or {}).get(package)
    if not isinstance(entry, dict) or not _is_true_config_value(entry.get('git')):
        raise ExecutionError(f'{package!r} is not a configured git: true package')
    raw = Path(entry.get('path') or '')
    root = (main / raw).resolve()
    if raw.is_absolute() or '..' in raw.parts or root == main.resolve() or not root.is_relative_to(main.resolve()):
        raise ExecutionError('product path must be contained in the control checkout')
    if Path(git(root, 'rev-parse', '--show-toplevel')).resolve() != root or identity(root) == identity(main):
        raise ExecutionError('package must be the root of an independent Git repository')
    return root, entry


# Read when a task's integration branch is created, not part of the policy.
START_DEFAULT_KEYS = ('base_ref', 'merge_target')


def frozen_execution(entry: dict) -> dict:
    """``packages.<pkg>.execution`` without the start-time defaults."""
    section = entry.get('execution') if isinstance(entry, dict) else None
    if not isinstance(section, dict):
        return {}
    return {k: v for k, v in section.items() if k not in START_DEFAULT_KEYS}
