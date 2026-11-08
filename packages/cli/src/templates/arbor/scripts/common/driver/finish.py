"""
FINISH: scorecard, pull request or local merge command, merge detection and
cleanup.

    before merge   one ``arbor finish`` writes ``<task>/scorecard.md``, commits it
                   on the task branch (``arbor(<task>): scorecard``) and decides
                   the merge in the same run: with ``--pr`` and ``gh`` on PATH it
                   pushes the branch and opens a PR (body = contract.md +
                   scorecard.md), with ``merge=auto`` it merges a small clean
                   branch itself, otherwise it prints the local ``merge --no-ff``
                   command. Nothing else pushes.
    merge          a human merges the task branch into ``base_branch``
                   (``git merge-base --is-ancestor`` in the main checkout).
                   A child of a parent task targets the parent's integration
                   branch instead: the same ``arbor finish`` catches the child
                   up with it, runs the gate and the merge checks, and merges
                   it ``--no-ff`` itself (``integration.py``); a failed check
                   leaves a human merge with the reason.
    after merge    ``arbor finish`` removes the task worktree and branch (never
                   forced: a dirty worktree stops it), sets ``state: DONE`` in
                   the merged copy of task.json (in the checkout of the target
                   branch), archives the task there, clears the session
                   pointer and writes the journal entry -> DONE. A child merged
                   into an integration branch records itself on the parent
                   instead of writing the journal (the baseline stays untouched).

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

from .. import lessons as ls
from ..active_task import clear_task_from_sessions
from ..contract import find_contract, load_contract
from ..git import run_git
from ..io import read_json_checked, write_json
from ..paths import DIR_TASKS, DIR_WORKFLOW, FILE_TASK_JSON
from ..worktree import WorktreeError, is_ancestor, remove_worktree
from ..worktree import merge_no_ff as merge_into_worktree
from . import integration as ig
from . import validate as rv
from .executor import utc_now
from .state import Step

SCORECARD = "scorecard.md"
RUNTIME_FINISH = f"{DIR_WORKFLOW}/.runtime/finish"
_REPORT_SPLIT = "\n---\n\n## Driver: "
SPEC_REMINDER = ("update .arbor/spec/ (or add a lint) for any CONFIRMED finding category that "
                 "recurred (scorecard.md, Recurring CONFIRMED categories); fill root_cause, prevention "
                 "and check in the lessons rows this finish appended")
_ACROSS_HEADING = "## Recurring across tasks"


def spec_reminder(across: list[str]) -> str:
    """The pre-merge reminder; names the categories that recur across tasks."""
    if not across:
        return SPEC_REMINDER
    return (f"add a lint rule or a test (lessons check: lint|test) for {', '.join(across)}, which recurred "
            f"across tasks (scorecard.md, Recurring across tasks); {SPEC_REMINDER}")


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
    landing = ig.checkout_of(main, base_branch)
    if landing is not None and landing.resolve() != main.resolve():
        return f"git -C {landing} merge --no-ff {branch}"
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
    return None


def _findings(task_dir: Path, entry: dict) -> list[dict]:
    """The findings of an ok reader dispatch as the state table saw them: a
    CONFIRMED finding the driver downgraded (no valid repro) counts as PLAUSIBLE."""
    reply = _reply(task_dir, str(entry.get("id")), entry.get("interpreted_report"))
    if reply is None:
        return []
    downgraded = set(entry.get("downgraded") or [])
    findings = rv.check_reply(entry["role"], reply).findings
    for finding in findings:
        if downgraded and rv.finding_id(finding) in downgraded:
            finding["verdict"] = "PLAUSIBLE"
    return findings


def verdict_counts(task_dir: Path, dispatches: list[dict]) -> tuple[dict, Counter]:
    """({level: Counter(verdict)}, Counter(angle of every CONFIRMED finding))."""
    levels: dict[str, Counter] = {"2": Counter(), "3": Counter(), "4": Counter()}
    confirmed_angles: Counter = Counter()
    for entry in dispatches:
        level = _level(entry)
        if level is None or entry.get("status") != "ok":
            continue
        for finding in _findings(task_dir, entry):
            verdict = str(finding.get("verdict", "")).upper()
            levels[level][verdict] += 1
            if verdict == "CONFIRMED":
                confirmed_angles[str(finding.get("angle") or "unspecified")] += 1
    return levels, confirmed_angles


def confirmed_findings(task_dir: Path, dispatches: list[dict]) -> list[dict]:
    """Every distinct CONFIRMED finding a review reader settled."""
    found: dict[str, dict] = {}
    for entry in dispatches:
        if _level(entry) is None or entry.get("status") != "ok":
            continue
        for finding in _findings(task_dir, entry):
            if str(finding.get("verdict", "")).upper() == "CONFIRMED":
                found.setdefault(rv.finding_id(finding), finding)
    return list(found.values())


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
        if isinstance(row, dict) and row.get("task") == task:
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


def scorecard_facts(main: Path, task_dir: Path, data: dict, tier: str,
                    lessons: list[dict] | None = None) -> dict:
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
        "review_rounds": sum(1 for d in dispatches if d.get("role") == "review" and not d.get("phase")),
        "review_fail_rounds": int(counters.get("review", 0)),
        "levels": levels,
        "recurring": sorted(a for a, n in confirmed_angles.items() if n >= 2),
        "recurring_across": ls.recurring_across_tasks(lessons or []),
        "recheck_skips": [s for s in data.get("recheck_skips") or [] if isinstance(s, dict)],
        "auto": auto,
        "map_total": total,
        "overrides": len(data.get("overrides") or []),
        "violations": violations,
    }


def summary_line(facts: dict) -> str:
    gates = facts["gates"]
    auto, total = facts["auto"], facts["map_total"]
    return (f"{facts['tier']} tier: {facts['dispatches']} dispatches, {len(gates)} gate round(s), "
            f"{facts['review_rounds']} review read(s) / {facts['review_fail_rounds']} fix round(s), "
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
    lines += ["", "## REVIEW", "",
              f"- review reads: {facts['review_rounds']}",
              f"- fix rounds: {facts['review_fail_rounds']}",
              *[f"- recheck skipped (repros passed in gate {s.get('gate')}): "
                f"{', '.join(map(str, s.get('findings') or []))}" for s in facts["recheck_skips"]],
              "", "## Findings by level", "",
              "| level | CONFIRMED | PLAUSIBLE | REFUTED |", "|---|---|---|---|"]
    names = {"2": "2 review", "3": "3 candidates", "4": "4 sweep"}
    for level in ("2", "3", "4"):
        c = facts["levels"][level]
        lines.append(f"| {names[level]} | {c['CONFIRMED']} | {c['PLAUSIBLE']} | {c['REFUTED']} |")
    pct = f" ({round(100 * facts['auto'] / facts['map_total'])}%)" if facts["map_total"] else ""
    lines += ["", "## Recurring CONFIRMED categories", "",
              *([f"- {a}: add a spec rule or a lint before merging" for a in facts["recurring"]] or ["- none"]),
              "", _ACROSS_HEADING, "",
              *([f"- {c}: {', '.join(tasks)}" for c, tasks in facts["recurring_across"]] or ["- none"]),
              "", "## Other", "",
              f"- AC auto-coverage: {facts['auto']}/{facts['map_total']}{pct}",
              f"- overrides: {facts['overrides']}",
              f"- invariant violations: {facts['violations']}", ""]
    return "\n".join(lines)


def write_scorecard(main: Path, task_dir: Path, data: dict, tier: str,
                    lessons: list[dict] | None = None) -> bool:
    """Write scorecard.md unless it exists (a human may have annotated it).
    True when written."""
    path = task_dir / SCORECARD
    if path.is_file():
        return False
    facts = scorecard_facts(main, task_dir, data, tier, lessons)
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
    if data.get("integration_target"):
        blocked = data.get("merge_blocked")
        if blocked:
            return Step("human", f"FINISH: automatic merge into {base} blocked ({blocked.get('reason')}); "
                        f"check it with the user, then fix the branch and `arbor finish`, or merge by hand: "
                        f"`{command}`", human={"kind": "merge", "command": command, "into": base, "blocked": blocked})
        return Step("run", f"FINISH: `arbor finish` merges {branch} into {base} "
                    "(integration branch: catch-up, gate, merge checks, no human merge)", action="finish")
    pr = data.get("pr_url")
    how = (f"merge PR {pr} with a merge commit, then update {base} in {main}" if pr
           else f"merge with `{command}`")
    return Step("human", f"FINISH: {spec_reminder(across_from_scorecard(task_dir))}; "
                f"then a human merges {branch} into {base}: {how}",
                human={"kind": "merge", "command": command, "pr_url": pr})


def finish_stage(main: Path, task_dir: Path, data: dict) -> str:
    if not (task_dir / SCORECARD).is_file():
        return "scorecard missing (`arbor finish`)"
    step = plan_finish(main, task_dir, data)
    if step.action == "finish":
        return f"ready to merge into {data.get('base_branch')} (`arbor finish`)"
    if step.needs == "run":
        return "merged (`arbor finish` cleans up)"
    pr = data.get("pr_url")
    return f"awaiting merge ({pr or (step.human or {}).get('command')})"


# =============================================================================
# finish before merge: scorecard, PR
# =============================================================================


def commit_paths(worktree: Path, rel: str | list[str], message: str) -> bool:
    rels = [rel] if isinstance(rel, str) else list(rel)
    _git(worktree, "add", "-A", "--", *rels)
    rc, _, _ = run_git(["diff", "--cached", "--quiet", "--", *rels], cwd=worktree)
    if rc == 0:
        return False
    _git(worktree, "commit", "-q", "--no-verify", "-m", message, "--", *rels)
    return True


def across_from_scorecard(task_dir: Path) -> list[str]:
    """The categories the scorecard lists under "Recurring across tasks"."""
    path = task_dir / SCORECARD
    if not path.is_file():
        return []
    out, inside = [], False
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("## "):
            inside = line.strip() == _ACROSS_HEADING
        elif inside and line.startswith("- ") and line.strip() != "- none":
            out.append(line[2:].split(":", 1)[0].strip())
    return out


def record_lessons(worktree: Path, task_dir: Path, data: dict) -> tuple[str, list[dict], int]:
    """Append this task's CONFIRMED findings to its package's lessons file
    (idempotent); returns (its repo-relative path, every row, rows added)."""
    rel = ls.lessons_rel(ls.package_for(worktree, data))
    path = worktree / rel
    dispatches = [d for d in data.get("dispatches") or [] if isinstance(d, dict)]
    found = confirmed_findings(task_dir, dispatches)
    date = datetime.now().date().isoformat()
    added = ls.append_rows(path, [ls.row(f, task_dir.name, date) for f in found])
    if found:
        ls.ensure_union_merge(worktree / DIR_WORKFLOW / "spec")
    return rel, ls.read_rows(path), added


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


def merge_checks(worktree: Path, task_rel: str, data: dict, target: str,
                 scope: tuple[str, ...] | None) -> tuple[str | None, list[str]]:
    """The checks before any automatic merge of a task branch into ``target``:
    why they fail (None when they hold) and the files outside the declared scope."""
    files = ig.out_of_scope(worktree, f"{target}...HEAD", scope)
    if files:
        return f"{len(files)} changed file(s) outside the declared paths", files
    if data.get("review_deferred"):
        return None, []  # the parent reviews the integration branch (task.py integrate)
    return ig.review_binding_problem(worktree, data.get("last_reviewed"), target, task_rel), []


def changed_lines(repo: Path, range_spec: str) -> int:
    """Product lines (added + deleted) ``range_spec`` changes; the task's own
    metadata commits (.arbor/tasks/<task>) do not count."""
    rc, out, _ = run_git(["diff", "--numstat", range_spec, "--", ".", f":(exclude){DIR_WORKFLOW}/{DIR_TASKS}"],
                         cwd=repo)
    lines = 0
    for row in out.splitlines() if rc == 0 else []:
        cols = row.split("\t")
        lines += sum(int(c) for c in cols[:2] if c.isdigit())
    return lines


def auto_merge_blocked(main: Path, branch: str, base: str, max_lines: int) -> tuple[str | None, int]:
    """Why the mandate's auto-merge rule does not hold for ``branch`` (None when it
    does), plus the product lines the branch changes."""
    lines = changed_lines(main, f"{base}...{branch}")
    if lines >= max_lines:
        return f"{lines} changed lines, auto-merge allows fewer than {max_lines}", lines
    if current_branch(main) != base:
        return f"main checkout is on {current_branch(main) or 'a detached HEAD'}, not {base}", lines
    rc, status, _ = run_git(["status", "--porcelain", "--untracked-files=no"], cwd=main)
    if rc != 0 or status.strip():
        return "main checkout has uncommitted changes", lines
    return None, lines


def merge_no_ff(main: Path, branch: str) -> str | None:
    """``git merge --no-ff`` of ``branch`` in the main checkout; aborted on conflict (the reason)."""
    rc, _, err = run_git(["merge", "--no-ff", "--no-edit", "-m", f"merge {branch}", branch], cwd=main)
    if rc != 0:
        run_git(["merge", "--abort"], cwd=main)
        return f"merge did not apply cleanly: {err.strip().splitlines()[-1] if err.strip() else 'conflict'}"
    return None


def merge_into_integration(main: Path, worktree: Path, task_dir: Path, task_rel: str, data: dict, *,
                           save, scope: tuple[str, ...] | None, gate) -> int:
    """A child into its parent's integration branch, without a human: catch up
    with the integration branch, gate, merge checks, ``--no-ff`` merge. A failed
    check is recorded (``merge_blocked``) and leaves the merge to a human."""
    name, branch = task_dir.name, data["branch"]
    target = data["integration_target"]
    into, landing = target["branch"], Path(target["worktree"])
    def blocked(reason: str, files: list[str] | None = None) -> int:
        data["merge_blocked"] = {"ts": utc_now(), "into": into, "reason": reason, "files": files or []}
        save()
        commit_paths(worktree, task_rel, f"arbor({name}): automatic merge into {into} blocked")
        print(f"automatic merge into {into} blocked: {reason}")
        for path in files or []:
            print(f"  {path}")
        print(f"merge (human, after checking): {merge_command(main, branch, into)}")
        return 0

    if not landing.is_dir():
        return blocked(f"the integration worktree {landing} is missing")
    if dirty_paths(landing):
        return blocked(f"the integration worktree {landing} has uncommitted changes")
    dirty = dirty_paths(worktree)
    if dirty:
        print(f"{worktree} has uncommitted changes; commit or discard them, then `arbor finish`:")
        for path in dirty:
            print(f"  {path}")
        return 1
    if not is_ancestor(worktree, into):
        caught = merge_into_worktree(worktree, into, f"arbor({name}): catch up with {into}")
        if not caught.ok:
            print(f"catching up with {into} conflicts ({', '.join(caught.conflicts) or '-'}): in {worktree} run "
                  f"`git merge --no-ff {into}`, resolve, commit, then `arbor finish` again")
            return 1
        print(f"caught up with {into} ({(caught.sha or '')[:12]})")
    if gate is not None:
        failing = gate()
        if failing:
            print(f"gate red before the merge into {into}: {', '.join(failing)}; fix it on the task branch "
                  "(`arbor override --to GATE --reason \"...\"`), then `arbor finish` again")
            return 1
    why, files = merge_checks(worktree, task_rel, data, into, scope)
    if why:
        return blocked(why, files)
    data.pop("merge_blocked", None)
    data["integration_merge"] = {"ts": utc_now(), "into": into, "parent": target.get("parent")}
    save()
    commit_paths(worktree, task_rel, f"arbor({name}): merge into {into} (integration branch)")
    merged = merge_into_worktree(landing, branch, f"merge {branch} into {into}")
    if not merged.ok:
        data.pop("integration_merge", None)
        return blocked(f"the merge into {into} conflicts ({', '.join(merged.conflicts) or '-'})")
    print(f"merged {branch} into {into} with --no-ff (integration branch)")
    return 0


def finish_before_merge(main: Path, worktree: Path, task_dir: Path, task_rel: str, data: dict, tier: str,
                        *, want_pr: bool, save, auto_merge_max_lines: int | None = None,
                        scope: tuple[str, ...] | None = None, gate=None) -> int:
    name = task_dir.name
    if data.get("execution_binding"):
        return finish_product(main, task_dir, data, tier, want_pr=want_pr, save=save)
    lessons_rel, lessons, added = record_lessons(worktree, task_dir, data)
    if added:
        print(f"lessons: +{added} row(s) in {lessons_rel}")
    scorecard_written = write_scorecard(main, task_dir, data, tier, lessons)
    if scorecard_written:
        print(f"scorecard: {task_dir / SCORECARD}")
    spec_rels = [r for r in (lessons_rel, f"{DIR_WORKFLOW}/spec/.gitattributes") if (worktree / r).is_file()]
    if commit_paths(worktree, [task_rel, *spec_rels], f"arbor({name}): scorecard"):
        print(f"committed on {data['branch']}: arbor({name}): scorecard")
    base = base_branch_of(main, data)
    if data.get("integration_target") and not want_pr:
        return merge_into_integration(main, worktree, task_dir, task_rel, data, save=save, scope=scope, gate=gate)
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
    elif auto_merge_max_lines is not None:
        why, lines = auto_merge_blocked(main, data["branch"], base, auto_merge_max_lines)
        if why is None:
            why, files = merge_checks(worktree, task_rel, data, base, scope)
            if files:
                why += ": " + ", ".join(files[:10])
        if why is None:
            # Recorded and committed on the task branch first, so the merge commit carries it
            # and the worktree stays clean for the cleanup.
            data["auto_merge"] = {"ts": utc_now(), "base": base, "lines": lines, "max_lines": auto_merge_max_lines}
            save()
            commit_paths(worktree, task_rel, f"arbor({name}): auto-merge into {base} (mandate merge=auto, {lines} lines)")
            why = merge_no_ff(main, data["branch"])
            if why is None:
                print(f"merged {data['branch']} into {base} with --no-ff (mandate merge=auto, {lines} lines)")
                return 0
        print(f"auto-merge skipped: {why}")
    print(f"before merging: {spec_reminder(across_from_scorecard(task_dir))}")
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
        # The checkout of the target branch: the merged copy of the task lives there.
        "landing": str(ig.checkout_of(main, base) or main),
        "integration_parent": (data.get("integration_target") or {}).get("parent"),
        # An integrated parent: the children its integration branch carried.
        "children": [{"task": m.get("task"), "summary": m.get("summary")}
                     for m in (data.get("integration") or {}).get("merged") or []],
    }


def _script(main: Path, script: str, *args: str, cwd: Path | None = None) -> tuple[int, str]:
    proc = subprocess.run(
        [sys.executable, str(main / DIR_WORKFLOW / "scripts" / script), *args],
        cwd=cwd or main, capture_output=True, text=True, encoding="utf-8", errors="replace",
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

    landing = Path(record.get("landing") or main)
    merged_copy = landing / DIR_WORKFLOW / DIR_TASKS / name
    if "state" not in done:
        path = merged_copy / FILE_TASK_JSON
        if path.is_file():
            data, reason = read_json_checked(path)
            if data is None:
                raise FinishError(f"cannot read {path}: {reason}")
            data["state"], data["step"] = "DONE", "done"
            data.pop("decision", None)
            if isinstance(data.get("integration"), dict):
                data["integration"]["cleaned"] = utc_now()
                data["integration"]["merge_commit"] = record["merge_commit"]
            if not write_json(path, data):
                raise FinishError(f"failed to write {path}")
        mark("state")

    if "archive" not in done:
        if merged_copy.is_dir():
            rc, out = _script(main, "task.py", "archive", name, cwd=landing)
            if rc != 0:
                raise FinishError(f"task.py archive {name} failed:\n{out}")
        mark("archive")

    if "pointer" not in done:
        for task_path in (Path(record["worktree_path"]) / DIR_WORKFLOW / DIR_TASKS / name, merged_copy):
            clear_task_from_sessions(str(task_path), main)
        mark("pointer")

    if "journal" not in done and record.get("integration_parent"):
        # The baseline stays untouched until a human merges the integration
        # branch; the parent writes one journal entry for all its children then.
        parent = main / DIR_WORKFLOW / DIR_TASKS / record["integration_parent"]
        try:
            ig.record_merged(parent, {"task": name, "title": record["title"], "tip": record["tip"],
                                      "merge_commit": record["merge_commit"], "summary": record["summary"]})
        except ig.IntegrationError as e:
            raise FinishError(str(e)) from e
        mark("journal")

    if "journal" not in done:
        short = record["merge_commit"][:12]
        children = [arg for m in record.get("children") or [] for arg in ("--change", f"{m['task']}: {m['summary']}")]
        rc, out = _script(
            main, "add_session.py", "--title", record["title"], "--commit", record["merge_commit"],
            "--summary", record["summary"], "--branch", record["base_branch"],
            "--change", f"Merged {record['branch']} into {record['base_branch']} ({short})",
            *children,
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
