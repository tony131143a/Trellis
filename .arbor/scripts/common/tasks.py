"""
Task data access layer.

Single source of truth for loading and iterating task directories.
Replaces scattered task.json parsing across 9+ files.

Provides:
    load_task          — Load a single task by directory path
    iter_active_tasks  — Iterate all non-archived tasks (sorted)
    get_all_statuses   — Get {dir_name: status} map for children progress
    resolve_tier       — Task tier (light / standard / full) from meta or artifacts
"""

from __future__ import annotations

import sys
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from .contract import CONTRACT_FILE, LEGACY_CONTRACT_FILE
from .io import describe_json_read_failure, read_json_checked
from .paths import FILE_TASK_JSON
from .types import TaskInfo


# =============================================================================
# Task tiers
# =============================================================================
#
# A task's tier decides how much of the workflow runs (which roles take part
# and how long the review chain is). It is stored in ``task.json.meta.tier``
# when the main agent pins it; otherwise it is inferred from the planning
# artifacts that exist, so a task that grows a ``design.md`` moves up on its
# own. Every reader (task.py start, the breadcrumb hook, session-start,
# get_context) goes through these helpers so they cannot disagree.

TIERS: tuple[str, ...] = ("light", "standard", "full")

WAVES_FILE = "waves.md"

TIER_ARTIFACTS: dict[str, tuple[str, ...]] = {
    "light": (CONTRACT_FILE,),
    "standard": (CONTRACT_FILE, "design.md"),
    "full": (CONTRACT_FILE, "design.md", WAVES_FILE),
}

# v1 names still accepted for a planning artifact.
LEGACY_ARTIFACTS: dict[str, str] = {
    CONTRACT_FILE: LEGACY_CONTRACT_FILE,
    WAVES_FILE: "implement.md",
}


def find_artifact(task_dir: Path, name: str) -> Path | None:
    """``task_dir/name``, else its legacy v1 file, else None."""
    for candidate in (name, LEGACY_ARTIFACTS.get(name)):
        if candidate and (task_dir / candidate).is_file():
            return task_dir / candidate
    return None


def explicit_tier(task_data: Any) -> str | None:
    """The tier pinned in ``meta.tier``, normalised, or None when absent or invalid."""
    if not isinstance(task_data, dict):
        return None
    meta = task_data.get("meta")
    if not isinstance(meta, dict):
        return None
    value = meta.get("tier")
    if not isinstance(value, str):
        return None
    value = value.strip().lower()
    return value if value in TIERS else None


def infer_tier(task_dir: Path) -> str:
    """Tier implied by the artifacts on disk: waves.md (or legacy implement.md) → full,
    design.md → standard, else light."""
    if find_artifact(task_dir, WAVES_FILE):
        return "full"
    if (task_dir / "design.md").is_file():
        return "standard"
    return "light"


def resolve_tier(task_dir: Path, task_data: Any) -> str:
    """``meta.tier`` when valid, otherwise :func:`infer_tier`."""
    return explicit_tier(task_data) or infer_tier(task_dir)


def missing_tier_artifacts(task_dir: Path, tier: str) -> list[str]:
    """Planning artifacts the tier requires that do not exist yet."""
    required = TIER_ARTIFACTS.get(tier, TIER_ARTIFACTS["light"])
    return [name for name in required if find_artifact(task_dir, name) is None]


def load_task(task_dir: Path) -> TaskInfo | None:
    """Load task from a directory containing task.json.

    Args:
        task_dir: Absolute path to the task directory.

    Returns:
        TaskInfo if task.json exists and is valid, None otherwise.

    A directory without task.json is not a task, so it is skipped silently.
    A task.json that exists but cannot be loaded is different: the task
    disappears from `task.py list` and from every context the iterator feeds.
    Callers stay tolerant, but the skip is announced on stderr so a task
    cannot vanish from the workflow with no diagnostic anywhere.
    """
    task_json = task_dir / FILE_TASK_JSON
    if not task_json.is_file():
        return None

    data, reason = read_json_checked(task_json)
    if data is None:
        problem, hint = describe_json_read_failure(task_json, reason)
        print(f"[WARN] Skipping task '{task_dir.name}': {problem}", file=sys.stderr)
        print(f"       {hint}", file=sys.stderr)
        return None

    return TaskInfo(
        dir_name=task_dir.name,
        directory=task_dir,
        title=data.get("title") or data.get("name") or "unknown",
        status=data.get("status", "unknown"),
        assignee=data.get("assignee", ""),
        priority=data.get("priority", "P2"),
        children=tuple(data.get("children", [])),
        parent=data.get("parent"),
        package=data.get("package"),
        raw=data,
    )


def iter_active_tasks(tasks_dir: Path) -> Iterator[TaskInfo]:
    """Iterate all active (non-archived) tasks, sorted by directory name.

    Skips the "archive" directory and directories without valid task.json.

    Args:
        tasks_dir: Path to the tasks directory.

    Yields:
        TaskInfo for each valid task.
    """
    if not tasks_dir.is_dir():
        return

    for d in sorted(tasks_dir.iterdir()):
        if not d.is_dir() or d.name == "archive":
            continue
        info = load_task(d)
        if info is not None:
            yield info


def get_all_statuses(tasks_dir: Path) -> dict[str, str]:
    """Get a {dir_name: status} mapping for all active tasks.

    Useful for computing children progress without loading full TaskInfo.

    Args:
        tasks_dir: Path to the tasks directory.

    Returns:
        Dict mapping directory names to status strings.
    """
    return {t.dir_name: t.status for t in iter_active_tasks(tasks_dir)}


def children_progress(
    children: tuple[str, ...] | list[str],
    all_statuses: dict[str, str],
) -> str:
    """Format children progress string like " [2/3 done]".

    Args:
        children: List of child directory names.
        all_statuses: Status map from get_all_statuses().

    Returns:
        Formatted string, or "" if no children.
    """
    if not children:
        return ""
    # A child missing from active statuses has been archived (cmd_archive
    # sets status=completed before moving the dir). Count it as done so
    # parent progress doesn't regress when children are archived.
    done = sum(
        1 for c in children
        if c not in all_statuses or all_statuses.get(c) in ("completed", "done")
    )
    return f" [{done}/{len(children)} done]"
