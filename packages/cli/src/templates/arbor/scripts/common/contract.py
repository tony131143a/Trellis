"""
Contract: the task's acceptance contract (``contract.md``) — parse, validate, hash.

``contract.md`` is what a human approves: the goal and the checks that say
when it is reached. After approval its hash is recorded in ``task.json``.

Sections (``## `` headings). Order is free; optional sections may be absent.

    ## Goal                 one paragraph
    ## Scope                "- in: …" / "- out: …" bullets (free text allowed)
    ## Acceptance criteria  "- AC-1: Given … When … Then …"
    ## Verification map     table: | id | kind | check | file | [repo |]
                            kind = auto | manual; auto → check is a shell command;
                            repo = where it runs (absent/empty: the task's repo)
    ## Interface pins       bullets; may be the single line "existing interfaces"

Other sections (e.g. the Partitions / Waves of arbor < 1.0) are ignored.

Parsing is markdown-light: ``## `` headings (case-insensitive), ``- ``
bullets, and the one Verification map table. HTML comments are ignored.
"""

from __future__ import annotations

import functools
import hashlib
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Sequence

CONTRACT_FILE = "contract.md"
LEGACY_CONTRACT_FILE = "prd.md"

CRITERION_ID_PATTERN = r"^AC-\d+$"


class ContractError(ValueError):
    """Raised when contract.md cannot be parsed into a Contract."""


@dataclass(frozen=True)
class Criterion:
    id: str
    text: str


@dataclass(frozen=True)
class MapEntry:
    id: str
    kind: Literal["auto", "manual"]
    check: str
    file: str | None = None
    repo: str = ""  # "": the task's default repo


@dataclass(frozen=True)
class Contract:
    path: Path
    goal: str
    scope_in: tuple[str, ...]
    scope_out: tuple[str, ...]
    criteria: tuple[Criterion, ...]
    verification_map: tuple[MapEntry, ...]
    interface_pins: tuple[str, ...]

    def auto_checks(self) -> tuple[MapEntry, ...]:
        return tuple(e for e in self.verification_map if e.kind == "auto")

    def criterion_ids(self) -> tuple[str, ...]:
        return tuple(c.id for c in self.criteria)


def find_contract(task_dir: Path) -> Path | None:
    """``contract.md`` in the task dir, else the legacy ``prd.md``, else None."""
    for name in (CONTRACT_FILE, LEGACY_CONTRACT_FILE):
        candidate = task_dir / name
        if candidate.is_file():
            return candidate
    return None


_COMMENT_RE = re.compile(r"<!--.*?-->", re.DOTALL)
_SECTION_RE = re.compile(r"^##(?!#)\s*(.*?)\s*:?\s*$")
_BULLET_RE = re.compile(r"^\s*[-*]\s+(.*?)\s*$")
_TABLE_SEPARATOR_RE = re.compile(r"^:?-+:?$")
_MAP_COLUMNS = ("id", "kind", "check", "file", "repo")


def _sections(text: str) -> tuple[list[str], dict[str, list[str]]]:
    """(lines before the first ``## `` heading, {lower-cased heading: lines})."""
    preamble: list[str] = []
    sections: dict[str, list[str]] = {}
    current = preamble
    for line in _COMMENT_RE.sub("", text).splitlines():
        match = _SECTION_RE.match(line)
        if match:
            current = sections.setdefault(match.group(1).lower(), [])
        else:
            current.append(line)
    return preamble, sections


def _first_paragraph(lines: list[str]) -> str:
    paragraph: list[str] = []
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("#"):
            stripped = ""
        if stripped:
            paragraph.append(stripped)
        elif paragraph:
            break
    return "\n".join(paragraph)


def _unquote(value: str) -> str:
    """Strip whitespace and one wrapping code span (`` `x` `` or ``` ``x`` ```)."""
    value = value.strip()
    for fence in ("``", "`"):
        inner = value[len(fence):-len(fence)]
        if (
            len(value) > 2 * len(fence)
            and value.startswith(fence)
            and value.endswith(fence)
            and fence not in inner
        ):
            return inner.strip()
    return value


def _bullets(lines: list[str]) -> list[str]:
    """Bullet texts. A bullet indented no deeper than the first one starts an
    item; a deeper line (a nested bullet too) continues the previous item."""
    items: list[str] = []
    base: int | None = None
    for line in lines:
        indent = len(line) - len(line.lstrip())
        match = _BULLET_RE.match(line)
        if match and (base is None or indent <= base):
            base = indent if base is None else base
            items.append(match.group(1))
        elif items and indent > (base or 0) and line.strip():
            items[-1] = f"{items[-1]} {line.strip()}"
    return [item for item in items if item]


