#!/usr/bin/env python3
"""
Arbor configuration reader.

Reads settings from .arbor/config.yaml with sensible defaults.
"""

from __future__ import annotations

import sys
from pathlib import Path

from .paths import DIR_WORKFLOW, get_repo_root
from .arbor_config import parse_simple_yaml


# Defaults
DEFAULT_SESSION_COMMIT_MESSAGE = "chore: record journal"
DEFAULT_MAX_JOURNAL_LINES = 2000
DEFAULT_SESSION_AUTO_COMMIT = True

CONFIG_FILE = "config.yaml"


TRUE_CONFIG_VALUES = ("true", "yes", "1", "on")
FALSE_CONFIG_VALUES = ("false", "no", "0", "off")


def coerce_config_bool(
    value: object,
    default: bool,
    label: str,
) -> bool:
    """Coerce a config value to a bool, warning on anything unrecognized.

    The parser stores every value as a string, so ``git: yes`` arrives as
    ``"yes"``. Every boolean config key goes through this one helper: an
    accepted-here/rejected-there split means a user writing a perfectly
    reasonable YAML boolean silently gets the opposite branch.

    Args:
        value: Raw value from the parsed config.
        default: Returned when the value is unrecognized.
        label: Config key name, used in the warning.
    """
    if isinstance(value, bool):
        return value
    s = str(value).strip().lower()
    if s in TRUE_CONFIG_VALUES:
        return True
    if s in FALSE_CONFIG_VALUES:
        return False
    print(
        f"[WARN] invalid {label} value: {value!r}; using {str(default).lower()} (default)",
        file=sys.stderr,
    )
    return default


def _is_true_config_value(value: object, label: str = "config flag") -> bool:
    """Return True when a config value represents an enabled flag."""
    if value is None:
        return False
    return coerce_config_bool(value, False, label)


def _get_config_path(repo_root: Path | None = None) -> Path:
    """Get path to config.yaml."""
    root = repo_root or get_repo_root()
    return root / DIR_WORKFLOW / CONFIG_FILE


def _load_config(repo_root: Path | None = None) -> dict:
    """Load and parse config.yaml. Returns empty dict on any error.

    Fail-open, matching ``arbor_config.read_arbor_config``: a malformed
    config must not take down the script reading it. A parse failure is reported
    once on stderr so it is not invisible.
    """
    config_file = _get_config_path(repo_root)
    try:
        content = config_file.read_text(encoding="utf-8")
    except (OSError, IOError):
        return {}
    try:
        parsed = parse_simple_yaml(content, source=str(config_file))
    except Exception as e:
        print(
            f"[WARN] could not parse {config_file}: {type(e).__name__}: {e}; "
            "using defaults",
            file=sys.stderr,
        )
        return {}
    return parsed if isinstance(parsed, dict) else {}


def get_session_commit_message(repo_root: Path | None = None) -> str:
    """Get the commit message for auto-committing session records."""
    config = _load_config(repo_root)
    return config.get("session_commit_message", DEFAULT_SESSION_COMMIT_MESSAGE)


def get_max_journal_lines(repo_root: Path | None = None) -> int:
    """Get the maximum lines per journal file."""
    config = _load_config(repo_root)
    value = config.get("max_journal_lines", DEFAULT_MAX_JOURNAL_LINES)
    try:
        return int(value)
    except (ValueError, TypeError):
        return DEFAULT_MAX_JOURNAL_LINES


def get_session_auto_commit(repo_root: Path | None = None) -> bool:
    """Whether scripts should auto-stage + auto-commit session/task changes.

    Governs both ``add_session.py:_auto_commit_workspace`` and the archive
    commit of ``driver/finish.py``.

    Default: ``True`` (existing behavior — auto-stage + auto-commit).
    Set ``session_auto_commit: false`` in ``.arbor/config.yaml`` to skip
    auto-staging entirely; the journal/archive files are still written to
    disk, but the user manages ``git add`` / ``git commit`` themselves.

    Accepts native YAML booleans (``true`` / ``false``) and the string
    aliases ``true / false / yes / no / 1 / 0 / on / off`` (case-insensitive).
    Invalid values fall back to ``True`` with a stderr warning.
    """
    config = _load_config(repo_root)
    raw = config.get("session_auto_commit", DEFAULT_SESSION_AUTO_COMMIT)
    return coerce_config_bool(
        raw, DEFAULT_SESSION_AUTO_COMMIT, "session_auto_commit"
    )


# =============================================================================
# Monorepo / Packages
# =============================================================================


def get_packages(repo_root: Path | None = None) -> dict[str, dict] | None:
    """Get monorepo package declarations.

    Returns:
        Dict mapping package name to its config (path, git, execution),
        or None if not configured (single-repo mode).

    Example return:
        {"cli": {"path": "packages/cli"}, "docs-site": {"path": "docs-site"}}
    """
    config = _load_config(repo_root)
    packages = config.get("packages")
    if not isinstance(packages, dict):
        return None
    # Ensure each value is a dict (filter out scalar entries)
    filtered = {k: v for k, v in packages.items() if isinstance(v, dict)}
    if not filtered:
        return None
    return filtered


def get_default_package(repo_root: Path | None = None) -> str | None:
    """Get the default package name from config.

    Returns:
        Package name string, or None if not configured.
    """
    config = _load_config(repo_root)
    value = config.get("default_package")
    return str(value) if value else None


def is_monorepo(repo_root: Path | None = None) -> bool:
    """Check if the project is configured as a monorepo (has packages in config)."""
    return get_packages(repo_root) is not None


def validate_package(package: str, repo_root: Path | None = None) -> bool:
    """Check if a package name is valid in this project.

    Single-repo (no packages configured): always returns True.
    Monorepo: returns True only if package exists in config.yaml packages.
    """
    packages = get_packages(repo_root)
    if packages is None:
        return True  # Single-repo, no validation needed
    return package in packages


def resolve_package(repo_root: Path | None = None) -> str | None:
    """Resolve the package from ``default_package`` with validation.

    An invalid value prints a warning to stderr and is skipped.

    Returns:
        Resolved package name, or None if no valid package found.

    Note:
        CLI --package should be validated separately by the caller
        (fail-fast with available packages list on error).
    """
    packages = get_packages(repo_root)
    if packages is None:
        return None  # Single-repo, no package needed

    default = get_default_package(repo_root)
    if default:
        if default in packages:
            return default
        print(
            f"Warning: default_package '{default}' not found in config, skipping",
            file=sys.stderr,
        )

    return None

