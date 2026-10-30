"""Durable handoff between the Arbor driver and the host's codeg MCP tools.

The host calls the real MCP tools. This module never starts an agent or reads
codeg credentials. A bound task id and a terminal MCP report are required before
the driver accepts the reply and advances its state.
"""
from __future__ import annotations

import json
import re
from dataclasses import asdict
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path
from tempfile import gettempdir

from ..invariants import RefSnapshot
from ..io import write_json
from .executor import ExecResult, Executor, ExecutorError, utc_now


def snapshot_dict(before: RefSnapshot) -> dict:
    return {**asdict(before), "dirty": sorted(before.dirty)}


def snapshot_from(data: dict) -> RefSnapshot:
    return RefSnapshot(data["head"], data["head_ref"], data["branches"], data["remotes"],
                       frozenset(data["dirty"]))


def request(executor: Executor, role: str, prompt: str, worktree: Path) -> dict:
    arguments: dict = {"task": prompt, "working_dir": str(worktree)}
    target = {"assistant_name": executor.assistant.replace("{role}", role)}
    assistant_id = (executor.assistant_ids or {}).get(role)
    if assistant_id is not None:
        if isinstance(assistant_id, bool) or not str(assistant_id).isdigit() or int(assistant_id) < 1:
            raise ExecutorError(f"invalid assistant_ids.{role}: expected a positive codeg assistant id")
        arguments["assistant_id"] = int(assistant_id)
    elif executor.agent_type:
        arguments["agent_type"] = executor.agent_type
        target = {"agent_type": executor.agent_type}
    return {"tool": "delegate_to_agent", "arguments": arguments, "target": target}


def pending_path(main: Path, task: str, dispatch: str) -> Path:
    if not all(re.fullmatch(r"[\w.-]+", s) and s not in (".", "..") for s in (task, dispatch)):
        raise ExecutorError("invalid MCP dispatch path")
    return main / ".arbor/.runtime/delegations" / task / f"{dispatch}.json"


def store(path: Path, record: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not write_json(path, record):
        raise ExecutorError(f"cannot write MCP request {path}")


def load(main: Path, path: str) -> tuple[Path, dict]:
    resolved = Path(path).resolve()
    root = (main / ".arbor/.runtime/delegations").resolve()
    if not resolved.is_relative_to(root):
        raise ExecutorError("--request must be a driver-created .arbor/.runtime/delegations file")
    record = json.loads(resolved.read_text(encoding="utf-8"))
    if record.get("schema") != 1 or record.get("main") != str(main):
        raise ExecutorError("MCP request belongs to another checkout or schema")
    return resolved, record


def envelope(path: Path, record: dict) -> dict:
    task_id = record.get("task_id")
    return {
        "needs": "delegation", "dispatch": record["dispatch"], "request_path": str(path),
        "result_path": str(Path(gettempdir()) / ("arbor-mcp-" + sha256(str(path).encode()).hexdigest()[:16]
                                                + ".result.json")),
        "task_id": task_id, "mcp": record["mcp"] if not task_id else None,
        "status_call": {"tool": "get_delegation_status", "arguments": {"task_ids": [task_id], "wait_ms": 1000}}
                       if task_id else None,
        "timeout_s": record.get("timeout_s"), "started": record["started"],
        "instructions": (
            "Call codeg MCP delegate_to_agent once with mcp.arguments. If assistant_id/agent_type is absent, "
            "resolve mcp.target.assistant_name from the tool's assistant roster and add its assistant_id; "
            "if unavailable, stop and report the missing assistant. Never use codeg-cli or native Agent/Task. "
            "Immediately bind its returned task_id with arbor.py bind --request <request_path> --task-id <id>. "
            "If setup fails before a task_id exists, collect the failed MCP acknowledgment directly. "
            "Poll get_delegation_status (wait_ms <= 60000); save its complete JSON response at result_path "
            "outside the task worktree, "
            "then arbor.py collect --request <request_path> --result <file>. "
            "On interruption resume/poll the bound task; never delegate it again. If timeout_s expires, "
            "cancel_delegation and collect its terminal report. Never fabricate a child reply."
        ),
    }


def find_pending(main: Path, task: str = "_intake") -> tuple[Path, dict] | None:
    root = pending_path(main, task, "unused").parent
    for path in sorted(root.glob("*.json")):
        pair = load(main, str(path))
        if pair[1].get("status") == "pending":
            return pair
    return None


def terminal_result(record: dict, payload: dict) -> tuple[ExecResult, dict]:
    """Accept raw status JSON or a complete MCP tools/call result envelope."""
    if not isinstance(payload, dict):
        raise ExecutorError("MCP result must be a JSON object")
    report = payload.get("structuredContent", payload)
    if not isinstance(report, dict):
        raise ExecutorError("MCP structuredContent must be a JSON object")
    if "tasks" not in report and not report.get("task_id"):
        for block in payload.get("content", []):
            if block.get("type") == "text":
                try:
                    report = json.loads(block["text"])
                    break
                except (ValueError, KeyError):
                    continue
    reports = report.get("tasks", [report])
    if not isinstance(reports, list) or not all(isinstance(r, dict) for r in reports):
        raise ExecutorError("MCP tasks must be a list of task reports")
    setup_failed = (len(reports) == 1 and reports[0].get("task_id") is None
                    and reports[0].get("status") == "failed")
    if not record.get("task_id") and not setup_failed:
        raise ExecutorError("bind the codeg task_id before collecting its result")
    matches = [r for r in reports if r.get("task_id") == record["task_id"]]
    if len(matches) != 1:
        raise ExecutorError("MCP result must contain exactly one report for the bound task_id")
    report = matches[0]
    status = report.get("status")
    if status not in ("completed", "failed", "canceled"):
        raise ExecutorError(f"delegation is {status!r}, not terminal; poll/resume the existing task")
    if status == "completed" and (report.get("truncated") or report.get("text_truncated")):
        raise ExecutorError("MCP result is truncated; retrieve the complete child report before collecting")
    text = report.get("text", "")
    if isinstance(text, str) and len(text.encode("utf-8")) >= 262140 and text.endswith("…"):
        raise ExecutorError("MCP result reached codeg's text cap; retrieve the complete child report")
    if status == "completed" and (not isinstance(text, str) or not text.strip()):
        raise ExecutorError("completed MCP report has no result text; retrieve the complete child report")
    ended = utc_now()
    duration = (datetime.now(timezone.utc) - datetime.fromisoformat(record["started"].replace("Z", "+00:00"))).total_seconds()
    error = None if status == "completed" else str(report.get("message") or report.get("error_code") or status)
    return ExecResult(record["executor"], f"MCP delegate_to_agent task_id={record['task_id']}",
                      0 if error is None else 1, text if isinstance(text, str) else "", "",
                      record["started"], ended, round(duration, 3), error), report
