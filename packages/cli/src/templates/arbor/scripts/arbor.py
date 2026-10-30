#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
arbor: the task driver. It owns the state table, the counters and the
validators; models write briefs and answer the decisions it asks for.

Usage (from the main checkout or any worktree of the repo):
    python3 ./.arbor/scripts/arbor.py next [--json]
    python3 ./.arbor/scripts/arbor.py run [--dispatch d-NNN]
    python3 ./.arbor/scripts/arbor.py run --role explore|architect|review [--mode plan] [--dispatch d-NNN]
    python3 ./.arbor/scripts/arbor.py gate
    python3 ./.arbor/scripts/arbor.py decide <impl|tests|contract|fix|skip> --reason "..."
    python3 ./.arbor/scripts/arbor.py canary [--role explore|review|verify]
    python3 ./.arbor/scripts/arbor.py override --reason "..." (--role R [--mode M] | --to STATE[/step])
    python3 ./.arbor/scripts/arbor.py status | resume | abandon [--reason "..."]
    python3 ./.arbor/scripts/arbor.py prompt --dispatch d-NNN --print

Every command takes ``--task <dir>``; the default is the session's active task.

``run --role`` is the CONTRACT phase (task not started yet): a read-only
dispatch in the main checkout, recorded in task.json and results.jsonl,
never committed and outside the state table. Without any task, ``--role
explore`` reads its brief from stdin and prints the reply.

Files:
    <task>/briefs/d-NNN.md      the brief the main agent writes before `run`
    <task>/reports/d-NNN.md     the reply plus the driver's verdict
    <task>/reports/gate-N.md    output of the N-th gate round
    <task>/reports/candidates-rN.json   POLISH round N after the prefilter
    .arbor/.runtime/prompts/<task>/d-NNN.md   the full prompt sent (main checkout)
    .arbor/.runtime/results.jsonl             one row per dispatch (main checkout)

Exit codes: 0 ok, 1 refused / failed dispatch / red gate, 2 usage error.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path

