#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Arbor dispatch context assembler.

Single source of truth for the prompt a dispatched implement / check /
research role receives. Both the PreToolUse hook on codeg
``delegate_to_agent`` (``inject-delegation-context.py``) and the terminal
fallback build the final task text through ``build_dispatch_prompt`` so the
two paths cannot drift.

Header protocol (written by the main agent at the top of the task text):

    Active task: /abs/repo/.arbor/tasks/10-24-foo
    Role: implement            # implement | check | check [finish] | research
    Target: star               # optional; recorded only
    Workspace: /abs/repo-wt/foo-a   # optional; parallel variant

Context sources per role:
- implement: implement.jsonl entries -> prd.md -> design.md -> implement.md
- check / check [finish]: check.jsonl entries -> the same task artifacts
- research: spec directory overview (task directory optional)

Byte limits come from ``config.get_context_injection_limits()``.
"""

from __future__ import annotations

import json
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .active_task import resolve_active_task
from .config import get_context_injection_limits, get_dispatch_config
from .paths import DIR_SPEC, DIR_WORKFLOW, resolve_task_ref


ROLES = ("implement", "check", "research")
ROLES_REQUIRE_TASK = ("implement", "check")
HEADER_KEYS = ("active task", "role", "target", "workspace")
MARKER = "<!-- arbor-hook-injected -->"
FINISH_TAG = "[finish]"

# Written by codeg setup; maps codeg assistant ids to Arbor roles.
CODEG_ASSISTANTS_FILE = ".runtime/codeg-assistants.json"

_HEADER_RE = re.compile(
    r"^\s*(active task|role|target|workspace)\s*:\s*(.*?)\s*$",
    re.IGNORECASE,
)


# =============================================================================
# Header protocol
# =============================================================================


@dataclass(frozen=True)
class DispatchHeader:
    """Leading ``Key: value`` lines of a dispatch task text."""

    task_dir: str | None
    role: str | None
    finish: bool
    target: str | None
    workspace: str | None
    body: str


@dataclass(frozen=True)
class DispatchRequest:
    """Everything ``build_dispatch_prompt`` needs to assemble one prompt."""

    repo_root: Path
    role: str
    task_dir: Path | None
    header: DispatchHeader
    original_text: str


@dataclass(frozen=True)
class DispatchPrompt:
    """Assembled prompt plus diagnostics for the caller."""

    text: str
    context_bytes: int
    degraded: tuple[str, ...]
    warnings: tuple[str, ...]


def parse_dispatch_header(text: str) -> DispatchHeader:
    """Parse the leading header lines of a dispatch task text.

    Scans leading non-empty lines matching ``Key: value`` (keys in
    HEADER_KEYS, case-insensitive) and stops at the first other line.
    ``Role: check [finish]`` yields role=check, finish=True; ``[finish]``
    anywhere in the body also sets finish (consumed only for role=check).
    """
    values: dict[str, str] = {}
    lines = text.splitlines()
    index = 0
    while index < len(lines) and not lines[index].strip():
        index += 1
    while index < len(lines):
        match = _HEADER_RE.match(lines[index])
        if not match:
            break
        key = match.group(1).lower()
        if key not in values:
            values[key] = match.group(2)
        index += 1

    body = "\n".join(lines[index:]).strip() if values else text.strip()

    role: str | None = None
    finish = FINISH_TAG in body.lower()
    raw_role = values.get("role", "").lower()
    if FINISH_TAG in raw_role:
        finish = True
        raw_role = raw_role.replace(FINISH_TAG, " ")
    tokens = raw_role.split()
    if tokens:
        role = tokens[0]

    return DispatchHeader(
        task_dir=values.get("active task") or None,
        role=role,
        finish=finish,
        target=values.get("target") or None,
        workspace=values.get("workspace") or None,
        body=body,
    )


def resolve_task_dir(
    repo_root: Path,
    header: DispatchHeader,
    hook_input: dict | None,
    platform: str | None,
) -> Path | None:
    """Resolve the task directory a dispatch targets, as an absolute path.

    An explicit ``Active task:`` header wins and goes through
    ``paths.resolve_task_ref`` (containment check; a symlinked ``.arbor`` is
    accepted). An explicit header that does not resolve returns None rather
    than silently falling back to another task. Without a header, the
    session's active task is used. Stale or missing directories return None.
    """
    if header.task_dir:
        resolved = resolve_task_ref(header.task_dir, repo_root)
        if resolved is None or not resolved.is_dir():
            return None
        return resolved

    active = resolve_active_task(
        repo_root,
        hook_input,
        platform,
        allow_single_session_fallback=True,
    )
    if not active.task_path or active.stale:
        return None
    resolved = resolve_task_ref(active.task_path, repo_root)
    if resolved is None or not resolved.is_dir():
        return None
    return resolved


def role_from_assistant_id(repo_root: Path, assistant_id: Any) -> str | None:
    """Map a codeg assistant id to an Arbor role via the runtime registry.

    Reads ``.arbor/.runtime/codeg-assistants.json`` ->
    ``by_id[str(assistant_id)]["role"]``. Any missing piece returns None.
    """
    if assistant_id is None or isinstance(assistant_id, bool):
        return None
    key = str(assistant_id).strip()
    if not key:
        return None
    registry = Path(repo_root) / DIR_WORKFLOW / CODEG_ASSISTANTS_FILE
    try:
        data = json.loads(registry.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    by_id = data.get("by_id")
    if not isinstance(by_id, dict):
        return None
    entry = by_id.get(key)
    if not isinstance(entry, dict):
        return None
    role = entry.get("role")
    if isinstance(role, str) and role.strip().lower() in ROLES:
        return role.strip().lower()
    return None


def hook_decision(repo_root: Path) -> str:
    """PreToolUse permission decision for an injected dispatch: allow | ask."""
    try:
        decision = get_dispatch_config(repo_root).get("hook_decision")
    except Exception:
        return "allow"
    return decision if decision in ("allow", "ask") else "allow"


# =============================================================================
# Context injection limits
# =============================================================================

DEFAULT_LIMITS: dict[str, int] = {
    "max_file_bytes": 32768,
    "max_artifact_bytes": 65536,
    "max_total_bytes": 131072,
}


def _get_limits(repo_root: str | Path) -> dict[str, int]:
    """Load context-injection byte limits from config.yaml, with safe fallback."""
    try:
        return get_context_injection_limits(Path(repo_root))
    except Exception:
        return dict(DEFAULT_LIMITS)


def truncate_utf8(data: bytes, cap: int) -> bytes:
    """Truncate ``data`` to at most ``cap`` bytes without splitting a UTF-8
    multi-byte sequence.

    ``cap <= 0`` means "no limit" — returns ``data`` unchanged.
    """
    if cap <= 0 or len(data) <= cap:
        return data

    truncated = data[:cap]
    i = len(truncated)
    # Back off over continuation bytes (10xxxxxx) to find the lead byte.
    while i > 0 and (truncated[i - 1] & 0xC0) == 0x80:
        i -= 1
    if i == 0:
        return b""

    lead = truncated[i - 1]
    if lead & 0x80:
        if (lead & 0xE0) == 0xC0:
            seq_len = 2
        elif (lead & 0xF0) == 0xE0:
            seq_len = 3
        elif (lead & 0xF8) == 0xF0:
            seq_len = 4
        else:
            seq_len = 1
        # Drop the lead byte too if its full sequence didn't fit.
        if (i - 1) + seq_len > len(truncated):
            i -= 1

    return truncated[:i]


class _Budget:
    """Tracks the running total of bytes emitted into the dispatched context.

    Also collects diagnostics (files degraded to index lines, manifest
    warnings) so callers can surface them without re-reading anything.
    """

    def __init__(self, max_total_bytes: int) -> None:
        self.max_total_bytes = max_total_bytes
        self.used = 0
        self.degraded: list[str] = []
        self.warnings: list[str] | None = None

    def has_room(self, size: int) -> bool:
        if self.max_total_bytes <= 0:
            return True
        return self.used + size <= self.max_total_bytes

    def add(self, size: int) -> None:
        self.used += size


def _real_path_contained(base_real: str, target_real: str) -> bool:
    """Whether an already-realpath'd target sits under an already-realpath'd base.

    ValueError on Windows when the two sit on different drives; that is
    outside the base by definition, so it fails closed.
    """
    try:
        return os.path.commonpath([base_real, target_real]) == base_real
    except ValueError:
        return False


def _read_file_bytes(base_path: str, file_path: str) -> bytes | None:
    """Read raw file bytes, return None if file doesn't exist."""
    full_path = os.path.join(base_path, file_path)
    try:
        root_real = os.path.realpath(base_path)
        # `.arbor` may itself be a symlink into a store outside the repo
        # (#567); its real location is a second legitimate containment base.
        workflow_real = os.path.realpath(os.path.join(base_path, DIR_WORKFLOW))
        full_real = os.path.realpath(full_path)
        if not _real_path_contained(root_real, full_real) and not (
            _real_path_contained(workflow_real, full_real)
        ):
            return None
    except OSError:
        return None
    if os.path.exists(full_path) and os.path.isfile(full_path):
        try:
            with open(full_path, "rb") as f:
                return f.read()
        except Exception:
            return None
    return None


