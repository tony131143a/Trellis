#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
arbor: the task driver. It owns the state table, the counters and the
validators; models write briefs and answer the decisions it asks for.

Usage (from the main checkout or any worktree of the repo):
    python3 ./.arbor/scripts/arbor.py next [--json] [--partition P]
    python3 ./.arbor/scripts/arbor.py run [--partition P] [--dispatch d-NNN]
    python3 ./.arbor/scripts/arbor.py run --role explore|architect|review [--mode plan] [--dispatch d-NNN]
    python3 ./.arbor/scripts/arbor.py run --autopilot
    python3 ./.arbor/scripts/arbor.py bind --request <path> --task-id <codeg-task-id>
    python3 ./.arbor/scripts/arbor.py collect --request <path> --result <terminal-MCP-JSON-file>
    python3 ./.arbor/scripts/arbor.py finish [--pr]
    python3 ./.arbor/scripts/arbor.py gate
    python3 ./.arbor/scripts/arbor.py decide <impl|tests|contract|fix|skip> --reason "..." [--partition P]
    python3 ./.arbor/scripts/arbor.py canary [--role explore|review|verify]
    python3 ./.arbor/scripts/arbor.py override --reason "..." (--role R [--mode M] | --to STATE[/step])
    python3 ./.arbor/scripts/arbor.py status | resume | abandon [--reason "..."]
    python3 ./.arbor/scripts/arbor.py prompt --dispatch d-NNN --print

Every command takes ``--task <dir>``; the default is the session's active task.

``run --autopilot`` keeps taking the next step (gate, dispatch with
``briefs/<id>.md`` or ``briefs/default-<role>.md``, finish) until a decision,
a human gate, STOP, a red gate or a failed dispatch.

``finish`` in FINISH: before the merge it writes and commits scorecard.md,
then opens a PR (``--pr`` with gh) or prints the ``merge --no-ff`` command;
after the merge it removes the worktree, archives the task and writes the
journal entry (DONE). Re-running continues at the first missing step.

``run --role`` is the CONTRACT phase (task not started yet): a read-only
dispatch in the main checkout, recorded in task.json and results.jsonl,
never committed and outside the state table. Without any task, ``--role
explore`` reads its brief from stdin and prints the reply.

A wave of named partitions runs each partition in its own worktree
(``<root>/<task>-<p>`` on ``arbor/<task>--<p>``): ``run`` creates them, each
partition then takes its own ``test`` / ``implement`` dispatches (``next``
lists the others that are ready in ``partitions_pending``; run them in
parallel with ``run --partition P``), and once all are done ``run`` merges
them back with ``--no-ff``. A conflict waits for a hand merge in the task
worktree and ``resume``. Parallel runs share task.json under ``<task>/.lock``.

Files:
    <task>/briefs/d-NNN.md      the brief the main agent writes before `run`
    <task>/reports/d-NNN.md     the reply plus the driver's verdict
    <task>/reports/gate-N.md    output of the N-th gate round
    <task>/reports/candidates-rN.json   POLISH round N after the prefilter
    <task>/scorecard.md         FINISH: the task's measurements
    .arbor/.runtime/prompts/<task>/d-NNN.md   the full prompt sent (main checkout)
    .arbor/.runtime/results.jsonl             one row per dispatch (main checkout)

Exit codes: 0 ok, 1 refused / failed dispatch / red gate, 2 usage error.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import asdict
from uuid import uuid4
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator

from common.active_task import resolve_active_task, resolve_task_ref
from common.arbor_config import get_executors_config, get_gate_commands, get_test_paths, read_arbor_config
from common.contract import (
    Contract,
    ContractError,
    contract_hash,
    effective_test_paths,
    find_contract,
    load_contract,
    validate_contract,
)
from common.dispatch_context import (
    PROMPT_ROLES,
    RANGE_ROLES,
    REVIEW_MODES,
    DispatchHeader,
    DispatchRequest,
    build_dispatch_prompt,
)
from common.driver import partitions as pt
from common.driver import autopilot
from common.driver import mcp
from common.driver import finish as fin
from common.driver import state as sm
from common.driver import validate as rv
from common.driver.executor import ExecResult, ExecutorError, resolve_executor, run_executor, utc_now
from common.driver.gate import CheckResult, RedResult, format_checks, run_gate, run_red_check
from common.driver.lock import LockTimeout, pid_alive, task_lock
from common.git import run_git
from common.invariants import WRITER_ROLES, _dirty_paths, check_after_dispatch, snapshot_refs
from common.io import read_json_checked, write_json
from common.log import Colors, colored
from common.paths import DIR_TASKS, DIR_WORKFLOW, FILE_TASK_JSON
from common.tasks import resolve_tier
from common.worktree import WorktreeError, is_ancestor, main_checkout, partition_branch, partition_worktree_path

RUNTIME = f"{DIR_WORKFLOW}/.runtime"
CANARY_ROLES = ("explore", "review", "verify")
CONTRACT_ROLES = ("explore", "architect", "review")
STDERR_TAIL_LINES = 40


from common import execution as ex


class DriverError(RuntimeError):
    pass


@dataclass
class Ctx:
    main: Path
    config: dict
    task_dir: Path
    name: str
    data: dict
    started: bool

    @property
    def worktree(self) -> Path:
        return Path(self.data["worktree_path"])

    @property
    def control_worktree(self) -> Path:
        return Path(ex.control_data(self.data)["worktree_path"])

    @property
    def execution_main(self) -> Path:
        binding = self.data.get("execution_binding")
        return Path(binding["repo"]) if binding else self.main

    @property
    def execution_config(self) -> dict:
        binding = self.data.get("execution_binding")
        return binding["config"] if binding else self.config

    @property
    def branch(self) -> str:
        return self.data["branch"]

    @property
    def task_rel(self) -> str:
        return f"{DIR_WORKFLOW}/{DIR_TASKS}/{self.name}"

    @property
    def tier(self) -> str:
        return resolve_tier(self.task_dir, self.data)

    def unit(self, partition: str | None) -> "Unit":
        """Where a step of ``partition`` runs (None/default: the task worktree)."""
        rec = (self.data.get("partitions") or {}).get(partition) if partition else None
        if rec is None:
            return Unit(None, self.worktree, self.branch)
        return Unit(partition, Path(rec["worktree"]), rec["branch"])


@dataclass(frozen=True)
class Unit:
    partition: str | None  # None: the task branch itself
    worktree: Path
    branch: str

    @property
    def label(self) -> str:
        return self.partition or "default"


# =============================================================================
# Resolution and persistence
# =============================================================================


def _repo_root() -> Path:
    cwd = Path.cwd().resolve()
    for candidate in (cwd, *cwd.parents):
        if (candidate / DIR_WORKFLOW).is_dir():
            return candidate
    raise DriverError(f"no {DIR_WORKFLOW}/ directory above {cwd}")


def _main() -> Path:
    root = _repo_root()
    # A `.git` directory marks the main checkout; skip asking git (hooks call `next` every turn).
    return root if (root / ".git").is_dir() else main_checkout(root)


def load_ctx(task_arg: str | None) -> Ctx | None:
    """The active task, or None when there is none."""
    main = _main()
    if task_arg:
        task_dir = resolve_task_ref(task_arg, main)
    else:
        active = resolve_active_task(main, allow_single_session_fallback=True)
        if not active.task_path or active.stale:
            return None
        # resolve_active_task already checked containment; absolute = started task
        path = Path(active.task_path)
        task_dir = path if path.is_absolute() else resolve_task_ref(active.task_path, main)
    if task_dir is None or not (task_dir / FILE_TASK_JSON).is_file():
        if task_arg:
            raise DriverError(f"task not found: {task_arg}")
        return None
    data, reason = read_json_checked(task_dir / FILE_TASK_JSON)
    if data is None:
        raise DriverError(f"cannot read {task_dir / FILE_TASK_JSON}: {reason}")
    started = bool(data.get("worktree_path") and data.get("branch") and data.get("base") and data.get("state"))
    if started:
        sm.ensure_fields(data)
        try:
            binding = ex.validate(main, read_arbor_config(main), data)
            if binding:
                control = binding["control"]
                expected = Path(control["worktree_path"]) / DIR_WORKFLOW / DIR_TASKS / task_dir.name
                if task_dir.resolve() != expected.resolve():
                    merged_copy = main / DIR_WORKFLOW / DIR_TASKS / task_dir.name
                    if (task_dir.resolve() == merged_copy.resolve() and data.get("state") == "FINISH"
                            and fin.is_merged(main, control["branch"], control["base_branch"])):
                        task_dir = expected
                    else:
                        raise ex.ExecutionError("task directory does not belong to the bound control worktree")
        except ex.ExecutionError as e:
            raise DriverError(str(e)) from None
    return Ctx(main, read_arbor_config(main), task_dir, task_dir.name, data, started)


def require_started(ctx: Ctx | None) -> Ctx:
    if ctx is None:
        raise DriverError("no active task (task.py start <task>, or pass --task)")
    if not ctx.started:
        raise DriverError(f"task {ctx.name} has not been started in a worktree (task.py start)")
    return ctx


def save(ctx: Ctx) -> None:
    """Write task.json; partitions entering a brief step get their dispatch id
    here (callers hold the task lock)."""
    for name in sm.unassigned_partitions(ctx.data):
        ctx.data["partitions"][name]["next_dispatch"] = next_dispatch_id(ctx.data, ctx.task_dir)
    if not write_json(ctx.task_dir / FILE_TASK_JSON, ctx.data):
        raise DriverError(f"failed to write {ctx.task_dir / FILE_TASK_JSON}")


