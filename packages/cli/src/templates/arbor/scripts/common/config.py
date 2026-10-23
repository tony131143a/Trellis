#!/usr/bin/env python3
"""
Arbor configuration reader.

Reads settings from .arbor/config.yaml with sensible defaults.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from .paths import DIR_WORKFLOW, get_repo_root
from .arbor_config import parse_simple_yaml

# The YAML subset parser lives in arbor_config.py — it imports nothing from
# this package, so hooks can load it as a single standalone file. Two byte-
# equivalent copies is a drift hazard, not a feature.


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
    config must not take down ``task.py create``. A parse failure is reported
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

    Governs both ``add_session.py:_auto_commit_workspace`` and
    ``task_store.py:_auto_commit_archive``.

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


DEFAULT_CONTEXT_INJECTION_MAX_FILE_BYTES = 32768
DEFAULT_CONTEXT_INJECTION_MAX_ARTIFACT_BYTES = 65536
DEFAULT_CONTEXT_INJECTION_MAX_TOTAL_BYTES = 131072


def get_context_injection_limits(repo_root: Path | None = None) -> dict[str, int]:
    """Return sub-agent context injection byte limits.

    Reads the ``context_injection:`` section of ``.arbor/config.yaml``:

        context_injection:
          max_file_bytes: 32768
          max_artifact_bytes: 65536
          max_total_bytes: 131072

    ``0`` disables the corresponding limit. Missing keys use their default;
    invalid (non-int or negative) values fall back to the default for that
    key with a stderr warning.
    """
    defaults = {
        "max_file_bytes": DEFAULT_CONTEXT_INJECTION_MAX_FILE_BYTES,
        "max_artifact_bytes": DEFAULT_CONTEXT_INJECTION_MAX_ARTIFACT_BYTES,
        "max_total_bytes": DEFAULT_CONTEXT_INJECTION_MAX_TOTAL_BYTES,
    }

    config = _load_config(repo_root)
    section = config.get("context_injection")
    if not isinstance(section, dict):
        return defaults

    result = dict(defaults)
    for key, default_value in defaults.items():
        if key not in section:
            continue
        raw = section[key]
        try:
            value = int(raw)
        except (TypeError, ValueError):
            print(
                f"[WARN] invalid context_injection.{key} value: {raw!r}; "
                f"using default {default_value}",
                file=sys.stderr,
            )
            continue
        if value < 0:
            print(
                f"[WARN] invalid context_injection.{key} value: {raw!r}; "
                f"using default {default_value}",
                file=sys.stderr,
            )
            continue
        result[key] = value

    return result


DEFAULT_PROMPT_INJECTION_SKIP_KEYWORD = "no-arbor"


def get_prompt_injection_config(repo_root: Path | None = None) -> dict[str, str]:
    """Return per-turn prompt injection config.

    Reads the ``prompt_injection:`` section of ``.arbor/config.yaml``:

        prompt_injection:
          skip_keyword: "no-arbor"   # "" disables the escape hatch entirely

    ``skip_keyword`` is the word-boundary, case-insensitive keyword that, when
    present in the user's prompt, makes the per-turn workflow-state injection
    emit nothing for that turn. Defaults to ``"no-arbor"``. A non-string
    value falls back to the default.
    """
    defaults = {"skip_keyword": DEFAULT_PROMPT_INJECTION_SKIP_KEYWORD}

    config = _load_config(repo_root)
    section = config.get("prompt_injection")
    if not isinstance(section, dict):
        return defaults

    result = dict(defaults)
    raw = section.get("skip_keyword", DEFAULT_PROMPT_INJECTION_SKIP_KEYWORD)
    if isinstance(raw, str):
        result["skip_keyword"] = raw
    return result


DISPATCH_ROLES = ("implement", "check", "research")
DISPATCH_HOOK_DECISIONS = ("allow", "ask")
# Runtime override written by `/arbor:dispatch-target`, relative to .arbor/.
DISPATCH_TARGET_FILE = ".runtime/dispatch-target"
ENV_DISPATCH_TARGET = "ARBOR_DISPATCH_TARGET"

DEFAULT_DISPATCH: dict = {
    "default_target": "star",
    "max_parallel": 3,
    "guard_builtin_agent": True,
    "hook_decision": "allow",
    "codeg_cli": "",
    "permissions": "allow",
    "timeout": "90m",
    "targets": {
        "star": {
            "agent_type": "custom:star",
            "options": {},
            "assistants": {
                "implement": "arbor-implement-star",
                "check": "arbor-check-star",
                "research": "arbor-research-star",
            },
        },
        "pi": {
            "agent_type": "pi",
            "options": {
                "model": "deepseek/DeepSeek-V4.1-Flash",
                "thought_level": "max",
            },
            "assistants": {
                "implement": "arbor-implement-pi",
                "check": "arbor-check-pi",
                "research": "arbor-research-pi",
            },
        },
    },
}


def _warn_dispatch(key: str, raw: object, default: object) -> None:
    print(
        f"[WARN] invalid dispatch.{key} value: {raw!r}; using default {default!r}",
        file=sys.stderr,
    )


def _dispatch_target(name: str, raw: object, default: dict | None) -> dict:
    """Normalise one ``dispatch.targets.<name>`` block.

    The template keeps role names directly under the target (the parser has
    no flow mappings, and a fourth nesting level is noise); they are collected
    into ``assistants``. Any other scalar key (``model``, ``thought_level``)
    lands in ``options``. A missing role falls back to the shipped name, or to
    ``arbor-<role>-<target>`` for a target Arbor does not ship.
    """
    base = default or {"agent_type": name, "options": {}, "assistants": {}}
    agent_type = str(base.get("agent_type") or name)
    options = dict(base.get("options") or {})
    assistants = {
        role: str((base.get("assistants") or {}).get(role) or f"arbor-{role}-{name}")
        for role in DISPATCH_ROLES
    }
    if not isinstance(raw, dict):
        if raw is not None and raw != {}:
            _warn_dispatch(f"targets.{name}", raw, "defaults")
        return {"agent_type": agent_type, "options": options, "assistants": assistants}

    for key, value in raw.items():
        if key == "agent_type":
            if isinstance(value, str) and value.strip():
                agent_type = value.strip()
            else:
                _warn_dispatch(f"targets.{name}.agent_type", value, agent_type)
        elif key in DISPATCH_ROLES:
            if isinstance(value, str) and value.strip():
                assistants[key] = value.strip()
            else:
                _warn_dispatch(f"targets.{name}.{key}", value, assistants[key])
        elif isinstance(value, str):
            options[key] = value
        else:
            _warn_dispatch(f"targets.{name}.{key}", value, "ignored")
    return {"agent_type": agent_type, "options": options, "assistants": assistants}


def get_dispatch_config(repo_root: Path | None = None) -> dict:
    """Return the ``dispatch:`` section of config.yaml merged over defaults.

    Shape (always complete)::

        {"default_target": "star", "max_parallel": 3,
         "guard_builtin_agent": True, "hook_decision": "allow",
         "codeg_cli": "", "permissions": "allow", "timeout": "90m",
         "targets": {"<name>": {"agent_type": str, "options": {str: str},
                                "assistants": {"implement": str,
                                               "check": str,
                                               "research": str}}}}

    Invalid values fall back to the default with a stderr warning.
    """
    defaults = DEFAULT_DISPATCH
    section = _load_config(repo_root).get("dispatch")
    if section is not None and not isinstance(section, dict):
        _warn_dispatch("", section, "defaults")
        section = None
    section = section or {}

    result: dict = {"default_target": defaults["default_target"]}

    raw = section.get("max_parallel", defaults["max_parallel"])
    try:
        max_parallel = int(raw)
    except (TypeError, ValueError):
        max_parallel = 0
    if max_parallel < 1:
        _warn_dispatch("max_parallel", raw, defaults["max_parallel"])
        max_parallel = defaults["max_parallel"]
    result["max_parallel"] = max_parallel

    result["guard_builtin_agent"] = coerce_config_bool(
        section.get("guard_builtin_agent", defaults["guard_builtin_agent"]),
        defaults["guard_builtin_agent"],
        "dispatch.guard_builtin_agent",
    )

    raw = section.get("hook_decision", defaults["hook_decision"])
    decision = str(raw).strip().lower() if isinstance(raw, str) else ""
    if decision not in DISPATCH_HOOK_DECISIONS:
        _warn_dispatch("hook_decision", raw, defaults["hook_decision"])
        decision = defaults["hook_decision"]
    result["hook_decision"] = decision

    for key in ("codeg_cli", "permissions", "timeout"):
        raw = section.get(key, defaults[key])
        if not isinstance(raw, str) or (key != "codeg_cli" and not raw.strip()):
            _warn_dispatch(key, raw, defaults[key])
            raw = defaults[key]
        result[key] = raw.strip()

    raw_targets = section.get("targets")
    if raw_targets is not None and not isinstance(raw_targets, dict):
        _warn_dispatch("targets", raw_targets, "defaults")
        raw_targets = None
    raw_targets = raw_targets or {}
    names = list(defaults["targets"]) + [
        name for name in raw_targets if name not in defaults["targets"]
    ]
    result["targets"] = {
        name: _dispatch_target(name, raw_targets.get(name), defaults["targets"].get(name))
        for name in names
    }

    raw = section.get("default_target", defaults["default_target"])
    target = raw.strip() if isinstance(raw, str) else ""
    if target not in result["targets"]:
        _warn_dispatch("default_target", raw, defaults["default_target"])
        target = defaults["default_target"]
    result["default_target"] = target

    return result


def resolve_dispatch_target(repo_root: Path | None = None) -> tuple[str, str]:
    """Return ``(target, source)`` for the effective dispatch target.

    Precedence: ``.arbor/.runtime/dispatch-target`` > ``ARBOR_DISPATCH_TARGET``
    > ``dispatch.default_target``. An override naming an unknown target is
    reported on stderr and skipped.
    """
    root = repo_root or get_repo_root()
    config = get_dispatch_config(root)
    override_file = root / DIR_WORKFLOW / DISPATCH_TARGET_FILE
    try:
        file_value = override_file.read_text(encoding="utf-8").strip()
    except (OSError, UnicodeDecodeError):
        file_value = ""
    candidates = (
        (file_value, f"{DIR_WORKFLOW}/{DISPATCH_TARGET_FILE}"),
        (os.environ.get(ENV_DISPATCH_TARGET, "").strip(), ENV_DISPATCH_TARGET),
    )
    for value, source in candidates:
        if not value:
            continue
        if value in config["targets"]:
            return value, source
        print(
            f"[WARN] unknown dispatch target {value!r} from {source}; ignoring",
            file=sys.stderr,
        )
    return config["default_target"], "config"


def get_dispatch_target(repo_root: Path | None = None) -> str:
    """Effective dispatch target name (see ``resolve_dispatch_target``)."""
    return resolve_dispatch_target(repo_root)[0]


def get_hooks(event: str, repo_root: Path | None = None) -> list[str]:
    """Get hook commands for a lifecycle event.

    Args:
        event: Event name (e.g. "after_create", "after_archive").
        repo_root: Repository root path.

    A hook the user believes is installed and which silently never runs is the
    worst outcome for this feature, so a declared-but-unusable shape warns
    instead of returning an empty list quietly.

    Returns:
        List of shell commands to execute, empty if none configured.
    """
    config = _load_config(repo_root)
    hooks = config.get("hooks")
    if hooks is None:
        return []
    if not isinstance(hooks, dict):
        print(
            f"[WARN] ignoring `hooks` in config.yaml: expected a mapping of "
            f"event -> list of commands, got {hooks!r}",
            file=sys.stderr,
        )
        return []
    commands = hooks.get(event)
    if commands is None:
        return []
    if isinstance(commands, list):
        return [str(c) for c in commands]
    # `after_create: echo hi` instead of a `- ` list — parses fine, registers
    # nothing.
    print(
        f"[WARN] ignoring hook `{event}` in config.yaml: expected a list of "
        f"commands, got {commands!r}. Write it as:\n"
        f"  hooks:\n    {event}:\n      - {commands}",
        file=sys.stderr,
    )
    return []


# =============================================================================
# Monorepo / Packages
# =============================================================================


def get_packages(repo_root: Path | None = None) -> dict[str, dict] | None:
    """Get monorepo package declarations.

    Returns:
        Dict mapping package name to its config (path, type, etc.),
        or None if not configured (single-repo mode).

    Example return:
        {"cli": {"path": "packages/cli"}, "docs-site": {"path": "docs-site", "type": "submodule"}}
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


