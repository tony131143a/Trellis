#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Delegation Context Injection Hook (Claude Code / StarFactory)

PreToolUse hook on codeg `delegate_to_agent`
(matcher `^mcp__codeg[-_]mcp__delegate_to_agent$`). Inlines Arbor task
context into `tool_input.task` before codeg hands it to the assistant that
runs the Arbor role (explore / architect / implement / review / verify /
fix / simplify).

Flow:
- `ARBOR_HOOKS=0` / `ARBOR_DISABLE_HOOKS=1` -> no-op
- task text already carries `<!-- arbor-hook-injected -->` -> no-op (retry /
  resume of an already-injected dispatch)
- role: `Role:` header line -> `.arbor/.runtime/codeg-assistants.json`
  `by_id[assistant_id].role` -> neither: no-op (the assistant's own
  instructions load context themselves)
- task: `Active task:` header -> session active task; a task-bound role
  (every role but explore) without a resolvable task -> no-op with a stderr
  warning
- assistant: when `.arbor/.runtime/codeg-assistants.json` says the given
  `assistant_id` runs on another target than this dispatch resolves to
  (`Target:` header, else this session's target), swap in the expected
  target's assistant for the role (`common.dispatch_context.reconcile_assistant`)
- output: `updatedInput` = original tool_input with `task` replaced (and
  `assistant_id` when it was swapped)

Prompt assembly lives in `.arbor/scripts/common/dispatch_context.py`, shared
with the terminal dispatch fallback.
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

# IMPORTANT: Force stdout to use UTF-8 on Windows
# This fixes UnicodeEncodeError when outputting non-ASCII characters
if sys.platform.startswith("win"):
    import io as _io
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
    elif hasattr(sys.stdout, "detach"):
        sys.stdout = _io.TextIOWrapper(sys.stdout.detach(), encoding="utf-8", errors="replace")  # type: ignore[union-attr]


DIR_WORKFLOW = ".arbor"
TOOL_RE = re.compile(r"^mcp__codeg[-_]mcp__delegate_to_agent$")
MARKER = "<!-- arbor-hook-injected -->"


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


def _detect_platform() -> str:
    # StarFactory is a Claude Code fork and exports CLAUDE_PROJECT_DIR too, so
    # only its own vendor key distinguishes it.
    return "star" if os.environ.get("STARFACTORY_PROJECT_DIR") else "claude"


def main() -> int:
    if os.environ.get("ARBOR_HOOKS") == "0" or os.environ.get("ARBOR_DISABLE_HOOKS") == "1":
        return 0

    try:
        data = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        return 0
    if not isinstance(data, dict) or not TOOL_RE.match(str(data.get("tool_name", ""))):
        return 0

    raw_input = data.get("tool_input")
    tool_input = raw_input if isinstance(raw_input, dict) else {}
    task_text = tool_input.get("task")
    if not isinstance(task_text, str) or MARKER in task_text:
        return 0

    root = _find_root(data.get("cwd") or os.getcwd())
    if root is None:
        return 0

    scripts_dir = str(root / DIR_WORKFLOW / "scripts")
    if scripts_dir not in sys.path:
        sys.path.insert(0, scripts_dir)
    try:
        from common import dispatch_context as dc  # type: ignore[import-not-found]
    except Exception as exc:
        print(f"[arbor] dispatch_context unavailable: {exc}", file=sys.stderr)
        return 0

    try:
        header = dc.parse_dispatch_header(task_text)
        role = header.role or dc.role_from_assistant_id(root, tool_input.get("assistant_id"))
        if role not in dc.ROLES:
            return 0

        platform = _detect_platform()
        task_dir = dc.resolve_task_dir(root, header, data, platform)
        if role in dc.ROLES_REQUIRE_TASK and task_dir is None:
            print(
                f"[arbor] delegate_to_agent ({role}) without a resolvable "
                "`Active task:` — no context injected",
                file=sys.stderr,
            )
            return 0

        prompt = dc.build_dispatch_prompt(
            dc.DispatchRequest(root, role, task_dir, header, task_text)
        )
        assistant = dc.reconcile_assistant(
            root, role, header, tool_input.get("assistant_id"), data, platform
        )
        decision = dc.hook_decision(root)
    except Exception as exc:
        print(f"[arbor] dispatch context injection failed: {exc}", file=sys.stderr)
        return 0

    for warning in prompt.warnings:
        print(f"[arbor] {warning}", file=sys.stderr)
    if assistant.warning:
        print(f"[arbor] {assistant.warning}", file=sys.stderr)

    reason = f"Arbor injected {role} context ({prompt.context_bytes} bytes)"
    # updatedInput replaces tool_input wholesale: carry every original field
    # (assistant_id, working_dir, agent_type) and swap `task`, plus
    # `assistant_id` when it disagreed with the dispatch target.
    updated = {**tool_input, "task": prompt.text}
    if assistant.note:
        updated["assistant_id"] = assistant.assistant_id
        reason += f"; {assistant.note}"

    output = {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": decision,
            "permissionDecisionReason": reason,
            "updatedInput": updated,
        }
    }
    print(json.dumps(output, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
