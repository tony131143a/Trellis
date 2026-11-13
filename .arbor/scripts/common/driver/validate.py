"""
Fail-closed reply validation, finding ids and the mechanical prefilter.

Report formats come from ``.arbor/agents/<role>.md``:

    review     first line PASS | FAIL, then a JSON array of findings, each with a
               verdict (CONFIRMED | PLAUSIBLE | REFUTED)
    implement  "## Implementation Complete | Partial | Blocked"
    fix        "## Fix: Done | Partial | Blocked"; no commit is fine only when
               every finding was skipped
    simplify   "## Simplify: Changed | No Change"; No Change needs no commit
    explore    "## Explore Results"

Rules: an empty reply fails. A review without an explicit first-line verdict
or valid findings array fails (never read as PASS).

A CONFIRMED finding of a candidates or sweep review carries a ``repro``: ``{"kind": "exec", "path":
<file under <task>/research/repro/>, "command": <run from the worktree root>,
...}`` or ``{"kind": "trace", "path": [<file:line>, <file:line>, ...]}``.
:func:`check_repros` (it needs the worktree) reads a CONFIRMED entry without a
valid one as PLAUSIBLE; that is an observation, never a failed reply.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path

from ..git import run_git

FINDING_VERDICTS = ("CONFIRMED", "PLAUSIBLE", "REFUTED")
FINDING_KEYS = ("file", "line", "summary", "verdict")
PREFILTER_SLACK = 5
# Angles whose `file` is a planning artifact, not code in the Range.
NON_DIFF_ANGLES = ("acceptance", "plan")

_EMPHASIS = "*_`# \t"
_REVIEW_VERDICT_RE = re.compile(r"^(PASS|FAIL)\b")
_JSON_BLOCK_RE = re.compile(r"```(?:json)?\s*\n(.*?)\n\s*```", re.DOTALL)
_STATUS_LINE_RE = {
    "implement": re.compile(r"^##\s*Implementation\s+(Complete|Partial|Blocked)\b", re.IGNORECASE),
    "fix": re.compile(r"^##\s*Fix:\s*(Done|Partial|Blocked)\b", re.IGNORECASE),
    "simplify": re.compile(r"^##\s*Simplify:\s*(Changed|No Change)\b", re.IGNORECASE),
    "explore": re.compile(r"^##\s*Explore Results\b", re.IGNORECASE),
}
_RULE_FILE_RE = re.compile(r"(\.arbor/spec/[\w./-]+\.md)")
_NO_COMMIT_VIOLATION = "produced no new commit"
REPRO_DIR = "research/repro/"
REPRO_TRACE_MIN = 2
_TRACE_REF_RE = re.compile(r"^(.+?):(\d+)$")


@dataclass
class ReplyCheck:
    ok: bool
    problem: str | None = None
    verdict: str | None = None  # review: PASS | FAIL; writers: their status word
    confidence: str = "high"
    findings: list[dict] = field(default_factory=list)
    downgraded: list[str] = field(default_factory=list)  # review: CONFIRMED ids read as PLAUSIBLE
    repros: dict = field(default_factory=dict)  # review: CONFIRMED id -> normalised repro


def first_line(reply: str) -> str:
    for line in reply.splitlines():
        if line.strip():
            return line.strip()
    return ""


def extract_json_list(reply: str) -> list | None:
    """The first JSON array in a fenced block, else the outermost ``[...]``."""
    candidates = [m.group(1) for m in _JSON_BLOCK_RE.finditer(reply)]
    start, end = reply.find("["), reply.rfind("]")
    if start != -1 and end > start:
        candidates.append(reply[start:end + 1])
    for text in candidates:
        try:
            value = json.loads(text)
        except ValueError:
            continue
        if isinstance(value, list):
            return value
    return None


def _schema_ok(findings: list, verdicts: tuple[str, ...]) -> bool:
    return all(
        isinstance(f, dict)
        and all(k in f for k in FINDING_KEYS)
        and isinstance(f["file"], str) and bool(f["file"].strip())
        and type(f["line"]) is int and f["line"] > 0
        and isinstance(f["summary"], str) and bool(f["summary"].strip())
        and str(f.get("verdict", "")).upper() in verdicts
        for f in findings
    )


def finding_id(finding: dict) -> str:
    """Stable-enough id: ``file:line:`` + the first 40 chars of the summary
    (the review role defines no id of its own)."""
    summary = " ".join(str(finding.get("summary", "")).split())[:40]
    return f"{finding.get('file', '?')}:{finding.get('line', '?')}:{summary}"


def check_reply(role: str, reply: str) -> ReplyCheck:
    if not reply.strip():
        return ReplyCheck(False, "empty reply")

    if role == "review":
        verdict_match = _REVIEW_VERDICT_RE.match(first_line(reply).strip(_EMPHASIS))
        findings = extract_json_list(reply)
        confidence = "high" if findings is not None and _schema_ok(findings, FINDING_VERDICTS) else "low"
        findings = [f for f in (findings or []) if isinstance(f, dict)]
        if verdict_match is None:
            return ReplyCheck(False, "review reply does not start with PASS or FAIL; "
                              "put your explicit verdict on the first line, then one JSON findings array. "
                              "Correct the report using your existing review; do not repeat the review.",
                              "FAIL", "low", findings)
        verdict = verdict_match.group(1)
        if confidence == "low":
            return ReplyCheck(False, "review reply needs a valid JSON findings array; each finding requires "
                              "a non-empty file and summary, a positive integer line and a supported verdict. "
                              "Use [] only when there are no findings. Correct the report without repeating the review.",
                              verdict, "low", findings)
        if verdict == "PASS" and any(
            str(f.get("verdict", "")).upper() in ("CONFIRMED", "PLAUSIBLE") for f in findings
        ):
            return ReplyCheck(True, "PASS contradicts the listed findings; read as FAIL", "FAIL", "low", findings)
        return ReplyCheck(True, None, verdict, confidence, findings)

    status_re = _STATUS_LINE_RE.get(role)
    if status_re is None:
        return ReplyCheck(True)
    match = status_re.match(first_line(reply))
    if match is None:
        return ReplyCheck(True, f"{role} reply lacks its status line", None, "low")
    return ReplyCheck(True, None, match.group(1).title() if match.lastindex else None)


def _section(reply: str, title: str) -> list[str]:
    """Lines of the ``### <title>`` section."""
    lines: list[str] = []
    inside = False
    for line in reply.splitlines():
        if line.startswith("### "):
            inside = line[4:].strip().lower().startswith(title.lower())
            continue
        if line.startswith("## "):
            inside = False
        if inside and line.strip():
            lines.append(line.strip())
    return lines