from common.active_task import resolve_active_task, resolve_task_ref
from common.arbor_config import get_gate_commands, get_test_paths, read_arbor_config
from common.contract import (
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
from common.driver import state as sm
from common.driver import validate as rv
from common.driver.executor import ExecResult, ExecutorError, resolve_executor, run_executor, utc_now
from common.driver.gate import format_checks, run_gate, run_red_check
from common.git import run_git
from common.invariants import WRITER_ROLES, _dirty_paths, check_after_dispatch, snapshot_refs
from common.io import read_json_checked, write_json
from common.log import Colors, colored
from common.paths import DIR_TASKS, DIR_WORKFLOW, FILE_TASK_JSON
from common.tasks import resolve_tier
from common.worktree import main_checkout

RUNTIME = f"{DIR_WORKFLOW}/.runtime"
CANARY_ROLES = ("explore", "review", "verify")
CONTRACT_ROLES = ("explore", "architect", "review")
STDERR_TAIL_LINES = 40


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
    def branch(self) -> str:
        return self.data["branch"]

    @property
    def task_rel(self) -> str:
        return f"{DIR_WORKFLOW}/{DIR_TASKS}/{self.name}"

    @property
    def tier(self) -> str:
        return resolve_tier(self.task_dir, self.data)


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
    return Ctx(main, read_arbor_config(main), task_dir, task_dir.name, data, started)


def require_started(ctx: Ctx | None) -> Ctx:
    if ctx is None:
        raise DriverError("no active task (task.py start <task>, or pass --task)")
    if not ctx.started:
        raise DriverError(f"task {ctx.name} has not been started in a worktree (task.py start)")
    return ctx


def save(ctx: Ctx) -> None:
    if not write_json(ctx.task_dir / FILE_TASK_JSON, ctx.data):
        raise DriverError(f"failed to write {ctx.task_dir / FILE_TASK_JSON}")


def git(ctx: Ctx, *args: str) -> str:
    rc, out, err = run_git(list(args), cwd=ctx.worktree)
    if rc != 0:
        raise DriverError(f"git {' '.join(args)} failed: {err.strip()}")
    return out.strip()


def head(ctx: Ctx) -> str:
    return git(ctx, "rev-parse", "HEAD")


def commit_task_dir(ctx: Ctx, message: str) -> bool:
    """Commit pending changes under the task dir on the task branch."""
    git(ctx, "add", "-A", "--", ctx.task_rel)
    rc, _, _ = run_git(["diff", "--cached", "--quiet", "--", ctx.task_rel], cwd=ctx.worktree)
    if rc == 0:
        return False
    git(ctx, "commit", "-q", "--no-verify", "-m", message, "--", ctx.task_rel)
    return True


def touched_files(ctx: Ctx) -> list[str]:
    rc, out, _ = run_git(["diff", "--name-only", f"{ctx.data['base']}..HEAD"], cwd=ctx.worktree)
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
        sm.stop(ctx.data, "HUMAN", "contract.md changed since approval; re-approve it with `arbor resume`",
                contract=True)
        save(ctx)
        raise DriverError(ctx.data["stop"]["detail"])


def next_dispatch_id(data: dict, task_dir: Path | None = None) -> str:
    """One past the highest id in task.json ``dispatches`` and in ``reports/``
    (``task.py start`` resets ``dispatches``; the CONTRACT-phase reports stay)."""
    ids = [str(d.get("id", "")) for d in data.get("dispatches") or [] if isinstance(d, dict)]
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
                 range_spec: str | None, dispatch: str | None, brief: str) -> str:
    header = DispatchHeader(
        task_dir=str(task_dir) if task_dir else None, role=role, mode=mode, diff=None,
        target=None, workspace=None, body=brief.strip(), range=range_spec, dispatch=dispatch,
    )
    return build_dispatch_prompt(
        DispatchRequest(repo_root=worktree, role=role, task_dir=task_dir, header=header, original_text=brief)
    ).text


# =============================================================================
# next / status
# =============================================================================


def next_payload(ctx: Ctx | None) -> dict:
    if ctx is None:
        return {"task": None, "state": "INTAKE", "needs": "human",
                "summary": "No active task: agree a tier, write contract.md, then `task.py start`"}
    if not ctx.started:
        dispatch = next_dispatch_id(ctx.data, ctx.task_dir)
        return {"task": ctx.name, "state": "CONTRACT", "needs": "human", "dispatch": dispatch,
                "brief_path": str(brief_path(ctx, dispatch)), "human": {"kind": "approve_contract"},
                "contract_roles": list(CONTRACT_ROLES),
                "summary": f"CONTRACT: finish {ctx.name}/contract.md (research with `arbor run --role "
                           "explore|architect|review [--mode plan]` after writing the brief); after human "
                           "approval run `task.py start`"}
    data = ctx.data
    if data.get("state") not in ("STOP", "CONTRACT") and contract_changed(ctx):
        step = sm.Step("human", f"{data['state']}: contract.md changed since approval; "
                       "a human re-approves it with `arbor resume`",
                       human={"kind": "approve_contract"})
    else:
        step = sm.plan(data, ctx.tier)
    out: dict = {"task": ctx.name, "state": data["state"], "tier": ctx.tier, "wave": data.get("wave", 1),
                 "partition": "default", "needs": step.needs}
    if step.role:
        dispatch = next_dispatch_id(data, ctx.task_dir)
        out["role"] = step.role
        out["mode"] = step.mode
        if step.role in RANGE_ROLES and step.range_from:
            out["range"] = f"{step.range_from}..{head(ctx)}"
        out["dispatch"] = dispatch
        out["brief_path"] = str(brief_path(ctx, dispatch))
    if step.decision:
        out["decision"] = step.decision
    if step.human:
        out["human"] = step.human
    out["touched_files"] = touched_files(ctx)
    out["summary"] = step.summary
    return out