def _truncate_notice(path: str, cap: int) -> str:
    return f"\n[Arbor: truncated at {cap} bytes — read {path} for the full content]"


def _is_binary_content(data: bytes) -> bool:
    """Return True when raw bytes should not be decoded into model context."""
    if b"\x00" in data:
        return True
    try:
        data.decode("utf-8", errors="strict")
    except UnicodeDecodeError:
        return True
    return False


def _binary_notice(path: str, size: int, reason: str) -> str:
    return (
        f"[Arbor: not inlined (binary file) — "
        f"{path} ({size} bytes): {reason}]"
    )


def _index_notice(path: str, size: int, reason: str) -> str:
    return (
        f"[Arbor: not inlined (total context limit reached) — "
        f"{path} ({size} bytes): {reason}]"
    )


def _budgeted_block(
    budget: _Budget,
    header: str,
    plain_path: str,
    content: str,
    reason: str,
    size_for_index: int,
) -> str:
    """Return an inlined ``=== header ===`` block, or degrade to an index
    notice once the total context budget is exhausted."""
    block = f"=== {header} ===\n{content}"
    block_bytes = len(block.encode("utf-8"))
    if not budget.has_room(block_bytes):
        notice = _index_notice(plain_path, size_for_index, reason)
        budget.add(len(notice.encode("utf-8")))
        budget.degraded.append(plain_path)
        return notice
    budget.add(block_bytes)
    return block


