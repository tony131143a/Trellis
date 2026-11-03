"""
Executor configuration. The only executor type is ``codeg-mcp``: the host's
real codeg MCP tools drive every role through the durable prepare / bind /
collect protocol in ``mcp.py``.

    executors:
      default: codeg
      codeg:
        type: codeg-mcp
        assistant: "arbor-{role}"   # or assistant_ids: {role: id} / agent_type
        timeout: 90m                # 90m | 30s | 2h | plain seconds; absent = none
        max_parallel: 3             # simultaneous delegations of one task
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timezone

from ..arbor_config import get_executors_config

_TIMEOUT_RE = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*([smh]?)\s*$", re.IGNORECASE)
_UNIT_SECONDS = {"": 1, "s": 1, "m": 60, "h": 3600}


class ExecutorError(ValueError):
    """The executor configuration cannot be used."""


@dataclass(frozen=True)
class Executor:
    name: str
    timeout: float | None
    kind: str = "codeg-mcp"
    assistant: str = "arbor-{role}"
    assistant_ids: dict | None = None
    agent_type: str | None = None


@dataclass(frozen=True)
class ExecResult:
    executor: str
    command: str
    exit_code: int | None  # None: could not start or timed out
    stdout: str
    stderr: str
    started: str
    ended: str
    duration_s: float
    error: str | None = None  # why the run failed before/without an exit code

    @property
    def ok(self) -> bool:
        return self.error is None and self.exit_code == 0


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_timeout(value: object) -> float | None:
    """``90m`` / ``30s`` / ``2h`` / ``45`` -> seconds; empty -> None."""
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    match = _TIMEOUT_RE.match(str(value))
    if not match:
        raise ExecutorError(f"timeout {value!r}: expected <number>[s|m|h]")
    seconds = float(match.group(1)) * _UNIT_SECONDS[match.group(2).lower()]
    return seconds if seconds > 0 else None


def resolve_executor(config: dict, name: str | None = None) -> Executor:
    """The executor named ``name`` (default: ``executors.default``)."""
    section = get_executors_config(config)
    chosen = name or str(section.get("default") or "").strip()
    if not chosen:
        raise ExecutorError("executors.default is not set in .arbor/config.yaml")
    spec = section.get(chosen)
    if not isinstance(spec, dict):
        raise ExecutorError(f"executor {chosen!r} is not configured under executors:")
    kind = str(spec.get("type") or "codeg-mcp")
    if kind != "codeg-mcp":
        raise ExecutorError(f"executor {chosen!r}: unknown type {kind!r} (v5 runs roles through codeg MCP only)")
    if spec.get("assistant_ids") is not None and not isinstance(spec["assistant_ids"], dict):
        raise ExecutorError("assistant_ids must map role names to codeg assistant ids")
    return Executor(chosen, parse_timeout(spec.get("timeout")), kind,
                    str(spec.get("assistant") or "arbor-{role}"), spec.get("assistant_ids"),
                    str(spec["agent_type"]) if spec.get("agent_type") else None)