def get_submodule_packages(repo_root: Path | None = None) -> dict[str, str]:
    """Get packages that are git submodules.

    Returns:
        Dict mapping package name to its path for submodule-type packages.
        Empty dict if none configured.

    Example return:
        {"docs-site": "docs-site"}
    """
    packages = get_packages(repo_root)
    if packages is None:
        return {}
    return {
        name: cfg.get("path", name)
        for name, cfg in packages.items()
        if cfg.get("type") == "submodule"
    }


def get_git_packages(repo_root: Path | None = None) -> dict[str, str]:
    """Get packages that have their own independent git repository.

    These are sub-directories with their own .git (not submodules),
    marked with ``git: true`` in config.yaml.

    Returns:
        Dict mapping package name to its path for git-repo packages.
        Empty dict if none configured.

    Example config::

        packages:
          backend:
            path: iqs
            git: true

    Example return::

        {"backend": "iqs"}
    """
    packages = get_packages(repo_root)
    if packages is None:
        return {}
    return {
        name: cfg.get("path", name)
        for name, cfg in packages.items()
        if _is_true_config_value(cfg.get("git"), f"packages.{name}.git")
    }


def is_monorepo(repo_root: Path | None = None) -> bool:
    """Check if the project is configured as a monorepo (has packages in config)."""
    return get_packages(repo_root) is not None


