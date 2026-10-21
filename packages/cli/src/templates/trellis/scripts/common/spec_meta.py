"""
Spec doc frontmatter: parse, line-level rewrite, seed block.

Spec docs under `.trellis/spec/` may open with a YAML frontmatter block that
records which code paths the doc describes and when it was last re-checked:

    ---
    sources:
      - packages/cli/src/commands/ablate.ts
    last_verified: 2026-10-21
    ---

The parser is a hand-written restricted subset (stdlib only, no PyYAML):
`key: scalar`, `key:` followed by `  - item` lines, `key: [a, b]`, blank
lines and `#` comments. Anything else is reported as an error naming the
line rather than silently ignored. Rewrites are line-level — a doc is never
re-serialized, so every byte outside the touched line stays as it was. Lines
are split on ``\n`` with any ``\r`` left in place, so a CRLF doc round-trips
byte-for-byte and a new line copies the ending of the line it follows.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

FRONTMATTER_DELIMITER = "---"
KEY_SOURCES = "sources"
KEY_LAST_VERIFIED = "last_verified"

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_KEY_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_-]*):(.*)$")
_LIST_ITEM_RE = re.compile(r"^\s*-(?:\s+(.*))?$")
_SOURCES_HEADING_RE = re.compile(r"^\s*(?:#+\s*)?\**Sources\**:?\s*$")
_BULLET_RE = re.compile(r"^\s*[-*]\s+(.*)$")
_CODE_SPAN_RE = re.compile(r"`([^`]*)`")

# How far into a doc `init-meta` looks for a prose `Sources:` bullet list.
SOURCES_SCAN_LINES = 30


@dataclass
class FrontmatterResult:
    """Parsed frontmatter.

    ``meta`` maps key -> str (scalar) or list[str] (list). ``block_span`` is
    the (open, close) pair of 0-based line indexes of the two ``---``
    delimiters, or None when the doc has no block. ``key_lines`` /
    ``item_lines`` carry 1-based line numbers so lint findings can point at
    the exact line. ``errors`` is a list of (1-based line, message).
    """

    meta: dict = field(default_factory=dict)
    block_span: tuple[int, int] | None = None
    key_lines: dict[str, int] = field(default_factory=dict)
    item_lines: dict[str, list[int]] = field(default_factory=dict)
    errors: list[tuple[int, str]] = field(default_factory=list)

    @property
    def has_block(self) -> bool:
        return self.block_span is not None


def detect_eol(text: str) -> str:
    """Line ending of the doc's first line: ``\\r\\n`` or ``\\n``."""
    idx = text.find("\n")
    return "\r\n" if idx > 0 and text[idx - 1] == "\r" else "\n"


def _cr(line: str) -> str:
    """The ``\\r`` a new line must carry to match ``line``'s ending."""
    return "\r" if line.endswith("\r") else ""


def _unquote(value: str) -> str:
    """Remove exactly one layer of matching outer quotes."""
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
        return value[1:-1]
    return value


def parse_frontmatter(text: str) -> FrontmatterResult:
    """Parse the leading frontmatter block of ``text``.

    A doc whose first line is not ``---`` has no block and parses to an
    empty result with no errors. An opening ``---`` with no closing one is an
    error at line 1.
    """
    result = FrontmatterResult()
    lines = text.split("\n")
    if not lines or lines[0].rstrip() != FRONTMATTER_DELIMITER:
        return result

    close = None
    for idx in range(1, len(lines)):
        if lines[idx].rstrip() == FRONTMATTER_DELIMITER:
            close = idx
            break
    if close is None:
        result.errors.append((1, "frontmatter block is not terminated by a closing ---"))
        return result

    result.block_span = (0, close)
    list_key: str | None = None

    for idx in range(1, close):
        raw = lines[idx].rstrip()
        line_no = idx + 1
        stripped = raw.strip()
        if not stripped or stripped.startswith("#"):
            continue

        item_match = _LIST_ITEM_RE.match(raw)
        if item_match:
            if list_key is None:
                result.errors.append((line_no, "list item without a preceding `key:` line"))
                continue
            item = _unquote((item_match.group(1) or "").strip())
            if not item:
                result.errors.append((line_no, "empty list item"))
                continue
            result.meta[list_key].append(item)
            result.item_lines[list_key].append(line_no)
            continue

        if raw[0].isspace():
            result.errors.append((line_no, f"unsupported frontmatter syntax: {stripped!r}"))
            continue

        key_match = _KEY_RE.match(raw)
        if not key_match:
            result.errors.append((line_no, f"unsupported frontmatter syntax: {stripped!r}"))
            list_key = None
            continue

        key = key_match.group(1)
        rest = key_match.group(2).strip()
        if key in result.meta:
            result.errors.append((line_no, f"duplicate key: {key}"))
            list_key = None
            continue

        result.key_lines[key] = line_no
        if rest == "":
            result.meta[key] = []
            result.item_lines[key] = []
            list_key = key
        elif rest.startswith("[") and rest.endswith("]"):
            items = [_unquote(p.strip()) for p in rest[1:-1].split(",")]
            result.meta[key] = [p for p in items if p]
            result.item_lines[key] = [line_no for p in items if p]
            list_key = None
        else:
            result.meta[key] = _unquote(rest)
            list_key = None

    return result


