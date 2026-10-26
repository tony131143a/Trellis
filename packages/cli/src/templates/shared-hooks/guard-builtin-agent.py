#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Built-in Agent Guard Hook (Claude Code / StarFactory)

PreToolUse hook on the host's built-in sub-agent tool (matcher
`^(Agent|Task)$`). Arbor roles (explore / architect / implement / review /
verify / fix / simplify) run as codeg
assistants; spawning them through the built-in Agent/Task tool would run
them without the codeg target, its model, or the injected task context.

Denies the call when `dispatch.guard_builtin_agent` is enabled (default) and
the call is recognisably an Arbor role dispatch:
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
GUARDED_TOOLS = ("Agent", "Task")
ROLE_RE = re.compile(
    r"^\s*(?:Active task:|Role:\s*"
    r"(?:explore|architect|implement|review|verify|fix|simplify)\b)",
    re.IGNORECASE | re.MULTILINE,
)
# Only the head of the prompt is the header; a role word deep in the body is
# ordinary prose.
HEADER_SCAN_CHARS = 400
DENY_REASON = (
    "Arbor roles (explore/architect/implement/review/verify/fix/simplify) "
    "run as codeg assistants. "
    "Use the `delegate_to_agent` tool with the role's assistant (see the "
    "<dispatch> session context), or "
    "`python3 ./.arbor/scripts/dispatch.py run --role <role>`. "
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


def _guard_enabled(root: Path) -> bool:
    scripts_dir = str(root / DIR_WORKFLOW / "scripts")
    if scripts_dir not in sys.path:
        sys.path.insert(0, scripts_dir)
    try:
        from common.config import get_dispatch_config  # type: ignore[import-not-found]

        return bool(get_dispatch_config(root).get("guard_builtin_agent", True))
    except Exception:
        return True


def _subagent_type(tool_input: dict) -> str:
    for key in ("subagent_type", "subagentType"):
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
    prompt = tool_input.get("prompt")
    prompt = prompt if isinstance(prompt, str) else ""
    is_role_dispatch = bool(ROLE_RE.search(prompt[:HEADER_SCAN_CHARS])) or (
        _subagent_type(tool_input).lower().startswith("arbor-")
    )
    if not is_role_dispatch:
        return 0

    root = _find_root(data.get("cwd") or os.getcwd())
    if root is None or not _guard_enabled(root):
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