_LABEL_SEP_RE = re.compile(r"[:：]")


def _split_labelled(item: str, section: str) -> tuple[str, str]:
    """``"<label>: <rest>"`` → (label, rest); a full-width ``：`` also
    separates. ContractError without a colon."""
    match = _LABEL_SEP_RE.search(item)
    if not match or not item[:match.start()].strip():
        raise ContractError(f"{section}: expected '- <name>: …' (ASCII or full-width colon), got {item!r}")
    return _unquote(item[:match.start()]), item[match.end():].strip()


def _table_cells(line: str) -> list[str]:
    """Split one ``| a | b |`` row; ``|`` inside a code span or escaped stays."""
    cells: list[str] = []
    current: list[str] = []
    in_code = False
    index = 0
    while index < len(line):
        char = line[index]
        if char == "\\" and index + 1 < len(line) and line[index + 1] == "|":
            current.append("|")
            index += 2
            continue
        if char == "`":
            in_code = not in_code
        if char == "|" and not in_code:
            cells.append("".join(current))
            current = []
        else:
            current.append(char)
        index += 1
    cells.append("".join(current))
    stripped = line.strip()
    if stripped.startswith("|"):
        cells = cells[1:]
    if stripped.endswith("|") and cells:
        cells = cells[:-1]
    return [cell.strip() for cell in cells]


def _parse_map(lines: list[str]) -> tuple[MapEntry, ...]:
    rows = [line for line in lines if line.strip().startswith("|")]
    if not rows:
        return ()
    header = [cell.lower() for cell in _table_cells(rows[0])]
    missing = [name for name in _MAP_COLUMNS[:3] if name not in header]
    if missing:
        raise ContractError(
            f"Verification map: header row lacks column(s) {', '.join(missing)} "
            f"(expected | id | kind | check | file |)"
        )
    if len(rows) < 2 or not all(_TABLE_SEPARATOR_RE.match(c) for c in _table_cells(rows[1])):
        raise ContractError("Verification map: second table row must be the |---| separator")
    column = {name: header.index(name) for name in _MAP_COLUMNS if name in header}

    entries: list[MapEntry] = []
    for row in rows[2:]:
        cells = _table_cells(row)
        if not any(cells):
            continue
        if len(cells) != len(header):
            raise ContractError(
                f"Verification map: row has {len(cells)} cells, header has "
                f"{len(header)}: {row.strip()}"
            )
        entry_id = _unquote(cells[column["id"]])
        kind = cells[column["kind"]].strip().lower()
        if kind not in ("auto", "manual"):
            raise ContractError(
                f"Verification map: {entry_id} has kind {kind!r} (expected auto or manual)"
            )
        file = _unquote(cells[column["file"]]) if "file" in column else ""
        check = _unquote(cells[column["check"]])
        repo = _unquote(cells[column["repo"]]) if "repo" in column else ""
        entries.append(MapEntry(entry_id, kind, check, file or None, repo))  # type: ignore[arg-type]
    return tuple(entries)


def parse_contract(text: str, path: Path) -> Contract:
    """Parse contract.md text. Tolerant of section order; raises ContractError
    only when a section's syntax is unreadable (not when it is missing).
    A legacy prd.md without the v2 sections parses to a Contract with empty
    criteria/map so callers can report "no contract" cleanly."""
    preamble, sections = _sections(text)

    goal_lines = sections.get("goal")
    goal = "\n".join(line.strip() for line in goal_lines).strip() if goal_lines else ""
    if goal_lines is None:
        goal = _first_paragraph(preamble)

    scope_in: list[str] = []
    scope_out: list[str] = []
    for item in _bullets(sections.get("scope", [])):
        label, sep, rest = item.partition(":")
        if sep and label.strip().lower() == "out":
            scope_out.append(rest.strip())
        elif sep and label.strip().lower() == "in":
            scope_in.append(rest.strip())
        else:
            scope_in.append(item)

    criteria = tuple(
        Criterion(*_split_labelled(item, "Acceptance criteria"))
        for item in _bullets(sections.get("acceptance criteria", []))
    )

    return Contract(
        path=path,
        goal=goal,
        scope_in=tuple(scope_in),
        scope_out=tuple(scope_out),
        criteria=criteria,
        verification_map=_parse_map(sections.get("verification map", [])),
        interface_pins=tuple(_bullets(sections.get("interface pins", []))),
    )


def load_contract(path: Path) -> Contract:
    return parse_contract(path.read_text(encoding="utf-8"), path)