def reload(ctx: Ctx) -> None:
    data, reason = read_json_checked(ctx.task_dir / FILE_TASK_JSON)
    if data is None:
        raise DriverError(f"cannot read {ctx.task_dir / FILE_TASK_JSON}: {reason}")
    if ctx.started:
        try:
            ex.validate(ctx.main, ctx.config, data)
        except ex.ExecutionError as e:
            raise DriverError(str(e)) from None
    ctx.data = sm.ensure_fields(data) if ctx.started else data


@contextmanager
def editing(ctx: Ctx) -> Iterator[Ctx]:
    """Hold the task lock and work on a fresh task.json (runs whose process
    died are marked aborted)."""
    try:
        with task_lock(ctx.task_dir):
            reload(ctx)
            sm.reap_stale(ctx.data, pid_alive)
            yield ctx
    except LockTimeout as e:
        raise DriverError(str(e)) from None


def git(ctx: Ctx, *args: str, cwd: Path | None = None) -> str:
    rc, out, err = run_git(list(args), cwd=cwd or ctx.worktree)
    if rc != 0:
        raise DriverError(f"git {' '.join(args)} failed: {err.strip()}")
    return out.strip()


def head(ctx: Ctx, worktree: Path | None = None) -> str:
    return git(ctx, "rev-parse", "HEAD", cwd=worktree)


def waves_of(ctx: Ctx) -> tuple[tuple[str, ...], ...] | None:
    path = find_contract(ctx.task_dir)
    if path is None:
        return None
    try:
        return load_contract(path).waves
    except ContractError:
        return None


def require_contract(ctx: Ctx) -> Contract:
    path = find_contract(ctx.task_dir)
    if path is None:
        raise DriverError(f"{ctx.name} has no contract.md")
    return load_contract(path)


def plan_for(ctx: Ctx, partition: str | None = None) -> sm.Step:
    return sm.plan(ctx.data, ctx.tier, waves_of(ctx), partition)


def commit_task_dir(ctx: Ctx, message: str) -> bool:
    """Commit pending changes under the task dir on the task branch."""
    git(ctx, "add", "-A", "--", ctx.task_rel, cwd=ctx.control_worktree)
    rc, _, _ = run_git(["diff", "--cached", "--quiet", "--", ctx.task_rel], cwd=ctx.control_worktree)
    if rc == 0:
        return False
    git(ctx, "commit", "-q", "--no-verify", "-m", message, "--", ctx.task_rel, cwd=ctx.control_worktree)
    return True


def touched_files(ctx: Ctx, worktree: Path | None = None) -> list[str]:
    rc, out, _ = run_git(["diff", "--name-only", f"{ctx.data['base']}..HEAD"], cwd=worktree or ctx.worktree)
    if rc != 0:
        return []
    return [p for p in out.splitlines() if p.strip() and not p.startswith(f"{DIR_WORKFLOW}/")]


def contract_changed(ctx: Ctx) -> bool:
    path = find_contract(ctx.task_dir)
    frozen = ctx.data.get("contract_hash")
    return bool(frozen) and (path is None or contract_hash(path) != frozen)


def guard_contract(ctx: Ctx) -> None:
    """STOP(HUMAN) when contract.md changed since approval."""
    if ctx.data.get("state") not in ("STOP", "CONTRACT") and contract_changed(ctx):
        with editing(ctx):
            sm.stop(ctx.data, "HUMAN", "contract.md changed since approval; re-approve it with `arbor resume`",
                    contract=True)
            save(ctx)
        raise DriverError(ctx.data["stop"]["detail"])


def next_dispatch_id(data: dict, task_dir: Path | None = None) -> str:
    """One past the highest id in task.json ``dispatches``, the ids already
    assigned to partitions, and ``reports/`` (a report whose record was lost
    still reserves its id)."""
    ids = [str(d.get("id", "")) for d in data.get("dispatches") or [] if isinstance(d, dict)]
    ids += [str(r.get("next_dispatch") or "") for r in (data.get("partitions") or {}).values()]
    if task_dir is not None and (task_dir / "reports").is_dir():
        ids += [p.stem for p in (task_dir / "reports").glob("d-*.md")]
    numbers = [int(i[2:]) for i in ids if i.startswith("d-") and i[2:].isdigit()]
    return f"d-{max(numbers, default=0) + 1:03d}"


def brief_path(ctx: Ctx, dispatch: str) -> Path:
    return ctx.task_dir / "briefs" / f"{dispatch}.md"


def runtime_dir(main: Path, *parts: str) -> Path:
    path = main.joinpath(RUNTIME, *parts)
    path.mkdir(parents=True, exist_ok=True)
    return path


def append_result(main: Path, row: dict) -> None:
    with (runtime_dir(main) / "results.jsonl").open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(row, ensure_ascii=False) + "\n")


def build_prompt(worktree: Path, task_dir: Path | None, role: str, mode: str | None,
                 range_spec: str | None, dispatch: str | None, brief: str, execution_root: Path | None = None) -> str:
    if execution_root is not None:
        brief = (f"Control repository: {worktree} (read only).\nExecution repository: {execution_root}.\n"
                 "Run all code edits, Git commands and tests in the execution repository. "
                 "Task/spec paths belong to the control repository; do not modify control artifacts.\n\n" + brief)
    header = DispatchHeader(
        task_dir=str(task_dir) if task_dir else None, role=role, mode=mode,
        body=brief.strip(), range=range_spec, dispatch=dispatch,
    )
    return build_dispatch_prompt(
        DispatchRequest(repo_root=worktree, role=role, task_dir=task_dir, header=header, original_text=brief, execution_root=execution_root)
    ).text


# =============================================================================
# next / status
# =============================================================================


def _max_parallel(config: dict) -> int | None:
    section = get_executors_config(config)
    spec = section.get(str(section.get("default") or ""))
    value = spec.get("max_parallel") if isinstance(spec, dict) else None
    return int(value) if isinstance(value, int) or (isinstance(value, str) and value.isdigit()) else None


def next_payload(ctx: Ctx | None, partition: str | None = None) -> dict:
    if ctx is None:
        external = mcp.find_pending(_main())
        if external:
            path, record = external
            return {"task": None, "state": record["state"], "needs": "delegation",
                    "dispatch": record["dispatch"], "request_path": str(path),
                    "task_id": record.get("task_id"),
                    "summary": f"MCP delegation pending: read {path}, bind/poll its task_id, then collect"}
        pending = fin.pending_records(_main())
        if pending:
            return {"task": pending[0], "state": "FINISH", "needs": "run",
                    "summary": f"FINISH: cleanup of {', '.join(pending)} is incomplete: `arbor finish`"}
        return {"task": None, "state": "INTAKE", "needs": "human", "started": False,
                "summary": "No active task: agree a tier, write contract.md, then `task.py start`"}
    pending = _pending(ctx, partition)
    if pending:
        path, record = pending
        return {"task": ctx.name, "state": record["state"], "needs": "delegation",
                "dispatch": record["dispatch"], "role": record["role"], "request_path": str(path),
                "task_id": record.get("task_id"), "started": ctx.started,
                "delegation_started": record["started"],
                "summary": f"MCP delegation {record['dispatch']}: " + (
                    f"poll/resume task {record['task_id']}, then arbor collect --request {path} --result <file>"
                    if record.get("task_id") else f"read {path}, call codeg MCP once, then arbor bind")}
    if not ctx.started:
        dispatch = next_dispatch_id(ctx.data, ctx.task_dir)
        return {"task": ctx.name, "state": "CONTRACT", "needs": "human", "started": False, "dispatch": dispatch,
                "brief_path": str(brief_path(ctx, dispatch)), "human": {"kind": "approve_contract"},
                "contract_roles": list(CONTRACT_ROLES),
                "summary": f"CONTRACT: finish {ctx.name}/contract.md (research with `arbor run --role "
                           "explore|architect|review [--mode plan]` after writing the brief); after human "
                           "approval run `task.py start`"}
    data = ctx.data
    sm.reap_stale(data, pid_alive)  # in memory only; the next locked write persists it
    if data.get("state") not in ("STOP", "CONTRACT") and contract_changed(ctx):
        step = sm.Step("human", f"{data['state']}: contract.md changed since approval; "
                       "a human re-approves it with `arbor resume`",
                       human={"kind": "approve_contract"})
    elif data.get("state") == "FINISH" and not data.get("override_role"):
        step = fin.plan_finish(ctx.main, ctx.task_dir, data)
    else:
        step = plan_for(ctx, partition)
    unit = ctx.unit(step.partition)
    out: dict = {"task": ctx.name, "state": data["state"], "tier": ctx.tier, "wave": data.get("wave", 1),
                 "partition": unit.label, "partitions_pending": list(step.pending), "needs": step.needs}
    if step.role:
        dispatch = step.dispatch or next_dispatch_id(data, ctx.task_dir)
        out["role"] = step.role
        out["mode"] = step.mode
        if step.role in RANGE_ROLES and step.range_from:
            out["range"] = f"{step.range_from}..{head(ctx, unit.worktree)}"
        out["dispatch"] = dispatch
        out["brief_path"] = str(brief_path(ctx, dispatch))
    if step.decision:
        out["decision"] = step.decision
    if step.human:
        out["human"] = step.human
    out["touched_files"] = touched_files(ctx, unit.worktree)
    summary = step.summary
    if step.pending:
        limit = _max_parallel(ctx.config)
        summary += (f"; also ready: {', '.join(step.pending)} (brief each from `next --partition P`, then "
                    f"`arbor run --partition P` in parallel{f', at most {limit} at once' if limit else ''})")
    out["summary"] = summary
    return out


