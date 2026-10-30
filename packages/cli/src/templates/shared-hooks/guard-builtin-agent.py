#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Built-in Agent Guard Hook (Claude Code / Codex)

PreToolUse hook on the host's built-in sub-agent tool (matcher
`^(Agent|Task)$`). Arbor roles (explore / architect / test / implement /
review / verify / fix / simplify) run only through the driver
(`arbor.py run`) and the executor configured in `executors:`; spawning them
through the built-in Agent/Task tool would skip the driver's prompt
assembly, invariant checks, commit validation and state tracking.

Inside an Arbor project, denies the call when it is recognisably an Arbor
role dispatch (`ARBOR_HOOKS=0` disables every Arbor hook, this one included):
- the prompt's first lines carry `Active task:` or `Role: <arbor role>`
- `subagent_type` starts with `arbor-`

Every other Agent/Task call passes through untouched (no output).
"""
from __future__ import annotations

# IMPORTANT: Suppress all warnings FIRST
import warnings
warnings.filterwarnings("ignore")

import json
import os
import re
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
GUARDED_TOOLS = ("Agent", "Task", "spawn_agent")
ROLE_RE = re.compile(
    r"^\s*(?:Active task:|Role:\s*"
    r"(?:explore|architect|test|implement|review|verify|fix|simplify)\b)",
    re.IGNORECASE | re.MULTILINE,
)
# Only the head of the prompt is the header; a role word deep in the body is
# ordinary prose.
HEADER_SCAN_CHARS = 400
DENY_REASON = (
    "Arbor roles (explore/architect/test/implement/review/verify/fix/simplify) "
    "run only through the driver. Run `python3 ./.arbor/scripts/arbor.py next`, "
    "write the brief it names, then `python3 ./.arbor/scripts/arbor.py run`. "
    "Never the built-in Agent/Task tool."
)


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


def _subagent_type(tool_input: dict) -> str:
    for key in ("subagent_type", "subagentType", "agent_type"):
        value = tool_input.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def main() -> int:
    if os.environ.get("ARBOR_HOOKS") == "0" or os.environ.get("ARBOR_DISABLE_HOOKS") == "1":
        return 0

    try:
        data = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        return 0
    if not isinstance(data, dict) or data.get("tool_name") not in GUARDED_TOOLS:
        return 0

    raw_input = data.get("tool_input")
    tool_input = raw_input if isinstance(raw_input, dict) else {}
    prompt = tool_input.get("prompt", tool_input.get("message"))
    prompt = prompt if isinstance(prompt, str) else ""
    is_role_dispatch = bool(ROLE_RE.search(prompt[:HEADER_SCAN_CHARS])) or (
        _subagent_type(tool_input).lower().startswith("arbor-")
    )
    if not is_role_dispatch:
        return 0

    root = _find_root(data.get("cwd") or os.getcwd())
    if root is None:
        return 0

    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": DENY_REASON,
        }
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
