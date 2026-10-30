"""
Post-dispatch invariants, checked with git.

The driver snapshots refs before a dispatch and calls
:func:`check_after_dispatch` afterwards. Each returned string is one
violation of the role capability table; an empty list means the dispatch
stayed inside its boundary.

    role                 writes                          commits
    explore, architect   .arbor/tasks/<task>/research/** no
    test                 test paths only                 yes, own branch
    implement, simplify  anything but test paths         yes, own branch
    fix                  as implement (regression tests  yes, own branch
                         only when listed in its report)
    review, verify       nothing                         no

Every role: no push, merge, rebase or checkout of another branch; no writes
under ``.arbor/`` outside ``tasks/<task>/``.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import PurePosixPath
from typing import Sequence

from .git import run_git

READ_ONLY_ROLES: frozenset[str] = frozenset({"review", "verify"})
RESEARCH_ROLES: frozenset[str] = frozenset({"explore", "architect"})
WRITER_ROLES: frozenset[str] = frozenset({"test", "implement", "fix", "simplify"})

COMMIT_SUBJECT_RE = re.compile(
    r"^(explore|architect|test|implement|review|verify|fix|simplify)\(([^)]+)\): \S.*$"
)
TRAILER_RE = re.compile(r"^Arbor-Dispatch: d-\d{3,}$", re.MULTILINE)

ARBOR_DIR = ".arbor/"


@dataclass(frozen=True)
class RefSnapshot:
    """Refs and working-tree state of one worktree at one moment."""

    head: str | None
    head_ref: str | None  # symbolic ref HEAD points at; None when detached
    branches: dict[str, str] = field(default_factory=dict)  # local branch -> sha
    remotes: dict[str, str] = field(default_factory=dict)  # refs/remotes/... -> sha
    dirty: frozenset[str] = frozenset()  # paths `git status --porcelain` reports

    @property
    def clean(self) -> bool:
        return not self.dirty


def _git_out(args: list[str], worktree) -> str | None:
    rc, out, _ = run_git(args, cwd=worktree)
    return out if rc == 0 else None


def _dirty_paths(worktree) -> frozenset[str]:
    out = _git_out(["status", "--porcelain", "-z", "--untracked-files=all"], worktree) or ""
    paths: set[str] = set()
    entries = out.split("\0")
    i = 0
    while i < len(entries):
        entry = entries[i]
        i += 1
        if len(entry) < 4:
            continue
        status, path = entry[:2], entry[3:]
        paths.add(path)
        if "R" in status or "C" in status:
            # -z prints the rename/copy source as the next entry.
            if i < len(entries) and entries[i]:
                paths.add(entries[i])
            i += 1
    return frozenset(paths)


def snapshot_refs(worktree) -> RefSnapshot:
    """Local branch heads, remote refs, HEAD and porcelain status of ``worktree``."""
    head = (_git_out(["rev-parse", "-q", "--verify", "HEAD"], worktree) or "").strip() or None
    head_ref = (_git_out(["symbolic-ref", "-q", "HEAD"], worktree) or "").strip() or None

    branches: dict[str, str] = {}
    remotes: dict[str, str] = {}
    listing = _git_out(
        ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/remotes"],
        worktree,
    ) or ""
    for line in listing.splitlines():
        ref, _, sha = line.partition(" ")
        if ref.startswith("refs/heads/"):
            branches[ref[len("refs/heads/"):]] = sha
        elif ref.startswith("refs/remotes/"):
            remotes[ref] = sha

    return RefSnapshot(head, head_ref, branches, remotes, _dirty_paths(worktree))


def changed_files(worktree, range_spec: str) -> list[str]:
    """Paths changed in ``range_spec`` (``<a>..<b>``), renames as both sides."""
    out = _git_out(["diff", "--name-only", "--no-renames", range_spec], worktree) or ""
    return sorted({line for line in out.splitlines() if line.strip()})


def _glob_regex(pattern: str) -> str:
    pattern = pattern.strip().removeprefix("./")
    if pattern.endswith("/"):
        pattern += "**"
    out: list[str] = []
    i = 0
    while i < len(pattern):
        if pattern.startswith("**/", i):
            out.append("(?:.*/)?")
            i += 3
        elif pattern.startswith("/**", i) and i + 3 == len(pattern):
            out.append("(?:/.*)?")
            i += 3
        elif pattern.startswith("**", i):
            out.append(".*")
            i += 2
        elif pattern[i] == "*":
            out.append("[^/]*")
            i += 1
        elif pattern[i] == "?":
            out.append("[^/]")
            i += 1
        else:
            out.append(re.escape(pattern[i]))
            i += 1
    return "".join(out)


# Private stand-in for contract.path_matches; swap for it once that is implemented.
def _glob_match(rel_posix: str, patterns: Sequence[str]) -> bool:
    return any(re.fullmatch(_glob_regex(p), rel_posix) for p in patterns if p.strip())


def validate_commit(
    worktree,
    sha: str,
    *,
    role: str,
    task_name: str,
    dispatch_id: str | None,
) -> list[str]:
    """Check one writer commit's message: subject format, role and task in the
    subject, and an ``Arbor-Dispatch`` trailer (naming ``dispatch_id`` when
    given)."""
    short = sha[:12]
    message = _git_out(["log", "-1", "--format=%B", sha], worktree)
    if message is None:
        return [f"commit {short}: not found"]

    problems: list[str] = []
    subject = message.splitlines()[0] if message.strip() else ""
    match = COMMIT_SUBJECT_RE.match(subject)
    if match is None:
        problems.append(
            f"commit {short}: subject '{subject}' is not '<role>(<task>): <summary>'"
        )
    else:
        if match.group(1) != role:
            problems.append(
                f"commit {short}: subject role '{match.group(1)}' is not the dispatched role '{role}'"
            )
        if match.group(2) != task_name:
            problems.append(
                f"commit {short}: subject task '{match.group(2)}' is not '{task_name}'"
            )

    trailers = [t.split(": ", 1)[1] for t in TRAILER_RE.findall(message)]
    if not trailers:
        problems.append(f"commit {short}: missing 'Arbor-Dispatch: d-NNN' trailer")
    elif dispatch_id and dispatch_id not in trailers:
        problems.append(
            f"commit {short}: trailer names {', '.join(trailers)}, expected {dispatch_id}"
        )
    return problems


def _diff_refs(label: str, before: dict[str, str], after: dict[str, str], skip: str | None = None) -> list[str]:
    problems: list[str] = []
    for ref in sorted(set(before) | set(after)):
        if ref == skip:
            continue
        old, new = before.get(ref), after.get(ref)
        if old == new:
            continue
        if old is None:
            problems.append(f"{label} {ref} was created")
        elif new is None:
            problems.append(f"{label} {ref} was deleted")
        else:
            problems.append(f"{label} {ref} moved {old[:12]} -> {new[:12]}")
    return problems


def check_after_dispatch(
    role: str,
    before: RefSnapshot,
    worktree,
    *,
    own_branch: str,
    test_paths: Sequence[str],
    task_rel_dir: str,
    dispatch_id: str | None = None,
) -> list[str]:
    """Violations of the capability table since ``before``; empty = ok.

    ``task_rel_dir`` is the task dir relative to the worktree root
    (``.arbor/tasks/<task>``); its last segment is the task name commits must
    carry. ``dispatch_id``, when given, is the id the commit trailer must name.
    """
    after = snapshot_refs(worktree)
    task_rel_dir = task_rel_dir.strip("/")
    task_prefix = f"{task_rel_dir}/"
    task_name = PurePosixPath(task_rel_dir).name
    violations: list[str] = []

    violations += _diff_refs("remote ref", before.remotes, after.remotes)
    violations += _diff_refs("branch", before.branches, after.branches, skip=own_branch)
    if after.head_ref != before.head_ref:
        violations.append(
            f"HEAD switched from {before.head_ref or 'detached'} to {after.head_ref or 'detached'}"
        )

    own_before = before.branches.get(own_branch)
    own_after = after.branches.get(own_branch)
    new_commits: list[str] = []
    if own_before is None or own_after is None:
        violations.append(f"own branch {own_branch} is missing")
    elif own_before != own_after:
        rc, _, _ = run_git(["merge-base", "--is-ancestor", own_before, own_after], cwd=worktree)
        if rc != 0:
            violations.append(
                f"own branch {own_branch} was rewritten ({own_before[:12]} is no longer an ancestor)"
            )
        else:
            out = _git_out(["rev-list", "--reverse", f"{own_before}..{own_after}"], worktree) or ""
            new_commits = [line for line in out.splitlines() if line.strip()]

    new_dirty = sorted(after.dirty - before.dirty)
    committed = (
        changed_files(worktree, f"{own_before}..{own_after}") if new_commits else []
    )
    touched = sorted(set(committed) | set(new_dirty))

    if role in READ_ONLY_ROLES or role in RESEARCH_ROLES:
        if new_commits:
            violations.append(f"{role} must not commit ({len(new_commits)} new commit(s) on {own_branch})")
        allowed = f"{task_prefix}research/" if role in RESEARCH_ROLES else None
        stray = [p for p in new_dirty if allowed is None or not p.startswith(allowed)]
        if stray:
            violations.append(f"{role} left the tree dirty: {', '.join(stray)}")
    elif role in WRITER_ROLES:
        if own_before is not None and own_before == own_after:
            violations.append(f"{role} produced no new commit on {own_branch}")
        for sha in new_commits:
            parents = (_git_out(["rev-list", "--parents", "-n", "1", sha], worktree) or "").split()
            if len(parents) > 2:
                violations.append(f"commit {sha[:12]} is a merge commit")
            violations += validate_commit(
                worktree, sha, role=role, task_name=task_name, dispatch_id=dispatch_id
            )
        if role == "test":
            outside = [p for p in touched if not _glob_match(p, test_paths)]
            if outside:
                violations.append(f"test touched non-test paths: {', '.join(outside)}")
        else:
            inside = [p for p in touched if _glob_match(p, test_paths)]
            if inside:
                note = " (allowed only if listed in the fix report)" if role == "fix" else ""
                violations.append(f"{role} touched test paths{note}: {', '.join(inside)}")
    else:
        violations.append(f"unknown role '{role}'")

    arbor_stray = [p for p in touched if p.startswith(ARBOR_DIR) and not p.startswith(task_prefix)]
    if arbor_stray:
        violations.append(f"writes under .arbor/ outside {task_prefix}: {', '.join(arbor_stray)}")

    return violations
