#!/usr/bin/env python3
"""Arbor per-turn breadcrumb hook (UserPromptSubmit / BeforeAgent equivalent).

Runs on every user prompt. Resolves the active task through Arbor's
session-aware active task resolver and emits a short <workflow-state>
block reminding the main AI what task is active and what comes next.

With an active task, the body is the driver's own next step: the hook runs
``.arbor/scripts/arbor.py next --json`` and injects only its one-line
``summary`` (plus ``needs``). The driver owns the task state, so the
breadcrumb cannot drift from it. When the driver is missing, fails, times
out, or prints something unusable, the hook falls back silently to the
status breadcrumb below.

The emitted ``hookEventName`` is ``UserPromptSubmit`` (Claude Code naming,
shared by the StarFactory fork).
Fallback breadcrumb text (and the no-task text) is pulled exclusively from
workflow.md [workflow-state:STATUS] tag blocks — workflow.md is the single source of
truth. There are no fallback dicts in this script: when workflow.md is
missing or a tag is absent, the breadcrumb degrades to a generic
"Refer to workflow.md for current step." line so users see (and fix)
the broken state instead of the hook silently masking it.

Which platforms register this hook is decided by SHARED_HOOKS_BY_PLATFORM
in templates/shared-hooks/index.ts. That table is the source of truth; each
listed platform's collect<Platform>Templates() pulls this file into its
template map through collectSharedHooks(), and a single writer puts that
map on disk at init time.

Silent exit 0 case (no output):
  - No .arbor/ directory found (not a Arbor project)

When a session points at a task directory whose task.json is missing, malformed,
or missing a usable status, the hook emits a task_error breadcrumb instead of
misreporting the session as having no active task.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import queue
import threading
from pathlib import Path

# Force UTF-8 on stdin/stdout/stderr on Windows. Default codepage there is
# cp936 / cp1252 / etc. — non-ASCII content (Chinese task names, contract snippets)
# both in stdin (hook payload from host CLI) and stdout (our emitted blocks)
# raises UnicodeDecodeError / UnicodeEncodeError. Equivalent to `python -X utf8`
# but applied per-stream so we don't depend on host CLI's command wiring.
if sys.platform.startswith("win"):
    import io as _io
    for _stream_name in ("stdin", "stdout", "stderr"):
        _stream = getattr(sys, _stream_name, None)
        if _stream is None:
            continue
        if hasattr(_stream, "reconfigure"):
            try:
                _stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
            except Exception:
                pass  # Optional Windows stream setup; keep hook startup non-fatal.
        elif hasattr(_stream, "detach"):
            try:
                setattr(sys, _stream_name, _io.TextIOWrapper(_stream.detach(), encoding="utf-8", errors="replace"))
            except Exception:
                pass  # Optional Windows stream setup; keep hook startup non-fatal.
from typing import Optional


# ---------------------------------------------------------------------------
# CWD-robust Arbor root discovery (fixes hook-path-robustness for this hook)
# ---------------------------------------------------------------------------

def find_arbor_root(start: Path) -> Optional[Path]:
    """Walk up from start to find directory containing .arbor/.

    Handles CWD drift: subdirectory launches, monorepo packages, etc.
    Returns None if no .arbor/ found (silent no-op).
    """
    cur = start.resolve()
    while cur != cur.parent:
        if (cur / ".arbor").is_dir():
            return cur
        cur = cur.parent
    return None


# ---------------------------------------------------------------------------
# Active task discovery
# ---------------------------------------------------------------------------

def _detect_platform(input_data: dict) -> str | None:
    # StarFactory is a Claude Code fork: it exports CLAUDE_PROJECT_DIR too, so
    # its own vendor key must be checked FIRST or a star session is detected as
    # claude and the context key becomes `claude_<session-id>`. That key does
    # not match the session file `task.py start` wrote under the host's real
    # name, so every turn reports no_task while the pointer exists on disk.
    env_map = {
        "STARFACTORY_PROJECT_DIR": "star",
        # Last: the shared alias, only meaningful once no vendor key matched.
        "CLAUDE_PROJECT_DIR": "claude",
    }
    for env_name, platform in env_map.items():
        if os.environ.get(env_name):
            return platform
    script_parts = set(Path(sys.argv[0]).parts)
    if ".claude" in script_parts:
        return "claude"
    if ".starFactory" in script_parts:
        return "star"
    return None


def _resolve_active_task(root: Path, input_data: dict):
    scripts_dir = root / ".arbor" / "scripts"
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))
    from common.active_task import resolve_active_task  # type: ignore[import-not-found]

    return resolve_active_task(root, input_data, platform=_detect_platform(input_data))


def _tier_label(task_dir: Path, data: dict) -> str:
    """``"<tier>"`` when ``meta.tier`` pins it, else ``"<tier> (inferred)"``.

    Uses the same ``common.tasks`` helpers as ``task.py start`` and
    session-start, so the breadcrumb cannot disagree with the start gate.
    ``_resolve_active_task`` has already put ``.arbor/scripts`` on sys.path.
    """
    from common.tasks import explicit_tier, resolve_tier  # type: ignore[import-not-found]

    tier = resolve_tier(task_dir, data)
    return tier if explicit_tier(data) is not None else f"{tier} (inferred)"


def get_active_task(
    root: Path, input_data: dict
) -> tuple[str, str, str, dict, str | None] | None:
    """Return active task data, a task-record error, or no task pointer.

    ``(task_id, status, source, meta, tier)``; ``meta`` is task.json ``meta``
    (empty when absent or unreadable) and ``tier`` is the label from
    :func:`_tier_label`. ``(task_id, "task_error", source, {}, None)`` is
    distinct from ``None``: a session pointer can exist even when its task
    record is missing or unreadable, and that state needs a diagnostic
    breadcrumb rather than the normal ``no_task`` prompt. ``task_error`` and
    ``stale_*`` carry no tier.
    """
    active = _resolve_active_task(root, input_data)
    if not active.task_path:
        return None

    task_dir = Path(active.task_path)
    if not task_dir.is_absolute():
        task_dir = root / task_dir
    if active.stale:
        return task_dir.name, f"stale_{active.source_type}", active.source, {}, None

    task_json = task_dir / "task.json"
    if not task_json.is_file():
        return task_dir.name, "task_error", active.source, {}, None
    try:
        data = json.loads(task_json.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return task_dir.name, "task_error", active.source, {}, None
    if not isinstance(data, dict):
        return task_dir.name, "task_error", active.source, {}, None

    task_id = data.get("id") or task_dir.name
    status = data.get("status", "")
    if not isinstance(status, str) or not status:
        return task_dir.name, "task_error", active.source, {}, None
    meta = data.get("meta")
    return (
        task_id,
        status,
        active.source,
        meta if isinstance(meta, dict) else {},
        _tier_label(task_dir, data),
    )


# ---------------------------------------------------------------------------
# Driver summary: `arbor.py next --json`
# ---------------------------------------------------------------------------

# Well inside the 15 s hook timeout; `next` only reads task state.
ARBOR_NEXT_TIMEOUT_S = 8


def _context_key(root: Path, input_data: dict) -> str | None:
    """Session context key for the driver subprocess (``ARBOR_CONTEXT_ID``)."""
    try:
        from common.active_task import resolve_context_key  # type: ignore[import-not-found]

        return resolve_context_key(input_data, _detect_platform(input_data))
    except Exception:
        return None


def arbor_next(root: Path, input_data: dict) -> dict | None:
    """Parsed ``arbor.py next --json`` output, or None when unavailable.

    The driver resolves the active task the same way ``task.py`` does, so the
    hook passes this session's context key through ``ARBOR_CONTEXT_ID``.
    Only ``summary`` and ``needs`` are relied on; anything else is optional.
    """
    script = root / ".arbor" / "scripts" / "arbor.py"
    if not script.is_file():
        return None
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    context_key = _context_key(root, input_data)
    if context_key:
        env["ARBOR_CONTEXT_ID"] = context_key
    try:
        result = subprocess.run(
            [sys.executable, "-W", "ignore", str(script), "next", "--json"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=ARBOR_NEXT_TIMEOUT_S,
            cwd=str(root),
            env=env,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    try:
        data = json.loads(result.stdout)
    except ValueError:
        return None
    if not isinstance(data, dict):
        return None
    if data.get("started") is False:
        # Not started yet: the workflow.md planning breadcrumb says more than
        # the driver's "approve the contract" line.
        return None
    summary = data.get("summary")
    needs = data.get("needs")
    if not isinstance(summary, str) or not summary.strip():
        return None
    if not isinstance(needs, str) or not needs.strip():
        return None
    return data


def build_driver_breadcrumb(task_id: str, status: str, tier: str | None, next_step: dict) -> str:
    """``<workflow-state>`` block carrying the driver's one-line next step."""
    header = f"Task: {task_id} ({status})"
    if tier:
        header += f" · Tier: {tier}"
    summary = " ".join(str(next_step["summary"]).split())
    needs = str(next_step["needs"]).strip()
    return f"<workflow-state>\n{header}\nNext (needs={needs}): {summary}\n</workflow-state>"


