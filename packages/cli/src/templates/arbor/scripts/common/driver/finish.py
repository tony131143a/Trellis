"""
``arbor.py review`` / ``review --pass`` / ``finish``.

A review record names the integration HEAD of every repo; any later merge
makes it stale. ``finish`` prints one ``merge --no-ff`` per repo for the
human, and once every integration branch is in its target it removes the
worktrees and branches, archives the task directory (one commit of that move
in the control repository) and writes the journal entry. Each cleanup step is
recorded in ``cleanup.done`` before the next, so a rerun continues.
"""

from __future__ import annotations

import re
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

from ..arbor_config import get_executors_config
from ..git import run_git
from ..paths import DIR_ARCHIVE, DIR_WORKFLOW
from ..worktree import WorktreeError, is_ancestor, remove_worktree
from . import plan
from .executor import utc_now
from .prompt import review_brief
from .repos import DriverError, Task, git, settings, tasks_dir
from .sync import _heads, map_rows


def gate_problems(task: Task) -> list[str]:
    problems = []
    heads = _heads(task)
    for key, repo in sorted(task.data["repos"].items()):
        g = repo.get("gate") or {}
        if g.get("sha") != heads[key]:
            problems.append(f"{key}: no gate result at HEAD {heads[key][:7]} (arbor.py sync runs it)")
        elif not g.get("green"):
            problems.append(f"{key}: gate red on {', '.join(g.get('failing') or [])}")
    contract = task.contract()
    for key in sorted({(e.repo or task.data["default_repo"]) for e in contract.auto_checks()} - set(heads)):
        if task.data["repos"]:
            ids = ", ".join(e.id for e in map_rows(task, contract, key) if e.kind == "auto")
            problems.append(f"{ids} run in repo {key}, where no writer node ran: they were never checked")
    return problems


def open_nodes(task: Task, statuses: tuple[str, ...]) -> list[str]:
    return [f"{n} ({r['status']})" for n, r in sorted(task.data["nodes"].items()) if r["status"] in statuses]


def _refuse(problems: list[str]) -> int:
    for p in problems:
        print(f"refused: {p}", file=sys.stderr)
    return 1


def review_write(task: Task) -> int:
    """One read-only reviewer node per repo whose gated HEAD has no review."""
    d = task.data
    problems = [] if d["status"] == "active" else [f"the task is {d['status']}"]
    busy = open_nodes(task, ("pending", "running"))
    problems += [f"nodes still open: {', '.join(busy)}"] if busy else []
    problems += gate_problems(task) if not problems else []
    if problems:
        return _refuse(problems)
    heads, reviewed = _heads(task), (d.get("review") or {}).get("heads") or {}
    reviewers = d.get("reviewers") or {}
    todo = [k for k, h in heads.items() if reviewed.get(k) != h and not any(
        r["repo"] == k and r["head"] == h and d["nodes"].get(n, {}).get("status") not in ("failed", "cancelled")
        for n, r in reviewers.items())]
    if not todo:
        print("nothing to review: every integration HEAD is reviewed or has a reviewer node")
        return 0
    nodes_dir = task.dir / "nodes"
    taken = [int(m.group(1)) for p in nodes_dir.glob("review-*.md") if (m := re.fullmatch(r"review-(\d+)(?:-\d+)?", p.stem))]
    number = max(taken, default=0) + 1
    tiers = (get_executors_config(task.config).get(task.executor.name) or {}).get("tiers") or {}
    contract = task.contract()
    written: dict[str, dict] = {}
    for k, key in enumerate(todo, start=1):
        repo, sha = d["repos"][key], heads[key]
        nid = f"review-{number}" + (f"-{k}" if len(todo) > 1 else "")
        gate_cmds = settings(task.main, task.config, key).gate
        checks = [(f"GATE-{i}", c) for i, c in enumerate(gate_cmds, start=1)]
        checks += [(e.id, e.check) for e in map_rows(task, contract, key) if e.kind == "auto" and e.check]
        brief = review_brief(task.dir / "contract.md", Path(repo["worktree"]), repo["base"], sha, checks)
        front = [f"title: Review {key} {repo['base'][:7]}..{sha[:7]}", f"repo: {key}"]
        front += ["tier: review"] if isinstance(tiers, dict) and "review" in tiers else []
        path = nodes_dir / f"{nid}.md"
        path.write_text("---\n" + "\n".join(front) + "\n---\n" + brief + "\n", encoding="utf-8")
        written[nid] = {"repo": key, "head": sha}
        print(f"wrote {path}")
    with task.edit() as d:
        d.setdefault("reviewers", {}).update(written)
    print("next: arbor.py sync")
    return 0


