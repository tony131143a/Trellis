"""
Executor configuration. The only executor type is ``orca``: the driver starts
every role as an Orca worker (``orca orchestration worker-start``) and reads
its outcome back with ``arbor.py sync`` (see ``orca.py``).

    executors:
      default: orca
      orca:
        type: orca
        command: orca        # the Orca CLI (an absolute path when it is not on PATH)
        agent: codex         # Orca agent id every role starts as
        timeout: 90m         # 90m | 30s | 2h | plain seconds; absent = none
        max_parallel: 5      # simultaneous workers of one task
        keep_open: false     # true: a finished worker stays open in Orca
        roles:               # per-role agent override
          explore:
            agent: omp

Model and reasoning effort are not set here: they are the agent's own settings in Orca.
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
    command: str
    timeout: float | None
    max_parallel: int | None  # simultaneous workers of one task
    keep_open: bool
    agent: str  # Orca agent id every role starts as
    roles: dict[str, str]  # role -> agent id, where it differs from ``agent``

    def agent_for(self, role: str) -> str:
        return self.roles.get(role, self.agent)


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


def _agent(spec: dict, where: str) -> str:
    agent = spec.get("agent")
    if not isinstance(agent, str) or not agent.strip():
        raise ExecutorError(f"{where}: agent is not set (an Orca agent id such as codex, claude or omp)")
    return agent.strip()


def resolve_executor(config: dict) -> Executor:
    """The executor ``executors.default`` names."""
    section = get_executors_config(config)
    chosen = str(section.get("default") or "").strip()
    if not chosen:
        raise ExecutorError("executors.default is not set in .arbor/config.yaml")
    spec = section.get(chosen)
    if not isinstance(spec, dict):
        raise ExecutorError(f"executor {chosen!r} is not configured under executors:")
    kind = str(spec.get("type") or "orca")
    if kind != "orca":
        raise ExecutorError(f"executor {chosen!r}: unknown type {kind!r} (roles run as Orca workers only)")
    command = str(spec.get("command") or "").strip()
    if not command:
        raise ExecutorError(f"executor {chosen!r}: command is not set (the Orca CLI)")
    agent = _agent(spec, f"executor {chosen!r}")
    roles = spec.get("roles") or {}
    if not isinstance(roles, dict) or not all(isinstance(v, dict) for v in roles.values()):
        raise ExecutorError("roles must map role names to {agent: <Orca agent id>}")
    limit = spec.get("max_parallel")
    max_parallel = int(limit) if isinstance(limit, int) or (isinstance(limit, str) and limit.isdigit()) else None
    return Executor(chosen, command, parse_timeout(spec.get("timeout")), max_parallel,
                    str(spec.get("keep_open") or "").strip().lower() == "true", agent,
                    {role: _agent(over, f"executors.{chosen}.roles.{role}") for role, over in roles.items()})