# ---------------------------------------------------------------------------
# Breadcrumb loading: parse workflow.md, fall back to hardcoded defaults
# ---------------------------------------------------------------------------

# Supports STATUS values with letters, digits, underscores, hyphens
# (so "in-review" / "blocked-by-team" work alongside "in_progress").
_TAG_RE = re.compile(
    r"\[workflow-state:([A-Za-z0-9_-]+)\]\s*\n(.*?)\n\s*\[/workflow-state:\1\]",
    re.DOTALL,
)

def load_breadcrumbs(root: Path) -> dict[str, str]:
    """Parse workflow.md for [workflow-state:STATUS] blocks.

    Returns {status: body_text}. workflow.md is the single source of
    truth — there are no fallback dicts in this script. Missing tags
    (or a missing/unreadable workflow.md) fall back to a generic line
    in build_breadcrumb so users see the broken state and fix
    workflow.md, rather than the hook silently masking the issue.
    """
    workflow = root / ".arbor" / "workflow.md"
    if not workflow.is_file():
        return {}
    try:
        content = workflow.read_text(encoding="utf-8")
    except OSError:
        return {}

    result: dict[str, str] = {}
    for match in _TAG_RE.finditer(content):
        status = match.group(1)
        body = match.group(2).strip()
        if body:
            result[status] = body
    return result