def set_last_verified(text: str, date: str) -> str:
    """Return ``text`` with ``last_verified: <date>`` stamped into its block.

    Replaces the existing ``last_verified:`` line when present; otherwise
    inserts one after the ``sources`` block (or right after the opening
    ``---``). A doc without any block gets a fresh one prepended. Every byte
    outside the touched line is unchanged — this is a line edit, not a
    re-serialization.
    """
    parsed = parse_frontmatter(text)
    if parsed.block_span is None:
        return build_block([], date, detect_eol(text)) + text

    lines = text.split("\n")
    open_idx = parsed.block_span[0]
    new_line = f"{KEY_LAST_VERIFIED}: {date}"

    existing = parsed.key_lines.get(KEY_LAST_VERIFIED)
    if existing is not None:
        lines[existing - 1] = new_line + _cr(lines[existing - 1])
        return "\n".join(lines)

    insert_at = open_idx + 1
    sources_line = parsed.key_lines.get(KEY_SOURCES)
    if sources_line is not None:
        insert_at = sources_line
        items = parsed.item_lines.get(KEY_SOURCES) or []
        if items:
            insert_at = max(items)
        # Trailing comments / blanks inside the sources block stay attached
        # to it: the stamp goes after the last list item, before the next key.
    lines.insert(insert_at, new_line + _cr(lines[insert_at - 1]))
    return "\n".join(lines)


def build_block(sources: list[str], last_verified: str | None, eol: str = "\n") -> str:
    """Render a frontmatter block for `init-meta`, joined and terminated by ``eol``."""
    out = [FRONTMATTER_DELIMITER]
    if sources:
        out.append(f"{KEY_SOURCES}:")
        out.extend(f"  - {s}" for s in sources)
    else:
        out.append(f"{KEY_SOURCES}: []")
    if last_verified:
        out.append(f"{KEY_LAST_VERIFIED}: {last_verified}")
    out.append(FRONTMATTER_DELIMITER)
    return eol.join(out) + eol


def extract_markdown_sources(text: str) -> list[str]:
    """Read a prose ``Sources:`` bullet list from the first lines of a doc.

    Returns the bullet entries with inline code spans stripped (``\\`a.ts\\```
    -> ``a.ts``). Only the first whitespace-delimited token of each bullet is
    kept, so a trailing parenthetical does not become part of the path.
    """
    lines = text.split("\n")
    head = lines[:SOURCES_SCAN_LINES]
    start = None
    for idx, line in enumerate(head):
        if _SOURCES_HEADING_RE.match(line):
            start = idx + 1
            break
    if start is None:
        return []

    sources: list[str] = []
    seen_bullet = False
    for line in lines[start:]:
        if not line.strip():
            if seen_bullet:
                break
            continue
        bullet = _BULLET_RE.match(line)
        if not bullet:
            break
        seen_bullet = True
        item = _CODE_SPAN_RE.sub(r"\1", bullet.group(1)).strip()
        if item:
            sources.append(item.split()[0])
    return sources
