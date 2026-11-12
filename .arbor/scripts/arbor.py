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
    python3 ./.arbor/scripts/arbor.py sync [--dispatch d-NNN] [--wait 10m]
    python3 ./.arbor/scripts/arbor.py finish [--pr]
    python3 ./.arbor/scripts/arbor.py gate
    python3 ./.arbor/scripts/arbor.py decide <impl|contract|fix|skip> --reason "..."
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
never committed and outside the state table.

Every role runs as an Orca worker: ``run`` prepares the prompt, starts the
worker (``orca orchestration worker-start``) in the dispatch's worktree and
returns ``needs=worker``; the worker writes its reply to the request's reply
file and reports ``worker_done``; ``sync`` reads every pending worker's state
from Orca, validates the settled replies and advances the task.

A wave of named partitions runs each partition in its own worktree
(``<root>/<task>-<p>`` on ``arbor/<task>--<p>``): ``run`` creates them, each
partition then takes its own ``implement`` dispatch (``next``
lists the others that are ready in ``partitions_pending``; run them in
parallel with ``run --partition P``), and once all are done ``run`` merges
them back with ``--no-ff``. A conflict waits for a hand merge in the task
worktree and ``resume``. Parallel runs share task.json under ``<task>/.lock``.

Files:
    <task>/briefs/d-NNN.md      the brief the main agent writes before `run`
    <task>/reports/d-NNN.md     the reply plus the driver's verdict
    <task>/reports/gate-N.md    output of the N-th gate round
    <task>/reports/candidates-rN.json   REVIEW cycle N after the prefilter
    <task>/scorecard.md         FINISH: the task's measurements
    .arbor/.runtime/prompts/<task>/d-NNN.md   the full prompt (main checkout); d-NNN.spec.md: the worker's task spec
    .arbor/.runtime/replies/<task>/d-NNN.md   the worker's reply (main checkout)
    .arbor/.runtime/workers/<task>/d-NNN.json the request record of a dispatch (main checkout)
    .arbor/.runtime/results.jsonl             one row per dispatch (main checkout)

Exit codes: 0 ok, 1 refused / failed dispatch / red gate, 2 usage error.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from dataclasses import asdict
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator

from common.active_task import resolve_active_task, resolve_task_ref
from common.arbor_config import get_gate_commands, read_arbor_config
from common.contract import (
    Contract,
    ContractError,
    contract_hash,
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
from common.driver import escalate as esc
from common.driver import orca
from common.driver import finish as fin
from common.driver import integration as ig
from common.driver import mandate as md
from common.driver import state as sm
from common.driver import validate as rv
from common.driver.executor import ExecResult, ExecutorError, parse_timeout, resolve_executor, utc_now
from common.driver.gate import CheckResult, format_checks, map_warnings, run_gate
from common.driver.lock import LockTimeout, pid_alive, task_lock
from common.config import get_packages
from common.git import run_git
from common.invariants import WRITER_ROLES, _dirty_paths, check_after_dispatch, snapshot_refs
from common.io import read_json_checked, write_json, write_text_atomic
from common.log import Colors, colored
from common.paths import DIR_TASKS, DIR_WORKFLOW, FILE_TASK_JSON
from common.task_utils import started_copy_by_name
from common.tasks import resolve_tier
from common.worktree import (WorktreeError, branch_prefix, is_ancestor, main_checkout, partition_branch, partition_worktree_path, remove_worktree,
                             worktree_root)

RUNTIME = f"{DIR_WORKFLOW}/.runtime"
CONTRACT_ROLES = ("explore", "architect", "review")
PARALLEL_RESEARCH_ROLES = ("explore", "architect")


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

    @property
    def mandate(self) -> dict:
        """Which human gates this task asks the user about (config per tier, task.json meta.mandate)."""
        try:
            return md.resolve(self.config, self.tier, self.data)
        except md.MandateError as e:
            raise DriverError(f"task.json meta.mandate: {e}") from None

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
        local = Path(task_arg)
        if not local.is_absolute() and (local / FILE_TASK_JSON).is_file():
            task_arg = str(local.resolve())  # relative to cwd (e.g. inside the task worktree)
        elif "/" not in task_arg and not (main / DIR_WORKFLOW / DIR_TASKS / task_arg / FILE_TASK_JSON).is_file():
            started = started_copy_by_name(task_arg, main)  # a started task lives in its worktree
            task_arg = str(started) if started else task_arg
        task_dir = resolve_task_ref(task_arg, main)
    else:
        # A sole session file does not make its task belong to this caller.
        # Main-driver commands require this session's binding or explicit --task.
        active = resolve_active_task(main)
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
    if ctx.started:
        for _ in range(sm.unassigned_batch(ctx.data, ctx.tier)):
            sm.on_batch_assigned(ctx.data, [next_dispatch_id(ctx.data, ctx.task_dir)])
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
        contract = load_contract(path)
    except ContractError as e:
        if ctx.data.get("state") in (None, "CONTRACT"):
            return None  # still being drafted
        # a started task must not fall back to the default partition silently
        raise DriverError(f"contract.md does not parse ({e}); fix it, then `arbor resume` to re-approve") from e
    return contract.waves


def require_contract(ctx: Ctx) -> Contract:
    path = find_contract(ctx.task_dir)
    if path is None:
        raise DriverError(f"{ctx.name} has no contract.md")
    return load_contract(path)


def plan_for(ctx: Ctx, partition: str | None = None) -> sm.Step:
    return sm.plan(ctx.data, ctx.tier, waves_of(ctx), partition)


def commit_task_dir(ctx: Ctx, message: str) -> bool:
    """Commit metadata only on its intended branch; never switch/reset for recovery."""
    rc, branch, _ = run_git(["symbolic-ref", "--short", "HEAD"], cwd=ctx.control_worktree)
    if rc != 0 or branch.strip() != ex.control_data(ctx.data)["branch"]:
        print("Note: task metadata preserved without committing because the checkout branch changed.", file=sys.stderr)
        return False
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
    """Report contract drift; the main agent judges changes in context."""
    if contract_changed(ctx):
        print("Note: contract.md differs from the recorded approval; review the change in context. "
              "No restoration or automatic re-approval is required to collect results; "
              "`arbor resume` records the revised contract as approved.", file=sys.stderr)


def next_dispatch_id(data: dict, task_dir: Path | None = None) -> str:
    """One past the highest id in task.json ``dispatches``, the ids already
    assigned to partitions, and ``reports/`` (a report whose record was lost
    still reserves its id)."""
    ids = [str(d.get("id", "")) for d in data.get("dispatches") or [] if isinstance(d, dict)]
    ids += [str(r.get("next_dispatch") or "") for r in (data.get("partitions") or {}).values()]
    batch = data.get("batch") if isinstance(data.get("batch"), dict) else {}
    ids += [str(i) for i in (batch.get("ids") or [])] + [str(i) for i in (batch.get("running") or {})]
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
                 range_spec: str | None, dispatch: str | None, brief: str, execution_root: Path | None = None,
                 task_base: str | None = None) -> str:
    if role == "review" and task_base and range_spec and range_spec.split("..")[0] != task_base:
        brief = (f"Task base: {task_base}. This range starts after the task's own earlier commits: a problem "
                 f"introduced in {task_base}..{range_spec.split('..')[0]} is this task's, not pre-existing.\n\n" + brief)
    if execution_root is not None:
        brief = (f"Control repository: {worktree} (read only).\nExecution repository: {execution_root}.\n"
                 "Run code edits, Git commands and tests in the execution repository. "
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


def planning_runs(ctx: Ctx) -> list[dict]:
    """Uncollected worker requests."""
    runs = []
    for path in (ctx.data.get("workers") or {}).values():
        _, record = orca.load(ctx.main, path)
        runs.append({"dispatch": record["dispatch"], "role": record["role"],
                     "kind": record["kind"], "request_path": str(path),
                     "orca_dispatch": orca.dispatch_id(record), "started": record["started"]})
    return sorted(runs, key=lambda r: r["dispatch"])


def planning_blocker(role: str, runs: list[dict]) -> str | None:
    if runs and (role not in PARALLEL_RESEARCH_ROLES or any(
            r["kind"] != "contract" or r["role"] not in PARALLEL_RESEARCH_ROLES for r in runs)):
        return "`arbor.py sync` the pending workers before a plan review or another kind of dispatch"
    return None


def planning_next(ctx: Ctx, role: str) -> dict:
    if ctx.started and ctx.data.get("state") != "CONTRACT":
        raise DriverError("next --role is for CONTRACT planning; use an override after start outside CONTRACT")
    runs = planning_runs(ctx)
    blocked = planning_blocker(role, runs)
    dispatch = next_dispatch_id(ctx.data, ctx.task_dir)
    return {"task": ctx.name, "state": "CONTRACT", "started": ctx.started,
            "needs": "wait" if blocked else "brief", "role": role,
            "dispatch": dispatch, "brief_path": str(brief_path(ctx, dispatch)),
            "pending_workers": runs,
            "summary": blocked or f"CONTRACT: write {dispatch}'s brief for {role}; "
                f"run --role {role} --dispatch {dispatch}. Independent research may run concurrently; "
                "the main agent chooses the number of angles and consolidates their results."}


def next_payload(ctx: Ctx | None, partition: str | None = None, role: str | None = None) -> dict:
    if role:
        if ctx is None or partition is not None:
            raise DriverError("next --role requires a task and cannot be combined with --partition")
        return planning_next(ctx, role)
    if ctx is None:
        pending = fin.pending_records(_main())
        if pending:
            return {"task": pending[0], "state": "FINISH", "needs": "run",
                    "summary": f"FINISH: cleanup of {', '.join(pending)} is incomplete: `arbor finish`"}
        return {"task": None, "state": "INTAKE", "needs": "human", "started": False,
                "summary": "No active task: agree a tier, write contract.md, then `task.py start`"}
    pending = _pending(ctx, partition)
    reader_running = bool(pending and ctx.started and record_is_reader(ctx, pending[1])
                          and sm.batch_of(ctx.data).get("ids"))
    if reader_running:
        pending = None  # other readers of the batch still wait for their brief; poll this one alongside
    if pending:
        path, record = pending
        out = {"task": ctx.name, "state": record["state"], "needs": "worker",
               "dispatch": record["dispatch"], "role": record["role"], "request_path": str(path),
               "orca_dispatch": orca.dispatch_id(record), "started": ctx.started,
               "worker_started": record["started"],
               "pending_workers": planning_runs(ctx),
               "summary": f"worker {record['dispatch']} ({record['role']}): " + (
                   "running in Orca; end your turn, and when Orca wakes you `arbor.py sync`"
                   if orca.dispatch_id(record) else f"not started; `arbor.py run --dispatch {record['dispatch']}`")}
        if ctx.started:
            out.update(ready_set(ctx, _current_step(ctx, partition)))
        return out
    active_planning = [] if reader_running else planning_runs(ctx)
    if active_planning:
        return {"task": ctx.name, "state": "CONTRACT", "started": ctx.started, "needs": "wait",
                "pending_workers": active_planning,
                "summary": "Planning workers are running: `arbor.py sync` when Orca wakes you; "
                           "use next --role explore|architect for another angle"}
    if not ctx.started:
        dispatch = next_dispatch_id(ctx.data, ctx.task_dir)
        out = {"task": ctx.name, "state": "CONTRACT", "needs": "human", "started": False, "dispatch": dispatch,
               "brief_path": str(brief_path(ctx, dispatch)),
               "human": {"kind": "approve_contract", "mandate": ctx.mandate["contract"]},
               "contract_roles": list(CONTRACT_ROLES),
               "summary": f"CONTRACT: finish {ctx.name}/contract.md (research with `arbor run --role "
                          "explore|architect|review [--mode plan]` after writing the brief); after human "
                          "approval run `task.py start`"}
        if ctx.data.get("children") and _live_integration(ctx):
            view = _integration_view(ctx, _children_rows(ctx))
            out["integration"] = view
            if view and view.get("all_merged"):
                out["needs"] = "run"
                out["summary"] = (f"every child of {ctx.name} is merged into {view['branch']}: "
                                  f"`task.py integrate {ctx.name}` starts the integration review")
            else:
                out["summary"] = (f"parent {ctx.name}: {view['children_merged']}/{len(ctx.data['children'])} "
                                  "children merged; drive the children, then `task.py integrate`")
        return out
    if sm.unassigned_batch(ctx.data, ctx.tier):
        with editing(ctx):  # a reader step entered outside the driver's own saves (task.py integrate)
            save(ctx)
    data = ctx.data
    sm.reap_stale(data, pid_alive)  # in memory only; the next locked write persists it
    step = _current_step(ctx, partition)
    unit = ctx.unit(step.partition)
    out: dict = {"task": ctx.name, "state": data["state"], "tier": ctx.tier, "wave": data.get("wave", 1),
                 "partition": unit.label, "partitions_pending": list(step.pending), "needs": step.needs}
    if contract_changed(ctx):
        out["observations"] = ["contract.md differs from the recorded approval; main agent judges the change"]
    if data.get("tier_history"):
        out["tier_history"] = data["tier_history"]
        out["escalated"] = data["tier_history"][-1]
    if step.role:
        dispatch = step.dispatch or next_dispatch_id(data, ctx.task_dir)
        out["role"] = step.role
        out["mode"] = step.mode
        if step.role in RANGE_ROLES and step.range_from:
            out["range"] = f"{step.range_from}..{head(ctx, unit.worktree)}"
        out["dispatch"] = dispatch
        out["brief_path"] = str(brief_path(ctx, dispatch))
    if len(step.batch) > 1:
        out["batch"] = [{"dispatch": d, "brief_path": str(brief_path(ctx, d))} for d in step.batch]
    running = sorted((sm.batch_of(data).get("running") or {}))
    if running:
        out["readers_running"] = running
        out["pending_workers"] = planning_runs(ctx)
    if step.decision:
        out["decision"] = step.decision
    if step.human:
        out["human"] = _human(ctx, step.human)
    repros = (data.get("cycle") or {}).get("repros")
    if (data.get("state"), sm.step_of(data)) == ("REVIEW", "fix") and repros:
        out["repros"] = repros  # paste into the fix brief with the findings
    out["touched_files"] = touched_files(ctx, unit.worktree)
    ready = ready_set(ctx, step)
    out.update(ready)
    summary = step.summary
    if step.pending and not data.get("execution_binding"):
        limit = resolve_executor(ctx.config).max_parallel
        summary += (f"; also ready: {', '.join(step.pending)} (brief each from `next --partition P`, then "
                    f"`arbor run --partition P` in parallel{f', at most {limit} at once' if limit else ''})")
    if data.get("execution_binding") and (step.pending or len(step.batch) > 1):
        summary += "; product task: dispatches run one at a time, `next` again after each collect"
    if len(ready["items"]) > 1:
        summary += (f"; {len(ready['items'])} items ready: act on every one (brief each at its brief_path, "
                    "dispatch them all), then wait once for the running ones")
    out["summary"] = summary
    return out


def _current_step(ctx: Ctx, partition: str | None = None) -> sm.Step:
    data = ctx.data
    if data.get("state") == "FINISH" and not data.get("override_role") and not data.get("report_pending"):
        return fin.plan_finish(ctx.main, ctx.task_dir, data)
    return plan_for(ctx, partition)


def _human(ctx: Ctx, human: dict) -> dict:
    """``human`` plus the mandate of its gate; a blocked automatic merge always asks."""
    out = dict(human)
    gate = md.HUMAN_KIND_GATE.get(human.get("kind"))
    out["mandate"] = "ask" if human.get("blocked") else (ctx.mandate[gate] if gate else "ask")
    return out


def _item(ctx: Ctx, step: sm.Step) -> dict:
    unit = ctx.unit(step.partition)
    item: dict = {"needs": step.needs, "partition": unit.label, "summary": step.summary}
    if step.role:
        dispatch = step.dispatch or next_dispatch_id(ctx.data, ctx.task_dir)
        item.update(role=step.role, mode=step.mode, dispatch=dispatch, brief_path=str(brief_path(ctx, dispatch)))
        if step.role in RANGE_ROLES and step.range_from:
            item["range"] = f"{step.range_from}..{head(ctx, unit.worktree)}"
    if step.action:
        item["action"] = step.action
    if step.decision:
        item["decision"] = step.decision
    if step.human:
        item["human"] = _human(ctx, step.human)
    return item


def ready_set(ctx: Ctx, step: sm.Step | None) -> dict:
    """The task's ready set, computed by the driver from its state (the main
    agent never adds to it): ``items`` = every step that can be acted on now
    (workers not started yet, the current step and every other partition
    needing a brief), ``running`` = what is in flight, ``blocked_on`` = what
    the task waits for when there is nothing to act on."""
    items: list[dict] = []
    running: list[dict] = []
    default_busy = False
    readers = sm.batch_of(ctx.data).get("running") or {}
    for path in (ctx.data.get("workers") or {}).values():
        _, record = orca.load(ctx.main, path)
        entry = {"dispatch": record["dispatch"], "role": record["role"],
                 "partition": record.get("partition") or "default", "request_path": str(path)}
        if orca.dispatch_id(record):
            running.append({**entry, "kind": "worker", "orca_dispatch": orca.dispatch_id(record)})
        else:
            items.append({"needs": "worker", **entry,
                          "summary": f"start {record['dispatch']}: `arbor.py run --dispatch {record['dispatch']}`"})
        # a reader of the current batch runs alongside the rest of its batch
        default_busy = default_busy or not (record.get("partition") or record["dispatch"] in readers)
    if step is not None and step.needs != "wait" and not (default_busy and step.partition is None):
        items.append(_item(ctx, step))
        for dispatch in step.batch[1:]:  # the other readers of a reader batch, each with its own brief
            items.append({**items[-1], "dispatch": dispatch, "brief_path": str(brief_path(ctx, dispatch))})
        for name in step.pending:
            other = plan_for(ctx, name)
            if other.needs == "brief":
                items.append(_item(ctx, other))
    if ctx.data.get("execution_binding"):
        # product task: one dispatch at a time (`_begin` refuses a second one)
        busy = ctx.data.get("workers") or any(
            p.get("running") for p in (ctx.data.get("partitions") or {}).values())
        items = [i for i in items if i["needs"] == "worker"] if busy else items[:1]
    out: dict = {"items": items, "running": running}
    if not items:
        out["blocked_on"] = (step.summary if step is not None and step.needs == "wait"
                             else "waiting for " + ", ".join(str(r["dispatch"]) for r in running))
    return out


def cmd_next(args: argparse.Namespace) -> int:
    payload = next_payload(load_ctx(args.task), args.partition, args.role)
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
    if len(payload.get("items") or []) > 1:
        print("  ready:")
        for item in payload["items"]:
            what = item.get("role") or item.get("needs")
            print(f"    {item.get('dispatch') or '-':<7} {what:<10} [{item.get('partition')}] {item.get('brief_path') or ''}")
    for run in payload.get("running") or []:
        print(f"  running: {run.get('dispatch')} [{run.get('partition')}] {run.get('orca_dispatch') or run.get('kind')}")
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    ctx = require_started(load_ctx(args.task))
    d = ctx.data
    print(colored(f"{ctx.name}  {d['state']}/{sm.step_of(d)}  tier {ctx.tier}", Colors.CYAN))
    print(f"  worktree: {ctx.worktree} ({ctx.branch}, base {d['base'][:12]})")
    print(f"  counters: {json.dumps(d['counters'])}")
    print(f"  mandate: {md.describe(ctx.mandate)}")
    if d.get("tier_history"):
        last = d["tier_history"][-1]
        print(f"  escalated: {last['from']} -> {last['to']} ({last['detail']}, {last.get('at') or '-'})")
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
    status: str  # ok | fail | judgment
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


def record_is_reader(ctx: Ctx, record: dict) -> bool:
    return record.get("dispatch") in (sm.batch_of(ctx.data).get("running") or {})


def _pending(ctx: Ctx, partition: str | None = None, dispatch: str | None = None) -> tuple[Path, dict] | None:
    """A pending worker request (of ``partition``). With ``dispatch``, the other
    readers of the current batch do not count: they run concurrently with it."""
    readers = set((sm.batch_of(ctx.data).get("running") or {}))
    for path in (ctx.data.get("workers") or {}).values():
        pair = orca.load(ctx.main, path)
        if dispatch and pair[1].get("dispatch") != dispatch and pair[1].get("dispatch") in readers:
            continue
        if partition is None or pair[1].get("partition") == partition:
            return pair
    return None


def _upsert_dispatch(data: dict, entry: dict) -> None:
    """Add ``entry`` to ``dispatches`` or replace the entry with its id."""
    entries = data.setdefault("dispatches", [])
    slot = next((i for i, d in enumerate(entries) if d.get("id") == entry["id"]), None)
    if slot is None:
        entries.append(entry)
    else:
        entries[slot] = entry


def _read_brief(ctx: Ctx, dispatch: str) -> str:
    brief_file = brief_path(ctx, dispatch)
    brief = brief_file.read_text(encoding="utf-8") if brief_file.is_file() else ""
    if not brief.strip():
        raise DriverError(f"write the brief first: {brief_file}")
    return brief


def require_report_decision(ctx: Ctx) -> None:
    if ctx.data.get("report_pending"):
        raise DriverError("report needs main-agent judgment: use `arbor decide retry` or "
                          "`arbor decide accept --report <interpreted-report>` with --reason")


def require_collected(ctx: Ctx) -> None:
    if ctx.data.get("workers"):
        raise DriverError("a worker is pending: `arbor.py sync` collects it once it settled "
                          "(`orca orchestration worker-stop --dispatch <id>` ends one that must not go on)")


def prepare_worker(ctx: Ctx, main: Path, executor, role: str, mode: str | None, dispatch: str,
                   kind: str, worktree: Path, branch: str, prompt: str, prompt_path: Path,
                   **extra) -> Path:
    """Caller holds the task lock. Persist the request; ``launch`` starts its
    worker once the lock is released."""
    if kind == "contract":
        blocked = planning_blocker(role, planning_runs(ctx))
        if blocked:
            raise DriverError(blocked)
    elif _pending(ctx, None if ctx.data.get("execution_binding") else extra.get("partition"), dispatch):
        raise DriverError("a worker is already pending; `arbor.py sync` it before starting another")
    path = orca.request_path(main, ctx.name, dispatch)
    reply_path = runtime_dir(main, "replies", ctx.name) / f"{dispatch}.md"
    spec_path = prompt_path.with_name(f"{dispatch}.spec.md")
    # The empty reply file exists before the snapshot: the worker's reply is never a new dirty path.
    if not (write_text_atomic(reply_path, "")
            and write_text_atomic(spec_path, orca.spec_text(prompt, prompt_path, reply_path))):
        raise DriverError(f"cannot write {spec_path}")
    record = {
        "schema": 2, "main": str(main), "task_dir": str(ctx.task_dir),
        "task": ctx.name, "dispatch": dispatch, "role": role, "mode": mode,
        "kind": kind, "state": ctx.data.get("state", "CONTRACT"),
        "worktree": str(worktree), "branch": branch, "executor": executor.name,
        "timeout_s": executor.timeout, "started": utc_now(), "status": "pending",
        "orca": None, "launcher": os.getpid(),
        "prompt_path": str(prompt_path), "spec_path": str(spec_path), "reply_path": str(reply_path),
        "before": None,
        **extra,
    }
    orca.store(path, record)
    ctx.data.setdefault("workers", {})[dispatch] = str(path)
    _upsert_dispatch(ctx.data, {
        "id": dispatch, "role": role, "mode": mode, "status": "running",
        "started": record["started"], "ended": None, "commit": None,
        **({"phase": "CONTRACT"} if kind == "contract" else {}),
        **({"partition": extra["partition"]} if extra.get("partition") else {})})
    if extra.get("partition"):
        ctx.data["partitions"][extra["partition"]]["running"]["external"] = True
    reader = (sm.batch_of(ctx.data).get("running") or {}).get(dispatch)
    if isinstance(reader, dict):
        reader["external"] = True
    save(ctx)
    # Snapshot after the driver's own writes so they are not mistaken for the worker's.
    record["before"] = orca.snapshot_dict(snapshot_refs(worktree))
    if ctx.started and ctx.data.get("execution_binding"):
        record["control_before"] = ex.snapshot_control(ctx.main, ctx.control_worktree, ctx.task_rel, ctx.execution_main)
    orca.store(path, record)
    return path


def claim_start(path: Path, record: dict) -> bool:
    """Locked: take over the start of a prepared request whose launcher died
    before Orca answered. False: it is started, or another process starts it."""
    if orca.dispatch_id(record) or pid_alive(record.get("launcher") or 0):
        return False
    record["launcher"] = os.getpid()
    orca.store(path, record)
    return True


def launch(main: Path, path: Path) -> int:
    """Start the worker of a prepared request. No task lock is held: Orca
    answers only once the agent is ready. A failed start is collected as a
    failed dispatch."""
    path, record = orca.load(main, str(path))
    ctx = _request_ctx(record)
    ids, error = orca.start(resolve_executor(ctx.config), record)
    record["orca"] = ids
    record.pop("launcher", None)
    orca.store(path, record)
    if error:
        return collect(main, path, orca.result_of(record, error))
    print(json.dumps(orca.envelope(path, record), ensure_ascii=False))
    return 0


def prepare_run(ctx: Ctx, job: Job, executor) -> Path:
    unit = job.unit
    base = head(ctx, unit.worktree)
    range_spec = f"{job.range_from}..{base}" if job.range_from and job.role in RANGE_ROLES else None
    contract = require_contract(ctx)
    paths = _partition_paths(contract, unit.partition)
    brief = _partition_brief(ctx, unit.partition, job.brief)
    prompt = build_prompt(ctx.control_worktree, ctx.task_dir, job.role, job.mode, range_spec, job.dispatch, brief, unit.worktree if ctx.data.get("execution_binding") else None,
                          task_base=ctx.data.get("base"))
    prompt_file = runtime_dir(ctx.main, "prompts", ctx.name) / f"{job.dispatch}.md"
    prompt_file.write_text(prompt, encoding="utf-8")
    job_data = {**asdict(job), "unit": {"partition": unit.partition, "worktree": str(unit.worktree),
                                      "branch": unit.branch}}
    return prepare_worker(ctx, ctx.main, executor, job.role, job.mode, job.dispatch, "run", unit.worktree,
                          unit.branch, prompt, prompt_file, job=job_data,
                          partition=unit.partition, range_spec=range_spec, head_before=base, paths=paths)


def _request_ctx(record: dict) -> Ctx:
    ctx = load_ctx(record["task_dir"])
    if ctx is None:
        raise DriverError(f"the task of worker request {record['dispatch']} is gone")
    return ctx


def collect(main: Path, path: Path, result: ExecResult, sibling: str | None = None,
            reason: str | None = None) -> int:
    """Validate the result of a pending request and advance the task."""
    _, record = orca.load(main, str(path))
    ctx = _request_ctx(record)
    with editing(ctx):
        path, record = orca.load(main, str(path))
        if record["status"] != "pending":
            raise DriverError("this dispatch has already been collected")
        if (ctx.data.get("workers") or {}).get(record["dispatch"]) != str(path):
            raise DriverError("worker request is no longer pending in this task")
        acceptance = None
        control_observations: list[str] = []
        reason = (reason or "").strip()
        if sibling and (not record.get("control_before") or not reason):
            raise DriverError("--accept-new-control-task requires a product dispatch and a non-empty --reason")
        if record.get("control_before"):
            try:
                if sibling:
                    additions = ex.accept_new_control_task(ctx.main, ctx.control_worktree, ctx.task_rel,
                                                          record["control_before"], ctx.execution_main, sibling)
                    acceptance = {"new_task": sibling, "reason": reason, "files": additions,
                                  "checked_at": utc_now(), "dispatch": record["dispatch"]}
                else:
                    ex.check_control(ctx.main, ctx.control_worktree, ctx.task_rel, record["control_before"], ctx.execution_main)
            except ex.ExecutionError as e:
                if sibling:
                    raise DriverError(str(e)) from None
                control_observations.append(str(e))
        before = orca.snapshot_from(record["before"])
        role, mode, dispatch = record["role"], record["mode"], record["dispatch"]
        if record["kind"] == "run":
            guard_contract(ctx)
            data = record["job"]
            unit = Unit(data["unit"]["partition"], Path(data["unit"]["worktree"]), data["unit"]["branch"])
            job = Job(**{**data, "unit": unit})
            if ctx.data["state"] != job.state:
                raise DriverError("task state changed while the worker ran; resolve the pending dispatch before advancing")
            out = validate_dispatch(ctx, unit, role, dispatch, before, record["paths"],
                                    record["head_before"], record["range_spec"], result, control_observations,
                                    mode)
            ctx.data["workers"].pop(dispatch)
            if acceptance:
                ctx.data.setdefault("collection_exceptions", []).append(acceptance)
            _finish(ctx, job, out)
            rc = 0 if out.status in ("ok", "judgment") else 1
            print(f"{dispatch} {role}: {out.status}; report: {ctx.task_dir / 'reports' / (dispatch + '.md')}")
        elif record["kind"] == "contract":
            if ctx.started != bool(record.get("planning_started")):
                raise DriverError("task was started before its pending CONTRACT dispatch was collected")
            if ctx.started and ctx.data.get("state") != "CONTRACT":
                raise DriverError("task left CONTRACT before its pending research was collected")
            ctx.data["workers"].pop(dispatch)
            rc = finish_contract(ctx, main, role, mode, dispatch, record["branch"],
                                 record["task_rel"], before, result, Path(record["worktree"]))
        else:
            raise DriverError(f"unknown dispatch kind {record['kind']!r}")
        if acceptance:
            record["control_drift_acceptance"] = acceptance
        record.update(status="collected", driver_exit_code=rc, ended=utc_now())
        orca.store(path, record)
    return rc


SYNC_POLL_S = 10


def cmd_sync(args: argparse.Namespace) -> int:
    """Read every pending worker's state from Orca and collect the settled ones."""
    ctx = load_ctx(args.task)
    if ctx is None:
        raise DriverError("no active task (pass --task)")
    if args.accept_new_control_task and not args.dispatch:
        raise DriverError("--accept-new-control-task goes with --dispatch")
    executor = resolve_executor(ctx.config)
    deadline = time.monotonic() + (parse_timeout(args.wait) or 0)
    while True:
        reload(ctx)
        rc, collected, waiting, open_lines = 0, 0, False, []
        for dispatch, request in sorted((ctx.data.get("workers") or {}).items()):
            if args.dispatch and dispatch != args.dispatch:
                continue
            path, record = orca.load(ctx.main, request)
            label = f"{dispatch} {record['role']}"
            if not orca.dispatch_id(record):
                open_lines.append(f"{label}: not started (`arbor.py run --dispatch {dispatch}`)")
                continue
            state, detail = orca.observe(executor, record)
            if state == "running":
                open_lines.append(f"{label}: running (orca dispatch {orca.dispatch_id(record)})")
            elif state == "waiting":
                waiting = True
                open_lines.append(f"{label}: waiting for a person ({detail}); answer it in the worker's Orca tab")
            else:
                result = orca.result_of(record, None if state == "done" else detail)
                if state == "done" and not result.stdout.strip():
                    print(f"{label}: no reply in {record['reply_path']}"
                          + (f" (worker_done said: {detail})" if detail else "")
                          + f"; its output: `orca orchestration worker-read --dispatch {orca.dispatch_id(record)}`")
                rc |= collect(ctx.main, path, result, args.accept_new_control_task, args.reason)
                collected += 1
        if collected or waiting or not open_lines or time.monotonic() >= deadline:
            break
        time.sleep(min(SYNC_POLL_S, max(0.0, deadline - time.monotonic())))
    for line in open_lines:
        print(line)
    if not collected and not open_lines:
        print("no pending worker")
    return rc


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


def validate_dispatch(ctx: Ctx, unit: Unit, role: str, dispatch: str, before, paths,
                      head_before: str, range_spec: str | None, result: ExecResult,
                      observations: list[str] | None = None, mode: str | None = None) -> Outcome:
    """Acceptance checks on a collected worker reply."""
    reply = result.stdout
    violations = check_after_dispatch(role, before, unit.worktree, own_branch=unit.branch,
                                      task_rel_dir=(f"__control__/{ctx.name}" if ctx.data.get("execution_binding") else ctx.task_rel),
                                      dispatch_id=dispatch,
                                      scope="repository" if ctx.data.get("execution_binding") else "worktree")
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
    if _verifying(role, mode):
        check = rv.check_repros(check, unit.worktree, ctx.task_rel)
        if check.downgraded:
            violations.append("CONFIRMED without repro downgraded to PLAUSIBLE: " + ", ".join(check.downgraded))
    violations = rv.adjust_violations(role, violations, reply, check)
    violations.extend(observations or [])
    if contract_changed(ctx):
        violations.append("contract.md differs from the recorded approval")

    if not result.ok:
        status, problem = "fail", result.error
    elif not check.ok or check.confidence == "low":
        status, problem = "judgment", check.problem or "report needs main-agent interpretation"
    elif role == "implement" and rv.implement_unfinished(violations, check):
        status, problem = "judgment", ("implement reported Blocked or made no commit: "
                                       "`decide retry` to re-dispatch, or accept an interpretation")
    else:
        status, problem = "ok", check.problem
    # Observations are not proof of authorship. Never reset commits or delete
    # files: the main agent evaluates the diff, report and session context.
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
    line = pt.scope_line(worktree.resolve(), partition_branch(ctx.name, partition, branch_prefix(ctx.execution_config)), paths)
    return line + "\n\n" + brief.strip()


def _verifying(role: str, mode: str | None) -> bool:
    """A review reader that verifies its own candidates: its CONFIRMED findings need a repro."""
    return role == "review" and mode in ("candidates", "sweep")


def _prefilter_report(ctx: Ctx, findings: list[dict], range_spec: str, rel: str) -> tuple[list[dict], int]:
    """Dedup and prefilter the CONFIRMED / PLAUSIBLE ``findings`` over
    ``range_spec`` and write ``<task>/<rel>``; returns the kept findings and
    the number dropped."""
    live = [f for f in findings if str(f.get("verdict", "")).upper() in ("CONFIRMED", "PLAUSIBLE")]
    kept, dropped = rv.prefilter(rv.dedup(live), ctx.worktree, range_spec)
    (ctx.task_dir / "reports").mkdir(exist_ok=True)
    (ctx.task_dir / rel).write_text(json.dumps({
        "range": range_spec,
        "kept": [{"id": rv.finding_id(f), **f} for f in kept],
        "dropped": [{"id": rv.finding_id(f), "reason": why, **f} for f, why in dropped],
    }, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return kept, len(dropped)


def _split(findings: list[dict]) -> tuple[list[str], list[str]]:
    """(CONFIRMED ids, PLAUSIBLE ids) of prefiltered findings."""
    by = lambda v: [rv.finding_id(f) for f in findings if str(f.get("verdict", "")).upper() == v]
    return by("CONFIRMED"), by("PLAUSIBLE")


def _advance(ctx: Ctx, state: str, step: str, role: str, dispatch: str, out: Outcome) -> list[str]:
    """Apply the state table after an ok dispatch on the task branch; returns extra report lines."""
    data, notes = ctx.data, []
    if (state, step) == ("REVIEW", "review"):
        ids = [rv.finding_id(f) for f in out.check.findings
               if str(f.get("verdict", "")).upper() in ("CONFIRMED", "PLAUSIBLE")]
        sm.on_review(data, out.check.verdict or "FAIL", ids, out.range_spec.split("..")[0], out.head_before,
                     ctx.tier)
    elif (state, step) == ("REVIEW", "candidates"):
        cycle = data.setdefault("cycle", {})
        cycle.setdefault("candidate_findings", []).extend(out.check.findings)
        cycle.setdefault("candidate_repros", {}).update(out.check.repros)
        if sm.on_candidate(data, ctx.tier, dispatch, out.head_before):
            number = data["counters"].get("review", 0) + 1
            rel = f"reports/candidates-r{number}.json"
            findings, repros = cycle.pop("candidate_findings", []), cycle.pop("candidate_repros", {})
            kept, dropped = _prefilter_report(ctx, findings, str(out.range_spec), rel)
            sm.on_candidates_filtered(data, *_split(kept), f"{ctx.task_rel}/{rel}", ctx.tier, repros)
            notes.append(f"### Prefilter\n- kept {len(kept)}, dropped {dropped} -> {rel}")
    elif (state, step) == ("REVIEW", "sweep"):
        rel = "reports/sweep.json"
        kept, dropped = _prefilter_report(ctx, out.check.findings, str(out.range_spec), rel)
        sm.on_sweep_filtered(data, *_split(kept), f"{ctx.task_rel}/{rel}", out.head_before, out.check.repros)
        notes.append(f"### Prefilter\n- kept {len(kept)}, dropped {dropped} -> {rel}")
    elif role in WRITER_ROLES:
        sm.on_writer_done(data, state, step, out.head_after != out.head_before, ctx.tier,
                          verdict=out.check.verdict if role == "implement" else None, at=utc_now())
    return notes


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
        lines += ["", "### Observations for the main agent",
                  "These changes were observed during dispatch; their author is not determined.",
                  *[f"- {v}" for v in out.violations]]
    if notes:
        lines += ["", *notes]
    path = ctx.task_dir / "reports" / f"{dispatch}.md"
    path.parent.mkdir(exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _begin(ctx: Ctx, step: sm.Step, requested: str | None) -> Job:
    """Locked: pick the dispatch id, check the brief and the worktree, mark a
    partition running, commit the brief."""
    data = ctx.data
    if data.get("execution_binding") and (data.get("workers") or any(
            p.get("running") for p in (data.get("partitions") or {}).values())):
        raise DriverError("product task dispatches are serialized; collect/finish the running dispatch first")
    dispatch = step.dispatch or next_dispatch_id(data, ctx.task_dir)
    if requested and requested in step.batch:
        dispatch = requested
    if requested and requested != dispatch:
        readers = f" (or one of {', '.join(step.batch)})" if len(step.batch) > 1 else ""
        raise DriverError(f"the next dispatch{' of ' + step.partition if step.partition else ''} is "
                          f"{dispatch}{readers}, not {requested}")
    brief = _read_brief(ctx, dispatch)
    unit = ctx.unit(step.partition)
    rc, dirty, _ = run_git(["diff", "--name-only", "HEAD", "--", ".", f":(exclude){ctx.task_rel}"],
                           cwd=unit.worktree)
    if rc == 0 and dirty.strip():
        print(f"Note: existing uncommitted changes in {unit.worktree}: {', '.join(dirty.split())}", file=sys.stderr)

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
        reader = (state, step_name) in sm.BATCH_STEPS and not data.get("override_role")
        if reader and sm.on_batch_dispatch(data, dispatch, os.getpid(), force=True):
            data["dispatches"].append({
                "id": dispatch, "role": step.role, "mode": step.mode, "commit": None,
                "status": "running", "started": utc_now(), "ended": None, "range": None, "confidence": None,
            })
            save(ctx)
    assert step.role is not None
    commit_task_dir(ctx, f"arbor({ctx.name}): {dispatch} {step.role} brief")
    return Job(dispatch, step.role, step.mode, state, step_name, step.range_from, unit, brief,
               data.get("override_role") if not unit.partition else None)


def apply_mandate(ctx: Ctx) -> None:
    """Automatic decisions the task's mandate allows (PLAUSIBLE skip); printed, recorded."""
    for taken in md.apply(ctx.data, ctx.mandate, ctx.tier):
        print(colored(f"  mandate: {taken['choice']} ({taken['reason']})", Colors.YELLOW))


def _finish(ctx: Ctx, job: Job, out: Outcome) -> None:
    """Locked, on a fresh task.json: apply the outcome, record, commit."""
    data, role, dispatch, name = ctx.data, job.role, job.dispatch, job.unit.partition
    notes: list[str] = []
    if name:
        sm.on_partition_finished(data, name)
    sm.on_batch_finished(data, dispatch)
    late = (not name and not job.override and (job.state, job.step) in sm.BATCH_STEPS
            and (data.get("state"), sm.step_of(data)) != (job.state, job.step))
    if late:
        notes.append(f"### Late reader\n- {job.state} {job.step} had already moved on when {dispatch} finished; "
                     "its report is kept and not counted")
    if job.override:
        data.pop("override_role", None)
    if out.status == "judgment":
        data.setdefault("report_pending", {})[dispatch] = {
            "job": {**asdict(job), "unit": {"partition": job.unit.partition,
                    "worktree": str(job.unit.worktree), "branch": job.unit.branch}},
            "outcome": asdict(out),
        }
    elif out.status == "fail":
        if name:
            sm.on_partition_failed(data, name, role)
        else:
            sm.on_dispatch_failed(data, role)
    elif name:
        sm.on_partition_implemented(data, name)
        if role == "implement":
            sm.maybe_escalate(data, ctx.tier, {"implement_status": out.check.verdict, "at": utc_now()})
    elif not job.override and not late:
        notes = _advance(ctx, job.state, job.step, role, dispatch, out)

    res = out.exec_result
    commit = out.head_after if out.status == "ok" and out.head_after != out.head_before else None
    entry = {
        "id": dispatch, "role": role, "mode": job.mode, "commit": commit, "status": out.status,
        "started": res.started if res else utc_now(), "ended": res.ended if res else utc_now(),
        "range": out.range_spec, "confidence": out.check.confidence,
        **({"verdict": out.check.verdict} if out.check.verdict else {}),
        **({"downgraded": list(out.check.downgraded)} if out.check.downgraded else {}),
        **({"partition": name} if name else {}),
        **({"override": True} if job.override else {}),
        "observations": out.violations,
    }
    _upsert_dispatch(data, entry)
    _write_report(ctx, dispatch, role, out, notes, name)
    apply_mandate(ctx)
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
    require_report_decision(ctx)
    guard_contract(ctx)
    with editing(ctx):
        pending = _pending(ctx, args.partition, args.dispatch)
        if pending and not args.dispatch and record_is_reader(ctx, pending[1]) and sm.batch_of(ctx.data).get("ids"):
            pending = None  # start the next reader of the batch; the pending one runs alongside
        if pending:
            path = pending[0]
            if not claim_start(*pending):
                print(json.dumps(orca.envelope(*pending), ensure_ascii=False))
                return 0
        else:
            step = plan_for(ctx, args.partition)
            if step.action == "start_wave":
                return start_wave(ctx)
            if step.action == "merge":
                return merge_wave(ctx)
            if step.action == "gate":
                return cmd_gate(args, ctx)
            if step.needs != "brief":
                print(colored(step.summary, Colors.YELLOW))
                return 1
            executor = resolve_executor(ctx.config)
            limit = executor.max_parallel
            if limit and len(ctx.data.get("workers") or {}) >= limit:
                raise DriverError(f"max_parallel={limit} reached; `arbor.py sync` a running worker first")
            job = _begin(ctx, step, args.dispatch)
            path = prepare_run(ctx, job, executor)
    return launch(ctx.main, path)


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
            orca.register_worktree(ctx.config, Path(rec["worktree"]), ctx.worktree, f"{ctx.name}/{name}")
        except WorktreeError as e:
            raise DriverError(f"wave {wave}: {e}") from None
        rec["step"] = "implement"
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
    escape = _scope_escape(ctx, order)
    if escape:
        sm.on_merge_conflict(data, escape)
        save(ctx)
        commit_task_dir(ctx, f"arbor({ctx.name}): wave {wave} partition {escape['partition']} outside its paths")
        print(colored(plan_for(ctx).summary, Colors.RED))
        return 1
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
    sm.on_wave_merged(data, len(waves), ctx.tier)
    save(ctx)
    commit_task_dir(ctx, f"arbor({ctx.name}): wave {wave} merged")
    print(colored(f"wave {wave} merged: {plan_for(ctx).summary}", Colors.GREEN))
    return 0


def _scope_escape(ctx: Ctx, order: list[str]) -> dict | None:
    """The first unmerged partition whose branch changed files outside its paths
    (the task directory aside): the merge-time scope check."""
    if ctx.data.get("execution_binding"):
        return None
    contract = require_contract(ctx)
    for name in order:
        rec = ctx.data["partitions"][name]
        if rec.get("merged"):
            continue
        globs = ig.scope_globs(_partition_paths(contract, name), ctx.task_rel)
        files = ig.out_of_scope(ctx.worktree, f"{rec.get('base') or ctx.branch}..{rec['branch']}", globs)
        if files:
            return {"partition": name, "branch": rec["branch"], "into": ctx.branch, "files": files, "reason": "scope"}
    return None


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
    """Plan readers: independent explore/architect angles share a task safely."""
    role = args.role
    mode = args.mode or ("plan" if role == "review" else None)
    if args.mode and role != "review":
        raise DriverError("--mode goes with --role review")
    range_spec = getattr(args, "range", None)
    if mode == "sweep" and not range_spec:
        raise DriverError("--mode sweep needs --range <base>..<head> (a parent task reviewing its merged children)")
    if range_spec and mode != "sweep":
        raise DriverError("--range goes with --role review --mode sweep")
    ctx = load_ctx(args.task)
    if ctx is None:
        raise DriverError("no active task (task.py create <task>, or pass --task)")
    if range_spec and ctx.started:
        raise DriverError("--range is for a task that is not started (a parent task)")
    main = ctx.main
    # Allocation, replay detection and prompt persistence are one transaction.
    with editing(ctx):
        if ctx.started and ctx.data.get("state") != "CONTRACT":
            raise DriverError(f"{ctx.name} is started; use `arbor override --role {role}` outside CONTRACT")
        runs = planning_runs(ctx)
        requested = args.dispatch
        if requested and not re.fullmatch(r"d-\d{3,}", requested):
            raise DriverError("--dispatch must be d-NNN")
        # Without an explicit new id, preserve the existing resume behavior.
        existing = next((r for r in runs if not requested or r["dispatch"] == requested), None)
        if existing:
            if existing["role"] != role or existing["kind"] != "contract":
                raise DriverError("pending dispatch belongs to another role; use next --role to prepare a new angle")
            path, record = orca.load(main, existing["request_path"])
            if record["mode"] != mode:
                raise DriverError("pending dispatch has a different review mode")
            if not claim_start(path, record):
                print(json.dumps(orca.envelope(path, record), ensure_ascii=False))
                return 0
        else:
            path = _prepare_contract(ctx, main, role, mode, requested, range_spec, runs)
    return launch(main, path)


def _prepare_contract(ctx: Ctx, main: Path, role: str, mode: str | None, requested: str | None,
                      range_spec: str | None, runs: list[dict]) -> Path:
    """Locked: allocate the dispatch, assemble its prompt and persist the request."""
    blocked = planning_blocker(role, runs)
    if blocked:
        raise DriverError(blocked)
    dispatch = requested or next_dispatch_id(ctx.data, ctx.task_dir)
    used = any(d.get("id") == dispatch for d in ctx.data.get("dispatches") or [])
    if used or (ctx.task_dir / "reports" / f"{dispatch}.md").exists():
        raise DriverError(f"dispatch {dispatch} has already been used; obtain a new id with next --role")
    brief = _read_brief(ctx, dispatch)
    record = _live_integration(ctx) if mode == "sweep" else None
    if record:
        brief = (f"The merged children are checked out at {record['worktree']} (branch {record['branch']}); "
                 "read the code there, not in the main checkout.\n\n" + brief)
    task_dir = ctx.task_dir
    worktree = ctx.control_worktree if ctx.started else main
    task_rel = task_dir.relative_to(worktree).as_posix()
    before = snapshot_refs(worktree)
    if before.head_ref is None or not before.head_ref.startswith("refs/heads/"):
        raise DriverError(f"{worktree} is on a detached HEAD; check out a branch first")
    branch = before.head_ref[len("refs/heads/"):]
    executor = resolve_executor(ctx.config)
    prompt = build_prompt(worktree, task_dir, role, mode, range_spec, dispatch, brief)
    prompt_file = runtime_dir(main, "prompts", ctx.name) / f"{dispatch}.md"
    if not write_text_atomic(prompt_file, prompt):
        raise DriverError(f"cannot write {prompt_file}")
    return prepare_worker(ctx, main, executor, role, mode, dispatch, "contract", worktree, branch,
                          prompt, prompt_file, task_rel=task_rel, planning_started=ctx.started)


def finish_contract(ctx: Ctx, main: Path, role: str, mode: str | None, dispatch: str,
                    branch: str, task_rel: str, before, result: ExecResult, worktree: Path) -> int:
    violations = check_after_dispatch(
        role, before, worktree, own_branch=branch,
        task_rel_dir=task_rel, dispatch_id=None, scope="task",
    )
    after = snapshot_refs(worktree)
    check = rv.check_reply(role, result.stdout)
    if not result.ok:
        status, problem = "fail", result.error
    elif not check.ok or check.confidence == "low":
        status, problem = "judgment", check.problem or "main agent must interpret the report"
    else:
        status, problem = "ok", check.problem

    append_result(main, {
        "ts": utc_now(), "task": ctx.name, "dispatch": dispatch, "role": role, "mode": mode,
        "state": "CONTRACT", "wave": None, "partition": None,
        "executor": result.executor, "started": result.started, "ended": result.ended,
        "duration_s": result.duration_s, "exit_code": result.exit_code, "status": status, "commit": None,
        "violations": violations,
    })
    color = Colors.GREEN if status == "ok" else Colors.RED
    out = Outcome(status, result.stdout, check, result, violations, problem, None, before.head, after.head)
    _write_report(ctx, dispatch, role, out, [])
    _upsert_dispatch(ctx.data, {
        "id": dispatch, "role": role, "mode": mode, "commit": None, "status": status,
        "started": result.started, "ended": result.ended, "range": None,
        "confidence": check.confidence, "phase": "CONTRACT",
        **({"verdict": check.verdict, "findings": len(check.findings)} if role == "review" else {}),
    })
    save(ctx)
    print(colored(f"{dispatch} {role}: {status}" + (f" ({problem})" if problem else ""), color))
    print(f"  report: {ctx.task_dir / 'reports' / (dispatch + '.md')}")
    return 0 if status in ("ok", "judgment") else 1


# =============================================================================
# gate / decide / override / resume / abandon
# =============================================================================


def _gate_parent(ctx: Ctx) -> int:
    """A parent task is never started: its ``auto`` checks run in the main
    checkout against the merged children."""
    contract_path = find_contract(ctx.task_dir)
    if contract_path is None:
        raise DriverError(f"{ctx.name} has no contract.md")
    record = _live_integration(ctx)
    where = Path(record["worktree"]) if record and Path(record["worktree"]).is_dir() else ctx.main
    if where != ctx.main:
        print(f"gate in the integration worktree {where} ({record['branch']})")
    result = run_gate(get_gate_commands(ctx.config), load_contract(contract_path), where)
    print(format_checks(result.checks) or "no gate commands and no auto checks")
    print(colored(f"failing: {' '.join(result.failing)}", Colors.RED) if result.failing
          else colored("gate green", Colors.GREEN))
    return 1 if result.failing else 0


def cmd_gate(args: argparse.Namespace, ctx: Ctx | None = None) -> int:
    ctx = ctx or load_ctx(args.task)
    if ctx is not None and not ctx.started and ctx.data.get("children"):
        return _gate_parent(ctx)
    ctx = require_started(ctx)
    require_collected(ctx)
    require_report_decision(ctx)
    guard_contract(ctx)
    contract_path = find_contract(ctx.task_dir)
    if contract_path is None:
        raise DriverError(f"{ctx.name} has no contract.md")
    recheck = (ctx.data.get("after_gate") or {}).get("step") == "recheck"
    repros = sorted(
        (fid, rec["command"]) for fid, rec in ((ctx.data.get("cycle") or {}).get("repros") or {}).items()
        if rec.get("kind") == "exec" and rec.get("command")
    ) if recheck else []  # before the fix a repro fails by construction
    result = run_gate(get_gate_commands(ctx.execution_config), load_contract(contract_path), ctx.worktree,
                      repros=repros)
    if ctx.data.get("execution_binding") and not result.checks:
        result.checks.append(CheckResult("GATE-EMPTY", "", 1,
                                         "product gate has no commands or auto checks"))
    print(format_checks(result.checks) or "no gate commands and no auto checks")
    warnings = map_warnings(load_contract(contract_path), ctx.worktree, ctx.data["base"])
    for warning in warnings:
        print(colored(f"  warning: {warning}", Colors.YELLOW))
    if result.failing:
        print(colored(f"failing: {' '.join(result.failing)}", Colors.RED))
    else:
        print(colored("gate green", Colors.GREEN))

    with editing(ctx):
        data = ctx.data
        if data["state"] != "GATE" or sm.step_of(data) != "gate":
            return 1 if result.failing else 0
        delta = None
        if (data.get("after_gate") or {}).get("step") == "recheck" and data.get("last_reviewed"):
            delta = fin.changed_lines(ctx.worktree, f"{data['last_reviewed']}..HEAD")  # the fix delta
        signals = {"at": utc_now()}
        if ctx.tier == "light" and not recheck and not result.failing:
            packages = None if data.get("execution_binding") else get_packages(ctx.main)
            signals = esc.build_signals(ctx.worktree, data["base"], packages, at=signals["at"])
        escalations = len(data.get("tier_history") or [])
        sm.on_gate(data, result.failing, ctx.tier, delta_lines=delta,
                   recheck_max_lines=int(ctx.mandate["auto_merge_max_lines"]),
                   repros_run=[fid for fid, _ in repros], head=head(ctx), signals=signals)
        if len(data.get("tier_history") or []) > escalations:
            last = data["tier_history"][-1]
            print(colored(f"  tier: {last['from']} -> {last['to']} ({last['detail']})", Colors.YELLOW))
        apply_mandate(ctx)
        number = data["counters"]["gate"]
        report = ctx.task_dir / "reports" / f"gate-{number}.md"
        report.parent.mkdir(exist_ok=True)
        report.write_text(
            f"# Gate {number}: {'red' if result.failing else 'green'}\n\n"
            f"failing: {', '.join(result.failing) or 'none'}\n\n"
            + (f"repros: {', '.join(f'REPRO-{i} = {fid}' for i, (fid, _) in enumerate(repros, start=1))}\n\n"
               if repros else "")
            + f"{format_checks(result.checks)}\n"
            + "".join(f"- warning: {w}\n" for w in warnings),
            encoding="utf-8",
        )
        save(ctx)
    print(f"  next: {plan_for(ctx).summary}")
    return 1 if result.failing else 0


def decide_report(ctx: Ctx, args: argparse.Namespace) -> int:
    """The main agent interprets a report; this is not a human approval gate."""
    pending = ctx.data["report_pending"]
    dispatch = args.dispatch or next(iter(pending))
    if dispatch not in pending:
        raise DriverError(f"no pending report {dispatch}")
    if args.choice not in ("accept", "retry"):
        raise DriverError("a report decision takes accept or retry")
    saved = pending[dispatch]
    raw_job = saved["job"]
    job = Job(**{**raw_job, "unit": Unit(raw_job["unit"]["partition"],
                                        Path(raw_job["unit"]["worktree"]), raw_job["unit"]["branch"])})
    if ctx.data["state"] != job.state:
        raise DriverError("task state changed; use an explicit override to resolve the old report")
    interpretation = None
    if args.choice == "accept":
        if not args.report:
            raise DriverError("accept requires --report with the main agent's interpretation; no implicit PASS")
        interpretation = Path(args.report).read_text(encoding="utf-8")
        check = rv.check_reply(job.role, interpretation)
        if not check.ok or check.confidence == "low":
            raise DriverError(check.problem or "interpretation needs an explicit structured result")
        if _verifying(job.role, job.mode):
            check = rv.check_repros(check, job.unit.worktree, ctx.task_rel)
        raw = saved["outcome"]
        out = Outcome(**{**raw, "status": "ok", "reply": interpretation, "check": check,
                         "exec_result": ExecResult(**raw["exec_result"]) if raw["exec_result"] else None})
        notes = []
        if job.unit.partition:
            sm.on_partition_implemented(ctx.data, job.unit.partition)
            if job.role == "implement":
                sm.maybe_escalate(ctx.data, ctx.tier, {"implement_status": check.verdict, "at": utc_now()})
        elif not job.override:
            notes = _advance(ctx, job.state, job.step, job.role, dispatch, out)
        rel = f"reports/{dispatch}-interpreted.md"
        (ctx.task_dir / rel).write_text(interpretation.rstrip() + "\n\n" + "\n".join(notes) + "\n", encoding="utf-8")
        for entry in ctx.data["dispatches"]:
            if entry.get("id") == dispatch:
                entry.update(status="ok", interpreted_report=rel)
                if check.downgraded:
                    entry["downgraded"] = list(check.downgraded)
    elif job.override:
        ctx.data["override_role"] = job.override
    elif job.role == "implement" and rv.implement_unfinished(
            saved["outcome"].get("violations") or [], rv.ReplyCheck(**saved["outcome"]["check"])):
        sm.on_implement_retry(ctx.data, job.unit.partition)  # an unreadable report retries freely
    pending.pop(dispatch)
    if not pending:
        ctx.data.pop("report_pending", None)
    ctx.data.setdefault("decisions", []).append({
        "ts": utc_now(), "kind": "report", "dispatch": dispatch,
        "choice": args.choice, "reason": args.reason,
        **({"report": f"reports/{dispatch}-interpreted.md"} if interpretation is not None else {}),
    })
    save(ctx)
    commit_task_dir(ctx, f"arbor({ctx.name}): main-agent report decision {dispatch}")
    print(f"main-agent decision {dispatch}: {args.choice}; {plan_for(ctx).summary}")
    return 0


def cmd_decide(args: argparse.Namespace) -> int:
    ctx = require_started(load_ctx(args.task))
    with editing(ctx):
        require_collected(ctx)
        if ctx.data.get("report_pending"):
            return decide_report(ctx, args)
        decision = sm.decide(ctx.data, args.choice, ctx.tier)
        ctx.data.setdefault("decisions", []).append({
            "ts": utc_now(), "kind": decision.get("kind"), "choice": args.choice, "reason": args.reason,
            "failing": decision.get("failing"),
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
        if (state, step) == ("REVIEW", "candidates"):
            sm.start_cycle(data)  # a candidate cycle needs its range and counters
        else:
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
    if data.get("report_pending"):
        record["report_pending"] = list(data.pop("report_pending"))
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
        if conflict.get("reason") == "scope":
            # Not accepted by a hand merge: the branch was corrected; check it again.
            ctx.data.pop("merge_conflict")
            return _merge_remaining(ctx)
        raise DriverError(f"{conflict['branch']} is not merged into {conflict.get('into')} yet: run "
                          f"`git merge --no-ff {conflict['branch']}` in {ctx.worktree}, resolve, commit")
    name = sm.on_conflict_resolved(ctx.data, head(ctx))
    print(colored(f"  {name}: merged by hand", Colors.GREEN))
    return _merge_remaining(ctx)


def _resume(ctx: Ctx) -> int:
    data = ctx.data
    in_place = data.get("state") not in ("STOP", "CONTRACT") and contract_changed(ctx)
    reapprove = data.get("state") == "CONTRACT" or (data.get("stop") or {}).get("contract") or in_place
    if reapprove:
        path = find_contract(ctx.task_dir)
        if path is None:
            raise DriverError(f"{ctx.name} has no contract.md")
        try:
            errors = validate_contract(load_contract(path))
        except ContractError as e:
            errors = [str(e)]
        if errors:
            for error in errors:
                print(colored(f"  {error}", Colors.RED))
            raise DriverError("contract.md does not validate; fix it before re-approving")
        data["contract_hash"] = contract_hash(path)
    if in_place:
        # an in-scope edit after start (wording, a clarified interface): record it, the state stays
        data.setdefault("decisions", []).append({"ts": utc_now(), "kind": "contract", "choice": "re-approve",
                                                 "reason": "contract.md edited after start"})
        message = f"contract re-approved in place; {data['state']}/{sm.step_of(data)} unchanged"
    else:
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
# children
# =============================================================================


def find_task_anywhere(main: Path, config: dict, name: str, roots: tuple[Path, ...] = ()) -> tuple[Path, dict] | None:
    """A task directory by name: main checkout, its task worktree, the archive,
    then the same places in ``roots`` (a parent's integration worktree)."""
    candidates = [main / DIR_WORKFLOW / DIR_TASKS / name,
                  worktree_root(main, config) / name / DIR_WORKFLOW / DIR_TASKS / name,
                  *sorted((main / DIR_WORKFLOW / DIR_TASKS / "archive").glob(f"*/{name}"))]
    for root in roots:
        candidates += [root / DIR_WORKFLOW / DIR_TASKS / name,
                       *sorted((root / DIR_WORKFLOW / DIR_TASKS / "archive").glob(f"*/{name}"))]
    for task_dir in candidates:
        data, _ = read_json_checked(task_dir / FILE_TASK_JSON) if (task_dir / FILE_TASK_JSON).is_file() else (None, "")
        if data is not None:
            return task_dir, data
    return None


def _live_integration(ctx: Ctx) -> dict | None:
    record = ctx.data.get("integration")
    return record if isinstance(record, dict) and not record.get("cleaned") else None


def _integration_view(ctx: Ctx, rows: list[dict]) -> dict | None:
    record = ctx.data.get("integration")
    if not isinstance(record, dict):
        return None
    view = {**record, "children_merged": sum(1 for r in rows if r.get("merged")),
            "all_merged": bool(rows) and all(r.get("merged") for r in rows)}
    if record.get("cleaned"):
        return view
    branch, base = record["branch"], record["base_branch"]
    view["merged_into_base"] = fin.branch_exists(ctx.main, branch) and fin.is_merged(ctx.main, branch, base)
    view["sweep_range"] = f"{record['base']}..{branch}"
    view["merge_command"] = fin.merge_command(ctx.main, branch, base)
    return view


def _integration_cleanup(ctx: Ctx) -> int:
    """After a human merged the integration branch into the baseline: one journal
    entry for the parent, then the integration worktree and branch go."""
    record = ctx.data.get("integration")
    if not isinstance(record, dict):
        raise DriverError(f"{ctx.name} has no integration branch")
    if record.get("cleaned"):
        print(f"{record['branch']}: already cleaned up ({record['cleaned']})")
        return 0
    branch, base, wt = record["branch"], record["base_branch"], Path(record["worktree"])
    if not fin.branch_exists(ctx.main, branch) or not fin.is_merged(ctx.main, branch, base):
        raise DriverError(f"{branch} is not merged into {base} yet; a human merges it first: "
                          f"{fin.merge_command(ctx.main, branch, base)}")
    if wt.exists() and fin.dirty_paths(wt):
        raise DriverError(f"the integration worktree {wt} has uncommitted changes; commit or discard them first:\n  "
                          + "\n  ".join(fin.dirty_paths(wt)))
    tip = fin._git(ctx.main, "rev-parse", f"refs/heads/{branch}")
    merged_by = fin.merge_commit(ctx.main, tip, base)
    children = record.get("merged") or []
    changes = [arg for m in children for arg in ("--change", f"{m.get('task')}: {m.get('summary')}")]
    rc, out = fin._script(
        ctx.main, "add_session.py", "--title", str(ctx.data.get("title") or ctx.name), "--commit", merged_by,
        "--summary", f"{len(children)} child task(s) merged through {branch}", "--branch", base,
        "--change", f"Merged {branch} into {base} ({merged_by[:12]})", *changes,
        "--idempotency-key", f"arbor-integration-{ctx.name}"[:64],
    )
    if rc != 0:
        raise DriverError(f"add_session.py failed:\n{out}")
    print("  journal: ok")
    try:
        if wt.exists():
            remove_worktree(ctx.main, wt, delete_branch=True)
        else:
            fin._git(ctx.main, "worktree", "prune")
            fin._git(ctx.main, "branch", "-D", branch)
    except WorktreeError as e:
        raise DriverError(str(e)) from None
    print(f"  removed {wt} and {branch}")
    record["cleaned"] = utc_now()
    record["merge_commit"] = merged_by
    save(ctx)
    print(colored(f"{ctx.name}: integration done; archive it with `task.py archive {ctx.name}`", Colors.GREEN))
    return 0


def _children_rows(ctx: Ctx) -> list[dict]:
    """One row per child: where it is, whether it is merged into its target."""
    record = ctx.data.get("integration") if isinstance(ctx.data.get("integration"), dict) else None
    roots = (Path(record["worktree"]),) if record and Path(record["worktree"]).is_dir() else ()
    rows = []
    for name in ctx.data.get("children") or []:
        found = find_task_anywhere(ctx.main, ctx.config, name, roots)
        row: dict = {"task": name, "found": found is not None}
        if found:
            task_dir, data = found
            started = bool(data.get("worktree_path") and data.get("state"))
            row.update({
                "status": data.get("status"), "started": started, "tier": resolve_tier(task_dir, data),
                "state": data.get("state"), "step": sm.step_of(data) if started else None,
                "merged": (True if data.get("state") == "DONE" else
                           fin.is_merged(ctx.main, data["branch"], data.get("base_branch") or fin.current_branch(ctx.main) or "")
                           if started and data.get("branch") and fin.branch_exists(ctx.main, data["branch"]) else
                           False if started else None),
                "merge_target": data.get("base_branch"),
                "dir": str(task_dir),
            })
            if record and started and data.get("state") != "DONE" and fin.branch_exists(ctx.main, data["branch"]):
                row["behind"] = not fin.is_merged(ctx.main, record["branch"], data["branch"])
        rows.append(row)
    return rows


def cmd_children(args: argparse.Namespace) -> int:
    ctx = load_ctx(args.task)
    if ctx is None:
        raise DriverError("no active task (pass --task <parent>)")
    if getattr(args, "cleanup", False):
        return _integration_cleanup(ctx)
    rows = _children_rows(ctx)
    view = _integration_view(ctx, rows)
    if args.json:
        print(json.dumps({"task": ctx.name, "children": rows, "integration": view}, ensure_ascii=False))
        return 0
    print(colored(f"{ctx.name}: {len(rows)} children", Colors.BLUE))
    for row in rows:
        if not row["found"]:
            print(f"  {row['task']}: not found")
            continue
        where = f"{row['state']}/{row['step']}" if row["started"] else row["status"]
        merged = f" merged into {row.get('merge_target')}" if row["merged"] else ""
        behind = " (behind the integration branch)" if row.get("behind") else ""
        print(f"  {row['task']}: {where} [{row['tier']}]{merged}{behind}")
    if view and view.get("cleaned"):
        print(f"  integration: {view['branch']} merged and cleaned up ({view['cleaned']})")
    elif view:
        print(f"  integration: {view['branch']} at {view['worktree']} -> {view['base_branch']}, "
              f"{view['children_merged']}/{len(rows)} children merged")
        if view["merged_into_base"]:
            print(f"  merged into {view['base_branch']}: `arbor --task {ctx.name} "
                  f"{'finish' if ctx.started else 'children --cleanup'}`")
        elif ctx.started:
            print(f"  integration review running: `arbor --task {ctx.name} next`")
        elif view["all_merged"]:
            print(f"  every child is merged: `task.py integrate {ctx.name}` starts the integration review "
                  f"(candidates, fix on {view['branch']}), then a human merges it: {view['merge_command']}")
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
    require_report_decision(ctx)
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
    mandate = ctx.mandate
    contract = require_contract(ctx)
    scope = ig.scope_globs([g for part in contract.partitions for g in part.paths], ctx.task_rel)

    def gate() -> list[str]:
        result = run_gate(get_gate_commands(ctx.execution_config), contract, ctx.worktree)
        print(format_checks(result.checks) or "no gate commands and no auto checks")
        return result.failing

    rc = fin.finish_before_merge(ctx.main, ctx.worktree, ctx.task_dir, ctx.task_rel, ctx.data, ctx.tier,
                                 want_pr=args.pr, save=lambda: save(ctx),
                                 auto_merge_max_lines=mandate["auto_merge_max_lines"]
                                 if mandate["merge"] == "auto" and not args.pr and not ctx.data.get("integration_review")
                                 else None,
                                 scope=scope, gate=gate)
    merged_itself = ctx.data.get("auto_merge") or ctx.data.get("integration_merge")
    if rc == 0 and merged_itself and fin.is_merged(ctx.main, ctx.branch, fin.base_branch_of(ctx.main, ctx.data)):
        print(colored(f"{ctx.branch} is merged: cleaning up", Colors.BLUE))
        return fin.cleanup(ctx.main, fin.start_cleanup(ctx.main, ctx.task_dir, ctx.data))
    return rc


# =============================================================================
# prompt
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
                        brief, ctx.unit(partition).worktree if ctx.started and ctx.data.get("execution_binding") else None,
                        task_base=ctx.data.get("base") if ctx.started else None)
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
    if dispatch in (sm.batch_of(ctx.data).get("ids") or []):
        return plan_for(ctx)
    if dispatch != next_dispatch_id(ctx.data, ctx.task_dir):
        raise DriverError(f"unknown dispatch {dispatch}")
    step = plan_for(ctx)
    if step.needs != "brief" or step.partition:
        raise DriverError(f"{dispatch} is not a dispatch step: {step.summary}")
    return step


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
    p.add_argument("--role", choices=CONTRACT_ROLES, help="prepare another CONTRACT research/design angle")
    p.set_defaults(func=cmd_next)
    p = sub.add_parser("run", help="dispatch briefs/<id>.md, validate, advance")
    p.add_argument("--dispatch")
    p.add_argument("--role", choices=CONTRACT_ROLES, help="CONTRACT phase only: dispatch before task.py start")
    p.add_argument("--mode", choices=("plan", "sweep"), help="with --role review (sweep: a parent task over --range)")
    p.add_argument("--range", help="<base>..<head> for --role review --mode sweep on a parent task")
    p.add_argument("--partition", help="run this partition's step (multi-partition waves)")
    p.add_argument("--autopilot", action="store_true",
                   help="keep going until a decision, a human gate, STOP, red or a failed dispatch")
    p.set_defaults(func=cmd_run)
    p = sub.add_parser("sync", help="read the pending workers' state from Orca, collect the settled ones")
    p.add_argument("--dispatch", help="only this dispatch (d-NNN)")
    p.add_argument("--wait", metavar="DURATION",
                   help="poll until a worker settles or needs a person, at most this long (10m, 90s)")
    p.add_argument("--accept-new-control-task", metavar="NAME",
                   help="explicitly accept only a newly created sibling task in control main; audit hashes are recorded")
    p.add_argument("--reason", help="required justification for --accept-new-control-task")
    p.set_defaults(func=cmd_sync)
    p = sub.add_parser("children", help="one line per child task: state, merged; the parent's integration branch")
    p.add_argument("--json", action="store_true")
    p.add_argument("--cleanup", action="store_true",
                   help="after a human merged the integration branch: journal, remove its worktree and branch")
    p.set_defaults(func=cmd_children)
    p = sub.add_parser("finish", help="FINISH: scorecard + PR / merge command; cleanup after the merge")
    p.add_argument("--pr", action="store_true", help="push the task branch and open a PR with gh")
    p.set_defaults(func=cmd_finish)
    sub.add_parser("gate", help="run level 0: gate commands + contract auto checks").set_defaults(func=cmd_gate)
    p = sub.add_parser("decide", help="answer a decision the state table asked for")
    p.add_argument("choice", choices=(*sm.DECIDE_CHOICES, *sm.PLAUSIBLE_CHOICES, "accept", "retry"))
    p.add_argument("--dispatch", help="report awaiting main-agent judgment (defaults to the first)")
    p.add_argument("--report", help="main agent's interpreted report; original agent output is retained")
    p.add_argument("--reason", required=True)
    p.set_defaults(func=cmd_decide)
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