def validate_contract(contract: Contract) -> list[str]:
    """Structural checks run before approval. Returns human readable error
    strings; empty list = valid.

    Rules:
      - at least one criterion; ids match CRITERION_ID_PATTERN and are unique
      - every criterion has >= 1 map entry; every map entry names a criterion
      - auto entries have a non-empty check (their ``file`` may not exist yet:
        a node creates it)
    """
    errors: list[str] = []

    ids = contract.criterion_ids()
    if not ids:
        errors.append(
            "Acceptance criteria: none (add at least one '- AC-1: Given … When … Then …')"
        )
    seen: set[str] = set()
    for criterion_id in ids:
        if not re.match(CRITERION_ID_PATTERN, criterion_id):
            errors.append(f"Acceptance criteria: id {criterion_id!r} does not match AC-<number>")
        if criterion_id in seen:
            errors.append(f"Acceptance criteria: duplicate id {criterion_id}")
        seen.add(criterion_id)

    mapped = {entry.id for entry in contract.verification_map}
    for criterion_id in dict.fromkeys(ids):
        if criterion_id not in mapped:
            errors.append(f"Verification map: {criterion_id} has no entry")
    for entry in contract.verification_map:
        if entry.id not in seen:
            errors.append(f"Verification map: entry {entry.id} names no acceptance criterion")
        if entry.kind == "auto" and not entry.check:
            errors.append(f"Verification map: {entry.id} is auto but its check is empty")

    return errors


_GLOB_CHARS = "*?"


def paths_overlap(a: Sequence[str], b: Sequence[str]) -> bool:
    """Whether two glob sets may name a common path: one literal prefix
    (the pattern up to its first glob character) starts the other."""
    for x in a:
        for y in b:
            px, py = _literal_prefix(x), _literal_prefix(y)
            if px.startswith(py) or py.startswith(px):
                return True
    return False


def _literal_prefix(pattern: str) -> str:
    """The pattern up to its first glob character."""
    pattern = _normalize(pattern)
    cut = min((i for i, c in enumerate(pattern) if c in _GLOB_CHARS), default=len(pattern))
    return pattern[:cut]


def _normalize(rel: str) -> str:
    return rel.strip().removeprefix("./")


def contract_hash(path: Path) -> str:
    """sha256 hex digest of the file bytes (what task.json freezes)."""
    return hashlib.sha256(path.read_bytes()).hexdigest()


def path_matches(rel_posix: str, patterns: Sequence[str]) -> bool:
    """Glob match with ``**`` support against a repo-relative posix path."""
    rel = _normalize(rel_posix)
    return any(_glob_regex(_normalize(p)).fullmatch(rel) for p in patterns if p.strip())


@functools.lru_cache(maxsize=256)
def _glob_regex(pattern: str) -> re.Pattern[str]:
    """``**`` spans directories, ``*`` / ``?`` stay within one segment; a
    pattern ending in ``/`` or ``/**`` also matches the directory itself."""
    if pattern.endswith("/"):
        pattern += "**"
    parts: list[str] = []
    index = 0
    while index < len(pattern):
        if pattern.startswith("**/", index):
            parts.append("(?:.*/)?")
            index += 3
        elif pattern.startswith("/**", index) and index + 3 == len(pattern):
            parts.append("(?:/.*)?")
            index += 3
        elif pattern.startswith("**", index):
            parts.append(".*")
            index += 2
        elif pattern[index] == "*":
            parts.append("[^/]*")
            index += 1
        elif pattern[index] == "?":
            parts.append("[^/]")
            index += 1
        else:
            parts.append(re.escape(pattern[index]))
            index += 1
    return re.compile("".join(parts))


def default_contract_content(title: str, description: str | None = None) -> str:
    """The contract.md written by ``arbor.py new``."""
    goal = (description or "").strip() or "<one paragraph: what changes and why>"
    return CONTRACT_TEMPLATE.format(title=title.strip(), goal=goal)


CONTRACT_TEMPLATE = """# {title}

## Goal

{goal}

## Scope

- in: <what this task changes>
- out: <what it deliberately leaves alone>

## Acceptance criteria

- AC-1: Given <precondition> When <action> Then <observable result>

## Verification map

| id   | kind   | check                                   | file |
|------|--------|-----------------------------------------|------|
| AC-1 | auto   | `<command that fails before, passes after>` | <test file path> |

<!-- optional last column | repo |: the package whose integration branch runs the check (empty: the task's repo) -->

## Interface pins

<!-- optional; signatures, paths, CLI / HTTP shapes the design fixes up front -->
"""