def no_commit_allowed(role: str, reply: str, check: ReplyCheck) -> bool:
    """simplify "No Change", or fix with every finding skipped."""
    if role == "simplify":
        return check.verdict == "No Change"
    if role == "fix":
        items = [l for l in _section(reply, "Findings") if "->" in l]
        return bool(items) and all(re.search(r"->\s*skipped", l, re.IGNORECASE) for l in items)
    return False


def adjust_violations(role: str, violations: list[str], reply: str, check: ReplyCheck) -> list[str]:
    """Drop the invariant hits the role file explicitly allows."""
    return [v for v in violations if not (_NO_COMMIT_VIOLATION in v and no_commit_allowed(role, reply, check))]


def implement_unfinished(violations: list[str], check: ReplyCheck) -> bool:
    """An implement report that must not count as done: Blocked, or no commit."""
    return (str(check.verdict or "").capitalize() == "Blocked"
            or any(_NO_COMMIT_VIOLATION in v for v in violations))


def only_missing_commit(violations: list[str]) -> bool:
    """A writer that made no commit failed; it did not break a boundary."""
    return bool(violations) and all(_NO_COMMIT_VIOLATION in v for v in violations)


# =============================================================================
# Mechanical prefilter (REVIEW, after the readers)
# =============================================================================


def changed_lines(worktree: Path, range_spec: str, rel_path: str) -> list[tuple[int, int]]:
    """New-side line spans ``[start, end]`` that ``range_spec`` changed in a file."""
    rc, out, _ = run_git(["diff", "-U0", "--no-color", range_spec, "--", rel_path], cwd=worktree)
    spans: list[tuple[int, int]] = []
    if rc != 0:
        return spans
    for m in re.finditer(r"^@@ -\S+ \+(\d+)(?:,(\d+))? @@", out, re.MULTILINE):
        start, count = int(m.group(1)), int(m.group(2) or "1")
        spans.append((start, start + max(count, 1) - 1))
    return spans


