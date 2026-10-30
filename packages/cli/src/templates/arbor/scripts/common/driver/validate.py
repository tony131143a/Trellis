"""
Fail-closed reply validation, finding ids and the mechanical prefilter.

Report formats come from ``.arbor/agents/<role>.md``:

    review     first line PASS | FAIL, then a JSON array of findings
    verify     a JSON array, one verdict per candidate (CONFIRMED | PLAUSIBLE |
               REFUTED), last line "CONFIRMED x, PLAUSIBLE y, REFUTED z."
    test       "## Tests Written | Partial | Blocked"
    implement  "## Implementation Complete | Partial | Blocked"
    fix        "## Fix: Done | Partial | Blocked"; no commit is fine only when
               every finding was skipped; regression tests are listed
    simplify   "## Simplify: Changed | No Change"; No Change needs no commit
    explore    "## Explore Results"

Rules: an empty reply fails. A review without a first-line verdict fails
(never read as PASS). A verify without per-candidate verdicts fails. JSON
that does not match the schema is passed on with ``confidence: low``.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path

from ..git import run_git

FINDING_VERDICTS = ("CONFIRMED", "PLAUSIBLE", "CANDIDATE", "REFUTED")
VERIFY_VERDICTS = ("CONFIRMED", "PLAUSIBLE", "REFUTED")
FINDING_KEYS = ("file", "line", "summary", "verdict")
PREFILTER_SLACK = 5
# Angles whose `file` is a planning artifact, not code in the Range.
NON_DIFF_ANGLES = ("acceptance", "plan")

_EMPHASIS = "*_`# \t"
_REVIEW_VERDICT_RE = re.compile(r"^(PASS|FAIL)\b")
_VERIFY_SUMMARY_RE = re.compile(
    r"CONFIRMED\s+\d+\s*,\s*PLAUSIBLE\s+\d+\s*,\s*REFUTED\s+\d+", re.IGNORECASE
)
_JSON_BLOCK_RE = re.compile(r"```(?:json)?\s*\n(.*?)\n\s*```", re.DOTALL)
_STATUS_LINE_RE = {
    "test": re.compile(r"^##\s*Tests\s+(Written|Partial|Blocked)\b", re.IGNORECASE),
    "implement": re.compile(r"^##\s*Implementation\s+(Complete|Partial|Blocked)\b", re.IGNORECASE),
    "fix": re.compile(r"^##\s*Fix:\s*(Done|Partial|Blocked)\b", re.IGNORECASE),
    "simplify": re.compile(r"^##\s*Simplify:\s*(Changed|No Change)\b", re.IGNORECASE),
    "explore": re.compile(r"^##\s*Explore Results\b", re.IGNORECASE),
}
_RULE_FILE_RE = re.compile(r"((?:[\w.-]+/)*(?:AGENTS|CLAUDE)\.md|\.arbor/spec/[\w./-]+\.md)")
_NO_COMMIT_VIOLATION = "produced no new commit"


@dataclass
class ReplyCheck:
    ok: bool
    problem: str | None = None
    verdict: str | None = None  # review: PASS | FAIL; writers: their status word
    confidence: str = "high"
    findings: list[dict] = field(default_factory=list)


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
            return ReplyCheck(False, "review reply does not start with PASS or FAIL", "FAIL", "low", findings)
        verdict = verdict_match.group(1)
        if verdict == "PASS" and any(
            str(f.get("verdict", "")).upper() in ("CONFIRMED", "PLAUSIBLE", "CANDIDATE") for f in findings
        ):
            return ReplyCheck(True, "PASS contradicts the listed findings; read as FAIL", "FAIL", "low", findings)
        return ReplyCheck(True, None, verdict, confidence, findings)

    if role == "verify":
        findings = extract_json_list(reply)
        if findings is None or not findings:
            return ReplyCheck(False, "verify reply carries no JSON verdict list", None, "low")
        entries = [f for f in findings if isinstance(f, dict)]
        if not entries or any(str(f.get("verdict", "")).upper() not in VERIFY_VERDICTS for f in entries):
            return ReplyCheck(False, "verify reply has a candidate without a CONFIRMED/PLAUSIBLE/REFUTED verdict",
                              None, "low", entries)
        confidence = "high" if _schema_ok(entries, VERIFY_VERDICTS) and _VERIFY_SUMMARY_RE.search(reply) else "low"
        return ReplyCheck(True, None, None, confidence, entries)

    status_re = _STATUS_LINE_RE.get(role)
    if status_re is None:
        return ReplyCheck(True)
    match = status_re.match(first_line(reply))
    if match is None:
        return ReplyCheck(True, f"{role} reply lacks its status line", None, "low")
    return ReplyCheck(True, None, match.group(1).title())


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


def listed_regression_tests(reply: str) -> list[str]:
    """Test files named under ``### Regression Tests Added`` of a fix report."""
    files: list[str] = []
    for line in _section(reply, "Regression Tests Added"):
        item = line.lstrip("-* ").strip().strip("`")
        if item and item.lower() != "none":
            files.append(item.split("::", 1)[0].split(" ", 1)[0].strip("`"))
    return files


def adjust_violations(role: str, violations: list[str], reply: str, check: ReplyCheck) -> list[str]:
    """Drop the invariant hits the role file explicitly allows."""
    kept: list[str] = []
    allowed_tests = set(listed_regression_tests(reply)) if role == "fix" else set()
    for v in violations:
        if _NO_COMMIT_VIOLATION in v and no_commit_allowed(role, reply, check):
            continue
        if role == "fix" and v.startswith("fix touched test paths"):
            paths = [p.strip() for p in v.split(": ", 1)[-1].split(",") if p.strip()]
            if paths and all(p in allowed_tests for p in paths):
                continue
        kept.append(v)
    return kept


def only_missing_commit(violations: list[str]) -> bool:
    """A writer that made no commit failed; it did not break a boundary."""
    return bool(violations) and all(_NO_COMMIT_VIOLATION in v for v in violations)


# =============================================================================
# Mechanical prefilter (POLISH, before verify)
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
            line = int(f.get("line"))
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
    seen: dict[str, dict] = {}
    for f in findings:
        seen.setdefault(finding_id(f), f)
    return list(seen.values())