def get_spec_base(package: str | None = None, repo_root: Path | None = None) -> str:
    """Get the spec directory base path relative to .arbor/.

    Single-repo: returns "spec"
    Monorepo with package: returns "spec/<package>"
    Monorepo without package: returns "spec" (caller should specify package)
    """
    if package and is_monorepo(repo_root):
        return f"spec/{package}"
    return "spec"


def validate_package(package: str, repo_root: Path | None = None) -> bool:
    """Check if a package name is valid in this project.

    Single-repo (no packages configured): always returns True.
    Monorepo: returns True only if package exists in config.yaml packages.
    """
    packages = get_packages(repo_root)
    if packages is None:
        return True  # Single-repo, no validation needed
    return package in packages


def resolve_package(
    task_package: str | None = None,
    repo_root: Path | None = None,
) -> str | None:
    """Resolve package from inferred sources with validation.

    Checks in order: task_package → default_package.
    Invalid inferred values print a warning to stderr and are skipped.

    Returns:
        Resolved package name, or None if no valid package found.

    Note:
        CLI --package should be validated separately by the caller
        (fail-fast with available packages list on error).
    """
    packages = get_packages(repo_root)
    if packages is None:
        return None  # Single-repo, no package needed

    # Try task_package (guard against non-string values from malformed JSON)
    if task_package and isinstance(task_package, str):
        if task_package in packages:
            return task_package
        print(
            f"Warning: task.json package '{task_package}' not found in config, skipping",
            file=sys.stderr,
        )

    # Try default_package
    default = get_default_package(repo_root)
    if default:
        if default in packages:
            return default
        print(
            f"Warning: default_package '{default}' not found in config, skipping",
            file=sys.stderr,
        )

    return None


def get_spec_scope(repo_root: Path | None = None) -> list[str] | str | None:
    """Get session.spec_scope configuration.

    Returns:
        list[str]: Package names to include in spec scanning.
        str: "active_task" to use current task's package.
        None: No scope configured (scan all packages).
    """
    config = _load_config(repo_root)
    session = config.get("session")
    if not isinstance(session, dict):
        return None

    scope = session.get("spec_scope")
    if scope is None:
        return None
    if isinstance(scope, str):
        return scope  # e.g. "active_task"
    if isinstance(scope, list):
        return [str(s) for s in scope]
    return None
