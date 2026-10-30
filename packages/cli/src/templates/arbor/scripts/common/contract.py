"""
Contract: the task's acceptance contract (``contract.md``) — parse, validate, hash.

``contract.md`` is the planning artifact a human approves (it replaces
``prd.md``). After approval its hash is frozen into ``task.json``; every later
phase (test, implement, gate, review) reads it.

Sections (``## `` headings). Order is free; optional sections may be absent.

    ## Goal                 one paragraph
    ## Scope                "- in: …" / "- out: …" bullets (free text allowed)
    ## Acceptance criteria  "- AC-1: Given … When … Then …"
    ## Verification map     table: | id | kind | check | file |
                            kind = auto | manual; auto → check is a shell command
    ## Interface pins       bullets; may be the single line "existing interfaces"
    ## Test paths           bullets of glob patterns (defaults come from config)
    ## Partitions           "- <name>: <glob>, <glob>"   (absent → one partition
                            "default" owning "**")
    ## Waves                "- 1: [name, name]"          (absent → one wave with
                            every partition)

This module is the shared interface for the v2 build. The signatures below
are the pins other modules import; bodies marked ``NotImplementedError`` are
filled in by the contract partition.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Sequence

CONTRACT_FILE = "contract.md"
LEGACY_CONTRACT_FILE = "prd.md"

#: A pin line that exempts a task from naming new interfaces (light tasks on
#: existing code). Case-insensitive match on the stripped bullet text.
EXISTING_INTERFACES_PIN = "existing interfaces"

DEFAULT_PARTITION = "default"

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


@dataclass(frozen=True)
class Partition:
    name: str
    paths: tuple[str, ...]


@dataclass(frozen=True)
class Contract:
    path: Path
    goal: str
    scope_in: tuple[str, ...]
    scope_out: tuple[str, ...]
    criteria: tuple[Criterion, ...]
    verification_map: tuple[MapEntry, ...]
    interface_pins: tuple[str, ...]
    test_paths: tuple[str, ...]
    partitions: tuple[Partition, ...]
    waves: tuple[tuple[str, ...], ...]

    def auto_checks(self) -> tuple[MapEntry, ...]:
        return tuple(e for e in self.verification_map if e.kind == "auto")

    def partition(self, name: str) -> Partition | None:
        for p in self.partitions:
            if p.name == name:
                return p
        return None

    def criterion_ids(self) -> tuple[str, ...]:
        return tuple(c.id for c in self.criteria)


def find_contract(task_dir: Path) -> Path | None:
    """``contract.md`` in the task dir, else the legacy ``prd.md``, else None."""
    for name in (CONTRACT_FILE, LEGACY_CONTRACT_FILE):
        candidate = task_dir / name
        if candidate.is_file():
            return candidate
    return None


def parse_contract(text: str, path: Path) -> Contract:
    """Parse contract.md text. Tolerant of section order; raises ContractError
    only when a section's syntax is unreadable (not when it is missing).
    A legacy prd.md without the v2 sections parses to a Contract with empty
    criteria/map so callers can report "no contract" cleanly."""
    raise NotImplementedError


def load_contract(path: Path) -> Contract:
    return parse_contract(path.read_text(encoding="utf-8"), path)


def validate_contract(
    contract: Contract,
    repo_root: Path,
    default_test_paths: Sequence[str],
) -> list[str]:
    """Structural checks run before approval (design §5.1). Returns human
    readable error strings; empty list = valid.

    Rules:
      - at least one criterion; ids match CRITERION_ID_PATTERN and are unique
      - every criterion has >= 1 map entry; every map entry names a criterion
      - auto entries have a non-empty check; when ``file`` is given it exists
        under repo_root or matches the effective test paths
      - interface pins non-empty, or exactly the EXISTING_INTERFACES_PIN line
      - partition names unique; partition path sets pairwise non-overlapping
        (compare literal prefixes before the first glob character)
      - every wave names existing partitions; every partition appears in
        exactly one wave
    """
    raise NotImplementedError


def contract_hash(path: Path) -> str:
    """sha256 hex digest of the file bytes (what task.json freezes)."""
    return hashlib.sha256(path.read_bytes()).hexdigest()


def effective_test_paths(contract: Contract, default_test_paths: Sequence[str]) -> tuple[str, ...]:
    """Contract ``Test paths`` when present, else the config defaults."""
    return contract.test_paths or tuple(default_test_paths)


def path_matches(rel_posix: str, patterns: Sequence[str]) -> bool:
    """Glob match with ``**`` support against a repo-relative posix path."""
    raise NotImplementedError


def default_contract_content(title: str, description: str | None = None) -> str:
    """The contract.md written by ``task.py create``."""
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

## Interface pins

- existing interfaces

## Test paths

<!-- optional; defaults come from .arbor/config.yaml test_paths -->

## Partitions

<!-- optional; absent = one partition "default" owning everything (serial) -->

## Waves

<!-- optional; absent = one wave with every partition -->
"""