def cmd_next(args: argparse.Namespace) -> int:
    payload = next_payload(load_ctx(args.task), args.partition)
    if args.json:
        print(json.dumps(payload, ensure_ascii=False))
        return 0
    print(colored(payload["summary"], Colors.CYAN))
    for key in ("role", "mode", "range", "dispatch", "brief_path"):
        if payload.get(key):
            print(f"  {key}: {payload[key]}")
    if payload.get("partition") not in (None, "default"):
        print(f"  partition: {payload['partition']}")
    if payload.get("decision"):
        print(f"  decision: {json.dumps(payload['decision'])}")
    if payload.get("touched_files"):
        print(f"  touched: {', '.join(payload['touched_files'])}")
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    ctx = require_started(load_ctx(args.task))
    d = ctx.data
    print(colored(f"{ctx.name}  {d['state']}/{sm.step_of(d)}  tier {ctx.tier}", Colors.CYAN))
    print(f"  worktree: {ctx.worktree} ({ctx.branch}, base {d['base'][:12]})")
    print(f"  counters: {json.dumps(d['counters'])}")
    if d.get("stop"):
        print(colored(f"  stop: {d['stop'].get('reason')}: {d['stop'].get('detail')}", Colors.RED))
    if d.get("partitions"):
        print(f"  wave {d.get('wave', 1)}:")
        for name, rec in d["partitions"].items():
            running = (rec.get("running") or {}).get("dispatch")
            what = f"running {running}" if running else (f"merged {rec['merged'][:12]}" if rec.get("merged")
                                                         else rec.get("step"))
            print(f"    {name:<12} {what:<20} {rec.get('branch')}  {rec.get('worktree')}")
    if d.get("merge_conflict"):
        c = d["merge_conflict"]
        print(colored(f"  merge conflict: {c.get('partition')} ({', '.join(c.get('files') or [])})", Colors.RED))
    if d["state"] == "FINISH":
        print(f"  finish: {fin.finish_stage(ctx.main, ctx.task_dir, d)}")
    for entry in d["dispatches"][-5:]:
        part = f" [{entry['partition']}]" if entry.get("partition") else ""
        print(f"  {entry.get('id')} {entry.get('role'):<9} {entry.get('status'):<9} {entry.get('commit') or ''}{part}")
    print(f"  next: {plan_for(ctx).summary}")
    return 0


# =============================================================================
# run
# =============================================================================


@dataclass
class Outcome:
    status: str  # ok | fail | violation
    reply: str
    check: rv.ReplyCheck
    exec_result: ExecResult | None
    violations: list[str]
    problem: str | None
    range_spec: str | None
    head_before: str
    head_after: str


@dataclass
class Job:
    """One dispatch between its locked start and its locked finish."""
    dispatch: str
    role: str
    mode: str | None
    state: str
    step: str
    range_from: str | None
    unit: Unit
    brief: str
    override: dict | None


def _pending(ctx: Ctx, partition: str | None = None) -> tuple[Path, dict] | None:
    for path in (ctx.data.get("mcp_pending") or {}).values():
        pair = mcp.load(ctx.main, path)
        if partition is None or pair[1].get("partition") == partition:
            return pair
    return None


def require_collected(ctx: Ctx) -> None:
    if ctx.data.get("mcp_pending"):
        raise DriverError("an MCP dispatch is pending; cancel/finish it and collect its terminal report first")


def prepare_mcp(ctx: Ctx | None, main: Path, executor, role: str, mode: str | None, dispatch: str,
                kind: str, worktree: Path, branch: str, prompt: str, before, **extra) -> int:
    """Caller holds the task lock. Persist the handoff before returning to the host."""
    if ctx is None:
        pending = mcp.find_pending(main)
        if pending:
            print(json.dumps(mcp.envelope(*pending), ensure_ascii=False))
            return 0
    if ctx and _pending(ctx, None if ctx.data.get("execution_binding") else extra.get("partition")):
        raise DriverError("an MCP dispatch is already pending; poll/collect it before starting another")
    if ctx is None or kind == "canary":
        dispatch = f"{dispatch}-{uuid4().hex[:8]}"
    path = mcp.pending_path(main, ctx.name if ctx else "_intake", dispatch)
    record = {
        "schema": 1, "main": str(main), "task_dir": str(ctx.task_dir) if ctx else None,
        "task": ctx.name if ctx else None, "dispatch": dispatch, "role": role, "mode": mode,
        "kind": kind, "state": ctx.data.get("state", "CONTRACT") if ctx else "INTAKE",
        "worktree": str(worktree), "branch": branch, "executor": executor.name,
        "timeout_s": executor.timeout, "started": utc_now(), "task_id": None, "status": "pending",
        "before": mcp.snapshot_dict(before), "mcp": mcp.request(executor, role, prompt, worktree), **extra,
    }
    mcp.store(path, record)
    if ctx:
        ctx.data.setdefault("mcp_pending", {})[dispatch] = str(path)
        if kind != "canary":
            entry = {"id": dispatch, "role": role, "mode": mode, "status": "running",
                     "started": record["started"], "ended": None, "commit": None,
                     **({"phase": "CONTRACT"} if kind == "contract" else {}),
                     **({"partition": extra["partition"]} if extra.get("partition") else {})}
            entries = ctx.data.setdefault("dispatches", [])
            slot = next((i for i, d in enumerate(entries) if d.get("id") == dispatch), None)
            if slot is None:
                entries.append(entry)
            else:
                entries[slot] = entry
        if extra.get("partition"):
            ctx.data["partitions"][extra["partition"]]["running"]["external"] = True
        save(ctx)
    # Driver-created metadata must not be mistaken for the child's writes.
    record["before"] = mcp.snapshot_dict(snapshot_refs(worktree))
    if ctx and ctx.started and ctx.data.get("execution_binding"):
        record["control_before"] = ex.snapshot_control(ctx.main, ctx.control_worktree, ctx.task_rel, ctx.execution_main)
    mcp.store(path, record)
    print(json.dumps(mcp.envelope(path, record), ensure_ascii=False))
    return 0


def prepare_run(ctx: Ctx, job: Job, executor) -> int:
    unit = job.unit
    base = head(ctx, unit.worktree)
    range_spec = f"{job.range_from}..{base}" if job.range_from and job.role in RANGE_ROLES else None
    contract = require_contract(ctx)
    paths = _partition_paths(contract, unit.partition)
    brief = pt.scope_line(unit.worktree, unit.branch, paths) + "\n\n" + job.brief if unit.partition else job.brief
    prompt = build_prompt(ctx.control_worktree, ctx.task_dir, job.role, job.mode, range_spec, job.dispatch, brief, unit.worktree if ctx.data.get("execution_binding") else None)
    (runtime_dir(ctx.main, "prompts", ctx.name) / f"{job.dispatch}.md").write_text(prompt, encoding="utf-8")
    job_data = {**asdict(job), "unit": {"partition": unit.partition, "worktree": str(unit.worktree),
                                      "branch": unit.branch}}
    return prepare_mcp(ctx, ctx.main, executor, job.role, job.mode, job.dispatch, "run", unit.worktree,
                       unit.branch, prompt, snapshot_refs(unit.worktree), job=job_data,
                       partition=unit.partition, range_spec=range_spec, head_before=base, paths=paths,
                       test_paths=effective_test_paths(contract, get_test_paths(ctx.config)))


def cmd_bind(args: argparse.Namespace) -> int:
    main = _main()
    path, record = mcp.load(main, args.request)
    ctx = load_ctx(record["task_dir"]) if record.get("task_dir") else None
    if not args.task_id.strip():
        raise DriverError("task_id cannot be empty")
    with editing(ctx) if ctx else task_lock(runtime_dir(main, "mcp-intake")):
        path, record = mcp.load(main, args.request)
        if record["status"] != "pending":
            raise DriverError("this MCP dispatch has already been collected")
        if record.get("task_id") not in (None, args.task_id):
            raise DriverError("dispatch is already bound to a different codeg task_id")
        record["task_id"] = args.task_id
        mcp.store(path, record)
    print(json.dumps(mcp.envelope(path, record), ensure_ascii=False))
    return 0


