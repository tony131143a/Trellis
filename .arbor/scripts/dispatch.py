#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Terminal dispatch of the Arbor roles (explore, architect, implement, review,
verify, fix, simplify) to codeg assistants, plus the working-tree snapshots
the review loop diffs against.

The codeg path (``delegate_to_agent`` + the PreToolUse hook) needs the codeg
MCP tools; this script is the same dispatch for a plain terminal, through
``codeg-cli``. Both paths assemble the prompt with
``common.dispatch_context.build_dispatch_prompt``.

Usage:
    python3 dispatch.py run --role R [--target T] [--task DIR] [--workspace WT]
                            [--mode M] [--diff FILE]
                            [--prompt TEXT | --prompt-file F | stdin]
                            [--detach] [--wait] [--worktree[=NAME]]
                            [--standalone] [--data-dir DIR] [--url URL]
                            [--dry-run] [--print-prompt]
    python3 dispatch.py wait RUN... [-o OUT] [--timeout DUR] [--url URL]
    python3 dispatch.py resolve --role R [--target T] [--json]
    python3 dispatch.py target get | set <T> | clear   [--repo]
    python3 dispatch.py print-context --role R [--task DIR] [--workspace WT] [--mode M]
                                      [--diff FILE] [--target T]
                                      [--prompt TEXT | --prompt-file F | stdin]
    python3 dispatch.py snapshot [-C DIR]
    python3 dispatch.py diff A [B] [--name N] [-C DIR]
    python3 dispatch.py codeg-setup [--target T] [--install] [--db PATH] [--codeg-cli PATH]

Runtime files (all under .arbor/.runtime/, gitignored):
    dispatch/<stamp>.md          assembled prompt of one run
    dispatch/<stamp>.result.md   final reply (codeg-cli -o)
    dispatch/<stamp>.run         run id of a --detach run
    dispatch/diffs/<name>.diff   diffs written by ``diff``
    sessions/<context>.dispatch-target   this session's target (``target set``)
    dispatch-target              checkout-wide target (``target set --repo``)
    codeg-assistants/<target>-<role>.md   rendered assistant instructions
    codeg-assistants.json        assistant name -> id registry
    codeg-db-backups/            codeg.db backups taken by --install

Exit codes: 0 ok, 1 failure, 2 usage error; ``run`` and ``wait`` pass
codeg-cli's own exit code through (3 timeout, 4 codeg unreachable,
6 still running, ...).
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from common.active_task import resolve_context_key
from common.config import (
    DISPATCH_TARGET_FILE,
    get_dispatch_config,
    resolve_dispatch_target,
    session_dispatch_target_file,
)
from common.dispatch_context import (
    CODEG_ASSISTANTS_FILE,
    REVIEW_MODES,
    ROLES,
    ROLES_REQUIRE_TASK,
    DispatchHeader,
    DispatchPrompt,
    DispatchRequest,
    build_dispatch_prompt,
    parse_dispatch_header,
    resolve_task_dir,
)
from common.io import write_json, write_text_atomic
from common.paths import DIR_WORKFLOW, get_repo_root, resolve_task_ref


RUNTIME_DIR = ".runtime"
DISPATCH_RUNS_DIR = f"{RUNTIME_DIR}/dispatch"
DIFFS_DIR = f"{DISPATCH_RUNS_DIR}/diffs"
RENDERED_ASSISTANTS_DIR = f"{RUNTIME_DIR}/codeg-assistants"
DB_BACKUPS_DIR = f"{RUNTIME_DIR}/codeg-db-backups"

MAC_APP_CODEG_CLI = "/Applications/codeg.app/Contents/MacOS/codeg-cli"
MAC_CODEG_DB = Path.home() / "Library" / "Application Support" / "app.codeg" / "codeg.db"
SETUP_HINT = "run python3 ./.arbor/scripts/dispatch.py codeg-setup"

# codeg-cli exit codes this script reacts to (codeg docs/cli.md "Exit codes").
EXIT_RUNTIME_UNAVAILABLE = 4
EXIT_STILL_RUNNING = 6
# Longest single `codeg-cli result --wait`; `wait` loops until its own deadline.
WAIT_CHUNK_SECONDS = 600

# codeg `assistant` table (src-tauri/src/db/migration/m20261016_000001_assistant.rs).
ASSISTANT_COLUMNS = frozenset(
    {
        "id", "uid", "name", "description", "avatar", "agent_type",
        "agent_options", "label_snapshot", "instructions", "enabled",
        "sort_order", "revision", "created_at", "updated_at", "deleted_at",
    }
)
# codeg assistant_service.rs limits.
MAX_NAME_CHARS = 40
MAX_DESCRIPTION_CHARS = 200
MAX_INSTRUCTIONS_CHARS = 20000

