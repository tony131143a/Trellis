"""
Lessons: one row per CONFIRMED review finding of a finished task, per package.

    .arbor/spec/<package>/lessons.jsonl     (single repo: .arbor/spec/lessons.jsonl)

    {"category": <review angle>, "summary": "...", "file": "...", "task": "<task dir>",
     "date": "YYYY-MM-DD", "repro": "<task-relative exec repro path>" | null,
     "root_cause": "", "prevention": "", "check": "none", "check_ref": ""}

``arbor finish`` appends the rows of a task (idempotent: one row per task,
file and summary) and commits them with the scorecard; the main agent fills
``root_cause``, ``prevention`` and ``check`` (none | spec | test | lint) with
``check_ref`` naming the rule or test. A category is *recurring across tasks*
when rows of two or more tasks carry it and none of its rows is backed by a
test or a lint (the scorecard lists it; advisory). ``task.py seed-context``
renders the newest rows that are not backed by a test or a lint into the
task's ``research/lessons.md`` (bounded by ``SEED_LIMIT``) so the roles read
a digest, never the whole file.

Task branches append to the same file concurrently; ``.arbor/spec/.gitattributes``
marks it ``merge=union`` so their merges keep every row.
"""

from __future__ import annotations

import json
from pathlib import Path

from .config import is_monorepo, resolve_package
from .paths import DIR_SPEC, DIR_WORKFLOW

LESSONS = "lessons.jsonl"
DIGEST = "lessons.md"
MECHANICAL_CHECKS = ("test", "lint")
SEED_LIMIT = 50
GITATTRIBUTES_LINE = f"{LESSONS} merge=union"


def lessons_rel(package: str | None) -> str:
    """Repo-relative path of the package's lessons file."""
    base = f"{DIR_WORKFLOW}/{DIR_SPEC}"
    return f"{base}/{package}/{LESSONS}" if package else f"{base}/{LESSONS}"


def package_for(root: Path, task_data: dict) -> str | None:
    """The package whose lessons a task records: None in a single repo."""
    if not is_monorepo(root):
        return None
    return resolve_package(task_data.get("package"), root)


def read_rows(path: Path) -> list[dict]:
    rows: list[dict] = []
    if not path.is_file():
        return rows
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if isinstance(row, dict):
            rows.append(row)
    return rows


def _key(row: dict) -> tuple[str, str, str]:
    return (str(row.get("task")), str(row.get("file")), " ".join(str(row.get("summary", "")).split()))


def row(finding: dict, task: str, date: str) -> dict:
    repro = finding.get("repro")
    path = repro.get("path") if isinstance(repro, dict) and repro.get("kind") == "exec" else None
    if isinstance(path, str) and f"/{task}/" in path:
        path = path.split(f"/{task}/", 1)[1]  # task-relative: the task dir moves into the archive
    return {
        "category": str(finding.get("angle") or "unspecified"),
        "summary": " ".join(str(finding.get("summary", "")).split()),
        "file": str(finding.get("file", "")),
        "task": task,
        "date": date,
        "repro": path if isinstance(path, str) else None,
        "root_cause": "",
        "prevention": "",
        "check": "none",
        "check_ref": "",
    }


def append_rows(path: Path, rows: list[dict]) -> int:
    """Append the rows not yet recorded; returns how many were added."""
    seen = {_key(r) for r in read_rows(path)}
    new = []
    for r in rows:
        if _key(r) not in seen:
            seen.add(_key(r))
            new.append(r)
    if not new:
        return 0
    path.parent.mkdir(parents=True, exist_ok=True)
    text = path.read_text(encoding="utf-8") if path.is_file() else ""
    if text and not text.endswith("\n"):
        text += "\n"
    text += "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in new)
    path.write_text(text, encoding="utf-8")
    return len(new)


def ensure_union_merge(spec_dir: Path) -> bool:
    """Make ``.arbor/spec/.gitattributes`` merge lessons files with ``union``."""
    path = spec_dir / ".gitattributes"
    text = path.read_text(encoding="utf-8") if path.is_file() else ""
    if GITATTRIBUTES_LINE in text.splitlines():
        return False
    spec_dir.mkdir(parents=True, exist_ok=True)
    path.write_text(text + ("" if not text or text.endswith("\n") else "\n") + GITATTRIBUTES_LINE + "\n",
                    encoding="utf-8")
    return True


def mechanical(r: dict) -> bool:
    return str(r.get("check", "")).lower() in MECHANICAL_CHECKS


def recurring_across_tasks(rows: list[dict]) -> list[tuple[str, list[str]]]:
    """[(category, sorted task names)] for categories seen in two or more tasks
    with no row backed by a test or a lint."""
    tasks: dict[str, set[str]] = {}
    backed: set[str] = set()
    for r in rows:
        category = str(r.get("category") or "unspecified")
        tasks.setdefault(category, set()).add(str(r.get("task")))
        if mechanical(r):
            backed.add(category)
    return [(c, sorted(t)) for c, t in sorted(tasks.items()) if len(t) >= 2 and c not in backed]


def digest(rows: list[dict], limit: int = SEED_LIMIT) -> str | None:
    """Markdown digest of the newest ``limit`` rows not backed by a test or a lint."""
    open_rows = [r for r in rows if not mechanical(r)]
    if not open_rows:
        return None
    newest = sorted(open_rows, key=lambda r: str(r.get("date", "")), reverse=True)[:limit]
    lines = ["# Lessons from earlier tasks", "",
             f"Confirmed review findings not yet backed by a test or a lint (newest {len(newest)} "
             f"of {len(open_rows)}). Avoid repeating them.", ""]
    for r in newest:
        prevention = f" Prevention: {r['prevention']}" if r.get("prevention") else ""
        lines.append(f"- [{r.get('category')}] {r.get('summary')} (`{r.get('file')}`, "
                     f"{r.get('task')}).{prevention}")
    return "\n".join(lines) + "\n"