def prefilter(findings: list[dict], worktree: Path, range_spec: str) -> tuple[list[dict], list[tuple[dict, str]]]:
    """(kept, [(dropped, reason)]). A finding survives when its file exists,
    its line (±5) touches a hunk of ``range_spec`` (acceptance / plan
    findings are exempt) and every rule file it cites exists."""
    kept: list[dict] = []
    dropped: list[tuple[dict, str]] = []
    spans_cache: dict[str, list[tuple[int, int]]] = {}
    for f in findings:
        rel = str(f.get("file", "")).strip().removeprefix("./")
        angle = str(f.get("angle", "")).strip().lower()
        if not rel or not (worktree / rel).is_file():
            dropped.append((f, f"file {rel or '?'} does not exist"))
            continue
        try:
            line = int(f.get("line", ""))
        except (TypeError, ValueError):
            dropped.append((f, "no line number"))
            continue
        if angle not in NON_DIFF_ANGLES:
            spans = spans_cache.setdefault(rel, changed_lines(worktree, range_spec, rel))
            if not any(s - PREFILTER_SLACK <= line <= e + PREFILTER_SLACK for s, e in spans):
                dropped.append((f, f"{rel}:{line} is not within {PREFILTER_SLACK} lines of a change in {range_spec}"))
                continue
        cited = _RULE_FILE_RE.findall(f"{f.get('evidence', '')} {f.get('summary', '')}")
        missing = [c for c in cited if not (worktree / c).is_file()]
        if missing:
            dropped.append((f, f"cited rule file(s) missing: {', '.join(missing)}"))
            continue
        if angle == "conventions" and not cited:
            dropped.append((f, "conventions finding cites no rule file"))
            continue
        kept.append(f)
    return kept, dropped


def dedup(findings: list[dict]) -> list[dict]:
    """One finding per id; a CONFIRMED copy wins over the others (first seen otherwise)."""
    seen: dict[str, dict] = {}
    for f in findings:
        fid = finding_id(f)
        if fid not in seen or (str(f.get("verdict", "")).upper() == "CONFIRMED"
                               and str(seen[fid].get("verdict", "")).upper() != "CONFIRMED"):
            seen[fid] = f
    return list(seen.values())


# =============================================================================
# Review repros
# =============================================================================


def repro_problem(repro: object, worktree: Path, task_rel: str) -> tuple[str | None, dict | None]:
    """(problem, normalised repro): exactly one of the two is None."""
    if not isinstance(repro, dict):
        return "no repro", None
    kind = repro.get("kind")
    if kind == "exec":
        raw, command = repro.get("path"), repro.get("command")
        if not isinstance(raw, str) or not raw.strip():
            return "exec repro without a path", None
        rel = raw.strip().removeprefix("./")
        prefix = f"{task_rel.strip('/')}/{REPRO_DIR}"
        if rel.startswith(REPRO_DIR):
            rel = f"{task_rel.strip('/')}/{rel}"
        if not rel.startswith(prefix) or ".." in rel.split("/"):
            return f"exec repro path {raw} is not under {prefix}", None
        if not (worktree / rel).is_file():
            return f"exec repro {rel} does not exist", None
        if not isinstance(command, str) or not command.strip():
            return "exec repro without a command", None
        return None, {"kind": "exec", "path": rel, "command": command.strip()}
    if kind == "trace":
        steps = repro.get("path")
        if not isinstance(steps, list) or len(steps) < REPRO_TRACE_MIN:
            return f"trace repro needs at least {REPRO_TRACE_MIN} file:line steps", None
        for step in steps:
            match = _TRACE_REF_RE.match(step.strip()) if isinstance(step, str) else None
            if match is None or not (worktree / match.group(1)).is_file():
                return f"trace step {step!r} is not an existing file:line", None
        return None, {"kind": "trace", "path": [s.strip() for s in steps]}
    return f"unknown repro kind {kind!r}", None


def check_repros(check: ReplyCheck, worktree: Path, task_rel: str) -> ReplyCheck:
    """Read every CONFIRMED review finding without a valid repro as PLAUSIBLE
    (in place, so the state table and the scorecard agree); collect the
    normalised repros of the rest."""
    for finding in check.findings:
        if str(finding.get("verdict", "")).upper() != "CONFIRMED":
            continue
        problem, repro = repro_problem(finding.get("repro"), worktree, task_rel)
        fid = finding_id(finding)
        if repro is not None:
            check.repros[fid] = repro
            continue
        finding["verdict"] = "PLAUSIBLE"
        finding["downgraded_from"] = "CONFIRMED"
        finding["repro_problem"] = problem
        check.downgraded.append(fid)
    return check