def _read_arbor_config(root: Path) -> dict:
    """Load .arbor/config.yaml via the bundled arbor_config helper.

    The helper lives in .arbor/scripts/common; the hook lives outside the
    scripts tree, so we extend sys.path before importing.
    """
    scripts_dir = root / ".arbor" / "scripts"
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))
    try:
        from common.arbor_config import read_arbor_config  # type: ignore[import-not-found]
    except Exception:
        return {}
    try:
        return read_arbor_config(root)
    except Exception:
        return {}


DEFAULT_PROMPT_INJECTION_SKIP_KEYWORD = "no-arbor"


def _resolve_skip_keyword(config: dict) -> str:
    """Read `prompt_injection.skip_keyword` from parsed .arbor/config.yaml.

    Mirrors `common.config.get_prompt_injection_config()`. Defaults to
    "no-arbor"; "" disables the escape hatch entirely. A non-string value
    falls back to the default.
    """
    if isinstance(config, dict):
        section = config.get("prompt_injection")
        if isinstance(section, dict):
            raw = section.get("skip_keyword", DEFAULT_PROMPT_INJECTION_SKIP_KEYWORD)
            if isinstance(raw, str):
                return raw
    return DEFAULT_PROMPT_INJECTION_SKIP_KEYWORD


def prompt_has_skip_keyword(prompt: str, keyword: str) -> bool:
    """Case-insensitive, word-boundary match of `keyword` in `prompt`.

    Hyphen counts as a word char so "no-arborx" / "xno-arbor" /
    "foo-no-arbor" don't match, but punctuation/whitespace boundaries do.
    Empty keyword never matches (disables the escape hatch).
    """
    if not keyword or not isinstance(prompt, str):
        return False
    pattern = r"(?<![\w-])" + re.escape(keyword) + r"(?![\w-])"
    return re.search(pattern, prompt, re.IGNORECASE) is not None