def _materialize_file(
    base_path: str,
    file_path: str,
    reason: str,
    limits: dict[str, int],
    budget: _Budget,
) -> str | None:
    """Read a JSONL-referenced file, apply the per-file cap, then budget it."""
    data = _read_file_bytes(base_path, file_path)
    if data is None:
        return None

    size = len(data)
    if _is_binary_content(data):
        notice = _binary_notice(file_path, size, reason)
        budget.add(len(notice.encode("utf-8")))
        return notice

    cap = limits["max_file_bytes"]
    truncated_bytes = truncate_utf8(data, cap)
    content = truncated_bytes.decode("utf-8", errors="replace")
    if len(truncated_bytes) < size:
        content += _truncate_notice(file_path, cap)

    return _budgeted_block(budget, file_path, file_path, content, reason, size)


def _materialize_directory(
    base_path: str,
    dir_path: str,
    reason: str,
    limits: dict[str, int],
    budget: _Budget,
    max_files: int = 20,
) -> list[str]:
    """Read all .md files in a directory, applying the same per-file and
    total caps as a single-file JSONL entry."""
    full_path = os.path.join(base_path, dir_path)
    if not os.path.exists(full_path) or not os.path.isdir(full_path):
        return []

    blocks: list[str] = []
    try:
        md_files = sorted(
            f
            for f in os.listdir(full_path)
            if f.endswith(".md") and os.path.isfile(os.path.join(full_path, f))
        )
        for filename in md_files[:max_files]:
            relative_path = os.path.join(dir_path, filename)
            block = _materialize_file(base_path, relative_path, reason, limits, budget)
            if block:
                blocks.append(block)
    except Exception:
        pass

    return blocks