def review_pass(task: Task) -> int:
    d = task.data
    problems = [] if d["status"] == "active" else [f"the task is {d['status']}"]
    busy = open_nodes(task, ("pending", "running", "failed", "invalid"))
    problems += [f"nodes not settled: {', '.join(busy)} (retry or cancel failed ones)"] if busy else []
    problems += ["contract.md changed since it was approved (arbor.py start --reapprove)"] if task.contract_changed() else []
    problems += gate_problems(task) if not problems else []
    if problems:
        return _refuse(problems)
    heads = _heads(task)
    with task.edit() as d:
        d["review"] = {"heads": heads, "at": utc_now()}
    print("review recorded for " + ", ".join(f"{k} {h[:7]}" for k, h in heads.items()))
    print("next: arbor.py finish")
    return 0


def _merge_commit(root: Path, tip: str, target: str) -> str:
    """The commit on ``target`` that brought ``tip`` in (``tip`` itself after a fast-forward)."""
    rc, out, _ = run_git(["rev-list", "--first-parent", "--merges", "--ancestry-path", f"{tip}..{target}"], cwd=root)
    merges = out.split() if rc == 0 else []
    return merges[-1] if merges else tip


def finish(task: Task) -> int:
    d = task.data
    if d["status"] == "done":
        return tail(task)
    if not d["cleanup"]["done"]:
        problems = [] if d["status"] == "active" else [f"the task is {d['status']}"]
        busy = open_nodes(task, ("pending", "running", "invalid", "failed"))
        problems += [f"nodes not settled: {', '.join(busy)} (retry or cancel failed ones)"] if busy else []
        problems += ["contract.md changed since it was approved"] if task.contract_changed() else []
        if not problems:
            problems += gate_problems(task)
            if (d.get("review") or {}).get("heads") != _heads(task):
                problems.append("no review of the current integration HEADs (arbor.py review --pass)")
        if problems:
            return _refuse(problems)
        unmerged = []
        with task.edit() as d:
            for key, repo in sorted(d["repos"].items()):
                tip = git(Path(repo["worktree"]), "rev-parse", "HEAD")
                repo["merged"] = tip == repo["base"] or is_ancestor(Path(repo["root"]), tip, repo["merge_target"])
                if repo["merged"] and tip != repo["base"]:
                    repo["merge_commit"] = _merge_commit(Path(repo["root"]), tip, repo["merge_target"])
                if not repo["merged"]:
                    unmerged.append((key, repo))
        if unmerged:
            manual = [e for e in task.contract().verification_map if e.kind == "manual"]
            if manual:
                print("Manual acceptance checks (confirm them with the user before merging):")
                for e in manual:
                    print(f"  {e.id}: {e.check}")
            print("Merge each integration branch (the user does this):")
            for key, repo in unmerged:
                print(f"  {key}: git -C {repo['root']} merge --no-ff {repo['branch']}"
                      f"   (with {repo['merge_target']} checked out in {repo['root']})")
            print("next: after the merges, arbor.py finish again")
            return 0
    return cleanup(task)


