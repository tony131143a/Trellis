#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Arbor dispatch context assembler.

Single source of truth for the prompt a dispatched Arbor role (explore,
architect, test, implement, review, verify, fix, simplify) receives. Both
``arbor.py run`` and ``arbor.py prompt`` build the final task text through
``build_dispatch_prompt`` so the two cannot drift.

Header protocol (written by the main agent at the top of the task text):

    Active task: /abs/repo-wt/10-24-foo/.arbor/tasks/10-24-foo
    Role: review               # one of PROMPT_ROLES
    Mode: candidates           # review only: self-check | candidates | sweep | plan
    Range: <base>..<head>      # optional; not for explore / architect
    Dispatch: d-003            # optional; the id writers put in their commit trailer

Context sources per role:
- explore: spec directory overview; with a task, contract.md + research file list
- architect: implement.jsonl entries -> task artifacts -> research/*.md
- test / implement: implement.jsonl entries -> contract.md -> design.md -> waves.md
- review / verify / fix / simplify: check.jsonl entries -> the same task
  artifacts
- every role given ``Range:``: ``git diff <range>`` run in the worktree that
  holds the task directory

The role's method, limits and report format are loaded from its role instructions
(``.arbor/agents/<role>.md``); the dispatch prompt only carries context, the
review mode and the brief.

Byte limits come from ``config.get_context_injection_limits()``.
"""

from __future__ import annotations

import json
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path

from .active_task import resolve_active_task
from .config import get_context_injection_limits
from .contract import CONTRACT_FILE, find_contract
from .git import run_git
from .paths import DIR_SPEC, DIR_WORKFLOW, get_tasks_dir, resolve_task_ref
from .tasks import WAVES_FILE, find_artifact


# Every role a dispatch prompt can be built for.
PROMPT_ROLES = (
    "explore", "architect", "test", "implement", "review", "verify", "fix", "simplify",
)
ROLES_REQUIRE_TASK = tuple(role for role in PROMPT_ROLES if role != "explore")
# Roles that take a ``Range:`` header (everything that writes or reads a diff).
RANGE_ROLES = tuple(role for role in ROLES_REQUIRE_TASK if role != "architect")
# Which task manifest feeds each task-bound role.
ROLE_MANIFEST = {
    "architect": "implement",
    "test": "implement",
    "implement": "implement",
    "review": "check",
    "verify": "check",
    "fix": "check",
    "simplify": "check",
}
REVIEW_MODES = ("self-check", "candidates", "sweep", "plan")
DEFAULT_REVIEW_MODE = "self-check"
REVIEW_MODE_NOTES = {
    "self-check": (
        "dedup, then re-check every candidate against the code and keep only "
        "the ones you can defend; your list goes straight to the fix role."
    ),
    "candidates": (
        "pass every candidate with a nameable failure scenario through; do not "
        "filter on doubt. An independent verify role filters afterwards."
    ),
    "sweep": (
        "the brief carries an already-verified list; report only defects that "
        "are not on it (up to 8), or an empty list."
    ),
    "plan": (
        "review the planning artifacts, not code: work backward from the goal "
        "to what must be true, which criterion covers it, and whether it is "
        "wired; report gaps as findings against contract.md / design.md."
    ),
}
HEADER_KEYS = ("active task", "role", "mode", "range", "dispatch")
MARKER = "<!-- arbor-hook-injected -->"

_HEADER_RE = re.compile(
    r"^\s*(active task|role|mode|range|dispatch)\s*:\s*(.*?)\s*$",
    re.IGNORECASE,
)
# ``<base>..<head>`` / ``<base>...<head>``; no leading dash, so never a git option.
_RANGE_RE = re.compile(r"^[^\s-]\S*\.\.\S*$")


# =============================================================================
# Header protocol
# =============================================================================


@dataclass(frozen=True)
class DispatchHeader:
    """Leading ``Key: value`` lines of a dispatch task text."""

    task_dir: str | None
    role: str | None
    mode: str | None
    body: str
    range: str | None = None
    dispatch: str | None = None


@dataclass(frozen=True)
class DispatchRequest:
    """Everything ``build_dispatch_prompt`` needs to assemble one prompt."""

    repo_root: Path
    role: str
    task_dir: Path | None
    header: DispatchHeader
    original_text: str
    execution_root: Path | None = None


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
    Role and mode are lower-cased; the first word of ``Role:`` is the role.
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

    tokens = values.get("role", "").lower().split()
    mode = values.get("mode", "").strip().lower()

    return DispatchHeader(
        task_dir=values.get("active task") or None,
        role=tokens[0] if tokens else None,
        mode=mode or None,
        body=body,
        range=values.get("range") or None,
        dispatch=values.get("dispatch") or None,
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
        if not _inside_tasks_dir(repo_root, resolved):
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


def _inside_tasks_dir(repo_root: Path, resolved: Path) -> bool:
    """True when `resolved` is a directory strictly below `.arbor/tasks/`.

    `resolve_task_ref` only guarantees containment in the repo; a dispatch
    header must point at a task directory (active or archived), never at the
    repo root or an arbitrary source folder, or the hook would inline whatever
    `contract.md` / `*.jsonl` happen to live there.
    """
    try:
        tasks_root = get_tasks_dir(repo_root).resolve()
        resolved.relative_to(tasks_root)
    except (OSError, ValueError):
        return False
    return resolved != tasks_root


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
    warnings) so callers can surface them without re-reading anything, and
    the paths already materialized so a file reached twice (a manifest row
    and the architect's research directory, say) is inlined and charged once.
    """

    def __init__(self, max_total_bytes: int) -> None:
        self.max_total_bytes = max_total_bytes
        self.used = 0
        self.degraded: list[str] = []
        self.warnings: list[str] | None = None
        self.seen: set[str] = set()

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
) -> str | None:
    """Return an inlined ``=== header ===`` block, or degrade to an index
    notice once the total context budget is exhausted. None when this prompt
    already materialized ``plain_path`` (first occurrence wins)."""
    key = os.path.normpath(plain_path)
    if key in budget.seen:
        return None
    budget.seen.add(key)
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
    """Read a task artifact (contract/design/waves.md), apply the per-artifact
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
    """Manifest entries followed by contract.md / design.md / waves.md."""
    context_parts = []

    base_context = get_agent_context(repo_root, task_dir, manifest, limits, budget)
    if base_context:
        context_parts.append(base_context)

    task_path = Path(repo_root) / task_dir
    artifacts = (
        (find_contract(task_path), CONTRACT_FILE, "Contract", "Acceptance contract"),
        (find_artifact(task_path, "design.md"), "design.md", "Technical Design",
         "Technical design document"),
        (find_artifact(task_path, WAVES_FILE), WAVES_FILE, "Waves", "Execution plan document"),
    )
    for found, name, label, reason in artifacts:
        if found is None:
            continue
        block = _materialize_artifact(
            repo_root,
            f"{task_dir}/{found.name}",
            f"{task_dir}/{name} ({label})",
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
    2. contract.md (legacy prd.md)
    3. design.md if present (technical design)
    4. waves.md (legacy implement.md) if present (execution plan)
    """
    limits = _get_limits(repo_root)
    return _task_context(
        str(repo_root), task_dir, "implement", limits, _Budget(limits["max_total_bytes"])
    )


def get_explore_context(
    repo_root: str,
    task_dir: str | None,
    limits: dict[str, int] | None = None,
    budget: _Budget | None = None,
) -> str:
    """
    Context for the explore role: the spec directory overview, plus, with a
    task, its contract.md and the names of research files already written.
    """
    context_parts = []

    spec_path = f"{DIR_WORKFLOW}/{DIR_SPEC}"
    spec_root = Path(repo_root) / DIR_WORKFLOW / DIR_SPEC

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

    context_parts.append(f"""## Project Spec Directory Structure

```
{spec_tree}
```

To get structured package info, run: `python3 ./{DIR_WORKFLOW}/scripts/get_context.py --mode packages`

## Search Tips

- Spec files: `{spec_path}/**/*.md`
- Code: `rg --files | rg <pattern>`, `rg -n <regex>`
- External sources: fetch the real repository or docs into `/tmp/research-<topic>/`""")

    if task_dir:
        if limits is None:
            limits = _get_limits(repo_root)
        if budget is None:
            budget = _Budget(limits["max_total_bytes"])
        contract = find_contract(Path(repo_root) / task_dir)
        if contract is not None:
            block = _materialize_artifact(
                repo_root,
                f"{task_dir}/{contract.name}",
                f"{task_dir}/{CONTRACT_FILE} (Contract)",
                "Acceptance contract",
                limits,
                budget,
            )
            if block:
                context_parts.append(block)
        research_dir = Path(repo_root) / task_dir / "research"
        names = (
            sorted(f.name for f in research_dir.iterdir() if f.suffix == ".md")
            if research_dir.is_dir()
            else []
        )
        listing = "\n".join(f"- {task_dir}/research/{n}" for n in names) or "- none yet"
        context_parts.append(f"## Existing research files\n\n{listing}")

    return "\n\n".join(context_parts)


def _task_worktree(task_dir: Path, fallback: Path) -> Path:
    """The checkout holding ``<checkout>/.arbor/tasks/.../<task>``: the parent of
    the nearest ``.arbor`` ancestor, else ``fallback``."""
    for parent in task_dir.parents:
        if parent.name == DIR_WORKFLOW:
            return parent.parent
    return fallback


def _range_diff_block(
    worktree: Path, range_spec: str, limits: dict[str, int], budget: _Budget
) -> str | None:
    """Inline ``git diff <range>`` from ``worktree`` (per-artifact cap).

    ``.arbor/`` is left out: task artifacts are inlined separately, and the
    committed ``briefs/`` would otherwise carry earlier diffs into this one.
    """
    command = f"git diff {range_spec}"
    rc, out, err = run_git(
        ["diff", "--no-color", "--no-ext-diff", range_spec,
         "--", ".", f":(exclude){DIR_WORKFLOW}"],
        cwd=worktree,
    )
    if rc != 0:
        reason = (err.strip().splitlines() or [f"exit {rc}"])[0]
        return (
            f"[Arbor: diff not inlined — `{command}` failed in {worktree}: {reason}; "
            "compute the scope yourself]"
        )
    if not out.strip():
        return f"[Arbor: `{command}` is empty in {worktree}]"
    data = out.encode("utf-8")
    size = len(data)
    cap = limits["max_artifact_bytes"]
    truncated_bytes = truncate_utf8(data, cap)
    content = truncated_bytes.decode("utf-8", errors="replace")
    if len(truncated_bytes) < size:
        content += (
            f"\n[Arbor: truncated at {cap} bytes — run `{command}` in {worktree} "
            "for the full diff]"
        )
    return _budgeted_block(
        budget, command, command, f"```diff\n{content}\n```", "Review scope", size
    )


# =============================================================================
# Role prompt templates
# =============================================================================


def build_role_prompt(
    role: str, original_prompt: str, context: str, mode: str | None = None
) -> str:
    """Build the dispatch prompt for one role.

    Deliberately thin: the role's method, limits and report format are its
    role instructions, so they are not repeated here.
    """
    mode_section = (
        f"\n\n## Mode\n\n`{mode}`: {REVIEW_MODE_NOTES[mode]}" if mode else ""
    )
    return f"""{MARKER}
# Arbor `{role}` dispatch

You are the dispatched `{role}` role. Your assistant instructions define your method, limits and report format; this message carries the prepared context and the brief.

## Your Context

{context}{mode_section}

---

## Your Task

{original_prompt}"""


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


def _header_block(req: DispatchRequest, mode: str | None) -> str:
    lines = []
    if req.task_dir is not None:
        lines.append(f"Active task: {req.task_dir}")
    lines.append(f"Role: {req.role}")
    if mode:
        lines.append(f"Mode: {mode}")
    if req.header.range:
        lines.append(f"Range: {req.header.range}")
    if req.header.dispatch:
        lines.append(f"Dispatch: {req.header.dispatch}")
    return "\n".join(lines)


def build_dispatch_prompt(req: DispatchRequest) -> DispatchPrompt:
    """Assemble the final task text for one dispatched role.

    text = normalised header block (``Active task:`` always the absolute task
    directory; ``Mode:`` resolved for review; Range / Dispatch kept as given)
    + blank line + role template (starts with MARKER,
    carries the injected context and ``## Your Task`` = header body).
    """
    if req.role not in PROMPT_ROLES:
        raise ValueError(f"unknown dispatch role: {req.role!r}")
    if req.role in ROLES_REQUIRE_TASK and req.task_dir is None:
        raise ValueError(f"role {req.role!r} requires a task directory")
    mode = req.header.mode
    if req.role == "review":
        mode = mode or DEFAULT_REVIEW_MODE
        if mode not in REVIEW_MODES:
            raise ValueError(
                f"unknown review mode: {mode!r} (expected {' | '.join(REVIEW_MODES)})"
            )
    elif mode:
        raise ValueError(f"Mode: only applies to role 'review', not {req.role!r}")
    range_spec = req.header.range
    if range_spec and req.role not in RANGE_ROLES:
        raise ValueError(f"Range: does not apply to role {req.role!r}")
    if range_spec and not _RANGE_RE.match(range_spec):
        raise ValueError(f"Range: expected <base>..<head>, got {range_spec!r}")

    repo_root = Path(req.repo_root)
    root_str = str(repo_root)
    task_rel = _repo_relative(repo_root, req.task_dir) if req.task_dir else None

    limits = _get_limits(repo_root)
    budget = _Budget(limits["max_total_bytes"])
    budget.warnings = []

    if req.role == "explore":
        context = get_explore_context(root_str, task_rel, limits, budget)
    else:
        assert task_rel is not None  # guarded above
        context = _task_context(root_str, task_rel, ROLE_MANIFEST[req.role], limits, budget)
        extra: list[str] = []
        if req.role == "architect":
            extra = _materialize_directory(
                root_str, f"{task_rel}/research", "Task research", limits, budget
            )
        if range_spec:
            assert req.task_dir is not None
            worktree = req.execution_root or _task_worktree(Path(req.task_dir), repo_root)
            diff_block = _range_diff_block(worktree, range_spec, limits, budget)
            if diff_block:
                extra.append(diff_block)
        if extra:
            context = "\n\n".join([context, *extra])
    role_file = repo_root / DIR_WORKFLOW / "agents" / f"{req.role}.md"
    try:
        instructions = role_file.read_text(encoding="utf-8").strip()
    except OSError:
        instructions = ""
    if not instructions:
        instructions = (
            f"Read `{role_file}` for your role instructions before proceeding. "
            "If unavailable, report Blocked; do not perform the role without its instructions."
        )
    body = build_role_prompt(req.role, req.header.body, context, mode)
    body = f"## Role Instructions\n\n{instructions}\n\n{body}"

    warnings = list(budget.warnings)
    if budget.degraded:
        warnings.append(
            "context budget reached; referenced as index lines only: "
            + ", ".join(budget.degraded)
        )

    return DispatchPrompt(
        text=f"{_header_block(req, mode)}\n\n{body}",
        context_bytes=len(context.encode("utf-8")),
        degraded=tuple(budget.degraded),
        warnings=tuple(warnings),
    )
