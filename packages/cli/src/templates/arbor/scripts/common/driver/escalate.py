"""
Git-side signals for the one-way light -> standard escalation.

``state.maybe_escalate`` decides (no git there); this module measures what
it needs at a BUILD gate: the changed lines of ``base..HEAD`` and the
configured packages the changed files fall in.
"""

from __future__ import annotations

from pathlib import Path
from typing import Iterable

from ..invariants import changed_files
from .finish import changed_lines


def packages_touched(files: Iterable[str], packages: dict[str, dict] | None) -> list[str]:
    """Names of the configured packages (``packages.<name>.path``) that hold one of ``files``."""
    prefixes = []
    for name, spec in (packages or {}).items():
        root = str((spec or {}).get("path") or "").strip().strip("/")
        if root.startswith("./"):
            root = root[2:]
        if root and root != ".":
            prefixes.append((f"{root}/", name))
    hit = {name for path in files for prefix, name in prefixes if path.startswith(prefix)}
    return sorted(hit)


def build_signals(worktree: Path, base: str, packages: dict[str, dict] | None, *, at: str) -> dict:
    """The size signals of everything the task changed so far."""
    range_spec = f"{base}..HEAD"
    return {
        "changed_lines": changed_lines(worktree, range_spec),
        "packages": packages_touched(changed_files(worktree, range_spec), packages),
        "at": at,
    }
