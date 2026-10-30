"""
Executor configuration and optional direct command adapter. The default
``type: codeg-mcp`` uses the host's real codeg MCP tools via the durable
prepare / bind / collect protocol in ``mcp.py``. Explicit command executors:

    executors:
      default: <name>
      <name>:
        command: "<cli> ... {role} {prompt} {worktree} {task} {dispatch}"
        timeout: 90m            # 90m | 30s | 2h | plain seconds; absent = none

Placeholders are substituted shell-quoted; the command runs with
``shell=True`` in the task worktree. stdout is the reply; stderr is kept for
the report. A missing executor, an empty command, a non-zero exit or a
timeout is a failed dispatch.
"""

from __future__ import annotations

import os
import re
import shlex
import signal
import subprocess
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from ..arbor_config import get_executors_config

PLACEHOLDERS = ("role", "prompt", "worktree", "task", "dispatch")
_TIMEOUT_RE = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*([smh]?)\s*$", re.IGNORECASE)
_UNIT_SECONDS = {"": 1, "s": 1, "m": 60, "h": 3600}


class ExecutorError(ValueError):
    """The executor configuration cannot be used."""


@dataclass(frozen=True)
class Executor:
    name: str
    command: str
    timeout: float | None
    kind: str = "command"
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
    kind = str(spec.get("type") or "command")
    if kind not in ("command", "codeg-mcp"):
        raise ExecutorError(f"executor {chosen!r}: unknown type {kind!r}")
    command = str(spec.get("command") or "").strip()
    if kind == "command" and not command:
        raise ExecutorError(f"executor {chosen!r} has no command")
    if spec.get("assistant_ids") is not None and not isinstance(spec["assistant_ids"], dict):
        raise ExecutorError("assistant_ids must map role names to codeg assistant ids")
    return Executor(chosen, command, parse_timeout(spec.get("timeout")), kind,
                    str(spec.get("assistant") or "arbor-{role}"), spec.get("assistant_ids"),
                    str(spec["agent_type"]) if spec.get("agent_type") else None)


def build_command(template: str, values: dict[str, str]) -> str:
    """Substitute ``{placeholder}`` tokens with shell-quoted values; other
    braces in the template are left alone."""
    command = template
    for key in PLACEHOLDERS:
        if key in values:
            command = command.replace("{" + key + "}", shlex.quote(str(values[key])))
    return command


def run_executor(
    executor: Executor,
    *,
    role: str,
    prompt_path: Path,
    worktree: Path,
    task: str,
    dispatch: str,
) -> ExecResult:
    """Run the dispatch; never raises for executor failures."""
    if executor.kind != "command":
        raise ExecutorError("codeg-mcp dispatches must be prepared, delegated by the host, then collected")
    command = build_command(
        executor.command,
        {
            "role": role,
            "prompt": str(prompt_path),
            "worktree": str(worktree),
            "task": task,
            "dispatch": dispatch,
        },
    )
    started, t0 = utc_now(), time.monotonic()

    def result(exit_code: int | None, out: str, err: str, error: str | None) -> ExecResult:
        return ExecResult(
            executor.name, command, exit_code, out, err, started, utc_now(),
            round(time.monotonic() - t0, 3), error,
        )

    # A role is a new host session, not the parent Arbor controller.
    env = os.environ.copy()
    for key in ("ARBOR_CONTEXT_ID", "CODEX_THREAD_ID", "CLAUDE_CODE_SESSION_ID", "CLAUDE_ENV_FILE"):
        env.pop(key, None)

    try:
        proc = subprocess.Popen(
            command,
            shell=True,
            cwd=worktree,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            start_new_session=True,
        )
    except OSError as e:
        return result(None, "", "", f"executor could not start: {e}")

    try:
        out, err = proc.communicate(timeout=executor.timeout)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except (OSError, AttributeError):
            proc.kill()
        out, err = proc.communicate()
        return result(None, out, err, f"executor timed out after {executor.timeout:g}s")

    if proc.returncode != 0:
        return result(proc.returncode, out, err, f"executor exited {proc.returncode}")
    return result(0, out, err, None)
