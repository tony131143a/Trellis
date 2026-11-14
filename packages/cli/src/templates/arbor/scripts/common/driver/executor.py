"""
Executor configuration. The only executor type is ``orca``: the driver starts
every node as an Orca worker (``orca orchestration worker-start``) and reads
its outcome back with ``arbor.py sync`` (see ``orca.py``).

    executors:
      default: orca
      orca:
        type: orca
        command: orca        # the Orca CLI (an absolute path when it is not on PATH)
        agent: codex         # Orca agent id of the `strong` tier
        timeout: 90m         # 90m | 30s | 2h | plain seconds; absent = none
        max_parallel: 5      # simultaneous workers of one task
        max_nodes: 30        # nodes of one task before sync stops and asks
        keep_open: false     # true: a finished worker stays open in Orca
        tiers:               # further tiers a node can name
          light:
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
    agent: str  # Orca agent id of the `strong` tier
    tiers: dict[str, str]  # tier -> agent id
    max_nodes: int

    def agent_for(self, tier: str) -> str:
        if tier == "strong":
            return self.agent
        if tier not in self.tiers:
            raise ExecutorError(f"unknown tier {tier!r} (strong, or one of executors.{self.name}.tiers)")
        return self.tiers[tier]


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
    tiers = spec.get("tiers") or {}
    if not isinstance(tiers, dict) or not all(isinstance(v, dict) for v in tiers.values()):
        raise ExecutorError("tiers must map tier names to {agent: <Orca agent id>}")
    return Executor(chosen, command, parse_timeout(spec.get("timeout")), _count(spec.get("max_parallel")),
                    str(spec.get("keep_open") or "").strip().lower() == "true", agent,
                    {tier: _agent(over, f"executors.{chosen}.tiers.{tier}") for tier, over in tiers.items()},
                    _count(spec.get("max_nodes")) or 30)


def _count(value: object) -> int | None:
    return int(value) if isinstance(value, int) or (isinstance(value, str) and value.isdigit()) else None
