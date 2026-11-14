"""
``arbor.py sync``: one step of the task's event loop.

    plan     read nodes/*.md into task.json
    mail     print Orca's messages for the task's Run
    observe  ask Orca about every running node
    judge    a settled writer: commits, clean tree, paths, its checks
    merge    good writers --no-ff into their repo's integration branch
    start    every ready node, each in its own Orca worktree (writers)
    gate     each integration HEAD not gated yet, once nothing runs
    report   what happened and the one next step

The task lock is held only to read and write task.json and around a merge;
Orca calls, checks and gates run without it. A second ``sync`` of the same
task exits at once while one runs.
"""

from __future__ import annotations

import hashlib
import json
import threading
import time
from dataclasses import replace
from pathlib import Path

from ..contract import Contract, parse_contract, path_matches
from ..invariants import changed_files, snapshot_refs
from ..worktree import WorktreeError, add_worktree, is_ancestor, merge_no_ff, remove_worktree, run_setup
from . import orca, plan
from .executor import ExecutorError, parse_timeout, utc_now
from .gate import format_checks, run_check, run_gate
from .lock import LockTimeout, task_lock
from .prompt import worker_spec
from .repos import DriverError, Task, create_integration, git, head, repo_keys, settings

POLL_S = 10
REPORT_HEAD_LINES = 5
MAX_FAILED_STARTS = orca.MAX_FAILED_STARTS


def suffix(rec: dict) -> str:
    return "" if rec.get("attempt", 1) == 1 else f".r{rec['attempt']}"


def report_path(task: Task, nid: str, rec: dict) -> Path:
    return task.dir / "reports" / f"{nid}{suffix(rec)}.md"


def default_repo(task: Task) -> str:
    return task.data.get("default_repo") or "."


def map_rows(task: Task, contract: Contract, key: str) -> list:
    return [e for e in contract.verification_map if (e.repo or default_repo(task)) == key]


def node_checks(contract: Contract, rec: dict) -> list[tuple[str, str]]:
    rows = {e.id: e.check for e in contract.auto_checks()}
    return [(cid, rows[cid]) for cid in rec.get("checks") or [] if cid in rows]


def known(task: Task, contract: Contract) -> plan.Known:
    return plan.Known(set(repo_keys(task.config)), {"strong", *task.executor.tiers},
                      {e.id: (e.kind, e.repo or default_repo(task)) for e in contract.verification_map})


# --------------------------------------------------------------------------
# observe and judge


def _done_idle(rec: dict, record: dict) -> bool:
    """An idle worker whose work is evidently complete."""
    if not plan.is_writer(rec):
        return orca.has_reply(record)
    wt = Path(rec["worktree"])
    count = git(wt, "rev-list", "--count", f"{rec['base']}..HEAD")
    return count != "0" and snapshot_refs(wt).clean


def observe(task: Task, events: list[str]) -> list[tuple[str, str | None]]:
    """(node, Orca's failure reason) of every running node that settled."""
    executor = task.executor
    settled: list[tuple[str, str | None]] = []
    notes: dict[str, str | None] = {}
    for nid, rec in sorted(task.data["nodes"].items()):
        if rec["status"] != "running":
            continue
        try:
            _, record = orca.load(task.main, rec["request"])
            state, detail = orca.observe(executor, record)
        except (ExecutorError, OSError, ValueError) as e:
            notes[nid] = f"orca: {e}"
            continue
        notes[nid] = None
        if state == "waiting":
            notes[nid] = f"waiting for a person ({detail})"
        elif state == "unstopped":
            notes[nid] = str(detail)
        elif state == "idle":
            if not _done_idle(rec, record):
                commit = "" if not plan.is_writer(rec) else "Commit your work, "
                notes[nid] = (f"idle without worker_done: answer it if it asked something, else orca orchestration "
                              f"send --to dispatch:{orca.dispatch_id(record)} --subject finish --body "
                              f"\"{commit}write the report to {record['report_path']}, then send worker_done.\"")
            elif orca.stop(executor, record):
                settled.append((nid, None))
            else:
                notes[nid] = "idle with its work done, but Orca could not prove the worker stopped"
        elif state in ("done", "failed"):
            settled.append((nid, detail if state == "failed" else None))
    with task.edit() as d:
        for nid, note in notes.items():
            if d["nodes"].get(nid, {}).get("status") == "running":
                if note and note != d["nodes"][nid].get("attention"):
                    events.append(f"{nid}: {note}")
                d["nodes"][nid]["attention"] = note
    return settled


