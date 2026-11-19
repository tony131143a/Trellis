#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
arbor: the task driver. A task is a contract the user approves plus a plan
that is a directory of node files; every node runs as one Orca worker.

    python3 .arbor/scripts/arbor.py [--task <name>] <command>

    new "<title>" [--slug s] [--repo key]   create .arbor/tasks/<MM-DD-slug>/
    start [--reapprove]                     the user approved contract.md
    sync [--wait [duration]] [--json]       one step: observe, judge, merge, start, gate, next
    review [--pass]                         write reviewer nodes / record the review of the HEADs
    finish                                  merge commands, then cleanup, archive, journal
    status [--json] [--all]                 no side effects
    cancel <id> | retry <id> [--force] | rejudge <id> | accept <id> | resume | abandon [--reason "…"]

The default task is the only one in planning or active state.
Run from a linked worktree of the control repository, this script hands over
to the main checkout's copy, so an older copy in a worktree never drives.
Exit codes: 0 ok, 1 refused or failed, 2 usage error.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path


def hand_over() -> None:
    """Run the main checkout's driver instead of this copy when this copy is
    another checkout's: a linked worktree of the control repository carries
    the scripts of the commit it was cut from, which may be older. Runs before
    the ``common`` imports, so an old copy's modules are never loaded."""
    if os.environ.get("ARBOR_OWN_SCRIPTS"):
        return
    here = Path(__file__).absolute().parent  # .arbor may be a symlink: find the repo by the path as called
    try:
        common = subprocess.run(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], cwd=here,
                                capture_output=True, text=True, timeout=30).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return
    own = Path(common).parent / ".arbor" / "scripts" / "arbor.py"
    if common and own.is_file() and own.resolve().parent != here.resolve():
        print(f"note: running the main checkout's driver {own}", file=sys.stderr)
        os.environ["ARBOR_OWN_SCRIPTS"] = "1"
        os.execv(sys.executable, [sys.executable, str(own), *sys.argv[1:]])


if __name__ == "__main__":
    hand_over()

from common.contract import contract_hash, default_contract_content, find_contract, validate_contract
from common.driver import finish as fin
from common.driver import orca, plan
from common.driver import sync as sy
from common.driver.executor import ExecutorError, utc_now
from common.driver.repos import SCHEMA, DriverError, Task, load_data, repo_keys, settings, tasks_dir
from common.arbor_config import read_arbor_config
from common.io import read_json, write_json
from common.paths import DIR_ARCHIVE, DIR_WORKFLOW, FILE_TASK_JSON
from common.git import run_git
from common.worktree import WorktreeError, is_ancestor, main_checkout, remove_worktree

SLUG_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,59}")


def find_main() -> Path:
    cwd = Path.cwd().resolve()
    for candidate in (cwd, *cwd.parents):
        if (candidate / DIR_WORKFLOW).is_dir():
            return main_checkout(candidate)
    raise DriverError(f"no {DIR_WORKFLOW}/ directory above {cwd}")


def find_task(main: Path, name: str | None) -> Path:
    root = tasks_dir(main)
    if name:
        if not re.fullmatch(r"[\w.-]+", name) or name in (".", ".."):
            raise DriverError(f"--task takes a task directory name, not {name!r}")
        candidates = [root / name, *sorted(root.glob(f"{DIR_ARCHIVE}/*/{name}"))]
        found = next((c for c in candidates if (c / FILE_TASK_JSON).is_file()), None)
        if found is None:
            raise DriverError(f"no task {name} under {root}")
        return found
    live = []
    for path in sorted(root.glob(f"*/{FILE_TASK_JSON}")):
        data = read_json(path) or {}
        if path.parent.name != DIR_ARCHIVE and data.get("schema") == SCHEMA and data.get("status") in ("planning", "active"):
            live.append(path.parent)
    if len(live) != 1:
        names = ", ".join(p.name for p in live)
        raise DriverError(f"several tasks are open ({names}): pass --task <name>" if live else
                          "no task in planning or active state: arbor.py new \"<title>\", or pass --task <name>")
    return live[0]


def load_task(name: str | None) -> Task:
    main = find_main()
    task_dir = find_task(main, name)
    return Task(main, read_arbor_config(main), task_dir, load_data(task_dir))


def refuse(message: str) -> int:
    print(f"refused: {message}", file=sys.stderr)
    return 1