def _warn(message: str, sink: list[str] | None) -> None:
    """Collect a warning when the caller provided a sink, else print it."""
    if sink is not None:
        sink.append(message)
    else:
        print(f"[arbor] WARN: {message}", file=sys.stderr)


def read_jsonl_entries(
    base_path: str,
    jsonl_path: str,
    warnings: list[str] | None = None,
) -> list[dict]:
    """
    Parse all file/directory entries referenced in a jsonl context file.

    Schema:
        {"file": "path/to/file.md", "reason": "..."}
        {"file": "path/to/dir/", "type": "directory", "reason": "..."}
        {"_example": "..."}          # legacy placeholder — skipped (no `file` field)

    Rows without a ``file`` field (e.g. the placeholder line older Arbor
    versions wrote at ``task.py create`` time) are skipped silently. A
    missing or entry-less manifest produces a warning — appended to
    ``warnings`` when given, printed to stderr otherwise.

    Returns:
        [{"file": path, "type": "file" | "directory", "reason": reason}, ...]
    """
    full_path = os.path.join(base_path, jsonl_path)
    if not os.path.exists(full_path):
        _warn(
            f"{jsonl_path} not found — dispatched role will receive only "
            f"task artifacts",
            warnings,
        )
        return []

    entries: list[dict] = []
    saw_real_entry = False
    try:
        with open(full_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    item = json.loads(line)
                    file_path = item.get("file") or item.get("path")

                    if not file_path:
                        # Seed / comment row — skip silently
                        continue

                    saw_real_entry = True
                    entries.append(
                        {
                            "file": file_path,
                            "type": item.get("type", "file"),
                            "reason": item.get("reason") or "-",
                        }
                    )
                except json.JSONDecodeError:
                    continue
    except Exception:
        pass

    if not saw_real_entry:
        _warn(
            f"{jsonl_path} has no curated entries (only seed / empty) — "
            f"dispatched role will receive only task artifacts. See "
            f"workflow.md planning artifact guidance.",
            warnings,
        )

    return entries


def _materialize_jsonl_entries(
    base_path: str, jsonl_path: str, limits: dict[str, int], budget: _Budget
) -> list[str]:
    """Materialize every entry in a jsonl context file into context blocks,
    applying per-file and total budget caps."""
    blocks: list[str] = []
    for entry in read_jsonl_entries(base_path, jsonl_path, budget.warnings):
        if entry["type"] == "directory":
            blocks.extend(
                _materialize_directory(
                    base_path, entry["file"], entry["reason"], limits, budget
                )
            )
        else:
            block = _materialize_file(
                base_path, entry["file"], entry["reason"], limits, budget
            )
            if block:
                blocks.append(block)
    return blocks


def get_agent_context(
    repo_root: str,
    task_dir: str,
    agent_type: str,
    limits: dict[str, int],
    budget: _Budget,
) -> str:
    """
    Get context from {agent_type}.jsonl for the specified role.
    Only reads implement.jsonl or check.jsonl (the two JSONL files the task system creates).
    """
    agent_jsonl = f"{task_dir}/{agent_type}.jsonl"
    blocks = _materialize_jsonl_entries(repo_root, agent_jsonl, limits, budget)
    if not blocks:
        # Zero curated context reaches the model silently otherwise — the
        # stderr WARN above never enters any session (#573). Put the fact in
        # the prompt itself so the dispatched role compensates instead of
        # assuming the spec context was complete.
        return (
            f"[Arbor] {agent_jsonl} has no curated entries, so no spec/research "
            "context was injected. Before working, read the guidelines relevant "
            "to the code you will touch under .arbor/spec/, and treat the task "
            "artifacts below as the only prepared context."
        )
    return "\n\n".join(blocks)


def _materialize_artifact(
    base_path: str,
    file_path: str,
    header_label: str,
    reason: str,
    limits: dict[str, int],
    budget: _Budget,
) -> str | None:
    """Read a task artifact (prd/design/implement.md), apply the per-artifact
    cap, then budget it."""
    data = _read_file_bytes(base_path, file_path)
    if data is None:
        return None

    size = len(data)
    cap = limits["max_artifact_bytes"]
    truncated_bytes = truncate_utf8(data, cap)
    content = truncated_bytes.decode("utf-8", errors="replace")
    if len(truncated_bytes) < size:
        content += _truncate_notice(file_path, cap)

    return _budgeted_block(budget, header_label, file_path, content, reason, size)


def _task_context(
    repo_root: str,
    task_dir: str,
    manifest: str,
    limits: dict[str, int],
    budget: _Budget,
) -> str:
    """Manifest entries followed by prd.md / design.md / implement.md."""
    context_parts = []

    base_context = get_agent_context(repo_root, task_dir, manifest, limits, budget)
    if base_context:
        context_parts.append(base_context)

    artifacts = (
        ("prd.md", "Requirements", "Requirements document"),
        ("design.md", "Technical Design", "Technical design document"),
        ("implement.md", "Execution Plan", "Execution plan document"),
    )
    for filename, label, reason in artifacts:
        block = _materialize_artifact(
            repo_root,
            f"{task_dir}/{filename}",
            f"{task_dir}/{filename} ({label})",
            reason,
            limits,
            budget,
        )
        if block:
            context_parts.append(block)

    return "\n\n".join(context_parts)


def get_implement_context(repo_root: str, task_dir: str) -> str:
    """
    Complete context for the implement role

    Read order:
    1. All files in implement.jsonl (spec/research manifests)
    2. prd.md (requirements)
    3. design.md if present (technical design)
    4. implement.md if present (execution plan)
    """
    limits = _get_limits(repo_root)
    return _task_context(
        str(repo_root), task_dir, "implement", limits, _Budget(limits["max_total_bytes"])
    )


def get_check_context(repo_root: str, task_dir: str) -> str:
    """
    Context for the check role: check.jsonl + task artifacts.
    """
    limits = _get_limits(repo_root)
    return _task_context(
        str(repo_root), task_dir, "check", limits, _Budget(limits["max_total_bytes"])
    )


def get_finish_context(repo_root: str, task_dir: str) -> str:
    """
    Context for the finish pass: reuses check.jsonl + prd.md
    (Finish is a final check, same context source.)
    """
    return get_check_context(repo_root, task_dir)


def get_research_context(repo_root: str, task_dir: str | None) -> str:
    """
    Context for the research role — project structure overview for spec directories.

    `task_dir` kept for signature parity with get_implement_context / get_check_context
    so the dispatcher can call them uniformly.
    """
    _ = task_dir
    context_parts = []

    # 1. Project structure overview (dynamically discover spec directories)
    spec_path = f"{DIR_WORKFLOW}/{DIR_SPEC}"
    spec_root = Path(repo_root) / DIR_WORKFLOW / DIR_SPEC

    # Build spec tree dynamically
    tree_lines = [f"{spec_path}/"]
    if spec_root.is_dir():
        pkg_dirs = sorted(d for d in spec_root.iterdir() if d.is_dir())
        for i, pkg_dir in enumerate(pkg_dirs):
            is_last = i == len(pkg_dirs) - 1
            prefix = "└── " if is_last else "├── "
            layers = sorted(d.name for d in pkg_dir.iterdir() if d.is_dir())
            layer_info = f" ({', '.join(layers)})" if layers else ""
            tree_lines.append(f"{prefix}{pkg_dir.name}/{layer_info}")

    spec_tree = "\n".join(tree_lines)

    project_structure = f"""## Project Spec Directory Structure

```
{spec_tree}
```

To get structured package info, run: `python3 ./{DIR_WORKFLOW}/scripts/get_context.py --mode packages`

## Search Tips

- Spec files: `{spec_path}/**/*.md`
- Code search: Use Glob and Grep tools
- Tech solutions: Use mcp__exa__web_search_exa or mcp__exa__get_code_context_exa"""

    context_parts.append(project_structure)

    return "\n\n".join(context_parts)


# =============================================================================
# Role prompt templates
# =============================================================================


def build_implement_prompt(original_prompt: str, context: str) -> str:
    """Build complete prompt for the implement role"""
    return f"""{MARKER}
# Implement Agent Task

You are the Implement Agent in an Arbor dispatch.

## Your Context

All the information you need has been prepared for you:

{context}

---

## Your Task

{original_prompt}

---

## Workflow

1. **Understand specs** - All dev specs are injected above, understand them
2. **Understand task artifacts** - Read requirements, technical design if present, and execution plan if present
3. **Implement feature** - Implement following specs and task artifacts
4. **Self-check** - Ensure code quality against check specs

## Important Constraints

- Do NOT execute git commit, only code modifications
- Follow all dev specs injected above
- Report list of modified/created files when done"""


def build_check_prompt(original_prompt: str, context: str) -> str:
    """Build complete prompt for the check role"""
    return f"""{MARKER}
# Check Agent Task

You are the Check Agent in an Arbor dispatch (code and cross-layer checker).

## Your Context

All check specs and dev specs you need:

{context}

---

## Your Task

{original_prompt}

---

## Workflow

1. **Get changes** - Run `git diff --name-only` and `git diff` to get code changes
2. **Check against specs** - Check item by item against specs above
3. **Self-fix** - Fix issues directly, don't just report
4. **Run verification** - Run project's lint and typecheck commands

## Important Constraints

- Fix issues yourself, don't just report
- Must execute complete checklist in check specs
- Pay special attention to impact radius analysis (L1-L5)"""


def build_finish_prompt(original_prompt: str, context: str) -> str:
    """Build complete prompt for the finish pass (final check before PR)"""
    return f"""{MARKER}
# Finish Agent Task

You are performing the final check before creating a PR.

## Your Context

Finish checklist and requirements:

{context}

---

## Your Task

{original_prompt}

---

## Workflow

1. **Review changes** - Run `git diff --name-only` to see all changed files
2. **Verify task artifacts** - Check requirements in prd.md and, when present, design.md / implement.md
3. **Spec sync** - Analyze whether changes introduce new patterns, contracts, or conventions
   - If new pattern/convention found: read target spec file → update it → update index.md if needed
   - If infra/cross-layer change: follow the 7-section mandatory template from update-spec.md
   - If pure code fix with no new patterns: skip this step
4. **Run final checks** - Execute lint and typecheck
5. **Confirm ready** - Ensure code is ready for PR

## Important Constraints

- You MAY update spec files when gaps are detected (use update-spec.md as guide)
- MUST read the target spec file BEFORE editing (avoid duplicating existing content)
- Do NOT update specs for trivial changes (typos, formatting, obvious fixes)
- If critical CODE issues found, report them clearly (fix specs, not code)
- Verify all acceptance criteria in prd.md are met
- Verify design.md and implement.md constraints when those files are present"""


def build_research_prompt(original_prompt: str, context: str) -> str:
    """Build complete prompt for the research role"""
    return f"""{MARKER}
# Research Agent Task

You are the Research Agent in an Arbor dispatch (search researcher).

## Core Principle

**You do one thing: find and explain information.**

You are a documenter, not a reviewer.

## Project Info

{context}

---

## Your Task

{original_prompt}

---

## Workflow

1. **Understand query** - Determine search type (internal/external) and scope
2. **Plan search** - List search steps for complex queries
3. **Execute search** - Execute multiple independent searches in parallel
4. **Organize results** - Output structured report

## Search Tools

| Tool | Purpose |
|------|---------|
| Glob | Search by filename pattern |
| Grep | Search by content |
| Read | Read file content |
| mcp__exa__web_search_exa | External web search |
| mcp__exa__get_code_context_exa | External code/doc search |

## Strict Boundaries

**Only allowed**: Describe what exists, where it is, how it works

**Forbidden** (unless explicitly asked):
- Suggest improvements
- Criticize implementation
- Recommend refactoring
- Modify any files

## Report Format

Provide structured search results including:
- List of files found (with paths)
- Code pattern analysis (if applicable)
- Related spec documents
- External references (if any)"""


# =============================================================================
# Assembler
# =============================================================================


def _repo_relative(repo_root: Path, task_dir: Path) -> str:
    """Repo-relative posix form of a task dir, used in context block labels."""
    try:
        return task_dir.relative_to(repo_root).as_posix()
    except ValueError:
        pass
    try:
        return task_dir.relative_to(repo_root.resolve()).as_posix()
    except (OSError, ValueError):
        return str(task_dir)


def _header_block(req: DispatchRequest, finish: bool) -> str:
    lines = []
    if req.task_dir is not None:
        lines.append(f"Active task: {req.task_dir}")
    lines.append(f"Role: {req.role} {FINISH_TAG}" if finish else f"Role: {req.role}")
    if req.header.target:
        lines.append(f"Target: {req.header.target}")
    if req.header.workspace:
        lines.append(f"Workspace: {req.header.workspace}")
    return "\n".join(lines)


def build_dispatch_prompt(req: DispatchRequest) -> DispatchPrompt:
    """Assemble the final task text for one dispatched role.

    text = normalised header block (``Active task:`` always the absolute task
    directory; Target / Workspace kept as given) + blank line + role template
    (starts with MARKER, carries the injected context and ``## Your Task`` =
    header body).
    """
    if req.role not in ROLES:
        raise ValueError(f"unknown dispatch role: {req.role!r}")
    if req.role in ROLES_REQUIRE_TASK and req.task_dir is None:
        raise ValueError(f"role {req.role!r} requires a task directory")

    repo_root = Path(req.repo_root)
    root_str = str(repo_root)
    task_rel = _repo_relative(repo_root, req.task_dir) if req.task_dir else None
    finish = req.role == "check" and req.header.finish

    limits = _get_limits(repo_root)
    budget = _Budget(limits["max_total_bytes"])
    budget.warnings = []

    if req.role == "research":
        context = get_research_context(root_str, task_rel)
        body = build_research_prompt(req.header.body, context)
    else:
        assert task_rel is not None  # guarded above
        manifest = "implement" if req.role == "implement" else "check"
        context = _task_context(root_str, task_rel, manifest, limits, budget)
        if req.role == "implement":
            body = build_implement_prompt(req.header.body, context)
        elif finish:
            body = build_finish_prompt(req.header.body, context)
        else:
            body = build_check_prompt(req.header.body, context)

    warnings = list(budget.warnings)
    if budget.degraded:
        warnings.append(
            "context budget reached; referenced as index lines only: "
            + ", ".join(budget.degraded)
        )

    return DispatchPrompt(
        text=f"{_header_block(req, finish)}\n\n{body}",
        context_bytes=len(context.encode("utf-8")),
        degraded=tuple(budget.degraded),
        warnings=tuple(warnings),
    )