def judge(task: Task, contract: Contract, rec: dict, detail: str | None) -> str | None:
    """Why a settled node failed, or None."""
    wt = Path(rec["worktree"])
    why = f" ({detail})" if detail else ""
    if not plan.is_writer(rec):
        if not report_path(task, rec["id"], rec).read_text(encoding="utf-8", errors="replace").strip():
            return f"no report{why}"
        repo = task.data["repos"].get(rec["repo"])
        if repo and Path(repo["worktree"]) == wt and (
                git(wt, "status", "--porcelain") != rec.get("tree", "") or head(wt) != repo["head"]):
            return f"left changes in {wt}"
        return None
    if git(wt, "rev-list", "--count", f"{rec['base']}..HEAD") == "0":
        return f"no commits{why}"
    if not snapshot_refs(wt).clean:
        return "uncommitted changes"
    outside = [f for f in changed_files(wt, f"{rec['base']}..HEAD") if not path_matches(f, rec["paths"])]
    if outside:
        return f"outside its paths: {', '.join(outside)}"
    red = [cid for cid, command in node_checks(contract, rec) if not run_check(cid, command, wt).passed]
    return f"checks red: {', '.join(red)}" if red else None


def _fail(task: Task, nid: str, reason: str, events: list[str], status: str = "running") -> None:
    with task.edit() as d:
        rec = d["nodes"].get(nid)
        if not rec or rec["status"] != status:
            return
        rec.update(status="failed", reason=reason, ended=utc_now(), attention=None)
    events.append(f"{nid} failed: {reason}")
    report = report_path(task, nid, rec)
    lines = report.read_text(encoding="utf-8", errors="replace").strip().splitlines() if report.is_file() else []
    events += [f"  | {line}" for line in lines[:REPORT_HEAD_LINES]]


def settle(task: Task, contract: Contract, settled: list[tuple[str, str | None]], events: list[str]) -> None:
    good: list[str] = []
    for nid, detail in settled:
        rec = {**task.data["nodes"][nid], "id": nid}
        try:
            reason = judge(task, contract, rec, detail)
        except DriverError as e:
            reason = str(e)
        if reason:
            _fail(task, nid, reason, events)
        elif plan.is_writer(rec):
            good.append(nid)
        else:
            with task.edit() as d:
                if d["nodes"][nid]["status"] == "running":
                    d["nodes"][nid].update(status="done", ended=utc_now(), attention=None)
                    events.append(f"{nid} done (report {report_path(task, nid, rec)})")
    for nid in sorted(good, key=lambda n: task.data["nodes"][n]["seq"]):
        merge(task, nid, events)


def merge(task: Task, nid: str, events: list[str]) -> None:
    with task.edit() as d:
        rec = d["nodes"][nid]
        if rec["status"] != "running":
            return
        repo = d["repos"][rec["repo"]]
        wt = Path(repo["worktree"])
        tip = git(wt, "rev-parse", rec["branch"])
        if is_ancestor(wt, tip):
            sha = head(wt)  # merged by an earlier sync that stopped before it saved
        else:
            result = merge_no_ff(wt, rec["branch"], f"merge {task.name}/{nid}")
            if not result.ok or not result.sha:
                conflict = f"merge conflict: {', '.join(result.conflicts) or 'git merge failed'}"
                rec.update(status="failed", reason=conflict, ended=utc_now(), attention=None)
                events.append(f"{nid} failed: {conflict}")
                return
            sha = result.sha
        rec.update(status="merged", merged_sha=sha, ended=utc_now(), attention=None)
        repo["head"] = sha
    events.append(f"merged {nid} ({sha[:7]})")
    try:
        remove_worktree(task.config, Path(repo["root"]), Path(rec["worktree"]), delete_branch=True)
    except WorktreeError as e:
        events.append(f"note: {nid}: worktree kept: {e}")


# --------------------------------------------------------------------------
# start


def _failed_start(rec: dict, error: str) -> dict:
    count = (rec.get("failed_starts") or 0) + 1
    if count >= MAX_FAILED_STARTS:
        return {"status": "failed", "reason": f"start failed {count} times: {error}", "failed_starts": count,
                "start_error": None, "ended": utc_now()}
    return {"start_error": error, "failed_starts": count}


