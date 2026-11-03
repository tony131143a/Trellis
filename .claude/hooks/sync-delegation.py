#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Arbor codeg MCP delegation sync hook (Claude Code / Codex, PostToolUse)

Registered on the codeg MCP tools `delegate_to_agent` and
`get_delegation_status` (matcher `^mcp__.+__(delegate_to_agent|get_delegation_status)$`).
It performs the two bookkeeping steps the main agent would otherwise run by
hand after each call:

- after `delegate_to_agent`: `arbor.py bind --request <pending request> --task-id <id>`
  for the pending driver request whose `task` text equals the call's `task`;
- after `get_delegation_status`: for every report in a terminal state
  (completed / failed / canceled) that is bound to a pending request, save the
  complete tool response next to the request and run
  `arbor.py collect --request <request> --result <file>`.

The outcome is returned as `additionalContext`, so the main agent sees what
was bound or collected (or why the driver refused) and continues with
`arbor.py next`. Without this hook the manual bind/collect commands work
unchanged; a request bound or collected by hand is simply skipped here.

Silent exit 0 (no output): `ARBOR_HOOKS=0`, not an Arbor project, a tool
other than the two above, no pending request matches, or no terminal report.
"""
from __future__ import annotations

# IMPORTANT: Suppress all warnings FIRST
import warnings
warnings.filterwarnings("ignore")

import json
import os
import re
import subprocess
import sys
from pathlib import Path

# Hook hosts send UTF-8 JSON regardless of the process locale.
_stdin_reconfigure = getattr(sys.stdin, "reconfigure", None)
if callable(_stdin_reconfigure):
    try:
        _stdin_reconfigure(encoding="utf-8", errors="replace")
    except (OSError, ValueError):
        pass


DIR_WORKFLOW = ".arbor"
DELEGATIONS = f"{DIR_WORKFLOW}/.runtime/delegations"
DRIVER = f"{DIR_WORKFLOW}/scripts/arbor.py"
TOOL_RE = re.compile(r"(?:^|__)(delegate_to_agent|get_delegation_status)$")
TASK_ID_RE = re.compile(r"task_id=([A-Za-z0-9_:-]+(?:\.[A-Za-z0-9_:-]+)*)")
PROMPT_RE = re.compile(r"^Prompt:\s*(.+?)\s*$", re.MULTILINE)
TERMINAL = ("completed", "failed", "canceled")
# `arbor.py collect` validates the reply and runs git checks on the worktree.
COLLECT_TIMEOUT_S = 180


def _find_root(start: str) -> Path | None:
    """Nearest ancestor of `start` that contains `.arbor/`."""
    try:
        cur = Path(start).resolve()
    except OSError:
        return None
    while True:
        if (cur / DIR_WORKFLOW).is_dir():
            return cur
        if cur == cur.parent:
            return None
        cur = cur.parent


def _main_checkout(tool_input: dict, cwd: str) -> Path | None:
    """The main checkout holding `.arbor/.runtime/delegations`: named by the
    `Prompt:` pointer of the dispatch header when present, else found from cwd."""
    task = tool_input.get("task")
    match = PROMPT_RE.search(task[:2000]) if isinstance(task, str) else None
    if match:
        prompt = Path(match.group(1))
        # <main>/.arbor/.runtime/prompts/<task>/<dispatch>.md -> parents[4] is <main>
        if len(prompt.parents) >= 5 and (prompt.parents[4] / DIR_WORKFLOW).is_dir():
            return prompt.parents[4]
    root = _find_root(cwd)
    if root is None:
        return None
    if (root / DELEGATIONS).is_dir():
        return root
    # A linked worktree: ask git for the main checkout.
    try:
        out = subprocess.run(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
                             cwd=root, capture_output=True, text=True, timeout=10)
        common = Path(out.stdout.strip()) if out.returncode == 0 and out.stdout.strip() else None
    except (OSError, subprocess.SubprocessError):
        common = None
    if common is not None and common.name == ".git" and (common.parent / DIR_WORKFLOW).is_dir():
        return common.parent
    return root


def _structured(response) -> tuple[dict | None, str]:
    """(the tool's structured result, its text) from whatever shape the host
    hands PostToolUse: the MCP envelope, its content blocks, a JSON string."""
    text = ""
    if isinstance(response, str):
        text = response
        try:
            response = json.loads(response)
        except ValueError:
            return None, text
    if isinstance(response, list):
        for block in response:
            if isinstance(block, dict) and block.get("type") == "text" and isinstance(block.get("text"), str):
                text = block["text"]
                break
        try:
            parsed = json.loads(text)
        except ValueError:
            return None, text
        return (parsed if isinstance(parsed, dict) else None), text
    if not isinstance(response, dict):
        return None, text
    structured = response.get("structuredContent")
    if isinstance(structured, dict):
        return structured, text
    content = response.get("content")
    if isinstance(content, list):
        return _structured(content)
    return response, text


def _pending_requests(main: Path) -> list[tuple[Path, dict]]:
    root = main / DELEGATIONS
    found = []
    for path in sorted(root.glob("*/*.json")) if root.is_dir() else []:
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(record, dict) and record.get("status") == "pending" and record.get("main") == str(main):
            found.append((path, record))
    return found


def _driver(main: Path, *args: str, timeout: int = 60) -> tuple[int, str]:
    try:
        proc = subprocess.run([sys.executable, str(main / DRIVER), *args], cwd=main,
                              capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.SubprocessError) as e:
        return 1, f"{type(e).__name__}: {e}"
    out = (proc.stdout.strip() + "\n" + proc.stderr.strip()).strip()
    return proc.returncode, out


def _last_line(text: str) -> str:
    lines = [line for line in text.splitlines() if line.strip()]
    return lines[-1] if lines else ""


def on_delegate(main: Path, tool_input: dict, response) -> list[str]:
    task = tool_input.get("task")
    if not isinstance(task, str):
        return []
    matches = [(p, r) for p, r in _pending_requests(main)
               if r.get("task_id") is None and ((r.get("mcp") or {}).get("arguments") or {}).get("task") == task]
    if len(matches) != 1:
        return []
    path, record = matches[0]
    dispatch = record.get("dispatch")
    structured, text = _structured(response)
    task_id = structured.get("task_id") if isinstance(structured, dict) else None
    if not isinstance(task_id, str) or not task_id.strip():
        found = TASK_ID_RE.search(text or "")
        task_id = found.group(1) if found else None
    if not task_id:
        if isinstance(structured, dict) and structured.get("status") == "failed":
            # Setup failed before a task_id existed: the driver accepts the failed acknowledgment as the report.
            result = path.with_suffix(".result.json")
            result.write_text(json.dumps(structured, ensure_ascii=False), encoding="utf-8")
            rc, out = _driver(main, "collect", "--request", str(path), "--result", str(result), timeout=COLLECT_TIMEOUT_S)
            if rc == 0:
                return [f"Arbor: {dispatch} failed before codeg started it; the driver collected the failure: "
                        f"{_last_line(out)}. Run `arbor.py next`."]
            return [f"Arbor: {dispatch} failed before codeg started it and the driver refused to collect the "
                    f"acknowledgment: {_last_line(out)}. Collect by hand: arbor.py collect --request {path} --result <file>."]
        return [f"Arbor: no task_id found in the delegate_to_agent reply for {dispatch}; bind it by hand: "
                f"arbor.py bind --request {path} --task-id <id>."]
    rc, out = _driver(main, "bind", "--request", str(path), "--task-id", task_id)
    if rc != 0:
        return [f"Arbor: could not bind {dispatch} to task_id {task_id}: {_last_line(out)}. "
                f"Bind by hand: arbor.py bind --request {path} --task-id {task_id}."]
    return [f"Arbor: bound {dispatch} to codeg task_id {task_id} (request {path}). Poll get_delegation_status "
            f"with task_ids [\"{task_id}\"] (wait_ms up to 60000); this hook collects the terminal report."]


def on_status(main: Path, response) -> list[str]:
    structured, _ = _structured(response)
    if not isinstance(structured, dict):
        return []
    reports = structured.get("tasks")
    if not isinstance(reports, list):
        reports = [structured] if structured.get("task_id") else []
    terminal = {r["task_id"]: r for r in reports
                if isinstance(r, dict) and isinstance(r.get("task_id"), str) and r.get("status") in TERMINAL}
    if not terminal:
        return []
    notes = []
    for path, record in _pending_requests(main):
        task_id = record.get("task_id")
        if task_id not in terminal:
            continue
        dispatch = record.get("dispatch")
        result = path.with_suffix(".result.json")
        try:
            result.write_text(json.dumps(response if isinstance(response, (dict, list)) else structured,
                                         ensure_ascii=False), encoding="utf-8")
        except OSError as e:
            notes.append(f"Arbor: could not save the status response for {dispatch}: {e}. Save it yourself and run "
                         f"arbor.py collect --request {path} --result <file>.")
            continue
        rc, out = _driver(main, "collect", "--request", str(path), "--result", str(result), timeout=COLLECT_TIMEOUT_S)
        if rc == 0:
            notes.append(f"Arbor: collected {dispatch} ({terminal[task_id].get('status')}): {_last_line(out)}. "
                         "Run `arbor.py next`.")
        else:
            notes.append(f"Arbor: {dispatch} ({terminal[task_id].get('status')}) was not collected: {_last_line(out)}. "
                         f"Response saved at {result}; resolve it, then arbor.py collect --request {path} --result {result} "
                         "or `arbor.py next` for the driver's view.")
    return notes


def main() -> int:
    if os.environ.get("ARBOR_HOOKS") == "0" or os.environ.get("ARBOR_DISABLE_HOOKS") == "1":
        return 0
    try:
        data = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        return 0
    if not isinstance(data, dict):
        return 0
    tool = TOOL_RE.search(str(data.get("tool_name") or ""))
    if not tool:
        return 0
    raw_input = data.get("tool_input")
    tool_input = raw_input if isinstance(raw_input, dict) else {}
    main_checkout = _main_checkout(tool_input, data.get("cwd") or os.getcwd())
    if main_checkout is None or not (main_checkout / DRIVER).is_file():
        return 0
    response = data.get("tool_response")
    if tool.group(1) == "delegate_to_agent":
        notes = on_delegate(main_checkout, tool_input, response)
    else:
        notes = on_status(main_checkout, response)
    if notes:
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "PostToolUse",
                                                 "additionalContext": "\n".join(notes)}}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