def cmd_next(args: argparse.Namespace) -> int:
    payload = next_payload(load_ctx(args.task))
    if args.json:
        print(json.dumps(payload, ensure_ascii=False))
        return 0
    print(colored(payload["summary"], Colors.CYAN))
    for key in ("role", "mode", "range", "dispatch", "brief_path"):
        if payload.get(key):
            print(f"  {key}: {payload[key]}")
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
    for entry in d["dispatches"][-5:]:
        print(f"  {entry.get('id')} {entry.get('role'):<9} {entry.get('status'):<9} {entry.get('commit') or ''}")
    print(f"  next: {sm.plan(ctx.data, ctx.tier).summary}")
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


def _restore(ctx: Ctx, before) -> None:
    """Put the task branch back where it was before the dispatch."""
    after = snapshot_refs(ctx.worktree)
    if after.head_ref != before.head_ref:
        run_git(["checkout", "-q", "-f", ctx.branch], cwd=ctx.worktree)
    run_git(["reset", "-q", "--hard", before.head], cwd=ctx.worktree)
    stray = sorted(
        p for p in snapshot_refs(ctx.worktree).dirty - before.dirty
        if not p.startswith(f"{ctx.task_rel}/")
    )
    if stray:
        run_git(["clean", "-fdq", "--", *stray], cwd=ctx.worktree)