def cmd_new(args: argparse.Namespace) -> int:
    main = find_main()
    config = read_arbor_config(main)
    slug = args.slug or re.sub(r"[^a-z0-9]+", "-", args.title.lower()).strip("-")[:40].strip("-")
    if not SLUG_RE.fullmatch(slug):
        return refuse(f"cannot make a slug of {args.title!r}: pass --slug <a-z0-9->")
    keys = repo_keys(config)
    repo = args.repo or (config.get("default_package") if config.get("default_package") in keys else ".")
    if repo not in keys:
        return refuse(f"unknown repo {repo!r} (known: {', '.join(keys)})")
    task_dir = tasks_dir(main) / f"{datetime.now().strftime('%m-%d')}-{slug}"
    if task_dir.exists():
        return refuse(f"{task_dir} exists")
    (task_dir / "nodes").mkdir(parents=True)
    (task_dir / "reports").mkdir()
    (task_dir / "contract.md").write_text(default_contract_content(args.title), encoding="utf-8")
    written = write_json(task_dir / FILE_TASK_JSON, {
        "schema": SCHEMA, "name": task_dir.name, "title": args.title, "created": utc_now(), "status": "planning",
        "default_repo": repo, "contract_hash": None, "orca_run": None, "repos": {}, "nodes": {},
        "review": None, "reviewers": {}, "rounds": 0, "allowance": {"rounds": 0, "nodes": 0}, "stopped": None,
        "cleanup": {"done": []}})
    if not written:
        shutil.rmtree(task_dir, ignore_errors=True)
        return refuse(f"cannot write {task_dir / FILE_TASK_JSON}")
    print(f"created {task_dir}")
    print(f"default repo: {repo}")
    print(f"next: fill {task_dir / 'contract.md'} with the user (read-only nodes can explore meanwhile: "
          "write them under nodes/, then arbor.py sync); after approval, arbor.py start")
    return 0


def cmd_start(args: argparse.Namespace) -> int:
    task = load_task(args.task)
    d = task.data
    path = find_contract(task.dir)
    if args.reapprove:
        if d["status"] != "active" or path is None:
            return refuse("--reapprove is for an active task with a contract.md")
        errors = validate_contract(task.contract())
        if errors:
            for e in errors:
                print(f"  {e}", file=sys.stderr)
            return refuse("contract.md is not ready")
        with task.edit() as d:
            d["contract_hash"] = contract_hash(path)
        for note in sy.restated_gates(task, task.contract()):
            print(f"note: {note}")
        print("contract re-approved")
        return 0
    if d["status"] != "planning":
        return refuse(f"{task.name} is {d['status']} (a changed contract: arbor.py start --reapprove)")
    contract = task.contract()
    keys = repo_keys(task.config)
    errors = validate_contract(contract)
    errors += [f"Verification map: {e.id} names unknown repo {e.repo!r}" for e in contract.verification_map
               if e.repo and e.repo not in keys]
    if errors:
        for e in errors:
            print(f"  {e}", file=sys.stderr)
        return refuse("contract.md is not ready")
    named = sorted({".", d["default_repo"], *(e.repo for e in contract.verification_map if e.repo)})
    try:
        added = orca.ensure_projects(task.executor, [settings(task.main, task.config, k).root for k in named])
    except ExecutorError as e:
        return refuse(str(e))
    for root in added:
        print(f"added {root} to Orca")
    with task.edit() as d:
        d.update(status="active", contract_hash=contract_hash(path) if path else None, approved=utc_now())
    for note in sy.restated_gates(task, contract):
        print(f"note: {note}")
    print(f"{task.name} is active")
    print(f"next: plan: write node files under {task.dir / 'nodes'}, then arbor.py sync")
    return 0


def cmd_sync(args: argparse.Namespace) -> int:
    return sy.run(load_task(args.task), args.wait or None, args.wait is not None, args.json)


def cmd_review(args: argparse.Namespace) -> int:
    task = load_task(args.task)
    return fin.review_pass(task) if args.passed else fin.review_write(task)


def cmd_finish(args: argparse.Namespace) -> int:
    return fin.finish(load_task(args.task))


def _counts(nodes: dict) -> str:
    counts: dict[str, int] = {}
    for rec in nodes.values():
        counts[rec["status"]] = counts.get(rec["status"], 0) + 1
    return ", ".join(f"{n} {s}" for s, n in sorted(counts.items())) or "no nodes"


