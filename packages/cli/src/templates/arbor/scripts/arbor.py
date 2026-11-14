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
    cancel <id> | retry <id> [--force] | resume | abandon [--reason "…"]

The default task is the only one in planning or active state.
Exit codes: 0 ok, 1 refused or failed, 2 usage error.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime
from pathlib import Path

from common.contract import contract_hash, default_contract_content, find_contract, validate_contract
from common.driver import finish as fin
from common.driver import orca, plan
from common.driver import sync as sy
from common.driver.executor import ExecutorError, utc_now
from common.driver.repos import SCHEMA, DriverError, Task, load_data, repo_keys, settings, tasks_dir
from common.arbor_config import read_arbor_config
from common.io import read_json, write_json
from common.paths import DIR_ARCHIVE, DIR_WORKFLOW, FILE_TASK_JSON
from common.worktree import WorktreeError, main_checkout, remove_worktree

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
    if args.repo not in repo_keys(config):
        return refuse(f"unknown repo {args.repo!r} (known: {', '.join(repo_keys(config))})")
    task_dir = tasks_dir(main) / f"{datetime.now().strftime('%m-%d')}-{slug}"
    if task_dir.exists():
        return refuse(f"{task_dir} exists")
    (task_dir / "nodes").mkdir(parents=True)
    (task_dir / "reports").mkdir()
    (task_dir / "contract.md").write_text(default_contract_content(args.title), encoding="utf-8")
    write_json(task_dir / FILE_TASK_JSON, {
        "schema": SCHEMA, "name": task_dir.name, "title": args.title, "created": utc_now(), "status": "planning",
        "default_repo": args.repo, "contract_hash": None, "orca_run": None, "repos": {}, "nodes": {},
        "review": None, "reviewers": {}, "rounds": 0, "allowance": {"rounds": 0, "nodes": 0}, "stopped": None,
        "cleanup": {"done": []}})
    print(f"created {task_dir}")
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
        with task.edit() as d:
            d["contract_hash"] = contract_hash(path)
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
    try:
        result, error = orca.call(task.executor, ["repo", "list"])
    except ExecutorError as e:
        return refuse(str(e))
    if error:
        return refuse(f"the Orca CLI does not answer: {error}")
    projects = {Path(r["path"]).resolve() for r in result.get("repos") or [] if isinstance(r, dict) and r.get("path")}
    named = sorted({".", d["default_repo"], *(e.repo for e in contract.verification_map if e.repo)})
    missing = [settings(task.main, task.config, k).root for k in named]
    missing = [root for root in missing if root.resolve() not in projects]
    if missing:
        for root in missing:
            print(f"  orca repo add --path {root}", file=sys.stderr)
        return refuse("these repositories are not Orca projects yet")
    with task.edit() as d:
        d.update(status="active", contract_hash=contract_hash(path) if path else None, approved=utc_now())
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
        print(f"  {nid:<14} {rec['status']:<9} {rec['repo']:<10} {rec.get('tier') or 'strong':<7} "
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
    if rec is None or rec["status"] != "failed":
        return refuse(f"{args.node} is not a failed node")
    if rec.get("attempt", 1) >= 2 and not args.force:
        return refuse(f"{args.node} already ran {rec['attempt']} times; arbor.py retry {args.node} --force, "
                      "or change the plan")
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
    p.add_argument("--repo", default=".")
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
    for name, func in (("cancel", cmd_cancel), ("retry", cmd_retry)):
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