def dispatch_once(ctx: Ctx, role: str, mode: str | None, range_from: str | None, dispatch: str,
                  brief: str) -> Outcome:
    commit_task_dir(ctx, f"arbor({ctx.name}): {dispatch} {role} brief")
    head_before = head(ctx)
    range_spec = f"{range_from}..{head_before}" if range_from and role in RANGE_ROLES else None
    prompt = build_prompt(ctx.worktree, ctx.task_dir, role, mode, range_spec, dispatch, brief)
    prompt_file = runtime_dir(ctx.main, "prompts", ctx.name) / f"{dispatch}.md"
    prompt_file.write_text(prompt, encoding="utf-8")

    contract_path = find_contract(ctx.task_dir)
    contract = load_contract(contract_path) if contract_path else None
    test_paths = (
        effective_test_paths(contract, get_test_paths(ctx.config)) if contract else get_test_paths(ctx.config)
    )
    before = snapshot_refs(ctx.worktree)
    try:
        executor = resolve_executor(ctx.config)
    except ExecutorError as e:
        empty = rv.ReplyCheck(False, str(e))
        return Outcome("fail", "", empty, None, [], str(e), range_spec, head_before, head_before)
    result = run_executor(executor, role=role, prompt_path=prompt_file, worktree=ctx.worktree,
                          task=ctx.name, dispatch=dispatch)
    reply = result.stdout
    violations = check_after_dispatch(role, before, ctx.worktree, own_branch=ctx.branch, test_paths=test_paths,
                                      task_rel_dir=ctx.task_rel, dispatch_id=dispatch)
    if role in WRITER_ROLES:
        leftover = sorted(
            p for p in _dirty_paths(ctx.worktree) - before.dirty
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
    if status != "ok":
        _restore(ctx, before)
    return Outcome(status, reply, check, result, violations, problem, range_spec, head_before, head(ctx))


def _advance(ctx: Ctx, state: str, step: str, role: str, dispatch: str, out: Outcome) -> list[str]:
    """Apply the state table after an ok dispatch; returns extra report lines."""
    data, notes = ctx.data, []
    if (state, step) == ("BUILD", "test"):
        contract = load_contract(find_contract(ctx.task_dir))
        red = run_red_check(contract, ctx.worktree)
        sm.on_red_check(data, red.passing, red.errored)
        notes += ["### Red check", format_checks(red.checks) or "- no auto checks"]
        if not red.valid:
            notes.append(f"Not a valid red: passing {red.passing or '-'}, collection errors {red.errored or '-'}")
    elif (state, step) == ("REVIEW", "review"):
        ids = [rv.finding_id(f) for f in out.check.findings
               if str(f.get("verdict", "")).upper() in ("CONFIRMED", "PLAUSIBLE")]
        sm.on_review(data, ctx.tier, out.check.verdict or "FAIL", ids, out.range_spec.split("..")[0], out.head_before)
    elif (state, step) == ("POLISH", "candidates"):
        polish = data.setdefault("polish", {})
        polish.setdefault("candidate_findings", []).extend(out.check.findings)
        if sm.on_candidate(data, ctx.tier, dispatch, out.head_before):
            findings = rv.dedup(polish.pop("candidate_findings", []))
            range_spec = f"{polish.get('range_from')}..{out.head_before}"
            kept, dropped = rv.prefilter(findings, ctx.worktree, range_spec)
            number = data["counters"].get("polish", 0) + 1
            rel = f"reports/candidates-r{number}.json"
            (ctx.task_dir / "reports").mkdir(exist_ok=True)
            (ctx.task_dir / rel).write_text(json.dumps({
                "range": range_spec,
                "kept": [{"id": rv.finding_id(f), **f} for f in kept],
                "dropped": [{"id": rv.finding_id(f), "reason": why, **f} for f, why in dropped],
            }, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
            sm.on_candidates_filtered(data, [rv.finding_id(f) for f in kept], f"{ctx.task_rel}/{rel}")
            notes.append(f"### Prefilter\n- kept {len(kept)}, dropped {len(dropped)} -> {rel}")
    elif (state, step) == ("POLISH", "verify"):
        by = lambda v: [rv.finding_id(f) for f in out.check.findings if str(f.get("verdict", "")).upper() == v]
        sm.on_verify(data, by("CONFIRMED"), by("PLAUSIBLE"))
    elif role in WRITER_ROLES:
        sm.on_writer_done(data, state, step, out.head_after != out.head_before)
    return notes


def _write_report(ctx: Ctx, dispatch: str, role: str, out: Outcome, notes: list[str]) -> None:
    lines = [out.reply.rstrip(), "", "---", "", f"## Driver: {dispatch} {role} {out.status}", ""]
    res = out.exec_result
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


def cmd_run(args: argparse.Namespace) -> int:
    if args.role:
        return cmd_run_contract(args)
    if args.mode:
        raise DriverError("--mode goes with --role review")
    ctx = require_started(load_ctx(args.task))
    data = ctx.data
    guard_contract(ctx)
    step = sm.plan(data, ctx.tier)
    if step.needs == "run":
        return cmd_gate(args, ctx)
    if step.needs != "brief":
        print(colored(step.summary, Colors.YELLOW))
        return 1
    dispatch = next_dispatch_id(data, ctx.task_dir)
    if args.dispatch and args.dispatch != dispatch:
        raise DriverError(f"the next dispatch is {dispatch}, not {args.dispatch}")
    brief_file = brief_path(ctx, dispatch)
    brief = brief_file.read_text(encoding="utf-8") if brief_file.is_file() else ""
    if not brief.strip():
        raise DriverError(f"write the brief first: {brief_file}")
    rc, dirty, _ = run_git(["diff", "--name-only", "HEAD", "--", ".", f":(exclude){ctx.task_rel}"],
                           cwd=ctx.worktree)
    if rc == 0 and dirty.strip():
        raise DriverError(f"uncommitted changes in {ctx.worktree}: {', '.join(dirty.split())}; commit or discard them")

    state, step_name, role, mode = data["state"], sm.step_of(data), step.role, step.mode
    override = data.pop("override_role", None)
    print(colored(f"{dispatch}: {role}{' (' + mode + ')' if mode else ''} in {ctx.worktree}", Colors.BLUE))
    out = dispatch_once(ctx, role, mode, step.range_from, dispatch, brief)

    notes: list[str] = []
    if out.status == "violation":
        sm.on_violation(data, role, dispatch, out.violations)
    elif out.status == "fail":
        sm.on_dispatch_failed(data, role)
    elif not override:
        notes = _advance(ctx, state, step_name, role, dispatch, out)

    res = out.exec_result
    commit = out.head_after if out.status == "ok" and out.head_after != out.head_before else None
    data["dispatches"].append({
        "id": dispatch, "role": role, "mode": mode, "commit": commit, "status": out.status,
        "started": res.started if res else utc_now(), "ended": res.ended if res else utc_now(),
        "range": out.range_spec, "confidence": out.check.confidence,
        **({"override": True} if override else {}),
    })
    _write_report(ctx, dispatch, role, out, notes)
    save(ctx)
    commit_task_dir(ctx, f"arbor({ctx.name}): {dispatch} {role} {out.status}")
    append_result(ctx.main, {
        "ts": utc_now(), "task": ctx.name, "dispatch": dispatch, "role": role, "mode": mode,
        "state": state, "wave": data.get("wave", 1), "partition": "default",
        "executor": res.executor if res else None,
        "started": res.started if res else None, "ended": res.ended if res else None,
        "duration_s": res.duration_s if res else 0, "exit_code": res.exit_code if res else None,
        "status": out.status, "commit": commit, "violations": out.violations,
    })

    color = Colors.GREEN if out.status == "ok" else Colors.RED
    print(colored(f"{dispatch} {role}: {out.status}" + (f" ({out.problem})" if out.problem else ""), color))
    print(f"  report: {ctx.task_dir / 'reports' / (dispatch + '.md')}")
    print(f"  next: {sm.plan(data, ctx.tier).summary}")
    return 0 if out.status == "ok" else 1


def _contract_restore(main: Path, paths: list[str]) -> None:
    """Undo new dirty paths in the main checkout without moving HEAD."""
    rc, out, _ = run_git(["ls-files", "--", *paths], cwd=main)
    tracked = set(out.splitlines()) if rc == 0 else set()
    if tracked:
        run_git(["checkout", "-q", "--", *sorted(tracked)], cwd=main)
    untracked = [p for p in paths if p not in tracked]
    if untracked:
        run_git(["clean", "-fq", "--", *untracked], cwd=main)


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
    print(colored(f"{dispatch}: {role}{' (' + mode + ')' if mode else ''} in {main}", Colors.BLUE))
    result = run_executor(executor, role=role, prompt_path=prompt_file, worktree=main,
                          task=ctx.name if ctx else "", dispatch=dispatch)
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
        stray = sorted(p for p in after.dirty - before.dirty
                       if task_rel is None or not p.startswith(f"{task_rel}/"))
        if stray:
            _contract_restore(main, stray)
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
    guard_contract(ctx)
    contract_path = find_contract(ctx.task_dir)
    if contract_path is None:
        raise DriverError(f"{ctx.name} has no contract.md")
    result = run_gate(get_gate_commands(ctx.config), load_contract(contract_path), ctx.worktree)
    print(format_checks(result.checks) or "no gate commands and no auto checks")
    if result.failing:
        print(colored(f"failing: {' '.join(result.failing)}", Colors.RED))
    else:
        print(colored("gate green", Colors.GREEN))

    data = ctx.data
    if data["state"] == "GATE" and sm.step_of(data) == "gate":
        sm.on_gate(data, result.failing)
        number = data["counters"]["gate"]
        report = ctx.task_dir / "reports" / f"gate-{number}.md"
        report.parent.mkdir(exist_ok=True)
        report.write_text(
            f"# Gate {number}: {'red' if result.failing else 'green'}\n\n"
            f"failing: {', '.join(result.failing) or 'none'}\n\n{format_checks(result.checks)}\n",
            encoding="utf-8",
        )
        save(ctx)
        print(f"  next: {sm.plan(ctx.data, ctx.tier).summary}")
    return 1 if result.failing else 0


def cmd_decide(args: argparse.Namespace) -> int:
    ctx = require_started(load_ctx(args.task))
    decision = sm.decide(ctx.data, args.choice)
    ctx.data.setdefault("decisions", []).append({
        "ts": utc_now(), "kind": decision.get("kind"), "choice": args.choice, "reason": args.reason,
        "failing": decision.get("failing"),
    })
    save(ctx)
    print(colored(f"decided {args.choice}: {sm.plan(ctx.data, ctx.tier).summary}", Colors.GREEN))
    return 0


def cmd_override(args: argparse.Namespace) -> int:
    ctx = require_started(load_ctx(args.task))
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
    print(colored(f"override recorded: {sm.plan(ctx.data, ctx.tier).summary}", Colors.YELLOW))
    return 0


def cmd_resume(args: argparse.Namespace) -> int:
    ctx = require_started(load_ctx(args.task))
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
    print(colored(f"{message}: {sm.plan(ctx.data, ctx.tier).summary}", Colors.GREEN))
    return 0


def cmd_abandon(args: argparse.Namespace) -> int:
    ctx = require_started(load_ctx(args.task))
    sm.stop(ctx.data, "HUMAN", f"abandoned{': ' + args.reason if args.reason else ''}")
    save(ctx)
    print(colored(f"{ctx.name}: STOP (HUMAN, abandoned)", Colors.YELLOW))
    return 0


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
    if not ctx.started:
        if entry is None:
            raise DriverError(f"unknown dispatch {args.dispatch} (before start only recorded dispatches rebuild)")
        role, mode, range_spec = entry["role"], entry.get("mode"), None
    elif entry is not None:
        role, mode, range_spec = entry["role"], entry.get("mode"), entry.get("range")
    elif args.dispatch == next_dispatch_id(ctx.data, ctx.task_dir):
        step = sm.plan(ctx.data, ctx.tier)
        if step.needs != "brief":
            raise DriverError(f"{args.dispatch} is not a dispatch step: {step.summary}")
        role, mode = step.role, step.mode
        range_spec = f"{step.range_from}..{head(ctx)}" if step.range_from and role in RANGE_ROLES else None
    else:
        raise DriverError(f"unknown dispatch {args.dispatch}")
    text = build_prompt(ctx.worktree if ctx.started else ctx.main, ctx.task_dir, role, mode, range_spec, args.dispatch,
                        brief_file.read_text(encoding="utf-8"))
    if args.print:
        sys.stdout.write(text)
    else:
        print(f"{args.dispatch}: {role} {mode or ''} {range_spec or ''} ({len(text.encode('utf-8'))} bytes)")
    return 0


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
    result = run_executor(executor, role=role, prompt_path=prompt_file, worktree=worktree,
                          task=ctx.name if ctx else "", dispatch="canary")
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
    p.set_defaults(func=cmd_next)
    p = sub.add_parser("run", help="dispatch briefs/<id>.md, validate, advance")
    p.add_argument("--dispatch")
    p.add_argument("--role", choices=CONTRACT_ROLES, help="CONTRACT phase only: dispatch before task.py start")
    p.add_argument("--mode", choices=("plan",), help="with --role review")
    p.set_defaults(func=cmd_run)
    sub.add_parser("gate", help="run level 0: gate commands + contract auto checks").set_defaults(func=cmd_gate)
    p = sub.add_parser("decide", help="answer a decision the state table asked for")
    p.add_argument("choice", choices=(*sm.DECIDE_CHOICES, *sm.PLAUSIBLE_CHOICES))
    p.add_argument("--reason", required=True)
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
    except (DriverError, sm.StateError, ExecutorError, ContractError) as e:
        print(colored(f"Error: {e}", Colors.RED), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
