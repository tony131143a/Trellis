"""
Spec change traceability.

Two halves of one question — "which task last changed this spec doc?":

* ``derive_spec_changes`` runs at ``task.py archive`` time and works out the
  spec files a task touched from git history, so the answer is recorded on
  the archived ``task.json`` (``spec_changes`` / ``spec_changes_source``).
* ``collect_provenance`` reads those records back for ``spec.py lint
  --provenance``.

Derivation is advisory: every failure is returned as a warning string, never
raised, so a broken git or a missing ``createdAt`` can never block archive.
"""

from __future__ import annotations

from pathlib import Path

from .git import branch_exists_locally, run_git
from .io import read_json
from .paths import DIR_ARCHIVE, DIR_SPEC, DIR_TASKS, DIR_WORKFLOW, FILE_TASK_JSON

SPEC_PREFIX = f"{DIR_WORKFLOW}/{DIR_SPEC}/"

SOURCE_NONE = "none"
SOURCE_MANUAL = "manual"
SOURCE_BRANCH_DIFF = "branch-diff"
SOURCE_SINCE_CREATED = "since-created"
SOURCE_MIXED = "mixed"


class _DerivationError(Exception):
    """Git could not answer; carries the warning text for the caller."""


def normalize_spec_path(raw: str) -> str | None:
    """Reduce a path to its repo-relative ``.arbor/spec/...`` POSIX form.

    git prints paths relative to the git top-level, which may sit above the
    Arbor root; the part from ``.arbor/spec/`` onward is what task.json
    stores. Returns None for anything outside the spec tree.
    """
    posix = raw.strip().replace("\\", "/")
    idx = posix.find(SPEC_PREFIX)
    if idx < 0:
        return None
    rel = posix[idx:]
    return rel if len(rel) > len(SPEC_PREFIX) else None


def manual_spec_changes(data: dict) -> list[str]:
    """Spec paths already recorded on a task (via ``add-spec-change``)."""
    raw = data.get("spec_changes")
    if not isinstance(raw, list):
        return []
    out: list[str] = []
    for item in raw:
        if isinstance(item, str):
            rel = normalize_spec_path(item)
            if rel and rel not in out:
                out.append(rel)
    return out


def _spec_paths_from_git_output(stdout: str) -> list[str]:
    paths: list[str] = []
    for line in stdout.splitlines():
        rel = normalize_spec_path(line)
        if rel and rel not in paths:
            paths.append(rel)
    return paths


def _git_or_raise(args: list[str], repo_root: Path, what: str) -> str:
    rc, out, err = run_git(args, cwd=repo_root)
    if rc != 0:
        detail = (err or out).strip().splitlines()
        reason = detail[0] if detail else f"exit {rc}"
        raise _DerivationError(f"{what} failed: {reason}")
    return out


def _fork_point_of_merged_branch(base: str, tip: str, repo_root: Path) -> str | None:
    """Return where ``tip`` forked from ``base`` when ``base`` already merged it.

    Once the branch is merged, ``merge-base base tip`` is ``tip`` itself. The
    oldest merge commit on ``base`` whose second parent contains ``tip`` is
    the one that brought the branch in; its first parent is ``base`` as it
    stood before the merge, so ``merge-base <merge>^1 tip`` is the original
    fork point. Returns ``None`` for a fast-forward merge (no merge commit).
    """
    merges = _git_or_raise(
        ["rev-list", "--merges", "--ancestry-path", "--reverse", f"{tip}..{base}"],
        repo_root,
        f"git rev-list --merges {tip}..{base}",
    ).split()
    for merge in merges:
        rc, _, _ = run_git(
            ["merge-base", "--is-ancestor", tip, f"{merge}^2"], cwd=repo_root
        )
        if rc == 0:
            fork = _git_or_raise(
                ["merge-base", f"{merge}^1", tip],
                repo_root,
                f"git merge-base {merge}^1 {tip}",
            ).strip()
            return fork or None
    return None