ROLE_AVATARS = {
    "explore": ("\U0001f50d", "sky"),
    "architect": ("\U0001f4d0", "amber"),
    "implement": ("\U0001f6e0\ufe0f", "blue"),
    "review": ("\U0001f9d0", "violet"),
    "verify": ("\u2696\ufe0f", "slate"),
    "fix": ("\U0001fa79", "red"),
    "simplify": ("\u2728", "green"),
}
ROLE_DESCRIPTIONS = {
    "explore": (
        "Arbor explore role ({target}): read-only tracing of code, specs and "
        "external sources; findings and essential files go to the task's "
        "research/ directory."
    ),
    "architect": (
        "Arbor architect role ({target}): one decisive blueprint from an "
        "assigned perspective, with a parallel split, written to "
        "research/design-<perspective>.md."
    ),
    "implement": (
        "Arbor implement role ({target}): implements one Arbor task from the "
        "injected specs and prd/design/implement.md; never commits."
    ),
    "review": (
        "Arbor review role ({target}): read-only correctness review of a diff; "
        "Mode: self-check | candidates | sweep; reports JSON findings."
    ),
    "verify": (
        "Arbor verify role ({target}): judges review candidates "
        "CONFIRMED / PLAUSIBLE / REFUTED against the code; read-only."
    ),
    "fix": (
        "Arbor fix role ({target}): applies verified review findings to the "
        "working tree, skips false positives with evidence; never commits."
    ),
    "simplify": (
        "Arbor simplify role ({target}): reuse / simplification / efficiency / "
        "altitude cleanup of a diff without behavior change; never commits."
    ),
}
# Roles before the seven-role split; codeg-setup --install soft-deletes
# their assistants.
RETIRED_ROLES = ("check", "research")
AGENT_LABELS = {"pi": "Pi", "claude_code": "Claude Code", "codex": "Codex"}
OPTION_LABELS = {"model": "Model", "thought_level": "Thinking"}
# codex-acp session modes (`_AgentMode` in @agentclientprotocol/codex-acp 2.x).
MODE_LABELS = {
    "read-only": "Read-only",
    "workspace-write": "Workspace access",
    "agent": "Auto review",
    "agent-full-access": "Full access",
}


class DispatchError(Exception):
    """A user-facing failure; ``code`` becomes the exit status."""

    def __init__(self, message: str, code: int = 1) -> None:
        super().__init__(message)
        self.code = code


# =============================================================================
# Small helpers
# =============================================================================


def _err(message: str) -> None:
    print(f"[arbor] {message}", file=sys.stderr)


def _write_stdout(text: str) -> None:
    """Write ``text`` as UTF-8 bytes, whatever the locale (byte-exact output)."""
    sys.stdout.flush()
    sys.stdout.buffer.write(text.encode("utf-8"))
    sys.stdout.buffer.flush()


def _arbor_dir(root: Path) -> Path:
    return root / DIR_WORKFLOW


def _rel(root: Path, path: Path) -> str:
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return str(path)


def _parse_duration(text: str) -> int | None:
    """``90s`` / ``30m`` / ``2h`` / bare seconds -> seconds; None if unparsable."""
    match = re.fullmatch(r"\s*(\d+)\s*([smh]?)\s*", text or "")
    if not match:
        return None
    return int(match.group(1)) * {"": 1, "s": 1, "m": 60, "h": 3600}[match.group(2)]