def start_one(task: Task, contract: Contract, nid: str, rec: dict, repo: dict | None) -> dict:
    """Start one node's worker; returns the changes to its record. No lock."""
    executor = task.executor
    attempt = rec.get("attempt", 1)
    changes: dict = {}
    if plan.is_writer(rec) and not rec.get("worktree"):
        assert repo is not None
        s = settings(task.main, task.config, rec["repo"])
        retry = "" if attempt == 1 else f"--r{attempt}"
        branch = f"{s.prefix}{task.name}--{nid}{retry}"
        base = head(Path(repo["worktree"]))
        try:
            path = add_worktree(task.config, s.root, f"{task.name}-{nid}{retry.replace('--', '-')}", branch, base,
                                Path(repo["worktree"]))
        except WorktreeError as e:
            return _failed_start(rec, str(e))
        if run_setup(path, s.setup) != 0:
            try:
                remove_worktree(task.config, s.root, path, delete_branch=True, force=True)
            except WorktreeError:
                pass
            return {"status": "failed", "reason": "worktree.setup failed", "ended": utc_now()}
        changes.update(worktree=str(path), branch=branch, base=base)
    elif not plan.is_writer(rec):
        workdir = Path(repo["worktree"]) if repo else settings(task.main, task.config, rec["repo"]).root
        changes.update(worktree=str(workdir), base=head(workdir), tree=git(workdir, "status", "--porcelain"))
    workdir = Path(changes.get("worktree") or rec["worktree"])
    name = f"{nid}{suffix(rec)}"
    report = report_path(task, nid, rec)
    report.parent.mkdir(parents=True, exist_ok=True)
    report.write_text("", encoding="utf-8")
    spec = task.runtime("specs", task.name) / f"{name}.md"
    if not spec.is_file():  # a start retried after a failure keeps the spec of its first try
        brief = plan.read(task.dir / "nodes" / f"{nid}.md", rec["repo"]).brief
        spec.write_text(worker_spec(task.name, nid, task.dir / "contract.md", rec.get("paths") or [],
                                    node_checks(contract, rec), report, brief, workdir), encoding="utf-8")
    path = orca.request_path(task.main, task.name, name)
    record = orca.load(task.main, str(path))[1] if path.is_file() else {
        "schema": 3, "main": str(task.main), "task": task.name, "node": nid, "attempt": attempt,
        "executor": executor.name, "spec_path": str(spec), "report_path": str(report),
        "request_id": orca.new_request_id(), "failed_starts": [], "orca": None}
    record.update(run=task.data["orca_run"], worktree=str(workdir), agent=executor.agent_for(rec.get("tier") or "strong"),
                  timeout_s=executor.timeout, started=utc_now())
    ids, error = orca.start(executor, record)
    changes["request"] = str(path)
    if error is None:
        record["orca"] = ids
        orca.store(path, record)
        return {**changes, "status": "running", "started": record["started"], "agent": record["agent"],
                "start_error": None, "attention": None}
    record["request_id"] = orca.new_request_id()  # Orca answered: the next start is a new request
    record["failed_starts"].append({**(ids or {}), "error": error})
    orca.store(path, record)
    return {**changes, **_failed_start(rec, error)}


def start(task: Task, contract: Contract, events: list[str]) -> int:
    """Start the ready nodes concurrently; returns how many were tried."""
    executor = task.executor
    with task.edit() as d:
        nodes = d["nodes"]
        chosen, blocked = plan.ready(nodes, executor.max_parallel, writers=d["status"] == "active")
        for nid, rec in nodes.items():
            if rec["status"] == "pending":
                rec["attention"] = f"blocked by {blocked[nid]}" if nid in blocked else None
        if chosen and not d.get("stopped"):
            allowance = d["allowance"]
            if len(nodes) > executor.max_nodes + 10 * allowance["nodes"]:
                d["stopped"] = "max_nodes"
            elif d["rounds"] > 3 + allowance["rounds"]:
                d["stopped"] = "rounds"
            if d.get("stopped"):
                events.append(f"stopped: budget {d['stopped']} reached")
        if d.get("stopped") or not chosen:
            return 0
        for nid in chosen:
            if not nodes[nid].get(plan.FROZEN):
                nodes[nid][plan.FROZEN] = hashlib.sha256((task.dir / "nodes" / f"{nid}.md").read_bytes()).hexdigest()
        missing = sorted({nodes[n]["repo"] for n in chosen if plan.is_writer(nodes[n])} - set(d["repos"]))
        snapshot = {nid: dict(nodes[nid]) for nid in chosen}
        run = d.get("orca_run")
    if not run:
        try:
            run = orca.create_run(executor, task.name)
        except ExecutorError as e:
            events.append(f"no node started: {e}")
            with task.edit() as d:  # shown as the next step until a start succeeds
                for nid in chosen:
                    d["nodes"][nid]["start_error"] = str(e)
            return 0
        with task.edit() as d:
            d["orca_run"] = run
    broken: dict[str, str] = {}
    for key in missing:
        try:
            made = create_integration(task, key)
        except DriverError as e:
            broken[key] = str(e)
            continue
        with task.edit() as d:
            d["repos"][key] = made
        events.append(f"integration branch {made['branch']} for {key} at {made['base'][:7]}")
    repos = task.data["repos"]
    results: dict[str, dict] = {}

    def run_one(nid: str) -> None:
        rec = snapshot[nid]
        try:
            results[nid] = start_one(task, contract, nid, rec, repos.get(rec["repo"]))
        except Exception as e:  # a thread must report, never die silently
            results[nid] = _failed_start(rec, f"{type(e).__name__}: {e}")

    threads = []
    for nid in chosen:
        rec = snapshot[nid]
        if plan.is_writer(rec) and rec["repo"] in broken:
            results[nid] = _failed_start(rec, broken[rec["repo"]])
            continue
        threads.append(threading.Thread(target=run_one, args=(nid,)))
        threads[-1].start()
    for thread in threads:
        thread.join()
    with task.edit() as d:
        for nid in chosen:
            rec = d["nodes"].get(nid)
            if not rec or rec["status"] != "pending":
                continue
            rec.update(results[nid])
            if rec["status"] == "running":
                events.append(f"started {nid} [{rec.get('tier') or 'strong'} {rec['agent']}]")
            elif rec["status"] == "failed":
                events.append(f"{nid} failed: {rec['reason']}")
            else:
                events.append(f"{nid} start failed ({rec['failed_starts']}/{MAX_FAILED_STARTS}): {rec['start_error']}")
    return len(chosen)