def cmd_collect(args: argparse.Namespace) -> int:
    main = _main()
    path, record = mcp.load(main, args.request)
    ctx = load_ctx(record["task_dir"]) if record.get("task_dir") else None
    payload = json.loads(Path(args.result).read_text(encoding="utf-8"))
    with editing(ctx) if ctx else task_lock(runtime_dir(main, "mcp-intake")):
        path, record = mcp.load(main, args.request)
        if record["status"] != "pending":
            raise DriverError("this MCP dispatch has already been collected")
        if ctx and (ctx.data.get("mcp_pending") or {}).get(record["dispatch"]) != str(path):
            raise DriverError("MCP request is no longer pending in this task")
        if record.get("control_before") and ctx:
            try:
                ex.check_control(ctx.main, ctx.control_worktree, ctx.task_rel, record["control_before"], ctx.execution_main)
            except ex.ExecutionError as e:
                raise DriverError(str(e)) from None
        result, report = mcp.terminal_result(record, payload)
        before = mcp.snapshot_from(record["before"])
        role, mode, dispatch = record["role"], record["mode"], record["dispatch"]
        if record["kind"] == "run":
            assert ctx is not None
            if contract_changed(ctx):
                raise DriverError("contract changed during delegation; restore the approved contract before collecting")
            data = record["job"]
            unit = Unit(data["unit"]["partition"], Path(data["unit"]["worktree"]), data["unit"]["branch"])
            job = Job(**{**data, "unit": unit})
            if ctx.data["state"] != job.state:
                raise DriverError("task state changed while delegated; resolve the pending task before advancing")
            out = validate_dispatch(ctx, unit, role, dispatch, before, record["test_paths"], record["paths"],
                                    record["head_before"], record["range_spec"], result)
            red = None
            if unit.partition and role == "test" and out.status == "ok":
                contract = require_contract(ctx)
                spec = contract.partition(unit.partition)
                red = run_red_check(contract, unit.worktree, spec.paths if spec else ())
            ctx.data["mcp_pending"].pop(dispatch)
            _finish(ctx, job, out, red)
            rc = 0 if out.status == "ok" else 1
            print(f"{dispatch} {role}: {out.status}; report: {ctx.task_dir / 'reports' / (dispatch + '.md')}")
        elif record["kind"] == "contract":
            if ctx:
                if ctx.started:
                    raise DriverError("task was started before its pending CONTRACT dispatch was collected")
                ctx.data["mcp_pending"].pop(dispatch)
                ctx.data["dispatches"] = [d for d in ctx.data["dispatches"] if d.get("id") != dispatch]
            rc = finish_contract(ctx, main, read_arbor_config(main), role, mode, dispatch, record["branch"],
                                 record["task_rel"], before, result)
        else:
            rc = finish_canary(ctx, main, Path(record["worktree"]), role, before, result)
            if ctx:
                ctx.data["mcp_pending"].pop(dispatch)
                save(ctx)
        record.update(status="collected", driver_exit_code=rc, ended=utc_now(),
                      child_conversation_id=report.get("child_conversation_id"))
        mcp.store(path, record)
    return rc


def _restore(ctx: Ctx, unit: Unit, before) -> None:
    """Put the unit's branch back where it was before the dispatch."""
    after = snapshot_refs(unit.worktree)
    if after.head_ref != before.head_ref:
        run_git(["checkout", "-q", "-f", unit.branch], cwd=unit.worktree)
    run_git(["reset", "-q", "--hard", before.head], cwd=unit.worktree)
    stray = sorted(
        p for p in snapshot_refs(unit.worktree).dirty - before.dirty
        if not p.startswith(f"{ctx.task_rel}/")
    )
    if stray:
        run_git(["clean", "-fdq", "--", *stray], cwd=unit.worktree)


_MOVED_RE = re.compile(r"^branch (\S+) moved [0-9a-f]+ -> [0-9a-f]+$")


def _driver_only(ctx: Ctx, old: str, new: str) -> bool:
    """Commits ``old..new`` on the task branch are the driver's task-dir commits."""
    rc, subjects, _ = run_git(["log", "--format=%s", f"{old}..{new}"], cwd=ctx.worktree)
    rc2, files, _ = run_git(["diff", "--name-only", f"{old}..{new}"], cwd=ctx.worktree)
    return (rc == 0 and rc2 == 0
            and all(line.startswith(f"arbor({ctx.name}): ") for line in subjects.splitlines() if line.strip())
            and all(f.startswith(f"{ctx.task_rel}/") for f in files.splitlines() if f.strip()))


def _concurrent_moves(ctx: Ctx, unit: Unit, before, violations: list[str]) -> list[str]:
    """A partition dispatch runs next to its siblings: their branches move,
    and the task branch takes the driver's task-dir commits. Drop exactly
    those moves from the violations."""
    data, _ = read_json_checked(ctx.task_dir / FILE_TASK_JSON)
    siblings = {rec.get("branch") for name, rec in ((data or {}).get("partitions") or {}).items()
                if name != unit.partition}
    kept: list[str] = []
    for v in violations:
        match = _MOVED_RE.match(v)
        ref = match.group(1) if match else None
        if ref in siblings:
            continue
        if ref == ctx.branch:
            rc, now, _ = run_git(["rev-parse", ctx.branch], cwd=ctx.worktree)
            if rc == 0 and _driver_only(ctx, before.branches[ref], now.strip()):
                continue
        kept.append(v)
    return kept


def dispatch_once(ctx: Ctx, unit: Unit, role: str, mode: str | None, range_from: str | None, dispatch: str,
                  brief: str) -> Outcome:
    """Run one dispatch in ``unit``'s worktree and check it; no task.json writes."""
    head_before = head(ctx, unit.worktree)
    range_spec = f"{range_from}..{head_before}" if range_from and role in RANGE_ROLES else None
    contract_path = find_contract(ctx.task_dir)
    contract = load_contract(contract_path) if contract_path else None
    paths = _partition_paths(contract, unit.partition)
    if unit.partition:
        brief = pt.scope_line(unit.worktree, unit.branch, paths) + "\n\n" + brief.strip()
    prompt = build_prompt(ctx.control_worktree, ctx.task_dir, role, mode, range_spec, dispatch, brief, unit.worktree if ctx.data.get("execution_binding") else None)
    prompt_file = runtime_dir(ctx.main, "prompts", ctx.name) / f"{dispatch}.md"
    prompt_file.write_text(prompt, encoding="utf-8")

    test_paths = (
        effective_test_paths(contract, get_test_paths(ctx.config)) if contract else get_test_paths(ctx.config)
    )
    before = snapshot_refs(unit.worktree)
    try:
        executor = resolve_executor(ctx.config)
    except ExecutorError as e:
        empty = rv.ReplyCheck(False, str(e))
        return Outcome("fail", "", empty, None, [], str(e), range_spec, head_before, head_before)
    control_before = ex.snapshot_control(ctx.main, ctx.control_worktree, ctx.task_rel, ctx.execution_main) if ctx.data.get("execution_binding") else None
    result = run_executor(executor, role=role, prompt_path=prompt_file, worktree=unit.worktree,
                          task=ctx.name, dispatch=dispatch)
    if control_before:
        try:
            ex.check_control(ctx.main, ctx.control_worktree, ctx.task_rel, control_before, ctx.execution_main)
        except ex.ExecutionError as e:
            raise DriverError(str(e)) from None
    return validate_dispatch(ctx, unit, role, dispatch, before, test_paths, paths, head_before, range_spec, result)


def validate_dispatch(ctx: Ctx, unit: Unit, role: str, dispatch: str, before, test_paths, paths,
                      head_before: str, range_spec: str | None, result: ExecResult) -> Outcome:
    """Identical acceptance checks for command executors and external MCP replies."""
    reply = result.stdout
    violations = check_after_dispatch(role, before, unit.worktree, own_branch=unit.branch, test_paths=test_paths,
                                      task_rel_dir=(f"__control__/{ctx.name}" if ctx.data.get("execution_binding") else ctx.task_rel), dispatch_id=dispatch)
    if unit.partition:
        violations = _concurrent_moves(ctx, unit, before, violations)
        new_dirty = _dirty_paths(unit.worktree) - before.dirty
        outside = pt.outside_paths(unit.worktree, head_before, new_dirty, paths, ctx.task_rel)
        if outside and role in WRITER_ROLES:
            violations.append(f"{role} touched files outside partition {unit.partition}: {', '.join(outside)}")
    if role in WRITER_ROLES:
        leftover = sorted(
            p for p in _dirty_paths(unit.worktree) - before.dirty
            if not p.startswith(f"{ctx.task_rel}/")
        )
        if leftover:
            violations.append(f"{role} left uncommitted changes: {', '.join(leftover)}")
    check = rv.check_reply(role, reply)
    violations = rv.adjust_violations(role, violations, reply, check)

    if violations and not rv.only_missing_commit(violations):
        status, problem = "violation", "; ".join(violations)
    elif not result.ok:
        status, problem = "fail", result.error
    elif violations:
        status, problem = "fail", violations[0]
    elif not check.ok:
        status, problem = "fail", check.problem
    else:
        status, problem = "ok", check.problem
    if status != "ok" and not ctx.data.get("execution_binding"):
        _restore(ctx, unit, before)
    return Outcome(status, reply, check, result, violations, problem, range_spec, head_before,
                   head(ctx, unit.worktree))


def _partition_paths(contract: Contract | None, partition: str | None) -> tuple[str, ...]:
    spec = contract.partition(partition) if contract and partition else None
    return spec.paths if spec else ()


def _partition_brief(ctx: Ctx, partition: str | None, brief: str) -> str:
    """``brief`` as a partition dispatch receives it (``prompt --print`` rebuilds it
    after the partition worktree is gone: the names are deterministic)."""
    if not partition:
        return brief
    contract_path = find_contract(ctx.task_dir)
    paths = _partition_paths(load_contract(contract_path) if contract_path else None, partition)
    worktree = partition_worktree_path(ctx.execution_main, ctx.execution_config, ctx.name, partition)
    line = pt.scope_line(worktree.resolve(), partition_branch(ctx.name, partition), paths)
    return line + "\n\n" + brief.strip()


def _red_notes(red: RedResult) -> list[str]:
    notes = ["### Red check", format_checks(red.checks) or "- no auto checks"]
    if not red.valid:
        notes.append(f"Not a valid red: passing {red.passing or '-'}, collection errors {red.errored or '-'}")
    return notes


