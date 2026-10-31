"""
FINISH: scorecard, pull request or local merge command, merge detection and
cleanup.

    before merge   ``arbor finish`` writes ``<task>/scorecard.md`` and commits it
                   on the task branch (``arbor(<task>): scorecard``); with
                   ``--pr`` and ``gh`` on PATH it pushes the branch and opens a
                   PR (body = contract.md + scorecard.md), otherwise it prints
                   the local ``merge --no-ff`` command. Nothing else pushes.
    merge          a human merges the task branch into ``base_branch``
                   (``git merge-base --is-ancestor`` in the main checkout).
    after merge    ``arbor finish`` removes the task worktree and branch (never
                   forced: a dirty worktree stops it), sets ``state: DONE`` in
                   the merged copy of task.json, archives the task, clears the
                   session pointer and writes the journal entry -> DONE.

Every step is idempotent. Cleanup progress lives in
``<main>/.arbor/.runtime/finish/<task>.json`` so a re-run continues at the
first missing step even after the worktree (and with it the session's task
pointer) is gone.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
from collections import Counter
from datetime import datetime
from pathlib import Path

from ..contract import find_contract, load_contract
from ..git import run_git
from ..io import read_json_checked, write_json
from ..paths import DIR_TASKS, DIR_WORKFLOW, FILE_TASK_JSON
from ..worktree import WorktreeError, remove_worktree
from . import validate as rv
from .state import Step

SCORECARD = "scorecard.md"
RUNTIME_FINISH = f"{DIR_WORKFLOW}/.runtime/finish"
_REPORT_SPLIT = "\n---\n\n## Driver: "
SPEC_REMINDER = ("before merging, update .arbor/spec/ (or add a lint) for any CONFIRMED finding "
                 "category that recurred (scorecard.md, Recurring CONFIRMED categories)")


class FinishError(RuntimeError):
    pass


# =============================================================================
# Git queries
# =============================================================================


def _git(cwd: Path, *args: str) -> str:
    rc, out, err = run_git(list(args), cwd=cwd)
    if rc != 0:
        raise FinishError(f"git {' '.join(args)} failed: {err.strip()}")
    return out.strip()


def current_branch(main: Path) -> str | None:
    rc, out, _ = run_git(["symbolic-ref", "--quiet", "--short", "HEAD"], cwd=main)
    return out.strip() or None if rc == 0 else None


def base_branch_of(main: Path, data: dict) -> str:
    base = data.get("base_branch") or current_branch(main)
    if not base:
        raise FinishError("no base_branch in task.json and the main checkout is on a detached HEAD")
    return base


def branch_exists(main: Path, branch: str) -> bool:
    rc, _, _ = run_git(["rev-parse", "--verify", "--quiet", f"refs/heads/{branch}"], cwd=main)
    return rc == 0


def is_merged(main: Path, branch: str, base_branch: str) -> bool:
    rc, _, _ = run_git(["merge-base", "--is-ancestor", branch, base_branch], cwd=main)
    return rc == 0


def merge_command(main: Path, branch: str, base_branch: str) -> str:
    cmd = f"git -C {main} merge --no-ff {branch}"
    if current_branch(main) != base_branch:
        cmd = f"git -C {main} checkout {base_branch} && {cmd}"
    return cmd


def merge_commit(main: Path, tip: str, base_branch: str) -> str:
    """The commit on ``base_branch`` that brought ``tip`` in: the oldest merge
    commit on its first-parent chain that descends from ``tip``; ``tip`` itself
    after a fast-forward."""
    rc, out, _ = run_git(
        ["rev-list", "--first-parent", "--merges", "--ancestry-path", f"{tip}..{base_branch}"], cwd=main,
    )
    merges = out.split() if rc == 0 else []
    return merges[-1] if merges else tip


def dirty_paths(worktree: Path) -> list[str]:
    rc, out, err = run_git(["status", "--porcelain", "--untracked-files=all"], cwd=worktree)
    if rc != 0:
        raise FinishError(f"git status in {worktree} failed: {err.strip()}")
    return [line for line in out.splitlines() if line.strip()]


# =============================================================================
# Scorecard
# =============================================================================


def _reply(task_dir: Path, dispatch: str, interpreted: str | None = None) -> str | None:
    path = task_dir / interpreted if interpreted else task_dir / "reports" / f"{dispatch}.md"
    if not path.is_file():
        return None
    return path.read_text(encoding="utf-8").split(_REPORT_SPLIT, 1)[0]


def _level(entry: dict) -> str | None:
    """Which rung of the verification ladder a reader dispatch belongs to."""
    role, mode = entry.get("role"), entry.get("mode")
    if entry.get("phase") == "CONTRACT":
        return None
    if role == "review":
        return {"self-check": "2", "candidates": "3", "sweep": "4"}.get(mode or "self-check")
    if role == "verify":
        return "3"
    return None


def verdict_counts(task_dir: Path, dispatches: list[dict]) -> tuple[dict, Counter]:
    """({level: Counter(verdict)}, Counter(angle of every CONFIRMED finding))."""
    levels: dict[str, Counter] = {"2": Counter(), "3": Counter(), "4": Counter()}
    confirmed_angles: Counter = Counter()
    for entry in dispatches:
        level = _level(entry)
        if level is None or entry.get("status") != "ok":
            continue
        reply = _reply(task_dir, str(entry.get("id")), entry.get("interpreted_report"))
        if reply is None:
            continue
        for finding in rv.check_reply(entry["role"], reply).findings:
            verdict = str(finding.get("verdict", "")).upper()
            levels[level][verdict] += 1
            if verdict == "CONFIRMED":
                confirmed_angles[str(finding.get("angle") or "unspecified")] += 1
    return levels, confirmed_angles


def gate_rounds(task_dir: Path, data: dict) -> list[tuple[int, str, str]]:
    """[(round, green|red, failing ids)] from ``reports/gate-N.md``."""
    rounds: list[tuple[int, str, str]] = []
    total = int((data.get("counters") or {}).get("gate", 0))
    numbers = sorted(
        int(p.stem[5:]) for p in (task_dir / "reports").glob("gate-*.md") if p.stem[5:].isdigit()
    ) if (task_dir / "reports").is_dir() else []
    for n in sorted(set(numbers) | set(range(1, total + 1))):
        path = task_dir / "reports" / f"gate-{n}.md"
        result, failing = "?", "?"
        if path.is_file():
            lines = path.read_text(encoding="utf-8").splitlines()
            if lines and ":" in lines[0]:
                result = lines[0].rsplit(":", 1)[1].strip()
            failing = next((l.split(":", 1)[1].strip() for l in lines if l.startswith("failing:")), "?")
        rounds.append((n, result, failing))
    return rounds


def _results_rows(main: Path, task: str) -> list[dict]:
    path = main / DIR_WORKFLOW / ".runtime" / "results.jsonl"
    rows: list[dict] = []
    if not path.is_file():
        return rows
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if isinstance(row, dict) and row.get("task") == task and row.get("dispatch") != "canary":
            rows.append(row)
    return rows


def _parse_ts(value) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _duration(seconds: float) -> str:
    seconds = int(round(seconds))
    hours, rest = divmod(seconds, 3600)
    minutes, secs = divmod(rest, 60)
    return f"{hours}h{minutes:02d}m{secs:02d}s" if hours else f"{minutes}m{secs:02d}s"


def coverage(task_dir: Path) -> tuple[int, int]:
    path = find_contract(task_dir)
    if path is None:
        return 0, 0
    entries = load_contract(path).verification_map
    return sum(1 for e in entries if e.kind == "auto"), len(entries)


def scorecard_facts(main: Path, task_dir: Path, data: dict, tier: str) -> dict:
    dispatches = [d for d in data.get("dispatches") or [] if isinstance(d, dict)]
    by_role: dict[str, Counter] = {}
    for d in dispatches:
        by_role.setdefault(str(d.get("role")), Counter())[str(d.get("status"))] += 1
    rows = _results_rows(main, task_dir.name)
    starts = [t for t in (_parse_ts(r.get("started")) for r in rows) if t]
    ends = [t for t in (_parse_ts(r.get("ended")) for r in rows) if t]
    levels, confirmed_angles = verdict_counts(task_dir, dispatches)
    auto, total = coverage(task_dir)
    counters = data.get("counters") or {}
    violations = sum(1 for d in dispatches if d.get("status") == "violation")
    setup = data.get("worktree_setup_s")
    return {
        "tier": tier,
        "by_role": by_role,
        "dispatches": len(dispatches),
        "wall": (max(ends) - min(starts)).total_seconds() if starts and ends else None,
        "dispatch_s": sum(float(r.get("duration_s") or 0) for r in rows),
        "setup_s": float(setup) if isinstance(setup, (int, float)) else None,
        "gates": gate_rounds(task_dir, data),
        "review_rounds": sum(1 for d in dispatches if d.get("role") == "review" and _level(d) == "2"),
        "review_fail_rounds": int(counters.get("review", 0)),
        "polish_rounds": int(counters.get("polish", 0)),
        "levels": levels,
        "recurring": sorted(a for a, n in confirmed_angles.items() if n >= 2),
        "auto": auto,
        "map_total": total,
        "overrides": len(data.get("overrides") or []),
        "violations": violations,
    }


def summary_line(facts: dict) -> str:
    gates = facts["gates"]
    auto, total = facts["auto"], facts["map_total"]
    return (f"{facts['tier']} tier: {facts['dispatches']} dispatches, {len(gates)} gate round(s), "
            f"{facts['review_rounds']} review / {facts['polish_rounds']} polish round(s), "
            f"AC auto-coverage {auto}/{total}, {facts['overrides']} override(s), "
            f"{facts['violations']} invariant violation(s)")


def render_scorecard(name: str, data: dict, facts: dict) -> str:
    title = data.get("title") or name
    lines = [f"# Scorecard: {title}", "",
             f"- task: {name}", f"- tier: {facts['tier']}",
             f"- branch: {data.get('branch')} (base {str(data.get('base') or '')[:12]}) into "
             f"{data.get('base_branch') or '-'}",
             f"- summary: {summary_line(facts)}", "",
             "## Dispatches", "", "| role | ok | fail | violation | total |", "|---|---|---|---|---|"]
    for role in sorted(facts["by_role"]):
        c = facts["by_role"][role]
        lines.append(f"| {role} | {c['ok']} | {c['fail']} | {c['violation']} | {sum(c.values())} |")
    lines += ["", f"- total: {facts['dispatches']}", "", "## Time", "",
              f"- total (first dispatch start to last dispatch end): "
              f"{_duration(facts['wall']) if facts['wall'] is not None else 'n/a'}",
              f"- dispatch time (sum): {_duration(facts['dispatch_s'])}",
              f"- worktree setup: {_duration(facts['setup_s']) if facts['setup_s'] is not None else 'n/a'}",
              "", "## GATE", "", f"- rounds: {len(facts['gates'])}"]
    if facts["gates"]:
        lines += ["", "| round | result | failing |", "|---|---|---|"]
        lines += [f"| {n} | {result} | {failing} |" for n, result, failing in facts["gates"]]
    lines += ["", "## REVIEW / POLISH", "",
              f"- review rounds: {facts['review_rounds']} ({facts['review_fail_rounds']} failed)",
              f"- polish rounds: {facts['polish_rounds']}",
              "", "## Findings by level", "",
              "| level | CONFIRMED | PLAUSIBLE | REFUTED |", "|---|---|---|---|"]
    names = {"2": "2 review", "3": "3 candidates + verify", "4": "4 sweep"}
    for level in ("2", "3", "4"):
        c = facts["levels"][level]
        lines.append(f"| {names[level]} | {c['CONFIRMED']} | {c['PLAUSIBLE']} | {c['REFUTED']} |")
    pct = f" ({round(100 * facts['auto'] / facts['map_total'])}%)" if facts["map_total"] else ""
    lines += ["", "## Recurring CONFIRMED categories", "",
              *([f"- {a}: add a spec rule or a lint before merging" for a in facts["recurring"]] or ["- none"]),
              "", "## Other", "",
              f"- AC auto-coverage: {facts['auto']}/{facts['map_total']}{pct}",
              f"- overrides: {facts['overrides']}",
              f"- invariant violations: {facts['violations']}", ""]
    return "\n".join(lines)


def write_scorecard(main: Path, task_dir: Path, data: dict, tier: str) -> bool:
    """Write scorecard.md unless it exists (a human may have annotated it).
    True when written."""
    path = task_dir / SCORECARD
    if path.is_file():
        return False
    facts = scorecard_facts(main, task_dir, data, tier)
    path.write_text(render_scorecard(task_dir.name, data, facts), encoding="utf-8")
    return True


def scorecard_summary(task_dir: Path) -> str:
    path = task_dir / SCORECARD
    if path.is_file():
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.startswith("- summary: "):
                return line[len("- summary: "):]
    return "task finished"


# =============================================================================
# next (cheap, no side effects)
# =============================================================================


def plan_finish(main: Path, task_dir: Path, data: dict) -> Step:
    binding = data.get("execution_binding")
    if binding and (task_dir / SCORECARD).is_file():
        product = Path(binding["repo"])
        if not is_merged(product, data["branch"], data["base_branch"]):
            command = merge_command(product, data["branch"], data["base_branch"])
            return Step("human", f"FINISH: merge product first: {command}",
                        human={"kind": "merge", "command": command})
        if (data.get("product_merge") or {}).get("tip") != _git(product, "rev-parse", data["branch"]):
            return Step("run", "FINISH: record product merge evidence: `arbor finish`")
        data = {**data, **binding["control"]}
    if not (task_dir / SCORECARD).is_file():
        return Step("run", "FINISH: write the scorecard: `arbor finish`")
    branch = data["branch"]
    try:
        base = base_branch_of(main, data)
    except FinishError as e:
        return Step("human", f"FINISH: {e}", human={"kind": "merge", "command": None, "pr_url": data.get("pr_url")})
    if branch_exists(main, branch) and is_merged(main, branch, base):
        return Step("run", "FINISH: merged: `arbor finish` to clean up")
    command = merge_command(main, branch, base)
    pr = data.get("pr_url")
    how = (f"merge PR {pr} with a merge commit, then update {base} in {main}" if pr
           else f"merge with `{command}`")
    return Step("human", f"FINISH: {SPEC_REMINDER}; then a human merges {branch} into {base}: {how}",
                human={"kind": "merge", "command": command, "pr_url": pr})


def finish_stage(main: Path, task_dir: Path, data: dict) -> str:
    if not (task_dir / SCORECARD).is_file():
        return "scorecard missing (`arbor finish`)"
    step = plan_finish(main, task_dir, data)
    if step.needs == "run":
        return "merged (`arbor finish` cleans up)"
    pr = data.get("pr_url")
    return f"awaiting merge ({pr or (step.human or {}).get('command')})"


# =============================================================================
# finish before merge: scorecard, PR
# =============================================================================


def commit_paths(worktree: Path, rel: str, message: str) -> bool:
    _git(worktree, "add", "-A", "--", rel)
    rc, _, _ = run_git(["diff", "--cached", "--quiet", "--", rel], cwd=worktree)
    if rc == 0:
        return False
    _git(worktree, "commit", "-q", "--no-verify", "-m", message, "--", rel)
    return True


def open_pr(worktree: Path, task_dir: Path, data: dict, base: str) -> str:
    """Push the task branch and ``gh pr create``; returns the PR url."""
    branch = data["branch"]
    _git(worktree, "push", "-u", "origin", branch)
    contract = find_contract(task_dir)
    body = (contract.read_text(encoding="utf-8") if contract else "") + "\n\n" + \
        (task_dir / SCORECARD).read_text(encoding="utf-8")
    with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False, encoding="utf-8") as fh:
        fh.write(body)
        body_file = fh.name
    try:
        proc = subprocess.run(
            ["gh", "pr", "create", "--base", base, "--head", branch,
             "--title", str(data.get("title") or task_dir.name), "--body-file", body_file],
            cwd=worktree, capture_output=True, text=True, encoding="utf-8", errors="replace",
        )
    finally:
        os.unlink(body_file)
    if proc.returncode != 0:
        raise FinishError(f"gh pr create failed: {(proc.stderr or proc.stdout).strip()}")
    urls = [l.strip() for l in proc.stdout.splitlines() if l.strip().startswith("http")]
    if not urls:
        raise FinishError(f"gh pr create printed no url: {proc.stdout.strip()}")
    return urls[-1]


def finish_product(main: Path, task_dir: Path, data: dict, tier: str, *, want_pr: bool, save) -> int:
    binding = data["execution_binding"]
    control = binding["control"]
    cwt = Path(control["worktree_path"])
    product = Path(binding["repo"])
    task_rel = f"{DIR_WORKFLOW}/{DIR_TASKS}/{task_dir.name}"
    write_scorecard(main, task_dir, data, tier)
    commit_paths(cwt, task_rel, f"arbor({task_dir.name}): scorecard")
    if not is_merged(product, data["branch"], data["base_branch"]):
        if want_pr:
            raise FinishError("product tasks currently use the explicit two-repository local merge flow")
        print(f"merge product (human): {merge_command(product, data['branch'], data['base_branch'])}")
        return 0
    tip = _git(product, "rev-parse", data["branch"])
    evidence = {"repo": str(product), "tip": tip,
                "merge_commit": merge_commit(product, tip, data["base_branch"]), "target": data["base_branch"]}
    if evidence["merge_commit"] == tip:
        raise FinishError("product merge requires a --no-ff merge commit")
    if data.get("product_merge") != evidence:
        data["product_merge"] = evidence
        save()
        commit_paths(cwt, task_rel, f"arbor({task_dir.name}): product merge evidence")
    print(f"merge control (human): {merge_command(main, control['branch'], control['base_branch'])}")
    return 0


def finish_before_merge(main: Path, worktree: Path, task_dir: Path, task_rel: str, data: dict, tier: str,
                        *, want_pr: bool, save) -> int:
    name = task_dir.name
    if data.get("execution_binding"):
        return finish_product(main, task_dir, data, tier, want_pr=want_pr, save=save)
    if write_scorecard(main, task_dir, data, tier):
        print(f"scorecard: {task_dir / SCORECARD}")
    if commit_paths(worktree, task_rel, f"arbor({name}): scorecard"):
        print(f"committed on {data['branch']}: arbor({name}): scorecard")
    base = base_branch_of(main, data)
    if data.get("pr_url"):
        print(f"PR: {data['pr_url']}")
    elif want_pr and shutil.which("gh"):
        url = open_pr(worktree, task_dir, data, base)
        data["pr_url"] = url
        save()
        if commit_paths(worktree, task_rel, f"arbor({name}): pr {url}"):
            _git(worktree, "push", "origin", data["branch"])  # the PR must carry the whole branch
        print(f"PR: {url}")
    elif want_pr:
        print("gh is not on PATH; merge locally instead")
    print(f"before merging: {SPEC_REMINDER}")
    print(f"merge (human): {merge_command(main, data['branch'], base)}")
    return 0


# =============================================================================
# finish after merge: cleanup
# =============================================================================


def record_path(main: Path, name: str) -> Path:
    return main / RUNTIME_FINISH / f"{name}.json"


def load_record(main: Path, name: str) -> dict | None:
    path = record_path(main, name)
    if not path.is_file():
        return None
    data, _ = read_json_checked(path)
    return data if isinstance(data, dict) else None


def pending_records(main: Path) -> list[str]:
    folder = main / RUNTIME_FINISH
    return sorted(p.stem for p in folder.glob("*.json")) if folder.is_dir() else []


def _save_record(main: Path, record: dict) -> None:
    path = record_path(main, record["task"])
    path.parent.mkdir(parents=True, exist_ok=True)
    if not write_json(path, record):
        raise FinishError(f"failed to write {path}")


def start_cleanup(main: Path, task_dir: Path, data: dict) -> dict:
    """Checks before any mutation; returns the cleanup record (not saved)."""
    binding = data.get("execution_binding")
    product_record = None
    if binding:
        if not data.get("product_merge"):
            raise FinishError("product merge evidence missing")
        product_data = {k: v for k, v in data.items() if k != "execution_binding"}
        product_record = start_cleanup(Path(binding["repo"]), task_dir, product_data)
        if product_record["tip"] != data["product_merge"].get("tip"):
            raise FinishError("product branch advanced after the recorded merge evidence")
        if current_branch(main) != binding["control"]["base_branch"]:
            raise FinishError("switch the control main checkout to its merge target before cleanup")
        product_record["repo"] = binding["repo"]
        product_record["repo_id"] = binding["repo_id"]
        data = {**data, **binding["control"]}
    branch = data["branch"]
    base = base_branch_of(main, data)
    if not branch_exists(main, branch) or not is_merged(main, branch, base):
        raise FinishError(f"{branch} is not merged into {base}")
    worktree = Path(data["worktree_path"])
    if worktree.exists():
        dirty = dirty_paths(worktree)
        if dirty:
            raise FinishError(f"the task worktree {worktree} has uncommitted changes; commit or discard them, "
                              "then re-run `arbor finish`:\n  " + "\n  ".join(dirty))
    tip = _git(main, "rev-parse", f"refs/heads/{branch}")
    merged_by = merge_commit(main, tip, base)
    if binding and merged_by == tip:
        raise FinishError("control merge requires a --no-ff merge commit")
    return {
        "task": task_dir.name, "title": data.get("title") or task_dir.name, "branch": branch,
        "base_branch": base, "worktree_path": str(worktree), "tip": tip, "merge_commit": merged_by,
        "summary": scorecard_summary(task_dir),
        "gate_rounds": len(gate_rounds(task_dir, data)), "done": [], "product": product_record,
    }


def _script(main: Path, script: str, *args: str) -> tuple[int, str]:
    proc = subprocess.run(
        [sys.executable, str(main / DIR_WORKFLOW / "scripts" / script), *args],
        cwd=main, capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    return proc.returncode, (proc.stdout + proc.stderr).strip()


def cleanup(main: Path, record: dict) -> int:
    """Run the missing cleanup steps; 0 when DONE."""
    name = record["task"]
    done: list[str] = record.setdefault("done", [])
    _save_record(main, record)

    def mark(step: str) -> None:
        done.append(step)
        _save_record(main, record)
        print(f"  {step}: ok")

    if record.get("product") and "product" not in done:
        from ..execution import identity
        product = record["product"]
        root = Path(product["repo"])
        if identity(root) != product["repo_id"]:
            raise FinishError("product repository identity changed; cleanup refused")
        tip, base = product["tip"], product["base_branch"]
        if not is_merged(root, tip, base):
            raise FinishError("product merge evidence no longer belongs to target")
        wt = Path(product["worktree_path"])
        if wt.exists():
            if identity(wt) != product["repo_id"] or _git(wt, "rev-parse", "HEAD") != tip:
                raise FinishError("product worktree identity/tip changed; cleanup refused")
            if dirty_paths(wt):
                raise FinishError("product worktree is dirty; cleanup refused")
            remove_worktree(root, wt, delete_branch=True)
        elif branch_exists(root, product["branch"]):
            if _git(root, "rev-parse", product["branch"]) != tip:
                raise FinishError("product branch moved; cleanup refused")
            _git(root, "branch", "-d", product["branch"])
        mark("product")

    if "worktree" not in done:
        worktree, branch = Path(record["worktree_path"]), record["branch"]
        try:
            if worktree.exists():
                dirty = dirty_paths(worktree)
                if dirty:
                    raise FinishError(f"{worktree} has uncommitted changes:\n  " + "\n  ".join(dirty))
                remove_worktree(main, worktree, delete_branch=True)
            elif branch_exists(main, branch):
                _git(main, "worktree", "prune")
                _git(main, "branch", "-D", branch)
        except WorktreeError as e:
            raise FinishError(str(e)) from e
        mark("worktree")

    merged_copy = main / DIR_WORKFLOW / DIR_TASKS / name
    if "state" not in done:
        path = merged_copy / FILE_TASK_JSON
        if path.is_file():
            data, reason = read_json_checked(path)
            if data is None:
                raise FinishError(f"cannot read {path}: {reason}")
            data["state"], data["step"] = "DONE", "done"
            data.pop("decision", None)
            if not write_json(path, data):
                raise FinishError(f"failed to write {path}")
        mark("state")

    if "archive" not in done:
        if merged_copy.is_dir():
            rc, out = _script(main, "task.py", "archive", name)
            if rc != 0:
                raise FinishError(f"task.py archive {name} failed:\n{out}")
        mark("archive")

    if "pointer" not in done:
        rc, out = _script(main, "task.py", "finish")
        if rc != 0:
            raise FinishError(f"task.py finish failed:\n{out}")
        mark("pointer")

    if "journal" not in done:
        short = record["merge_commit"][:12]
        rc, out = _script(
            main, "add_session.py", "--title", record["title"], "--commit", record["merge_commit"],
            "--summary", record["summary"], "--branch", record["base_branch"],
            "--change", f"Merged {record['branch']} into {record['base_branch']} ({short})",
            "--change", f"Scorecard archived with the task: {name}/{SCORECARD}",
            "--test", f"Gate: {record['gate_rounds']} round(s); last round green",
            "--idempotency-key", f"arbor-finish-{name}"[:64],
        )
        if rc != 0:
            raise FinishError(f"add_session.py failed:\n{out}")
        mark("journal")

    if record.get("product"):
        (main / DIR_WORKFLOW / ".runtime" / "starts" / f"{name}.json").unlink(missing_ok=True)
    record_path(main, name).unlink(missing_ok=True)
    print(f"{name}: DONE (merged as {record['merge_commit'][:12]})")
    return 0