def cmd_status(args: argparse.Namespace) -> int:
    if args.all:
        for path in sorted(tasks_dir(find_main()).glob(f"*/{FILE_TASK_JSON}")):
            data = read_json(path) or {}
            if data.get("schema") != SCHEMA:
                print(f"{path.parent.name}  (arbor < 1.0)")
            else:
                print(f"{path.parent.name}  {data.get('status')}  {_counts(data.get('nodes') or {})}")
        return 0
    task = load_task(args.task)
    if args.json:
        sy.output(task, [], True)
        return 0
    d = task.data
    print(f"{task.name}: {d['status']} ({d.get('title')})")
    for nid, rec in sorted(d["nodes"].items(), key=lambda kv: kv[1]["seq"]):
        note = rec.get("reason") or rec.get("attention") or rec.get("start_error") or ""
        print(f"  {nid:<14} {rec['status']:<9} {rec['repo']:<10} {rec.get('tier') or 'write':<7} "
              f"#{rec.get('attempt', 1)}  {note}".rstrip())
    for key, repo in sorted(d["repos"].items()):
        g = repo.get("gate") or {}
        verdict = "none" if not g else f"{'green' if g.get('green') else 'red'} at {g['sha'][:7]}"
        print(f"  repo {key}: {repo['branch']} HEAD {sy.head(Path(repo['worktree']))[:7] if Path(repo['worktree']).exists() else '-'}"
              f" gate {verdict}{' merged' if repo.get('merged') else ''}")
    review = d.get("review") or {}
    print("  review: " + (", ".join(f"{k} {h[:7]}" for k, h in review["heads"].items()) if review else "none"))
    sy.output(task, [], False)
    return 0


def cmd_cancel(args: argparse.Namespace) -> int:
    task = load_task(args.task)
    rec = task.data["nodes"].get(args.node)
    if rec is None:
        return refuse(f"no node {args.node}")
    if rec["status"] == "running":
        _, record = orca.load(task.main, rec["request"])
        if not orca.stop(task.executor, record):
            return refuse(f"Orca could not prove that {args.node}'s worker stopped; try again or stop it in Orca")
    elif rec["status"] not in ("pending", "invalid", "failed"):
        return refuse(f"{args.node} is {rec['status']}")
    with task.edit() as d:
        d["nodes"][args.node].update(status="cancelled", ended=utc_now(), attention=None)
    print(f"{args.node} cancelled" + (f"; its worktree stays: {rec['worktree']}"
                                      if plan.is_writer(rec) and rec.get("worktree") else ""))
    return 0


def cmd_retry(args: argparse.Namespace) -> int:
    task = load_task(args.task)
    rec = task.data["nodes"].get(args.node)
    if rec is None or rec["status"] not in ("failed", "cancelled"):
        return refuse(f"{args.node} is not a failed or cancelled node")
    if rec.get("attempt", 1) >= 2 and not args.force:
        return refuse(f"{args.node} already ran {rec['attempt']} times; finish it yourself in the integration "
                      f"worktree and arbor.py accept {args.node}, arbor.py retry {args.node} --force, or change the plan")
    if plan.is_writer(rec) and rec.get("worktree") and Path(rec["worktree"]).exists():
        try:
            remove_worktree(task.config, settings(task.main, task.config, rec["repo"]).root, Path(rec["worktree"]),
                            delete_branch=True)
        except WorktreeError as e:
            print(f"note: the old worktree stays: {e}")
    with task.edit() as d:
        node = d["nodes"][args.node]
        for key in (plan.FROZEN, "changed_noted"):
            node.pop(key, None)
        node.update(status="pending", attempt=node.get("attempt", 1) + 1, worktree=None, branch=None, base=None,
                    request=None, started=None, ended=None, reason=None, attention=None, start_error=None,
                    failed_starts=0)
    print(f"{args.node} is pending again (attempt {rec.get('attempt', 1) + 1}); its file is read again")
    print("next: arbor.py sync")
    return 0


def cmd_rejudge(args: argparse.Namespace) -> int:
    """Judge a failed writer again on the worktree it left (after the plan or
    the contract changed, or the commits were fixed by hand); merge it when good.
    Its paths and checks are read again from its node file."""
    task = load_task(args.task)
    rec = task.data["nodes"].get(args.node)
    if rec is None or rec["status"] != "failed" or not plan.is_writer(rec):
        return refuse(f"{args.node} is not a failed writer node")
    if not rec.get("worktree") or not Path(rec["worktree"]).is_dir() or not rec.get("base"):
        return refuse(f"{args.node} has no worktree to judge (arbor.py retry {args.node})")
    path = task.dir / "nodes" / f"{args.node}.md"
    if not path.is_file():
        return refuse(f"{path} is gone")
    f = plan.read(path, sy.default_repo(task))
    error = f.error or plan.check(f, sy.known(task, task.contract()))
    if error or not f.paths or f.repo != rec["repo"]:
        return refuse(f"{path}: " + (error or ("no paths" if not f.paths else f"repo is not {rec['repo']}")))
    events: list[str] = []
    with task.edit() as d:
        node = d["nodes"][args.node]
        node.pop("changed_noted", None)
        node.update(status="running", reason=None, ended=None, attention=None, paths=f.paths, checks=f.checks,
                    **{plan.FROZEN: f.hash})
    sy.settle(task, task.contract(), [(args.node, None)], events)
    task.reload()
    for line in events:
        print(line)
    print(f"next: {sy.next_step(task)[1]}")
    return 0