# --------------------------------------------------------------------------
# gate


def gate(task: Task, contract: Contract, events: list[str]) -> None:
    for key, repo in sorted(task.data["repos"].items()):
        wt = Path(repo["worktree"])
        sha = head(wt)
        if (repo.get("gate") or {}).get("sha") == sha:
            continue
        s = settings(task.main, task.config, key)
        result = run_gate(s.gate, replace(contract, verification_map=tuple(map_rows(task, contract, key))), wt)
        with task.edit() as d:
            d["repos"][key]["gate"] = {"sha": sha, "green": result.green, "failing": result.failing, "at": utc_now()}
        verdict = "green" if result.green else f"red on {', '.join(result.failing)}"
        events.append(f"gate {key} at {sha[:7]}: {verdict}")
        if result.checks:
            events.append(format_checks(result.checks))


def mail(task: Task, events: list[str]) -> None:
    run = task.data.get("orca_run")
    if not run:
        return
    try:
        result, _ = orca.call(task.executor, ["orchestration", "check", "--run", run])
    except ExecutorError:
        return
    messages = next((v for v in (result.get(k) for k in ("messages", "mail", "items")) if isinstance(v, list)), [])
    for m in messages:
        if isinstance(m, dict):
            sender = m.get("from") or m.get("sender") or m.get("fromHandle") or "?"
            events.append(f"orca mail: {m.get('type') or 'message'} from {sender}: {m.get('subject') or ''}"
                          f"{': ' + str(m['body']) if m.get('body') else ''}")


# --------------------------------------------------------------------------
# the next step


def _heads(task: Task) -> dict[str, str]:
    return {key: head(Path(repo["worktree"])) for key, repo in sorted(task.data["repos"].items())}


def attention(task: Task) -> list[tuple[str, str]]:
    items = []
    for nid, rec in sorted(task.data["nodes"].items(), key=lambda kv: kv[1]["seq"]):
        status = rec["status"]
        if status in ("failed", "invalid"):
            items.append((nid, str(rec.get("reason"))))
        elif status in ("running", "pending") and rec.get("attention"):
            items.append((nid, rec["attention"]))
        elif status == "pending" and rec.get("start_error"):
            items.append((nid, f"start failed: {rec['start_error']}; the next sync tries again"))
    return items