def _derive_from_git(data: dict, repo_root: Path) -> tuple[list[str], str]:
    branch = str(data.get("branch") or "").strip()
    base = str(data.get("base_branch") or "").strip()

    if branch and base and branch != base:
        # Prefer the recorded branch ref when it still exists: after a merge
        # HEAD may already be on the base branch, where `merge-base base HEAD`
        # is HEAD itself and the diff collapses to nothing.
        tip = branch if branch_exists_locally(branch, repo_root) else "HEAD"
        merge_base = _git_or_raise(
            ["merge-base", base, tip], repo_root, f"git merge-base {base} {tip}"
        ).strip()
        if not merge_base:
            raise _DerivationError(f"git merge-base {base} {tip} returned nothing")
        tip_sha = _git_or_raise(
            ["rev-parse", "--verify", f"{tip}^{{commit}}"],
            repo_root,
            f"git rev-parse {tip}",
        ).strip()
        if merge_base == tip_sha:
            # Base already contains the branch (merged before archive).
            merge_base = (
                _fork_point_of_merged_branch(base, tip, repo_root) or merge_base
            )
        diff = _git_or_raise(
            ["diff", "--name-only", merge_base, tip, "--", f"{DIR_WORKFLOW}/{DIR_SPEC}"],
            repo_root,
            "git diff --name-only",
        )
        return _spec_paths_from_git_output(diff), SOURCE_BRANCH_DIFF

    created = str(data.get("createdAt") or "").strip()
    if not created:
        raise _DerivationError("task.json has no createdAt to bound `git log --since`")
    log = _git_or_raise(
        [
            "log",
            f"--since={created}",
            "--name-only",
            "--format=",
            "--",
            f"{DIR_WORKFLOW}/{DIR_SPEC}",
        ],
        repo_root,
        "git log --since",
    )
    return _spec_paths_from_git_output(log), SOURCE_SINCE_CREATED


def derive_spec_changes(
    data: dict, repo_root: Path
) -> tuple[list[str], str, str | None]:
    """Return ``(spec_paths, source, warning)`` for a task about to be archived.

    ``source`` is one of ``branch-diff`` / ``since-created`` / ``manual`` /
    ``mixed`` / ``none``. Paths are sorted, deduplicated, repo-relative POSIX
    and may name files the task deleted. On any git failure the manual
    entries are returned unchanged with a warning; nothing is ever raised.
    """
    manual = manual_spec_changes(data)
    try:
        derived, method = _derive_from_git(data, repo_root)
    except _DerivationError as exc:
        warning = f"could not derive spec changes ({exc}); recorded manual entries only"
        return manual, (SOURCE_MANUAL if manual else SOURCE_NONE), warning
    except Exception as exc:  # advisory path: never let this reach archive
        warning = (
            f"could not derive spec changes ({type(exc).__name__}: {exc}); "
            "recorded manual entries only"
        )
        return manual, (SOURCE_MANUAL if manual else SOURCE_NONE), warning

    merged = sorted(set(manual) | set(derived))
    if manual and derived:
        source = SOURCE_MIXED
    elif manual:
        source = SOURCE_MANUAL
    else:
        source = method
    return merged, source, None


def _task_json_files(repo_root: Path) -> list[Path]:
    tasks_dir = repo_root / DIR_WORKFLOW / DIR_TASKS
    if not tasks_dir.is_dir():
        return []
    files = sorted(tasks_dir.glob(f"{DIR_ARCHIVE}/*/*/{FILE_TASK_JSON}"))
    files.extend(sorted(tasks_dir.glob(f"*/{FILE_TASK_JSON}")))
    return files


def collect_provenance(repo_root: Path) -> dict[str, list[dict]]:
    """Map each spec path to the tasks that recorded changing it.

    Reads every archived and active ``task.json``. Each entry is
    ``{"task": <dir name>, "completedAt": <date or None>, "source": <label>}``
    and lists are sorted newest first (tasks without ``completedAt`` last).
    """
    out: dict[str, list[dict]] = {}
    for task_json in _task_json_files(repo_root):
        data = read_json(task_json)
        if not isinstance(data, dict):
            continue
        entry = {
            "task": task_json.parent.name,
            "completedAt": data.get("completedAt"),
            "source": data.get("spec_changes_source") or SOURCE_NONE,
        }
        for rel in manual_spec_changes(data):
            out.setdefault(rel, []).append(dict(entry))

    for entries in out.values():
        dated = sorted(
            (e for e in entries if e["completedAt"] is not None),
            key=lambda e: str(e["completedAt"]),
            reverse=True,
        )
        undated = [e for e in entries if e["completedAt"] is None]
        entries[:] = dated + undated
    return out
