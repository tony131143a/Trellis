"""
Executor configuration. The only executor type is ``orca``: the driver starts
every node as an Orca worker (``orca orchestration worker-start``) and reads
its outcome back with ``arbor.py sync`` (see ``orca.py``).

    executors:
      default: orca
      orca:
        type: orca
        command: orca        # the Orca CLI (an absolute path when it is not on PATH)
        agents:              # the Orca agent id that does each kind of work
          write: codex       #   nodes with `paths`; the default of every node
          explore: omp       #   read-only nodes that name no tier
          review:            #   the reviewer nodes of `arbor.py review`
            agent: claude
            model: opus      #   optional: the agent's model id (else the agent's own Orca setting)
            effort: high     #   optional: reasoning effort; needs `model`
          light: omp         #   optional: mechanical edits (`tier: light`)
        timeout: 90m         # 90m | 30s | 2h | plain seconds; absent = none
        max_parallel: 5      # simultaneous workers of one task
        max_nodes: 30        # nodes of one task before sync stops and asks
        main: claude         # optional: the agent that runs the driver (else detected); `none` = never inline
        keep_open: false     # true: a finished worker stays open in Orca

An entry is an agent id, or `agent` with `model` and `effort`. `explore`, `review` and `light`
fall back to `write` (agent, model and effort) when they are not set. Any
other name under `agents` is a tier a node can name (`tier: <name>`). The older
spelling `agent: codex` (= `agents.write`) and `tiers.<name>.agent` still work.

Model and reasoning effort are not set here: they are the agent's own settings in Orca.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone

from ..arbor_config import get_executors_config

_TIMEOUT_RE = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*([smh]?)\s*$", re.IGNORECASE)
_UNIT_SECONDS = {"": 1, "s": 1, "m": 60, "h": 3600}
FALLBACK_TO_WRITE = ("explore", "review", "light")  # tiers that run on `write` until they are configured


class ExecutorError(ValueError):
    """The executor configuration cannot be used."""


@dataclass(frozen=True)
class Executor:
    name: str
    command: str
    timeout: float | None
    max_parallel: int | None  # simultaneous workers of one task
    keep_open: bool
    agent: str  # Orca agent id of the `write` tier
    tiers: dict[str, str]  # other tier -> agent id
    max_nodes: int
    options: dict[str, tuple[str, str]] = field(default_factory=dict)  # tier -> (model, effort)
    main: str = ""  # the agent of the session that runs the driver; "" = detect

    def main_agent(self) -> str:
        """Orca agent id of the session that runs the driver, '' when unknown (or `main: none`):
        `main:` of the config, else claude when Claude Code started this process."""
        if self.main:
            return "" if self.main.lower() in ("none", "off") else self.main
        return "claude" if os.environ.get("CLAUDECODE") else ""

    def options_for(self, tier: str) -> tuple[str, str]:
        """(model, effort) of ``tier``; ("", "") leaves both to the agent's Orca setting."""
        own = tier != "write" and (tier in self.tiers or tier not in FALLBACK_TO_WRITE)
        return self.options.get(tier if own else "write", ("", ""))

    def agent_for(self, tier: str) -> str:
        if tier == "write" or (tier in FALLBACK_TO_WRITE and tier not in self.tiers):
            return self.agent
        if tier not in self.tiers:
            raise ExecutorError(f"unknown tier {tier!r} (write, or one of executors.{self.name}.agents)")
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


def _text(value: object) -> str:
    return value.strip() if isinstance(value, str) else ""


def _agent(spec: object, where: str) -> tuple[str, str, str]:
    """(agent id, model, effort) of an entry: an agent id, or {agent, model, effort}."""
    entry: dict = {"agent": spec} if isinstance(spec, str) else spec if isinstance(spec, dict) else {}
    agent = _text(entry.get("agent"))
    if not agent:
        raise ExecutorError(f"{where}: agent is not set (an Orca agent id such as codex, claude or omp)")
    model, effort = _text(entry.get("model")), _text(entry.get("effort"))
    if effort and not model:
        raise ExecutorError(f"{where}: effort needs a model (Orca takes --effort only together with --model)")
    return agent, model, effort


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
    agents = spec.get("agents") or {}
    if not isinstance(agents, dict):
        raise ExecutorError("agents must map work names to an Orca agent id or {agent, model, effort}")
    tiers = spec.get("tiers") or {}
    if not isinstance(tiers, dict) or not all(isinstance(v, dict) for v in tiers.values()):
        raise ExecutorError("tiers must map tier names to {agent: <Orca agent id>}")
    entries = {**{t: _agent(v, f"executors.{chosen}.tiers.{t}") for t, v in tiers.items()},
               **{t: _agent(v, f"executors.{chosen}.agents.{t}") for t, v in agents.items() if t != "write"}}
    write = _agent(agents.get("write") or spec.get("agent"), f"executor {chosen!r} (agents.write or agent)")
    entries["write"] = write
    return Executor(chosen, command, parse_timeout(spec.get("timeout")), _count(spec.get("max_parallel")),
                    str(spec.get("keep_open") or "").strip().lower() == "true", write[0],
                    {t: e[0] for t, e in entries.items() if t != "write"},
                    _count(spec.get("max_nodes")) or 30, {t: (e[1], e[2]) for t, e in entries.items()},
                    _text(spec.get("main")))


def _count(value: object) -> int | None:
    return int(value) if isinstance(value, int) or (isinstance(value, str) and value.isdigit()) else None