def _prefilter_report(ctx: Ctx, findings: list[dict], range_spec: str, rel: str) -> tuple[list[dict], int]:
    """Prefilter ``findings`` over ``range_spec`` and write ``<task>/<rel>``;
    returns the kept findings and the number dropped."""
    kept, dropped = rv.prefilter(rv.dedup(findings), ctx.worktree, range_spec)
    (ctx.task_dir / "reports").mkdir(exist_ok=True)
    (ctx.task_dir / rel).write_text(json.dumps({
        "range": range_spec,
        "kept": [{"id": rv.finding_id(f), **f} for f in kept],
        "dropped": [{"id": rv.finding_id(f), "reason": why, **f} for f, why in dropped],
    }, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return kept, len(dropped)


def _advance(ctx: Ctx, state: str, step: str, role: str, dispatch: str, out: Outcome) -> list[str]:
    """Apply the state table after an ok dispatch on the task branch; returns extra report lines."""
    data, notes = ctx.data, []
    if (state, step) == ("BUILD", "test"):
        contract = load_contract(find_contract(ctx.task_dir))
        red = run_red_check(contract, ctx.worktree)
        sm.on_red_check(data, red.passing, red.errored)
        notes += _red_notes(red)
    elif (state, step) == ("REVIEW", "review"):
        ids = [rv.finding_id(f) for f in out.check.findings
               if str(f.get("verdict", "")).upper() in ("CONFIRMED", "PLAUSIBLE")]
        sm.on_review(data, ctx.tier, out.check.verdict or "FAIL", ids, out.range_spec.split("..")[0], out.head_before)
    elif (state, step) == ("POLISH", "candidates"):
        polish = data.setdefault("polish", {})
        polish.setdefault("candidate_findings", []).extend(out.check.findings)
        if sm.on_candidate(data, ctx.tier, dispatch, out.head_before):
            number = data["counters"].get("polish", 0) + 1
            rel = f"reports/candidates-r{number}.json"
            findings = polish.pop("candidate_findings", [])
            kept, dropped = _prefilter_report(ctx, findings, f"{polish.get('range_from')}..{out.head_before}", rel)
            sm.on_candidates_filtered(data, [rv.finding_id(f) for f in kept], f"{ctx.task_rel}/{rel}", ctx.tier)
            notes.append(f"### Prefilter\n- kept {len(kept)}, dropped {dropped} -> {rel}")
    elif (state, step) == ("POLISH", "sweep"):
        rel = "reports/sweep.json"
        range_from = (data.get("polish") or {}).get("range_from") or data.get("base")
        kept, dropped = _prefilter_report(ctx, out.check.findings, f"{range_from}..{out.head_before}", rel)
        sm.on_sweep_filtered(data, [rv.finding_id(f) for f in kept], f"{ctx.task_rel}/{rel}", out.head_before)
        notes.append(f"### Prefilter\n- kept {len(kept)}, dropped {dropped} -> {rel}")
    elif (state, step) == ("POLISH", "verify"):
        by = lambda v: [rv.finding_id(f) for f in out.check.findings if str(f.get("verdict", "")).upper() == v]
        sm.on_verify(data, by("CONFIRMED"), by("PLAUSIBLE"), ctx.tier)
    elif role in WRITER_ROLES:
        sm.on_writer_done(data, state, step, out.head_after != out.head_before)
    return notes


def _advance_partition(ctx: Ctx, job: Job, red: RedResult | None) -> list[str]:
    name = job.unit.partition
    assert name is not None
    if job.role == "test":
        assert red is not None
        sm.on_partition_red_check(ctx.data, name, red.passing, red.errored)
        return _red_notes(red)
    sm.on_partition_implemented(ctx.data, name)
    return []


def _write_report(ctx: Ctx, dispatch: str, role: str, out: Outcome, notes: list[str],
                  partition: str | None = None) -> None:
    lines = [out.reply.rstrip(), "", "---", "", f"## Driver: {dispatch} {role} {out.status}", ""]
    res = out.exec_result
    if partition:
        lines.append(f"- partition: {partition}")
    if res is not None:
        lines.append(f"- executor: {res.executor} (exit {res.exit_code}, {res.duration_s}s)")
    lines += [f"- range: {out.range_spec or '-'}", f"- confidence: {out.check.confidence}"]
    if out.problem:
        lines.append(f"- problem: {out.problem}")
    if out.violations:
        lines += ["", "### Violations", *[f"- {v}" for v in out.violations]]
    if notes:
        lines += ["", *notes]
    if res is not None and res.stderr.strip():
        tail = res.stderr.rstrip().splitlines()[-STDERR_TAIL_LINES:]
        lines += ["", "### Executor stderr (tail)", "```", *tail, "```"]
    path = ctx.task_dir / "reports" / f"{dispatch}.md"
    path.parent.mkdir(exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _begin(ctx: Ctx, step: sm.Step, requested: str | None) -> Job:
    """Locked: pick the dispatch id, check the brief and the worktree, mark a
    partition running, commit the brief."""
    data = ctx.data
    if data.get("execution_binding") and (data.get("mcp_pending") or any(
            p.get("running") for p in (data.get("partitions") or {}).values())):
        raise DriverError("product task dispatches are serialized; collect/finish the running dispatch first")
    dispatch = step.dispatch or next_dispatch_id(data, ctx.task_dir)
    if requested and requested != dispatch:
        raise DriverError(f"the next dispatch{' of ' + step.partition if step.partition else ''} is "
                          f"{dispatch}, not {requested}")
    brief_file = brief_path(ctx, dispatch)
    brief = brief_file.read_text(encoding="utf-8") if brief_file.is_file() else ""
    if not brief.strip():
        raise DriverError(f"write the brief first: {brief_file}")
    unit = ctx.unit(step.partition)
    rc, dirty, _ = run_git(["diff", "--name-only", "HEAD", "--", ".", f":(exclude){ctx.task_rel}"],
                           cwd=unit.worktree)
    if rc == 0 and dirty.strip():
        raise DriverError(f"uncommitted changes in {unit.worktree}: {', '.join(dirty.split())}; commit or discard them")

    if unit.partition:
        state, step_name = "BUILD", data["partitions"][unit.partition]["step"]
        sm.on_partition_dispatch(data, unit.partition, dispatch, os.getpid())
        data["dispatches"].append({
            "id": dispatch, "role": step.role, "mode": step.mode, "partition": unit.partition, "commit": None,
            "status": "running", "started": utc_now(), "ended": None, "range": None, "confidence": None,
        })
        save(ctx)
    else:
        state, step_name = data["state"], sm.step_of(data)
    assert step.role is not None
    commit_task_dir(ctx, f"arbor({ctx.name}): {dispatch} {step.role} brief")
    return Job(dispatch, step.role, step.mode, state, step_name, step.range_from, unit, brief,
               data.get("override_role") if not unit.partition else None)


def _finish(ctx: Ctx, job: Job, out: Outcome, red: RedResult | None) -> None:
    """Locked, on a fresh task.json: apply the outcome, record, commit."""
    data, role, dispatch, name = ctx.data, job.role, job.dispatch, job.unit.partition
    notes: list[str] = []
    if name:
        sm.on_partition_finished(data, name)
    if job.override:
        data.pop("override_role", None)
    if out.status == "violation":
        sm.on_violation(data, role, dispatch, out.violations)
    elif out.status == "fail":
        if name:
            sm.on_partition_failed(data, name, role)
        else:
            sm.on_dispatch_failed(data, role)
    elif name:
        notes = _advance_partition(ctx, job, red)
    elif not job.override:
        notes = _advance(ctx, job.state, job.step, role, dispatch, out)

    res = out.exec_result
    commit = out.head_after if out.status == "ok" and out.head_after != out.head_before else None
    entry = {
        "id": dispatch, "role": role, "mode": job.mode, "commit": commit, "status": out.status,
        "started": res.started if res else utc_now(), "ended": res.ended if res else utc_now(),
        "range": out.range_spec, "confidence": out.check.confidence,
        **({"partition": name} if name else {}),
        **({"override": True} if job.override else {}),
    }
    slot = next((i for i, d in enumerate(data["dispatches"]) if d.get("id") == dispatch), None)
    if slot is None:
        data["dispatches"].append(entry)
    else:
        data["dispatches"][slot] = entry
    _write_report(ctx, dispatch, role, out, notes, name)
    save(ctx)
    commit_task_dir(ctx, f"arbor({ctx.name}): {dispatch} {role} {out.status}")
    append_result(ctx.main, {
        "ts": utc_now(), "task": ctx.name, "dispatch": dispatch, "role": role, "mode": job.mode,
        "state": job.state, "wave": data.get("wave", 1), "partition": job.unit.label,
        "executor": res.executor if res else None,
        "started": res.started if res else None, "ended": res.ended if res else None,
        "duration_s": res.duration_s if res else 0, "exit_code": res.exit_code if res else None,
        "status": out.status, "commit": commit, "violations": out.violations,
    })


def cmd_run(args: argparse.Namespace) -> int:
    if getattr(args, "autopilot", False):
        return cmd_autopilot(args)
    if args.role:
        return cmd_run_contract(args)
    if args.mode:
        raise DriverError("--mode goes with --role review")
    ctx = require_started(load_ctx(args.task))
    guard_contract(ctx)
    with editing(ctx):
        pending = _pending(ctx, args.partition)
        if pending:
            print(json.dumps(mcp.envelope(*pending), ensure_ascii=False))
            return 0
        step = plan_for(ctx, args.partition)
        if step.action == "start_wave":
            return start_wave(ctx)
        if step.action == "merge":
            return merge_wave(ctx)
        executor = resolve_executor(ctx.config) if step.needs == "brief" else None
        if executor is not None and executor.kind == "codeg-mcp":
            limit = _max_parallel(ctx.config)
            if limit and len(ctx.data.get("mcp_pending") or {}) >= limit:
                raise DriverError(f"MCP max_parallel={limit} reached; collect an existing delegation first")
        job = _begin(ctx, step, args.dispatch) if step.needs == "brief" else None
        if job is not None and executor is not None and executor.kind == "codeg-mcp":
            return prepare_run(ctx, job, executor)
    if step.action == "gate":
        return cmd_gate(args, ctx)
    if job is None:
        print(colored(step.summary, Colors.YELLOW))
        return 1

    where = f" [{job.unit.partition}]" if job.unit.partition else ""
    print(colored(f"{job.dispatch}: {job.role}{' (' + job.mode + ')' if job.mode else ''}{where} in "
                  f"{job.unit.worktree}", Colors.BLUE))
    out = dispatch_once(ctx, job.unit, job.role, job.mode, job.range_from, job.dispatch, job.brief)
    red = None
    if job.unit.partition and job.role == "test" and out.status == "ok":
        contract = require_contract(ctx)
        spec = contract.partition(job.unit.partition)
        red = run_red_check(contract, job.unit.worktree, spec.paths if spec else ())
    with editing(ctx):
        _finish(ctx, job, out, red)

    color = Colors.GREEN if out.status == "ok" else Colors.RED
    print(colored(f"{job.dispatch} {job.role}: {out.status}" + (f" ({out.problem})" if out.problem else ""), color))
    print(f"  report: {ctx.task_dir / 'reports' / (job.dispatch + '.md')}")
    print(f"  next: {plan_for(ctx, job.unit.partition if ctx.data.get('state') == 'BUILD' else None).summary}")
    return 0 if out.status == "ok" else 1


# ======================================================================# waves: partition worktrees and merge-back
# =============================================================================


def start_wave(ctx: Ctx) -> int:
    """Locked: create the wave's partition branches and worktrees from the task HEAD."""
    data = ctx.data
    contract = require_contract(ctx)
    wave = data.get("wave", 1)
    parts = sm.wave_partitions(contract.waves, wave)
    start = head(ctx)
    records: dict[str, dict] = {}
    for name in parts:
        try:
            rec = pt.create_partition(ctx.execution_main, ctx.execution_config, ctx.name, name, start)
        except WorktreeError as e:
            raise DriverError(f"wave {wave}: {e}") from None
        rec["step"] = pt.first_step(contract, name)
        records[name] = rec
        print(colored(f"  {name}: {rec['worktree']} ({rec['branch']}), first step {rec['step']}", Colors.GREEN))
    sm.on_wave_started(data, records)
    save(ctx)
    commit_task_dir(ctx, f"arbor({ctx.name}): start wave {wave} ({', '.join(parts)})")
    step = plan_for(ctx)
    print(colored(f"wave {wave} started", Colors.GREEN))
    print(f"  next: {step.summary}" + (f" (also ready: {', '.join(step.pending)})" if step.pending else ""))
    return 0


def _merge_remaining(ctx: Ctx) -> int:
    """Locked: merge the wave's unmerged partitions in wave order; on success
    remove the partition worktrees and move to the next wave or GATE."""
    data = ctx.data
    wave = data.get("wave", 1)
    waves = waves_of(ctx) or ((sm.DEFAULT_PARTITION,),)
    order = [p for p in sm.wave_partitions(waves, wave) if p in data["partitions"]]
    rc, dirty, _ = run_git(["status", "--porcelain", "--", ".", f":(exclude){ctx.task_rel}"], cwd=ctx.worktree)
    if rc == 0 and dirty.strip():
        raise DriverError(f"uncommitted changes in {ctx.worktree}; commit or discard them before the merge")
    result = pt.merge_partitions(ctx.worktree, ctx.name, wave, order, data["partitions"])
    for name, sha in result.merged:
        sm.on_partition_merged(data, name, sha)
        print(colored(f"  merged {name} ({sha[:12]})", Colors.GREEN))
    if result.conflict:
        sm.on_merge_conflict(data, result.conflict)
        save(ctx)
        commit_task_dir(ctx, f"arbor({ctx.name}): wave {wave} merge conflict in {result.conflict['partition']}")
        print(colored(plan_for(ctx).summary, Colors.RED))
        return 1
    warnings = pt.remove_partitions(ctx.execution_main, data["partitions"])
    for warning in warnings:
        print(colored(f"  warning: {warning}", Colors.YELLOW))
    if warnings:
        data.setdefault("leftovers", []).extend(warnings)
    sm.on_wave_merged(data, len(waves))
    save(ctx)
    commit_task_dir(ctx, f"arbor({ctx.name}): wave {wave} merged")
    print(colored(f"wave {wave} merged: {plan_for(ctx).summary}", Colors.GREEN))
    return 0


def merge_wave(ctx: Ctx) -> int:
    commit_task_dir(ctx, f"arbor({ctx.name}): wave {ctx.data.get('wave', 1)} done")
    return _merge_remaining(ctx)


def cmd_autopilot(args: argparse.Namespace) -> int:
    if args.role or args.mode or args.dispatch:
        raise DriverError("--autopilot takes no --role / --mode / --dispatch")
    require_started(load_ctx(args.task))
    step_args = argparse.Namespace(task=args.task, dispatch=None, role=None, mode=None, partition=None, autopilot=False)
    return autopilot.run(
        next_payload=lambda: next_payload(load_ctx(args.task)),
        run_step=lambda: cmd_run(step_args),
        finish=lambda: cmd_finish(argparse.Namespace(task=args.task, pr=False)),
        task_dir=lambda: require_started(load_ctx(args.task)).task_dir,
    )


def cmd_run_contract(args: argparse.Namespace) -> int:
    """CONTRACT phase: explore / architect / review (plan) before `task.py start`."""
    role = args.role
    mode = args.mode or ("plan" if role == "review" else None)
    if args.mode and role != "review":
        raise DriverError("--mode goes with --role review")
    ctx = load_ctx(args.task)
    if ctx is not None and ctx.started:
        raise DriverError(f"{ctx.name} is started; use `arbor override --role {role}` for an extra dispatch")
    main = ctx.main if ctx else _main()
    config = ctx.config if ctx else read_arbor_config(main)
    if ctx is not None:
        with editing(ctx):
            pending = _pending(ctx)
            if pending:
                print(json.dumps(mcp.envelope(*pending), ensure_ascii=False))
                return 0

    if ctx is None:
        if role != "explore":
            raise DriverError(f"role {role} needs a task (no active task; pass --task)")
        if args.dispatch:
            raise DriverError("--dispatch needs a task")
        dispatch, brief = "intake", sys.stdin.read()
        if not brief.strip():
            raise DriverError("no active task: pipe the explore brief on stdin")
        task_dir = task_rel = None
    else:
        dispatch = next_dispatch_id(ctx.data, ctx.task_dir)
        if args.dispatch and args.dispatch != dispatch:
            raise DriverError(f"the next dispatch is {dispatch}, not {args.dispatch}")
        brief_file = brief_path(ctx, dispatch)
        brief = brief_file.read_text(encoding="utf-8") if brief_file.is_file() else ""
        if not brief.strip():
            raise DriverError(f"write the brief first: {brief_file}")
        task_dir = ctx.task_dir
        try:
            task_rel = task_dir.relative_to(main).as_posix()
        except ValueError:
            task_rel = f"{DIR_WORKFLOW}/{DIR_TASKS}/{ctx.name}"

    before = snapshot_refs(main)
    if before.head_ref is None or not before.head_ref.startswith("refs/heads/"):
        raise DriverError(f"{main} is on a detached HEAD; check out a branch first")
    branch = before.head_ref[len("refs/heads/"):]
    prompt = build_prompt(main, task_dir, role, mode, None, None if ctx is None else dispatch, brief)
    stamp = utc_now().replace(":", "").replace("-", "")
    prompt_file = (runtime_dir(main, "prompts", ctx.name) / f"{dispatch}.md" if ctx
                   else runtime_dir(main, "prompts") / f"intake-{stamp}.md")
    prompt_file.write_text(prompt, encoding="utf-8")
    before = snapshot_refs(main)  # the prompt file is not the dispatch's doing

    executor = resolve_executor(config)
    if executor.kind == "codeg-mcp":
        with editing(ctx) if ctx else task_lock(runtime_dir(main, "mcp-intake")):
            return prepare_mcp(ctx, main, executor, role, mode, dispatch, "contract", main, branch,
                               prompt, before, task_rel=task_rel)
    print(colored(f"{dispatch}: {role}{' (' + mode + ')' if mode else ''} in {main}", Colors.BLUE))
    result = run_executor(executor, role=role, prompt_path=prompt_file, worktree=main,
                          task=ctx.name if ctx else "", dispatch=dispatch)
    return finish_contract(ctx, main, config, role, mode, dispatch, branch, task_rel, before, result)


def finish_contract(ctx: Ctx | None, main: Path, config: dict, role: str, mode: str | None, dispatch: str,
                    branch: str, task_rel: str | None, before, result: ExecResult) -> int:
    violations = check_after_dispatch(
        role, before, main, own_branch=branch, test_paths=get_test_paths(config),
        task_rel_dir=task_rel or f"{DIR_WORKFLOW}/{DIR_TASKS}/-", dispatch_id=None,
    )
    after = snapshot_refs(main)
    if after.head != before.head:
        violations.append(f"HEAD of {branch} moved {str(before.head)[:12]} -> {str(after.head)[:12]}; "
                          "the driver never resets the main checkout: undo it by hand")
    check = rv.check_reply(role, result.stdout)
    if violations:
        status, problem = "violation", "; ".join(violations)
    elif not result.ok:
        status, problem = "fail", result.error
    elif not check.ok:
        status, problem = "fail", check.problem
    else:
        status, problem = "ok", check.problem

    append_result(main, {
        "ts": utc_now(), "task": ctx.name if ctx else None, "dispatch": dispatch, "role": role, "mode": mode,
        "state": "CONTRACT" if ctx else "INTAKE", "wave": None, "partition": None,
        "executor": result.executor, "started": result.started, "ended": result.ended,
        "duration_s": result.duration_s, "exit_code": result.exit_code, "status": status, "commit": None,
        "violations": violations,
    })
    color = Colors.GREEN if status == "ok" else Colors.RED
    if ctx is None:
        sys.stdout.write(result.stdout)
        print(colored(f"{role}: {status}" + (f" ({problem})" if problem else ""), color), file=sys.stderr)
        return 0 if status == "ok" else 1

    out = Outcome(status, result.stdout, check, result, violations, problem, None, before.head, after.head)
    _write_report(ctx, dispatch, role, out, [])
    if not isinstance(ctx.data.get("dispatches"), list):
        ctx.data["dispatches"] = []
    ctx.data["dispatches"].append({
        "id": dispatch, "role": role, "mode": mode, "commit": None, "status": status,
        "started": result.started, "ended": result.ended, "range": None,
        "confidence": check.confidence, "phase": "CONTRACT",
        **({"verdict": check.verdict, "findings": len(check.findings)} if role == "review" else {}),
    })
    save(ctx)
    print(colored(f"{dispatch} {role}: {status}" + (f" ({problem})" if problem else ""), color))
    print(f"  report: {ctx.task_dir / 'reports' / (dispatch + '.md')}")
    return 0 if status == "ok" else 1


# =============================================================================
# gate / decide / override / resume / abandon
# =============================================================================


def cmd_gate(args: argparse.Namespace, ctx: Ctx | None = None) -> int:
    ctx = ctx or require_started(load_ctx(args.task))
    require_collected(ctx)
    guard_contract(ctx)
    contract_path = find_contract(ctx.task_dir)
    if contract_path is None:
        raise DriverError(f"{ctx.name} has no contract.md")
    result = run_gate(get_gate_commands(ctx.execution_config), load_contract(contract_path), ctx.worktree)
    if ctx.data.get("execution_binding") and not result.checks:
        result.checks.append(CheckResult("GATE-EMPTY", "", 1,
                                         "product gate has no commands or auto checks"))
    print(format_checks(result.checks) or "no gate commands and no auto checks")
    if result.failing:
        print(colored(f"failing: {' '.join(result.failing)}", Colors.RED))
    else:
        print(colored("gate green", Colors.GREEN))

    with editing(ctx):
        data = ctx.data
        if data["state"] != "GATE" or sm.step_of(data) != "gate":
            return 1 if result.failing else 0
        sm.on_gate(data, result.failing, ctx.tier)
        number = data["counters"]["gate"]
        report = ctx.task_dir / "reports" / f"gate-{number}.md"
        report.parent.mkdir(exist_ok=True)
        report.write_text(
            f"# Gate {number}: {'red' if result.failing else 'green'}\n\n"
            f"failing: {', '.join(result.failing) or 'none'}\n\n{format_checks(result.checks)}\n",
            encoding="utf-8",
        )
        save(ctx)
    print(f"  next: {plan_for(ctx).summary}")
    return 1 if result.failing else 0


def cmd_decide(args: argparse.Namespace) -> int:
    ctx = require_started(load_ctx(args.task))
    with editing(ctx):
        require_collected(ctx)
        decision = sm.decide(ctx.data, args.choice, ctx.tier, args.partition)
        ctx.data.setdefault("decisions", []).append({
            "ts": utc_now(), "kind": decision.get("kind"), "choice": args.choice, "reason": args.reason,
            "failing": decision.get("failing"),
            **({"partition": decision["partition"]} if decision.get("partition") else {}),
        })
        save(ctx)
    print(colored(f"decided {args.choice}: {plan_for(ctx).summary}", Colors.GREEN))
    return 0


def cmd_override(args: argparse.Namespace) -> int:
    ctx = require_started(load_ctx(args.task))
    with editing(ctx):
        require_collected(ctx)
        return _override(ctx, args)


def _override(ctx: Ctx, args: argparse.Namespace) -> int:
    data = ctx.data
    record = {"ts": utc_now(), "reason": args.reason, "from": {"state": data["state"], "step": sm.step_of(data)}}
    if args.to:
        state, _, step = args.to.partition("/")
        state = state.upper()
        if state not in sm.DEFAULT_STEP or state == "STOP":
            raise DriverError(f"unknown state {state!r}")
        data.pop("stop", None)
        sm.goto(data, state, step or None)
        record["to"] = f"{data['state']}/{data['step']}"
    elif args.role:
        if args.role not in PROMPT_ROLES:
            raise DriverError(f"unknown role {args.role!r}")
        if args.mode and (args.role != "review" or args.mode not in REVIEW_MODES):
            raise DriverError("--mode applies to role review only (self-check|candidates|sweep|plan)")
        data["override_role"] = {"role": args.role, "mode": args.mode or ("self-check" if args.role == "review" else None)}
        record["role"] = args.role
    else:
        raise DriverError("override needs --to STATE[/step] or --role ROLE")
    data.setdefault("overrides", []).append(record)
    save(ctx)
    print(colored(f"override recorded: {plan_for(ctx).summary}", Colors.YELLOW))
    return 0


def cmd_resume(args: argparse.Namespace) -> int:
    ctx = require_started(load_ctx(args.task))
    with editing(ctx):
        require_collected(ctx)
        if ctx.data.get("merge_conflict") and ctx.data.get("state") == "BUILD":
            return _resume_merge(ctx)
        return _resume(ctx)


def _resume_merge(ctx: Ctx) -> int:
    """The human merged the conflicting partition by hand: check it, go on merging."""
    conflict = ctx.data["merge_conflict"]
    rc, _, _ = run_git(["rev-parse", "-q", "--verify", "MERGE_HEAD"], cwd=ctx.worktree)
    if rc == 0:
        raise DriverError(f"a merge is still in progress in {ctx.worktree}; finish it with `git commit` first")
    if not is_ancestor(ctx.worktree, conflict["branch"]):
        raise DriverError(f"{conflict['branch']} is not merged into {conflict.get('into')} yet: run "
                          f"`git merge --no-ff {conflict['branch']}` in {ctx.worktree}, resolve, commit")
    name = sm.on_conflict_resolved(ctx.data, head(ctx))
    print(colored(f"  {name}: merged by hand", Colors.GREEN))
    return _merge_remaining(ctx)


def _resume(ctx: Ctx) -> int:
    data = ctx.data
    reapprove = data.get("state") == "CONTRACT" or (data.get("stop") or {}).get("contract")
    if reapprove:
        path = find_contract(ctx.task_dir)
        if path is None:
            raise DriverError(f"{ctx.name} has no contract.md")
        try:
            errors = validate_contract(load_contract(path), ctx.worktree, get_test_paths(ctx.config))
        except ContractError as e:
            errors = [str(e)]
        if errors:
            for error in errors:
                print(colored(f"  {error}", Colors.RED))
            raise DriverError("contract.md does not validate; fix it before re-approving")
        data["contract_hash"] = contract_hash(path)
    message = sm.resume(data)
    save(ctx)
    if reapprove:
        commit_task_dir(ctx, f"contract({ctx.name}): re-approve contract")
    print(colored(f"{message}: {plan_for(ctx).summary}", Colors.GREEN))
    return 0


def cmd_abandon(args: argparse.Namespace) -> int:
    ctx = require_started(load_ctx(args.task))
    with editing(ctx):
        require_collected(ctx)
        sm.stop(ctx.data, "HUMAN", f"abandoned{': ' + args.reason if args.reason else ''}")
        save(ctx)
    print(colored(f"{ctx.name}: STOP (HUMAN, abandoned)", Colors.YELLOW))
    return 0


# =============================================================================
# finish
# =============================================================================


def cmd_finish(args: argparse.Namespace) -> int:
    """The next FINISH action: scorecard + PR / merge command, or cleanup after the merge."""
    main = _main()
    name = Path(args.task).name if args.task else None
    if name and fin.load_record(main, name):
        return fin.cleanup(main, fin.load_record(main, name))
    ctx = load_ctx(args.task)
    if ctx is None:  # the worktree (and the session's pointer into it) may already be gone
        pending = fin.pending_records(main)
        if len(pending) > 1:
            raise DriverError(f"cleanup pending for {', '.join(pending)}; pass --task")
        if pending:
            return fin.cleanup(main, fin.load_record(main, pending[0]))
    ctx = require_started(ctx)
    require_collected(ctx)
    record = fin.load_record(ctx.main, ctx.name)
    if record:
        return fin.cleanup(ctx.main, record)
    if ctx.data.get("state") != "FINISH":
        raise DriverError(f"{ctx.name} is in {ctx.data.get('state')}, not FINISH: {plan_for(ctx).summary}")
    guard_contract(ctx)
    step = fin.plan_finish(ctx.main, ctx.task_dir, ctx.data)
    if step.needs == "run" and (ctx.task_dir / fin.SCORECARD).is_file() and step.summary == "FINISH: merged: `arbor finish` to clean up":
        print(colored(f"{ctx.branch} is merged: cleaning up", Colors.BLUE))
        return fin.cleanup(ctx.main, fin.start_cleanup(ctx.main, ctx.task_dir, ctx.data))
    return fin.finish_before_merge(ctx.main, ctx.worktree, ctx.task_dir, ctx.task_rel, ctx.data, ctx.tier,
                                   want_pr=args.pr, save=lambda: save(ctx))


# =============================================================================
# prompt / canary
# =============================================================================


def cmd_prompt(args: argparse.Namespace) -> int:
    ctx = load_ctx(args.task)
    if ctx is None:
        raise DriverError("no active task (pass --task)")
    entry = next((d for d in ctx.data.get("dispatches") or [] if d.get("id") == args.dispatch), None)
    brief_file = brief_path(ctx, args.dispatch)
    if not brief_file.is_file():
        raise DriverError(f"no brief at {brief_file}")
    partition: str | None = None
    if not ctx.started:
        if entry is None:
            raise DriverError(f"unknown dispatch {args.dispatch} (before start only recorded dispatches rebuild)")
        role, mode, range_spec = entry["role"], entry.get("mode"), None
    elif entry is not None:
        role, mode, range_spec = entry["role"], entry.get("mode"), entry.get("range")
        partition = entry.get("partition")
    else:
        step = _step_of_dispatch(ctx, args.dispatch)
        role, mode = step.role, step.mode
        worktree = ctx.unit(step.partition).worktree
        range_spec = (f"{step.range_from}..{head(ctx, worktree)}"
                      if step.range_from and role in RANGE_ROLES else None)
        partition = step.partition
    brief = brief_file.read_text(encoding="utf-8")
    if ctx.started:
        brief = _partition_brief(ctx, partition, brief)
    text = build_prompt(ctx.control_worktree if ctx.started else ctx.main, ctx.task_dir, role, mode, range_spec, args.dispatch,
                        brief, ctx.unit(partition).worktree if ctx.started and ctx.data.get("execution_binding") else None)
    if args.print:
        sys.stdout.write(text)
    else:
        print(f"{args.dispatch}: {role} {mode or ''} {range_spec or ''} ({len(text.encode('utf-8'))} bytes)")
    return 0


def _step_of_dispatch(ctx: Ctx, dispatch: str) -> sm.Step:
    """The pending step that ``dispatch`` (not yet run) belongs to."""
    for name, rec in (ctx.data.get("partitions") or {}).items():
        if rec.get("next_dispatch") == dispatch:
            return plan_for(ctx, name)
    if dispatch != next_dispatch_id(ctx.data, ctx.task_dir):
        raise DriverError(f"unknown dispatch {dispatch}")
    step = plan_for(ctx)
    if step.needs != "brief" or step.partition:
        raise DriverError(f"{dispatch} is not a dispatch step: {step.summary}")
    return step


CANARY_BRIEFS = {
    "explore": "Canary check of the dispatch pipeline. Do not read, search or write anything. "
               "Reply with your report format, the conclusion being exactly: canary ok.",
    "review": "Canary check of the dispatch pipeline. Do not review anything and do not change anything. "
              "Reply with the first line PASS, then an empty JSON array.",
    "verify": "Canary check of the dispatch pipeline. Do not change anything. Candidates:\n\n"
              '```json\n[{"file": "README.md", "line": 1, "angle": "A", "summary": "canary placeholder", '
              '"failure_scenario": "none", "verdict": "CANDIDATE", "evidence": "-", "fix": "-"}]\n```\n\n'
              "Mark the candidate REFUTED without opening any file and reply with your report format.",
}


def cmd_canary(args: argparse.Namespace) -> int:
    role = args.role
    ctx = load_ctx(args.task)
    if role != "explore":
        ctx = require_started(ctx)
    started = ctx is not None and ctx.started
    main = ctx.main if ctx else _main()
    worktree = ctx.worktree if started else main
    task_dir = ctx.task_dir if started else None
    config = ctx.config if ctx else read_arbor_config(main)

    range_spec = None
    if started and role in RANGE_ROLES:
        range_spec = f"{ctx.data['base']}..{head(ctx)}"
    prompt = build_prompt(worktree, task_dir, role, "self-check" if role == "review" else None,
                          range_spec, None, CANARY_BRIEFS[role])
    stamp = utc_now().replace(":", "").replace("-", "")
    prompt_file = runtime_dir(main, "prompts") / f"canary-{stamp}.md"
    prompt_file.write_text(prompt, encoding="utf-8")

    executor = resolve_executor(config)
    before = snapshot_refs(worktree)
    if executor.kind == "codeg-mcp":
        branch = (before.head_ref or "").removeprefix("refs/heads/")
        with editing(ctx) if ctx else task_lock(runtime_dir(main, "mcp-intake")):
            return prepare_mcp(ctx, main, executor, role, "self-check" if role == "review" else None,
                               "canary", "canary", worktree, branch, prompt, before)
    result = run_executor(executor, role=role, prompt_path=prompt_file, worktree=worktree,
                          task=ctx.name if ctx else "", dispatch="canary")
    return finish_canary(ctx, main, worktree, role, before, result)


def finish_canary(ctx: Ctx | None, main: Path, worktree: Path, role: str, before, result: ExecResult) -> int:
    started = ctx is not None and ctx.started
    after = snapshot_refs(worktree)
    problems: list[str] = []
    if not result.ok:
        problems.append(result.error or "executor failed")
    check = rv.check_reply(role, result.stdout)
    if not check.ok or check.problem:
        problems.append(check.problem or "reply rejected")
    if after.head != before.head or after.dirty != before.dirty:
        problems.append("the canary changed the worktree")
    status = "ok" if not problems else "fail"
    append_result(main, {
        "ts": utc_now(), "task": ctx.name if ctx else None, "dispatch": "canary", "role": role, "mode": None,
        "state": ctx.data.get("state") if started else None, "wave": None, "partition": None,
        "executor": result.executor, "started": result.started, "ended": result.ended,
        "duration_s": result.duration_s, "exit_code": result.exit_code, "status": status, "commit": None,
        "violations": problems,
    })
    if problems:
        print(colored(f"canary {role} via {result.executor}: FAIL", Colors.RED))
        for p in problems:
            print(f"  - {p}")
        if result.stderr.strip():
            print("  stderr: " + result.stderr.strip().splitlines()[-1])
        return 1
    print(colored(f"canary {role} via {result.executor}: ok ({result.duration_s}s)", Colors.GREEN))
    return 0


# =============================================================================
# CLI
# =============================================================================


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="arbor.py", description="arbor task driver")
    parser.add_argument("--task", help="task dir (default: the session's active task)")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("next", help="print the single next step")
    p.add_argument("--json", action="store_true")
    p.add_argument("--partition", help="the step of this partition (multi-partition waves)")
    p.set_defaults(func=cmd_next)
    p = sub.add_parser("run", help="dispatch briefs/<id>.md, validate, advance")
    p.add_argument("--dispatch")
    p.add_argument("--role", choices=CONTRACT_ROLES, help="CONTRACT phase only: dispatch before task.py start")
    p.add_argument("--mode", choices=("plan",), help="with --role review")
    p.add_argument("--partition", help="run this partition's step (multi-partition waves)")
    p.add_argument("--autopilot", action="store_true",
                   help="keep going until a decision, a human gate, STOP, red or a failed dispatch")
    p.set_defaults(func=cmd_run)
    p = sub.add_parser("bind", help="bind a prepared MCP dispatch to codeg's returned task_id")
    p.add_argument("--request", required=True)
    p.add_argument("--task-id", required=True)
    p.set_defaults(func=cmd_bind)
    p = sub.add_parser("collect", help="validate a terminal codeg MCP report and advance the task")
    p.add_argument("--request", required=True)
    p.add_argument("--result", required=True, help="file containing the complete get_delegation_status JSON")
    p.set_defaults(func=cmd_collect)
    p = sub.add_parser("finish", help="FINISH: scorecard + PR / merge command; cleanup after the merge")
    p.add_argument("--pr", action="store_true", help="push the task branch and open a PR with gh")
    p.set_defaults(func=cmd_finish)
    sub.add_parser("gate", help="run level 0: gate commands + contract auto checks").set_defaults(func=cmd_gate)
    p = sub.add_parser("decide", help="answer a decision the state table asked for")
    p.add_argument("choice", choices=(*sm.DECIDE_CHOICES, *sm.PLAUSIBLE_CHOICES))
    p.add_argument("--reason", required=True)
    p.add_argument("--partition", help="the partition whose red-check decision this answers")
    p.set_defaults(func=cmd_decide)
    p = sub.add_parser("canary", help="read-only dispatch that checks the executor")
    p.add_argument("--role", choices=CANARY_ROLES, default="explore")
    p.set_defaults(func=cmd_canary)
    p = sub.add_parser("override", help="one step off the state table")
    p.add_argument("--reason", required=True)
    p.add_argument("--to", help="STATE[/step] to jump to")
    p.add_argument("--role", help="dispatch this role once without advancing")
    p.add_argument("--mode")
    p.set_defaults(func=cmd_override)
    sub.add_parser("status").set_defaults(func=cmd_status)
    sub.add_parser("resume", help="leave STOP, or re-approve a revised contract").set_defaults(func=cmd_resume)
    p = sub.add_parser("abandon")
    p.add_argument("--reason")
    p.set_defaults(func=cmd_abandon)
    p = sub.add_parser("prompt", help="rebuild the prompt of a dispatch")
    p.add_argument("--dispatch", required=True)
    p.add_argument("--print", action="store_true")
    p.set_defaults(func=cmd_prompt)

    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except (DriverError, sm.StateError, ExecutorError, ContractError, WorktreeError, fin.FinishError, LockTimeout, OSError,
            ValueError) as e:
        print(colored(f"Error: {e}", Colors.RED), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
