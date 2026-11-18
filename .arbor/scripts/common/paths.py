#!/usr/bin/env python3
"""
Common path utilities for Arbor workflow.

Provides:
    get_repo_root          - Get repository root directory
    get_developer          - Get developer name
    get_workspace_dir      - Get developer workspace directory
"""

from __future__ import annotations

import os
from pathlib import Path

from .git import main_worktree_root


# =============================================================================
# Path Constants (change here to rename directories)
# =============================================================================

# Directory names
DIR_WORKFLOW = ".arbor"
DIR_WORKSPACE = "workspace"
DIR_TASKS = "tasks"
DIR_ARCHIVE = "archive"
DIR_SPEC = "spec"

# File names
FILE_DEVELOPER = ".developer"
FILE_TASK_JSON = "task.json"
FILE_JOURNAL_PREFIX = "journal-"

# Environment override for the developer identity, ahead of the .developer file.
ENV_DEVELOPER = "ARBOR_DEVELOPER"

# Appended to every "no developer set" error so the two non-obvious sources are
# discoverable from the failure itself.
DEVELOPER_HINT = (
    f"  Or set {ENV_DEVELOPER}=<your-name> in the environment.\n"
    f"  A linked git worktree inherits {DIR_WORKFLOW}/{FILE_DEVELOPER} from its "
    f"main checkout — run init_developer.py there to cover every worktree."
)


# =============================================================================
# Repository Root
# =============================================================================

def get_repo_root(start_path: Path | None = None) -> Path:
    """Find the nearest directory containing .arbor/ folder.

    This handles nested git repos correctly (e.g., test project inside another repo).

    Args:
        start_path: Starting directory to search from. Defaults to current directory.

    Returns:
        Path to repository root, or current directory if no .arbor/ found.
    """
    current = (start_path or Path.cwd()).resolve()

    while current != current.parent:
        if (current / DIR_WORKFLOW).is_dir():
            return current
        current = current.parent

    # Fallback to current directory if no .arbor/ found
    return Path.cwd().resolve()


# =============================================================================
# Developer
# =============================================================================

def _read_developer_file(dev_file: Path) -> str | None:
    """Read the `name=` field out of a .developer file, or None."""
    if not dev_file.is_file():
        return None

    try:
        content = dev_file.read_text(encoding="utf-8")
    except (OSError, IOError):
        return None

    for line in content.splitlines():
        if line.startswith("name="):
            return line.split("=", 1)[1].strip() or None

    return None


def get_developer(repo_root: Path | None = None) -> str | None:
    """Get the developer name for this checkout.

    Resolution order, first hit wins:

        1. The ``ARBOR_DEVELOPER`` environment variable.
        2. ``.arbor/.developer`` in this checkout.
        3. ``.arbor/.developer`` in the main checkout, when this checkout is a
           linked git worktree.

    Step 3 exists because `.developer` is gitignored on purpose — it carries a
    personal identity and no tracked file should. A fresh `git worktree add`
    therefore starts with no identity file of its own; without this step every
    script that needs the developer would fail there until init_developer.py
    was re-run per worktree. The main checkout's file is read, never copied: a
    copy would go stale and shadow later changes made in the main checkout.

    Args:
        repo_root: Repository root path. Defaults to auto-detected.

    Returns:
        Developer name or None if not initialized.
    """
    env_name = os.environ.get(ENV_DEVELOPER, "").strip()
    if env_name:
        return env_name

    if repo_root is None:
        repo_root = get_repo_root()

    local = _read_developer_file(repo_root / DIR_WORKFLOW / FILE_DEVELOPER)
    if local:
        return local

    main_root = main_worktree_root(repo_root)
    if main_root is None:
        return None

    return _read_developer_file(main_root / DIR_WORKFLOW / FILE_DEVELOPER)


def check_developer(repo_root: Path | None = None) -> bool:
    """Check if developer is initialized.

    Args:
        repo_root: Repository root path. Defaults to auto-detected.

    Returns:
        True if developer is initialized.
    """
    return get_developer(repo_root) is not None


# =============================================================================
# Workspace Directory
# =============================================================================

def get_workspace_dir(repo_root: Path | None = None) -> Path | None:
    """Get developer workspace directory.

    Args:
        repo_root: Repository root path. Defaults to auto-detected.

    Returns:
        Path to workspace directory or None if developer not set.
    """
    if repo_root is None:
        repo_root = get_repo_root()

    developer = get_developer(repo_root)
    if developer:
        return repo_root / DIR_WORKFLOW / DIR_WORKSPACE / developer
    return None