def cleanup(task: Task) -> int:
    d = task.data
    done: list[str] = d["cleanup"]["done"]

    def mark(step: str) -> None:
        done.append(step)
        task.save()

    if "leftovers" not in done:
        # Node workspaces are Orca children of the integration workspace: they go first.
        for nid, rec in sorted(d["nodes"].items()):
            wt = Path(rec.get("worktree") or "")
            if (rec["status"] not in ("failed", "cancelled", "merged") or not plan.is_writer(rec)
                    or not rec.get("worktree") or not wt.exists()):
                continue
            merged = rec["status"] == "merged"
            try:
                remove_worktree(task.config, settings(task.main, task.config, rec["repo"]).root, wt,
                                delete_branch=merged)
                print(f"removed {nid} worktree" + ("" if merged else f" (branch {rec.get('branch')} kept)"))
            except (WorktreeError, DriverError) as e:
                print(f"leftover: {nid} worktree {wt} ({e})")
        mark("leftovers")
    for key, repo in sorted(d["repos"].items()):
        if f"repo:{key}" in done:
            continue
        root, wt = Path(repo["root"]), Path(repo["worktree"])
        try:
            if wt.exists():
                remove_worktree(task.config, root, wt, delete_branch=True)
            elif run_git(["rev-parse", "--verify", "--quiet", f"refs/heads/{repo['branch']}"], cwd=root)[0] == 0:
                git(root, "branch", "-D", repo["branch"])
        except WorktreeError as e:
            raise DriverError(f"{key}: {e}") from None
        print(f"removed {key} integration worktree and branch {repo['branch']}")
        mark(f"repo:{key}")
    if "archive" not in done:
        if not d["cleanup"].get("archive"):
            d["cleanup"]["archive"] = str(tasks_dir(task.main) / DIR_ARCHIVE / datetime.now().strftime("%Y-%m") / task.name)
            task.save()
        dest = Path(d["cleanup"]["archive"])
        if task.dir != dest and not dest.exists():
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(task.dir), str(dest))
            print(f"archived to {dest}")
        task.dir = dest
        task.reload()
        task.data.update(status="done", ended=utc_now())
        task.data["cleanup"]["done"].append("archive")
        task.save()
    return tail(task)


def _control_busy(main: Path) -> str | None:
    if run_git(["symbolic-ref", "--quiet", "HEAD"], cwd=main)[0] != 0:
        return "the control checkout is detached"
    for name in ("MERGE_HEAD", "rebase-merge", "rebase-apply"):
        rc, out, _ = run_git(["rev-parse", "--git-path", name], cwd=main)
        if rc == 0 and (main / out.strip()).exists():
            return "the control checkout is in the middle of a merge or rebase"
    return None


def tail(task: Task) -> int:
    """Commit the archive move and write the journal entry; both are idempotent."""
    d = task.data
    main = task.main
    old = f"{DIR_WORKFLOW}/tasks/{task.name}"
    new = Path(d["cleanup"]["archive"]).relative_to(main).as_posix()
    busy = _control_busy(main)
    if busy:
        print(f"note: {busy}; the archive move is not committed")
    else:
        paths = [new] + ([old] if run_git(["ls-files", "--", old], cwd=main)[1].strip() else [])
        rc, _, err = run_git(["add", "-A", "--", *paths], cwd=main)
        if rc != 0:
            print(f"note: git add failed ({err.strip()}); the archive move is not committed")
        elif run_git(["diff", "--cached", "--quiet", "--", *paths], cwd=main)[0] != 0:
            git(main, "commit", "-q", "--no-verify", "-m", f"chore(task): archive {task.name}", "--only", "--", *paths)
            print(f"committed the archive move of {task.name}")
    commits, subjects = [], []
    for key, repo in sorted(d["repos"].items()):
        sha = repo.get("merge_commit")
        if sha:
            subject = run_git(["log", "-1", "--format=%s", sha], cwd=Path(repo["root"]))[1].strip()
            commits.append(sha)
            subjects += ["--commit-subject", f"{sha}={key}: {subject or 'merge ' + repo['branch']}"]
    merged = [r.get("title") or n for n, r in sorted(d["nodes"].items(), key=lambda kv: kv[1]["seq"])
              if r["status"] == "merged"]
    proc = subprocess.run(
        [sys.executable, str(main / DIR_WORKFLOW / "scripts" / "add_session.py"), "--title", d.get("title") or task.name,
         "--summary", f"arbor task {task.name}: {len(merged)} node(s) merged into {', '.join(sorted(d['repos'])) or 'nothing'}",
         "--commit", ",".join(commits) or "-", *subjects, *(a for t in merged for a in ("--change", t)),
         "--idempotency-key", f"arbor-finish-{task.name}"[:64]],
        cwd=main, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if proc.returncode != 0:
        print(f"note: the journal entry was not written (add_session.py exited {proc.returncode}):\n"
              f"{(proc.stdout + proc.stderr).strip()}")
    else:
        print("journal entry written")
    print(f"{task.name}: done")
    return 0