def cmd_accept(args: argparse.Namespace) -> int:
    """A failed writer the main agent finished with its own commits on the
    integration branch: merged, judged with the rest by the gate and the review."""
    task = load_task(args.task)
    rec = task.data["nodes"].get(args.node)
    if rec is None or rec["status"] != "failed" or not plan.is_writer(rec):
        return refuse(f"{args.node} is not a failed writer node")
    repo = task.data["repos"].get(rec["repo"])
    if not repo:
        return refuse(f"repo {rec['repo']} has no integration branch yet")
    wt = Path(repo["worktree"])
    if sy.git(wt, "status", "--porcelain"):
        return refuse(f"{wt} has uncommitted or untracked files: commit the work first")
    branch = rec.get("branch")
    rc, tip, _ = run_git(["rev-parse", "--verify", "--quiet", f"refs/heads/{branch}"], cwd=wt) if branch else (1, "", "")
    if rc == 0 and tip.strip() != rec.get("base") and not is_ancestor(wt, tip.strip()):
        return refuse(f"{branch} has commits the integration branch lacks: git -C {wt} merge --no-ff {branch} "
                      f"and arbor.py rejudge {args.node}, or arbor.py cancel {args.node}")
    sha = sy.head(wt)
    with task.edit() as d:
        d["nodes"][args.node].update(status="merged", merged_sha=sha, accepted=True, reason=None, ended=utc_now(),
                                     attention=None)
        d["repos"][rec["repo"]]["head"] = sha
    if rec.get("worktree") and Path(rec["worktree"]).exists():
        try:
            remove_worktree(task.config, settings(task.main, task.config, rec["repo"]).root, Path(rec["worktree"]),
                            delete_branch=True)
        except WorktreeError as e:
            print(f"note: its worktree stays: {e}")
    print(f"{args.node} accepted at {sha[:7]}: the gate and the review judge it on the integration branch")
    print("next: arbor.py sync")
    return 0


def cmd_resume(args: argparse.Namespace) -> int:
    task = load_task(args.task)
    with task.edit() as d:
        stopped = d.get("stopped")
        if stopped:
            d["allowance"]["nodes" if stopped == "max_nodes" else "rounds"] += 1
            d["stopped"] = None
    print(f"resumed ({stopped}: more granted)" if stopped else "not stopped")
    return 0


def cmd_abandon(args: argparse.Namespace) -> int:
    task = load_task(args.task)
    for nid, rec in sorted(task.data["nodes"].items()):
        if rec["status"] == "running" and not orca.stop(task.executor, orca.load(task.main, rec["request"])[1]):
            print(f"note: Orca could not prove that {nid}'s worker stopped")
    with task.edit() as d:
        d.update(status="abandoned", ended=utc_now(), abandon_reason=args.reason)
    print(f"{task.name} abandoned; nothing was removed:")
    for key, repo in sorted(task.data["repos"].items()):
        print(f"  {key}: integration worktree {repo['worktree']} (branch {repo['branch']})")
    for nid, rec in sorted(task.data["nodes"].items()):
        if plan.is_writer(rec) and rec.get("worktree"):
            print(f"  {nid}: worktree {rec['worktree']} (branch {rec.get('branch')})")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="arbor.py", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--task", help="task directory name (default: the only open task)")
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("new")
    p.add_argument("title")
    p.add_argument("--slug")
    p.add_argument("--repo", help="where checks and nodes go by default (default: default_package, else .)")
    p.set_defaults(func=cmd_new)
    p = sub.add_parser("start")
    p.add_argument("--reapprove", action="store_true")
    p.set_defaults(func=cmd_start)
    p = sub.add_parser("sync")
    p.add_argument("--wait", nargs="?", const="", default=None, metavar="DURATION")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_sync)
    p = sub.add_parser("review")
    p.add_argument("--pass", dest="passed", action="store_true")
    p.set_defaults(func=cmd_review)
    sub.add_parser("finish").set_defaults(func=cmd_finish)
    p = sub.add_parser("status")
    p.add_argument("--json", action="store_true")
    p.add_argument("--all", action="store_true")
    p.set_defaults(func=cmd_status)
    for name, func in (("cancel", cmd_cancel), ("retry", cmd_retry), ("rejudge", cmd_rejudge), ("accept", cmd_accept)):
        p = sub.add_parser(name)
        p.add_argument("node")
        if name == "retry":
            p.add_argument("--force", action="store_true")
        p.set_defaults(func=func)
    sub.add_parser("resume").set_defaults(func=cmd_resume)
    p = sub.add_parser("abandon")
    p.add_argument("--reason")
    p.set_defaults(func=cmd_abandon)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except (DriverError, ExecutorError, WorktreeError, json.JSONDecodeError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