def next_step(task: Task) -> tuple[str, str]:
    d = task.data
    nodes = d["nodes"].values()
    if d["status"] in ("done", "abandoned"):
        return d["status"], f"the task is {d['status']}"
    if d.get("stopped"):
        return "stopped", f"ask the user: the {d['stopped']} budget is used up; arbor.py resume grants more"
    items = attention(task)
    if items:
        listed = "; ".join(f"{nid}: {why} (retry {nid} | cancel {nid} | edit or add nodes)" for nid, why in items)
        return "decide", f"decide: {listed}"
    if any(r["status"] == "running" for r in nodes):
        return "wait", 'wait: run "arbor.py sync --wait" in the background and end your turn'
    contract = task.dir / "contract.md"
    if d["status"] == "planning":
        return "contract", f"contract: fill {contract}, get the user's approval, then arbor.py start"
    if not any(r["status"] in ("pending", "running", "merged", "done") for r in nodes):
        return "plan", f"plan: write node files under {task.dir / 'nodes'}, then arbor.py sync"
    if any(r["status"] == "pending" for r in nodes):
        return "sync", "sync: arbor.py sync starts the pending nodes"
    heads = _heads(task)
    gates = {key: repo.get("gate") or {} for key, repo in d["repos"].items()}
    red = [(k, g) for k, g in sorted(gates.items()) if g.get("sha") == heads[k] and not g.get("green")]
    if red:
        listed = "; ".join(f"{k} red on {', '.join(g.get('failing') or [])}" for k, g in red)
        return "fix", f"fix: {listed}; add fix nodes (their brief names the failing check)"
    if any(g.get("sha") != heads[k] for k, g in gates.items()):
        return "sync", "sync: arbor.py sync gates the integration branches"
    if (d.get("review") or {}).get("heads") == heads:
        return "finish", "finish: arbor.py finish"
    reviewers = {k: [n for n, r in (d.get("reviewers") or {}).items()
                     if r["repo"] == k and r["head"] == h and d["nodes"].get(n, {}).get("status") == "done"]
                 for k, h in heads.items()}
    if heads and all(reviewers.values()):
        reports = ", ".join(str(report_path(task, n, d["nodes"][n])) for ns in reviewers.values() for n in ns)
        return "review", f"review: read {reports}; real findings become fix nodes, otherwise arbor.py review --pass"
    ranges = "; ".join(f"git -C {d['repos'][k]['worktree']} diff {d['repos'][k]['base'][:7]}..{h[:7]}"
                       for k, h in heads.items())
    return "review", ("review: arbor.py review starts one reviewer per repo (or review " + (ranges or "the diff")
                      + " yourself when the diff is small); findings become fix nodes; then arbor.py review --pass")


def output(task: Task, events: list[str], as_json: bool) -> None:
    kind, text = next_step(task)
    if as_json:
        print(json.dumps({"task": task.name, "status": task.data["status"], "events": events,
                          "nodes": task.data["nodes"], "repos": task.data["repos"],
                          "contract_changed": task.contract_changed(), "next": {"kind": kind, "text": text}}, ensure_ascii=False, indent=2))
        return
    for line in events:
        print(line)
    if task.contract_changed():
        print("contract.md changed since it was approved: get it re-approved, then arbor.py start --reapprove")
    print(f"next: {text}")


# --------------------------------------------------------------------------
# the pass


def wait(task: Task, duration: str | None) -> None:
    """Poll the running nodes until one is no longer running, or the deadline."""
    seconds = parse_timeout(duration) if duration else (task.executor.timeout or 3600)
    deadline = time.monotonic() + (seconds or 0)
    executor = task.executor
    while time.monotonic() < deadline:
        task.reload()
        running = [r for r in task.data["nodes"].values() if r["status"] == "running"]
        if not running:
            return
        for rec in running:
            try:
                state, _ = orca.observe(executor, orca.load(task.main, rec["request"])[1])
            except (ExecutorError, OSError, ValueError):
                return
            if state != "running":
                return
        time.sleep(max(0.0, min(POLL_S, deadline - time.monotonic())))


def sync_pass(task: Task) -> list[str]:
    events: list[str] = []
    try:
        contract = task.contract()
    except DriverError as e:
        if task.data["status"] != "planning":
            raise
        # While the contract is drafted, read-only nodes still run.
        contract = parse_contract("", task.dir / "contract.md")
        events.append(f"{e} (read-only nodes run anyway)")
    with task.edit() as d:
        if d["status"] not in ("planning", "active"):
            raise DriverError(f"{task.name} is {d['status']}")
        found, writers = plan.update(d["nodes"], task.dir / "nodes", default_repo(task), known(task, contract))
        events += found
        if writers and any((r.get("gate") or {}).get("sha") for r in d["repos"].values()):
            d["rounds"] += 1
    mail(task, events)
    settle(task, contract, observe(task, events), events)
    started = start(task, contract, events)
    task.reload()
    nodes = task.data["nodes"].values()
    if (not started and not any(r["status"] == "running" for r in nodes)
            and any(r["status"] in ("merged", "done") for r in nodes)):
        gate(task, contract, events)
        task.reload()
    return events


def run(task: Task, wait_for: str | None, waiting: bool, as_json: bool) -> int:
    guard = task.runtime("sync", task.name)
    try:
        with task_lock(guard, timeout=0):
            if waiting:
                wait(task, wait_for)
            events = sync_pass(task)
    except LockTimeout:
        print("another sync is running")
        return 0
    output(task, events, as_json)
    return 0