def resolve_breadcrumb_key(
    status: str,
    task_meta: dict | None,
    templates: dict[str, str],
    tier: str | None = None,
) -> str:
    """Pick the workflow.md breadcrumb block for a task.

    The first key workflow.md has wins:

    1. ``<status>-parallel`` — only for tier ``full`` with
       ``meta.execution == "parallel"`` (``task.py start`` refuses parallel
       below full);
    2. ``<status>-<tier>``;
    3. ``<status>``.

    ``tier`` is the header label; a `` (inferred)`` suffix is ignored here.
    Custom statuses walk the same chain.
    """
    tier_name = tier.split(" ", 1)[0] if isinstance(tier, str) and tier else None
    candidates: list[str] = []
    execution = task_meta.get("execution") if isinstance(task_meta, dict) else None
    if (
        tier_name == "full"
        and isinstance(execution, str)
        and execution.strip().lower() == "parallel"
    ):
        candidates.append(f"{status}-parallel")
    if tier_name:
        candidates.append(f"{status}-{tier_name}")
    for key in candidates:
        if key in templates:
            return key
    return status


def build_breadcrumb(
    task_id: Optional[str],
    status: str,
    templates: dict[str, str],
    source: str | None = None,
    breadcrumb_key: str | None = None,
    tier: str | None = None,
) -> str:
    """Build the <workflow-state>...</workflow-state> block.

    - Known status (tag present in workflow.md) → detailed template body
    - Unknown status (no tag, or workflow.md missing) → generic
      "Refer to workflow.md for current step." line
    - `no_task` pseudo-status (task_id is None) → header omits task info
    - ``breadcrumb_key`` selects a variant block (``<status>-<tier>`` or
      ``<status>-parallel``); the header still reports the task's real status
    - ``tier`` is appended after the status parentheses
      (``Task: <id> (<status>) · Tier: <tier>``); ``task_error`` passes None
    """
    body = templates.get(breadcrumb_key or status)
    if body is None:
        body = "Refer to workflow.md for current step."
    header = f"Status: {status}" if task_id is None else f"Task: {task_id} ({status})"
    if task_id is not None and tier:
        header += f" · Tier: {tier}"
    return f"<workflow-state>\n{header}\n{body}\n</workflow-state>"


# ---------------------------------------------------------------------------
# Entry
# ---------------------------------------------------------------------------

def _load_hook_input() -> dict:
    """Read hook JSON without trusting host runners to close stdin.

    Some hook runners can leave stdin open while sending no payload. A plain
    `json.load(sys.stdin)` then blocks forever. Normal hook runners write the
    complete JSON payload and close stdin, so the short daemon read preserves
    that path while failing closed to `{}` for non-piping hosts.
    """
    result_queue: "queue.Queue[str | Exception]" = queue.Queue(maxsize=1)

    def _read() -> None:
        try:
            result_queue.put(sys.stdin.read())
        except Exception as exc:
            result_queue.put(exc)

    reader = threading.Thread(target=_read, daemon=True)
    reader.start()
    try:
        raw = result_queue.get(timeout=0.2)
    except queue.Empty:
        return {}

    if isinstance(raw, Exception):
        return {}
    try:
        data = json.loads(raw) if raw.strip() else {}
    except (json.JSONDecodeError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def main() -> int:
    if os.environ.get("ARBOR_HOOKS") == "0" or os.environ.get("ARBOR_DISABLE_HOOKS") == "1":
        return 0

    data = _load_hook_input()

    cwd_str = data.get("cwd") or os.getcwd()
    cwd = Path(cwd_str)

    root = find_arbor_root(cwd)
    if root is None:
        return 0  # not a Arbor project

    config = _read_arbor_config(root)
    if prompt_has_skip_keyword(data.get("prompt", ""), _resolve_skip_keyword(config)):
        return 0  # user opted out of the per-turn breadcrumb for this turn

    templates = load_breadcrumbs(root)
    task = get_active_task(root, data)
    if task is None:
        # No active task — still emit a breadcrumb nudging AI toward
        # arbor-brainstorm + task.py create when user describes real work.
        breadcrumb = build_breadcrumb(None, "no_task", templates)
    else:
        task_id, status, source, meta, tier = task
        next_step = None
        if status != "task_error" and not status.startswith("stale_"):
            next_step = arbor_next(root, data)
        if next_step is not None:
            breadcrumb = build_driver_breadcrumb(task_id, status, tier, next_step)
        else:
            breadcrumb = build_breadcrumb(
                task_id,
                status,
                templates,
                source,
                resolve_breadcrumb_key(status, meta, templates, tier),
                tier,
            )

    output = {
        "hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": breadcrumb,
        }
    }
    print(json.dumps(output))
    return 0


if __name__ == "__main__":
    sys.exit(main())