def _read_registry(root: Path) -> dict:
    """``.arbor/.runtime/codeg-assistants.json``, or {} when missing/invalid."""
    try:
        data = json.loads((_arbor_dir(root) / CODEG_ASSISTANTS_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _registry_id(registry: dict, name: str) -> int | None:
    by_name = registry.get("by_name")
    if not isinstance(by_name, dict):
        return None
    value = by_name.get(name)
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    return None


def _check_target(config: dict, target: str) -> str:
    if target not in config["targets"]:
        known = ", ".join(sorted(config["targets"]))
        raise DispatchError(f"unknown dispatch target {target!r} (known: {known})", 2)
    return target


def _effective_target(root: Path, config: dict, explicit: str | None) -> tuple[str, str]:
    if explicit:
        return _check_target(config, explicit), "flag"
    return resolve_dispatch_target(root)


def _codeg_cli(config: dict, override: str | None = None) -> str | None:
    """codeg-cli to run: flag > dispatch.codeg_cli > $CODEG_CLI > PATH > macOS app."""
    for candidate in (override, config.get("codeg_cli"), os.environ.get("CODEG_CLI")):
        if candidate:
            return os.path.expanduser(candidate)
    found = shutil.which("codeg-cli")
    if found:
        return found
    if sys.platform == "darwin" and Path(MAC_APP_CODEG_CLI).is_file():
        return MAC_APP_CODEG_CLI
    return None


def _require_codeg_cli(config: dict) -> str:
    cli = _codeg_cli(config)
    if not cli:
        raise DispatchError(
            "codeg-cli not found: put it on PATH, or set dispatch.codeg_cli in "
            ".arbor/config.yaml",
            127,
        )
    return cli


# =============================================================================
# Prompt assembly (shared by run and print-context)
# =============================================================================


def _read_body(args: argparse.Namespace) -> str:
    if args.prompt is not None:
        return args.prompt
    if args.prompt_file is not None:
        try:
            return Path(args.prompt_file).read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as exc:
            raise DispatchError(f"cannot read --prompt-file {args.prompt_file}: {exc}", 2)
    if sys.stdin is None or sys.stdin.isatty():
        return ""
    return sys.stdin.buffer.read().decode("utf-8", errors="replace")


def _read_brief(args: argparse.Namespace) -> DispatchHeader:
    """The brief, parsed: a brief that starts with a header supplies defaults."""
    return parse_dispatch_header(_read_body(args))


def _assemble(
    root: Path,
    args: argparse.Namespace,
    inner: DispatchHeader,
    target: str | None,
) -> tuple[DispatchPrompt, Path | None, str | None]:
    """Build the dispatch prompt exactly as the delegation hook would.

    The flags become a header block in front of the brief, and that text goes
    through the same parse -> resolve -> build steps as the hook's
    ``tool_input.task``. Header lines at the top of the brief fill in what the
    flags leave unset. Returns (prompt, task dir, absolute workspace).
    """
    role = args.role
    if inner.role and inner.role != role:
        _err(f"brief header says Role: {inner.role}; using --role {role}")
    mode = args.mode or inner.mode
    diff = args.diff or inner.diff
    if diff:
        diff = str(Path(diff).expanduser().resolve())

    task_ref = args.task or inner.task_dir
    task_dir: Path | None = None
    if task_ref:
        task_dir = resolve_task_ref(task_ref, root)
        if task_dir is None or not task_dir.is_dir():
            raise DispatchError(f"task directory not found: {task_ref}", 2)

    workspace = args.workspace or inner.workspace
    if workspace:
        workspace = str(Path(workspace).expanduser().resolve())

    lines = []
    if task_dir is not None:
        lines.append(f"Active task: {task_dir}")
    lines.append(f"Role: {role}")
    if mode:
        lines.append(f"Mode: {mode}")
    if diff:
        lines.append(f"Diff: {diff}")
    if target:
        lines.append(f"Target: {target}")
    if workspace:
        lines.append(f"Workspace: {workspace}")
    text = "\n".join(lines) + "\n\n" + inner.body

    header = parse_dispatch_header(text)
    resolved = resolve_task_dir(root, header, None, None)
    if role in ROLES_REQUIRE_TASK and resolved is None:
        raise DispatchError(
            f"--role {role} needs a task: pass --task <dir> or start one with "
            "task.py start",
            2,
        )
    try:
        prompt = build_dispatch_prompt(DispatchRequest(root, role, resolved, header, text))
    except ValueError as exc:
        raise DispatchError(str(exc), 2)
    for warning in prompt.warnings:
        _err(warning)
    return prompt, resolved, workspace


def _reserve_stamp(runs_dir: Path, role: str, text: str) -> str:
    """Write the prompt to ``<stamp>.md`` under a stamp no other run holds."""
    runs_dir.mkdir(parents=True, exist_ok=True)
    base = f"{datetime.now():%Y%m%d-%H%M%S}-{role}"
    attempt = 1
    while True:
        stamp = base if attempt == 1 else f"{base}-{attempt}"
        try:
            with open(runs_dir / f"{stamp}.md", "x", encoding="utf-8", newline="") as f:
                f.write(text)
            return stamp
        except FileExistsError:
            attempt += 1


# =============================================================================
# run / wait
# =============================================================================


def _global_args(standalone: bool, data_dir: str | None, url: str | None) -> list[str]:
    argv = ["--standalone"] if standalone else []
    if data_dir:
        argv += ["--data-dir", data_dir]
    if url:
        argv += ["--url", url]
    return argv


def cmd_run(args: argparse.Namespace) -> int:
    root = get_repo_root()
    config = get_dispatch_config(root)
    if args.standalone and (args.detach or args.url):
        raise DispatchError(
            "--standalone cannot be combined with --detach or --url: its server "
            "stops when the command ends",
            2,
        )

    inner = _read_brief(args)
    target, _source = _effective_target(root, config, args.target or inner.target)
    prompt, task_dir, workspace = _assemble(root, args, inner, target)
    if args.print_prompt:
        _write_stdout(prompt.text)
        return 0

    assistant = config["targets"][target]["assistants"][args.role]
    runs_dir = _arbor_dir(root) / DISPATCH_RUNS_DIR
    task_name = task_dir.name if task_dir is not None else "-"
    workspace_dir = workspace or str(root)

    def build_argv(cli: str, result_path: Path) -> list[str]:
        argv = [cli] + _global_args(args.standalone, args.data_dir, args.url)
        argv += [
            "run",
            "-A", assistant,
            "-w", workspace_dir,
            "--permissions", config["permissions"],
            "--timeout", config["timeout"],
            "--title", f"arbor {args.role} {task_name}",
        ]
        if args.worktree is not None:
            argv.append("--worktree" if args.worktree is True else f"--worktree={args.worktree}")
        argv += ["--detach"] if args.detach else ["-o", str(result_path)]
        return argv + ["-p", "-"]

    if args.dry_run:
        stamp = f"{datetime.now():%Y%m%d-%H%M%S}-{args.role}"
        cli = _codeg_cli(config) or "codeg-cli"
        _write_stdout(" ".join(_quote(a) for a in build_argv(cli, runs_dir / f"{stamp}.result.md")) + "\n")
        return 0

    cli = _require_codeg_cli(config)
    if args.standalone and not args.data_dir:
        _err(
            "--standalone starts a codeg-server with an empty data directory, so "
            f"assistant {assistant!r} exists there only with --data-dir <codeg data dir>"
        )
    stamp = _reserve_stamp(runs_dir, args.role, prompt.text)
    result_path = runs_dir / f"{stamp}.result.md"
    argv = build_argv(cli, result_path)
    _err(f"prompt: {_rel(root, runs_dir / f'{stamp}.md')}")
    try:
        proc = subprocess.run(
            argv,
            input=prompt.text,
            encoding="utf-8",
            stdout=subprocess.PIPE if args.detach else None,
        )
    except OSError as exc:
        raise DispatchError(f"cannot run {cli}: {exc}", 127)

    if not args.detach:
        if proc.returncode == 0:
            _err(f"result: {_rel(root, result_path)}")
        return proc.returncode

    run_id = (proc.stdout or "").strip()
    if proc.returncode != 0 or not run_id:
        _err(f"codeg-cli --detach failed (exit {proc.returncode})")
        return proc.returncode or 1
    write_text_atomic(runs_dir / f"{stamp}.run", run_id + "\n")
    _write_stdout(run_id + "\n")
    if not args.wait:
        _err(f"collect with: python3 ./.arbor/scripts/dispatch.py wait {run_id}")
        return 0
    return _wait_runs(
        root,
        config,
        [run_id],
        result_path,
        _parse_duration(config["timeout"]) or 5400,
        _global_args(False, args.data_dir, args.url),
    )


def _quote(arg: str) -> str:
    if arg and re.fullmatch(r"[A-Za-z0-9_@%+=:,./-]+", arg):
        return arg
    return "'" + arg.replace("'", "'\"'\"'") + "'"


def _default_result_path(runs_dir: Path, run_id: str) -> Path:
    """``<stamp>.result.md`` of the run recorded in ``<stamp>.run``, if any."""
    if runs_dir.is_dir():
        for run_file in sorted(runs_dir.glob("*.run")):
            try:
                recorded = run_file.read_text(encoding="utf-8").strip()
            except OSError:
                continue
            if recorded and (recorded == run_id or recorded.startswith(run_id)):
                return run_file.with_name(run_file.stem + ".result.md")
    return runs_dir / f"{run_id}.result.md"


def _wait_runs(
    root: Path,
    config: dict,
    run_ids: list[str],
    out: Path | None,
    timeout_seconds: int,
    global_argv: list[str],
) -> int:
    cli = _require_codeg_cli(config)
    runs_dir = _arbor_dir(root) / DISPATCH_RUNS_DIR
    runs_dir.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + timeout_seconds
    first_failure = 0

    for run_id in run_ids:
        result_path = out or _default_result_path(runs_dir, run_id)
        while True:
            remaining = deadline - time.monotonic()
            chunk = max(1, math.ceil(min(remaining, WAIT_CHUNK_SECONDS)))
            argv = [cli] + global_argv + [
                "result", run_id, "--wait", f"{chunk}s", "-o", str(result_path),
            ]
            try:
                code = subprocess.run(argv).returncode
            except OSError as exc:
                raise DispatchError(f"cannot run {cli}: {exc}", 127)
            if code == EXIT_STILL_RUNNING and deadline - time.monotonic() > 0:
                continue
            break

        if code == 0:
            _err(f"{run_id}: done, result in {_rel(root, result_path)}")
        elif code == EXIT_STILL_RUNNING:
            _err(f"{run_id}: still running at the wait deadline; wait again later")
        elif code == EXIT_RUNTIME_UNAVAILABLE:
            _err(f"{run_id}: codeg is unreachable (exit 4); the run may still be going")
        else:
            _err(f"{run_id}: finished with exit {code}")
        if code != 0 and first_failure == 0:
            first_failure = code
    return first_failure


def cmd_wait(args: argparse.Namespace) -> int:
    root = get_repo_root()
    config = get_dispatch_config(root)
    if args.output and len(args.runs) > 1:
        raise DispatchError("-o/--output takes a single RUN", 2)
    raw_timeout = args.timeout or config["timeout"]
    seconds = _parse_duration(raw_timeout)
    if seconds is None:
        raise DispatchError(f"invalid --timeout {raw_timeout!r} (use 90s, 30m, 2h)", 2)
    out = Path(args.output).expanduser().resolve() if args.output else None
    return _wait_runs(root, config, args.runs, out, seconds, _global_args(False, None, args.url))


# =============================================================================
# resolve / target / print-context
# =============================================================================


def cmd_resolve(args: argparse.Namespace) -> int:
    root = get_repo_root()
    config = get_dispatch_config(root)
    target, source = _effective_target(root, config, args.target)
    target_cfg = config["targets"][target]
    name = target_cfg["assistants"][args.role]
    assistant_id = _registry_id(_read_registry(root), name)

    if args.json:
        payload = {
            "role": args.role,
            "target": target,
            "target_source": source,
            "assistant": name,
            "assistant_id": assistant_id,
            "agent_type": target_cfg["agent_type"],
        }
        _write_stdout(json.dumps(payload, ensure_ascii=False) + "\n")
        return 0

    id_text = str(assistant_id) if assistant_id is not None else f"unknown ({SETUP_HINT})"
    _write_stdout(
        f"role: {args.role}\n"
        f"target: {target} (source: {source})\n"
        f"assistant: {name}\n"
        f"assistant_id: {id_text}\n"
    )
    return 0


def _target_override_file(root: Path, repo_wide: bool) -> Path:
    """Where ``target set`` / ``clear`` operate: this session's file by default.

    Session identity comes from the same sources as the active task
    (``ARBOR_CONTEXT_ID``, the host's shell env). Without it the command falls
    back to the checkout-wide file and says so, mirroring ``task.py start``.
    """
    repo_file = _arbor_dir(root) / DISPATCH_TARGET_FILE
    if repo_wide:
        return repo_file
    context_key = resolve_context_key()
    if context_key:
        return session_dispatch_target_file(root, context_key)
    _err(
        "no session identity (ARBOR_CONTEXT_ID); using the checkout-wide "
        f"{_rel(root, repo_file)}, which every session in this checkout shares"
    )
    return repo_file


def cmd_target(args: argparse.Namespace) -> int:
    root = get_repo_root()
    config = get_dispatch_config(root)

    if args.action == "set":
        if not args.value:
            raise DispatchError("usage: dispatch.py target set <target> [--repo]", 2)
        value = _check_target(config, args.value)
        target_file = _target_override_file(root, args.repo)
        target_file.parent.mkdir(parents=True, exist_ok=True)
        if not write_text_atomic(target_file, value + "\n"):
            raise DispatchError(f"cannot write {_rel(root, target_file)}")
    elif args.action == "clear":
        try:
            _target_override_file(root, args.repo).unlink()
        except FileNotFoundError:
            pass
    elif args.value:
        raise DispatchError("usage: dispatch.py target get", 2)

    target, source = resolve_dispatch_target(root)
    _write_stdout(f"{target} (source: {source})\n")
    return 0


def cmd_print_context(args: argparse.Namespace) -> int:
    root = get_repo_root()
    config = get_dispatch_config(root)
    inner = _read_brief(args)
    target = args.target or inner.target
    if target:
        _check_target(config, target)
    prompt, _task_dir, _workspace = _assemble(root, args, inner, target)
    _write_stdout(prompt.text)
    return 0


# =============================================================================
# codeg-setup
# =============================================================================


def _assistant_rows(root: Path, config: dict, targets: list[str]) -> list[dict]:
    """One row per target x role, instructions rendered from .arbor/agents/."""
    rows = []
    for target in targets:
        target_cfg = config["targets"][target]
        agent_type = target_cfg["agent_type"]
        mode_id = target_cfg["mode_id"]
        options = {
            key: target_cfg["options"][key]
            for key in ("model", "thought_level")
            if target_cfg["options"].get(key)
        }
        for role in ROLES:
            source = _arbor_dir(root) / "agents" / f"{role}.md"
            try:
                body = source.read_text(encoding="utf-8").strip()
            except OSError:
                raise DispatchError(
                    f"missing {_rel(root, source)}: run `arbor update` to restore it"
                )
            name = target_cfg["assistants"][role]
            instructions = (
                f"{body}\n\n---\n\nCodeg assistant `{name}`: Arbor role `{role}`, "
                f"target `{target}` (agent `{agent_type}`)."
            )
            description = ROLE_DESCRIPTIONS[role].format(target=target)
            if len(name) > MAX_NAME_CHARS:
                raise DispatchError(f"assistant name {name!r} is over {MAX_NAME_CHARS} characters")
            if len(instructions) > MAX_INSTRUCTIONS_CHARS:
                raise DispatchError(
                    f"{_rel(root, source)} renders over {MAX_INSTRUCTIONS_CHARS} characters"
                )
            emoji, color = ROLE_AVATARS[role]
            rows.append(
                {
                    "uid": str(uuid.uuid5(uuid.NAMESPACE_URL, f"arbor/{target}/{role}")),
                    "name": name,
                    "role": role,
                    "target": target,
                    "description": description[:MAX_DESCRIPTION_CHARS],
                    "avatar": {"kind": "emoji", "emoji": emoji, "color": color},
                    "agent_type": agent_type,
                    "mode_id": mode_id,
                    "options": options,
                    "instructions": instructions,
                }
            )
    return rows


def _render_rows(root: Path, rows: list[dict]) -> dict[str, Path]:
    out_dir = _arbor_dir(root) / RENDERED_ASSISTANTS_DIR
    out_dir.mkdir(parents=True, exist_ok=True)
    paths = {}
    for row in rows:
        path = out_dir / f"{row['target']}-{row['role']}.md"
        if not write_text_atomic(path, row["instructions"] + "\n"):
            raise DispatchError(f"cannot write {_rel(root, path)}")
        paths[row["name"]] = path
    return paths


def _print_manual_steps(root: Path, rows: list[dict], paths: dict[str, Path]) -> None:
    lines = [
        f"Rendered {len(rows)} assistant instruction files under "
        f"{DIR_WORKFLOW}/{RENDERED_ASSISTANTS_DIR}/.",
        "",
        "Create each assistant in codeg (Settings -> Assistants -> New), or re-run",
        "with --install on macOS. Check agent slugs with `codeg-cli agents`.",
    ]
    for row in rows:
        options = ", ".join(f"{k}={v}" for k, v in row["options"].items()) or "(agent defaults)"
        lines += [
            "",
            f"  {row['name']}",
            f"    Description:  {row['description']}",
            f"    Agent:        {row['agent_type']}",
            f"    Mode:         {row['mode_id'] or '(agent default)'}",
            f"    Options:      {options}",
            f"    Instructions: paste {_rel(root, paths[row['name']])}",
        ]
    _write_stdout("\n".join(lines) + "\n")


def _dumps(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _label_snapshot(
    agent_type: str,
    options: dict[str, str],
    agent_label: str | None = None,
    mode_id: str | None = None,
) -> dict:
    agent = agent_label or AGENT_LABELS.get(agent_type, agent_type.split(":", 1)[-1])
    mode = MODE_LABELS.get(mode_id, mode_id) if mode_id else None
    labels = []
    for key, value in options.items():
        if key == "model":
            value_label = value.rsplit("/", 1)[-1]
        elif key == "thought_level":
            value_label = f"Thinking: {value}"
        else:
            value_label = value
        labels.append(
            {
                "id": key,
                "kind": "select",
                "name": OPTION_LABELS.get(key, key),
                "value_label": value_label,
            }
        )
    return {"agent": agent, "mode": mode, "options": labels}


def _install_rows(root: Path, db_path: Path, rows: list[dict]) -> dict[str, int] | None:
    """Upsert ``rows`` into codeg's assistant table.

    A new row gets the target's agent, mode and options. An existing row keeps
    its ``agent_type`` / ``agent_options`` / ``label_snapshot`` — once created,
    those belong to the codeg UI — and only Arbor's own fields (name,
    description, avatar, instructions, sort order) are refreshed.

    Returns name -> id of every live assistant afterwards, or None when the
    table schema is not the one this script was written against.
    """
    conn = sqlite3.connect(str(db_path), timeout=15, isolation_level=None)
    try:
        columns = {row[1] for row in conn.execute("PRAGMA table_info(assistant)")}
        if columns != ASSISTANT_COLUMNS:
            missing = sorted(ASSISTANT_COLUMNS - columns)
            extra = sorted(columns - ASSISTANT_COLUMNS)
            _err(
                "codeg assistant table differs from the expected schema "
                f"(missing: {missing or '-'}, unexpected: {extra or '-'}); "
                "refusing --install, create the assistants in the codeg UI instead"
            )
            return None

        backup_dir = _arbor_dir(root) / DB_BACKUPS_DIR
        backup_dir.mkdir(parents=True, exist_ok=True)
        backup = backup_dir / f"codeg.db.{datetime.now():%Y%m%d-%H%M%S-%f}"
        with sqlite3.connect(str(backup)) as out:
            conn.backup(out)
        out.close()
        _err(f"backup: {_rel(root, backup)}")

        # Custom ACP agents (agent_type `custom:<id>`) show their registered
        # name in codeg's UI; read it so the label matches what the UI shows.
        custom_labels: dict[str, str] = {}
        if conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='custom_agent'"
        ).fetchone():
            custom_labels = {
                f"custom:{registry_id}": str(name)
                for registry_id, name in conn.execute(
                    "SELECT registry_id, name FROM custom_agent"
                )
            }

        # Keep the user's existing assistants (e.g. a hand-built pipeline) in
        # front; arbor rows follow in role order after the highest sort_order
        # of everything else.
        retired = {
            str(uuid.uuid5(uuid.NAMESPACE_URL, f"arbor/{target}/{role}"))
            for target in {row["target"] for row in rows}
            for role in RETIRED_ROLES
        }
        our_uids = {row["uid"] for row in rows} | retired
        existing_orders = {
            uid: order
            for uid, order in conn.execute(
                "SELECT uid, sort_order FROM assistant WHERE deleted_at IS NULL"
            )
        }
        next_order = (
            max(
                (order for uid, order in existing_orders.items() if uid not in our_uids),
                default=0,
            )
            + 1
        )

        now = datetime.now(timezone.utc).isoformat(timespec="microseconds")
        conn.execute("BEGIN IMMEDIATE")
        try:
            for order, row in enumerate(rows, start=next_order):
                clash = conn.execute(
                    "SELECT uid FROM assistant WHERE deleted_at IS NULL"
                    " AND name = ? COLLATE NOCASE AND uid <> ?",
                    (row["name"], row["uid"]),
                ).fetchone()
                if clash:
                    raise DispatchError(
                        f"another codeg assistant is already named {row['name']!r}; "
                        "rename it or change dispatch.targets in .arbor/config.yaml"
                    )
                existing = conn.execute(
                    "SELECT id FROM assistant WHERE uid = ?", (row["uid"],)
                ).fetchone()
                if existing:
                    conn.execute(
                        "UPDATE assistant SET name=?, description=?, avatar=?, instructions=?,"
                        " enabled=1, sort_order=?, deleted_at=NULL, revision=revision+1,"
                        " updated_at=? WHERE id=?",
                        (
                            row["name"],
                            row["description"],
                            _dumps(row["avatar"]),
                            row["instructions"],
                            order,
                            now,
                            existing[0],
                        ),
                    )
                    _err(
                        f"updated assistant {row['name']} (id {existing[0]}; "
                        "agent/mode/options kept)"
                    )
                else:
                    agent_options: dict = {}
                    if row["mode_id"]:
                        agent_options["mode_id"] = row["mode_id"]
                    if row["options"]:
                        agent_options["config_values"] = row["options"]
                    cursor = conn.execute(
                        "INSERT INTO assistant (uid, name, description, avatar, agent_type,"
                        " agent_options, label_snapshot, instructions, enabled, sort_order,"
                        " revision, created_at, updated_at, deleted_at)"
                        " VALUES (?,?,?,?,?,?,?,?,1,?,1,?,?,NULL)",
                        (
                            row["uid"],
                            row["name"],
                            row["description"],
                            _dumps(row["avatar"]),
                            row["agent_type"],
                            _dumps(agent_options),
                            _dumps(
                                _label_snapshot(
                                    row["agent_type"],
                                    row["options"],
                                    custom_labels.get(row["agent_type"]),
                                    row["mode_id"],
                                )
                            ),
                            row["instructions"],
                            order,
                            now,
                            now,
                        ),
                    )
                    _err(f"created assistant {row['name']} (id {cursor.lastrowid})")
            for uid, name, assistant_id in conn.execute(
                "SELECT uid, name, id FROM assistant WHERE deleted_at IS NULL"
            ).fetchall():
                if uid in retired:
                    conn.execute(
                        "UPDATE assistant SET deleted_at=?, enabled=0,"
                        " revision=revision+1, updated_at=? WHERE id=?",
                        (now, now, assistant_id),
                    )
                    _err(f"retired assistant {name} (id {assistant_id})")
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise
        return {
            str(name): int(assistant_id)
            for assistant_id, name in conn.execute(
                "SELECT id, name FROM assistant WHERE deleted_at IS NULL AND enabled"
            )
        }
    finally:
        conn.close()


def _list_codeg_assistants(cli: str | None) -> list[dict] | None:
    """``codeg-cli assistants --json`` entries, or None when unreachable."""
    if not cli:
        _err("codeg-cli not found; skipped the assistant id registry")
        return None
    try:
        proc = subprocess.run(
            [cli, "assistants", "--json"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            encoding="utf-8",
            timeout=120,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        _err(f"codeg-cli assistants failed ({exc}); skipped the assistant id registry")
        return None
    if proc.returncode != 0:
        detail = (proc.stderr or "").strip().splitlines()
        _err(
            f"codeg-cli assistants exited {proc.returncode}"
            + (f": {detail[-1]}" if detail else "")
            + "; codeg is not reachable, skipped the assistant id registry"
        )
        return None
    try:
        entries = json.loads(proc.stdout)
    except ValueError:
        _err("codeg-cli assistants --json did not print JSON; skipped the assistant id registry")
        return None
    if not isinstance(entries, list):
        return None
    return [entry for entry in entries if isinstance(entry, dict)]


def _write_registry(root: Path, config: dict, ids_by_name: dict[str, int]) -> Path:
    roles_by_name = {
        name: (role, target)
        for target, target_cfg in config["targets"].items()
        for role, name in target_cfg["assistants"].items()
    }
    by_name: dict[str, int] = {}
    by_id: dict[str, dict] = {}
    for name, assistant_id in sorted(ids_by_name.items()):
        if name not in roles_by_name:
            continue
        role, target = roles_by_name[name]
        by_name[name] = assistant_id
        by_id[str(assistant_id)] = {"role": role, "target": target}
    path = _arbor_dir(root) / CODEG_ASSISTANTS_FILE
    path.parent.mkdir(parents=True, exist_ok=True)
    data = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "by_name": by_name,
        "by_id": by_id,
    }
    if not write_json(path, data):
        raise DispatchError(f"cannot write {_rel(root, path)}")
    return path


def cmd_codeg_setup(args: argparse.Namespace) -> int:
    root = get_repo_root()
    config = get_dispatch_config(root)
    targets = [_check_target(config, args.target)] if args.target else list(config["targets"])
    rows = _assistant_rows(root, config, targets)
    paths = _render_rows(root, rows)

    exit_code = 0
    installed: dict[str, int] | None = None
    if args.install:
        db_path = Path(args.db).expanduser() if args.db else MAC_CODEG_DB
        if not args.db and sys.platform != "darwin":
            _err("--install without --db is macOS-only; showing the manual steps instead")
            exit_code = 2
        elif not db_path.is_file():
            _err(f"codeg database not found at {db_path}; showing the manual steps instead")
            exit_code = 2
        else:
            installed = _install_rows(root, db_path, rows)
            if installed is None:
                exit_code = 2
            else:
                _write_stdout(f"Installed {len(rows)} assistants into {db_path}.\n")
    if installed is None:
        _print_manual_steps(root, rows, paths)

    entries = _list_codeg_assistants(_codeg_cli(config, args.codeg_cli))
    ids_by_name: dict[str, int] | None = None
    if entries is not None:
        ids_by_name = {
            str(entry["name"]): entry["id"]
            for entry in entries
            if isinstance(entry.get("id"), int) and isinstance(entry.get("name"), str)
        }
    elif installed:
        _err("using the ids in the codeg database instead")
        ids_by_name = installed
    if ids_by_name is not None:
        registry = _write_registry(root, config, ids_by_name)
        known = _read_registry(root).get("by_name") or {}
        _write_stdout(
            f"Wrote {_rel(root, registry)} ({len(known)} arbor assistants with ids).\n"
        )
    return exit_code


# =============================================================================
# snapshot / diff
# =============================================================================


def _git(cwd: Path, *argv: str, env: dict | None = None) -> str:
    proc = subprocess.run(
        ["git", "-C", str(cwd), *argv],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        encoding="utf-8",
        errors="replace",
        env=env,
    )
    if proc.returncode != 0:
        detail = (proc.stderr or "").strip().splitlines()
        raise DispatchError(
            f"git {argv[0]} failed" + (f": {detail[-1]}" if detail else "")
        )
    return proc.stdout


def _snapshot_tree(work: Path) -> str:
    """Tree id of the working tree, untracked files included.

    Built in a throwaway index, so neither the real index nor the working
    tree changes; ``.gitignore`` is honoured.
    """
    with tempfile.TemporaryDirectory(prefix="arbor-snapshot-") as tmp:
        env = {**os.environ, "GIT_INDEX_FILE": str(Path(tmp) / "index")}
        has_head = subprocess.run(
            ["git", "-C", str(work), "rev-parse", "--verify", "-q", "HEAD"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        ).returncode == 0
        if has_head:
            _git(work, "read-tree", "HEAD", env=env)
        _git(work, "add", "-A", env=env)
        return _git(work, "write-tree", env=env).strip()


def _work_dir(args: argparse.Namespace) -> Path:
    work = Path(args.C).expanduser().resolve() if args.C else Path.cwd()
    return Path(_git(work, "rev-parse", "--show-toplevel").strip())


def cmd_snapshot(args: argparse.Namespace) -> int:
    _write_stdout(_snapshot_tree(_work_dir(args)) + "\n")
    return 0


def cmd_diff(args: argparse.Namespace) -> int:
    name = args.name or f"{datetime.now():%Y%m%d-%H%M%S}"
    if not re.fullmatch(r"[A-Za-z0-9._-]+", name):
        raise DispatchError(f"--name must match [A-Za-z0-9._-]+: {name!r}", 2)
    root = get_repo_root()
    work = _work_dir(args)
    end = args.b or _snapshot_tree(work)
    pathspec = ["--", ".", f":(exclude){DIR_WORKFLOW}"]
    text = _git(work, "diff", "--no-ext-diff", "--no-color", args.a, end, *pathspec)
    numstat = _git(work, "diff", "--numstat", args.a, end, *pathspec)

    out = _arbor_dir(root) / DIFFS_DIR / f"{name}.diff"
    out.parent.mkdir(parents=True, exist_ok=True)
    if not write_text_atomic(out, text):
        raise DispatchError(f"cannot write {_rel(root, out)}")

    files = added = deleted = 0
    for line in numstat.splitlines():
        parts = line.split("\t")
        if len(parts) >= 3:
            files += 1
            added += int(parts[0]) if parts[0].isdigit() else 0
            deleted += int(parts[1]) if parts[1].isdigit() else 0
    _err(f"{files} files, +{added} -{deleted} ({added + deleted} changed lines)")
    _write_stdout(f"{out}\n")
    return 0


# =============================================================================
# CLI
# =============================================================================


def _add_prompt_options(parser: argparse.ArgumentParser) -> None:
    source = parser.add_mutually_exclusive_group()
    source.add_argument("-p", "--prompt", help="brief text (default: read stdin)")
    source.add_argument("--prompt-file", help="read the brief from this file")


def _add_header_options(parser: argparse.ArgumentParser, *, role_help: str) -> None:
    parser.add_argument("--role", required=True, choices=ROLES, help=role_help)
    parser.add_argument("--task", help="task directory (default: the session's active task)")
    parser.add_argument("--workspace", help="worktree the role works in (adds Workspace:)")
    parser.add_argument(
        "--mode", choices=REVIEW_MODES, help="review mode (adds Mode:; review only)"
    )
    parser.add_argument("--diff", help="diff file the role reviews (adds Diff:)")
    parser.add_argument("--target", help="star | pi | any configured target")
    _add_prompt_options(parser)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="dispatch.py",
        description="Dispatch Arbor roles to codeg assistants from a terminal.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    run = sub.add_parser("run", help="assemble the prompt and run it with codeg-cli")
    _add_header_options(run, role_help="role to dispatch")
    run.add_argument("--detach", action="store_true", help="start in the background, print the run id")
    run.add_argument("--wait", action="store_true", help="with --detach: wait for the result")
    run.add_argument(
        "--worktree", nargs="?", const=True, default=None, metavar="NAME",
        help="let codeg-cli run in a new git worktree (branch cli/NAME)",
    )
    run.add_argument("--standalone", action="store_true", help="codeg-cli --standalone")
    run.add_argument("--data-dir", help="codeg-cli --data-dir (codeg data directory)")
    run.add_argument("--url", help="codeg-cli --url (remote codeg-server; token via CODEG_TOKEN)")
    run.add_argument("--dry-run", action="store_true", help="print the codeg-cli command only")
    run.add_argument("--print-prompt", action="store_true", help="print the assembled prompt only")
    run.set_defaults(func=cmd_run)

    wait = sub.add_parser("wait", help="wait for detached runs")
    wait.add_argument("runs", nargs="+", metavar="RUN", help="run id (or its first 8+ characters)")
    wait.add_argument("-o", "--output", help="result file (single RUN only)")
    wait.add_argument("--timeout", help="overall wait limit (default: dispatch.timeout)")
    wait.add_argument("--url", help="codeg-cli --url")
    wait.set_defaults(func=cmd_wait)

    resolve = sub.add_parser("resolve", help="print the assistant and id for a role")
    resolve.add_argument("--role", required=True, choices=ROLES)
    resolve.add_argument("--target")
    resolve.add_argument("--json", action="store_true")
    resolve.set_defaults(func=cmd_resolve)

    target = sub.add_parser(
        "target", help="get, set, or clear this session's dispatch target override"
    )
    target.add_argument("action", nargs="?", default="get", choices=("get", "set", "clear"))
    target.add_argument("value", nargs="?")
    target.add_argument(
        "--repo", action="store_true",
        help="set/clear the checkout-wide target (shared by every session) instead",
    )
    target.set_defaults(func=cmd_target)

    context = sub.add_parser(
        "print-context", help="print the prompt the delegation hook would build"
    )
    _add_header_options(context, role_help="role of the dispatch")
    context.set_defaults(func=cmd_print_context)

    snapshot = sub.add_parser(
        "snapshot", help="print a tree id of the working tree (untracked files included)"
    )
    snapshot.add_argument("-C", metavar="DIR", help="work tree to snapshot (default: cwd)")
    snapshot.set_defaults(func=cmd_snapshot)

    diff = sub.add_parser("diff", help="write the diff between two snapshots to a file")
    diff.add_argument("a", metavar="A", help="snapshot tree id, commit or branch")
    diff.add_argument("b", metavar="B", nargs="?", help="end point (default: the working tree now)")
    diff.add_argument("--name", help="file name under .arbor/.runtime/dispatch/diffs/")
    diff.add_argument("-C", metavar="DIR", help="work tree to diff (default: cwd)")
    diff.set_defaults(func=cmd_diff)

    setup = sub.add_parser("codeg-setup", help="render or install the codeg assistants")
    setup.add_argument("--target", help="only this target (default: every configured target)")
    setup.add_argument("--install", action="store_true", help="write the assistants into codeg's database")
    setup.add_argument("--db", help="codeg database (default: the macOS app's codeg.db)")
    setup.add_argument("--codeg-cli", help="codeg-cli used to read assistant ids")
    setup.set_defaults(func=cmd_codeg_setup)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return int(args.func(args))
    except DispatchError as exc:
        _err(str(exc))
        return exc.code
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
