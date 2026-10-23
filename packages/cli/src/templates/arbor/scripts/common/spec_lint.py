"""
Spec freshness lint: `spec.py lint | verify | init-meta`.

Scans `.arbor/spec/**/*.md` and reports docs that are stale, broken or
still placeholders. Advisory by design: `lint` exits 0 unless `--strict` is
passed and at least one error-severity finding exists. Exit 2 is reserved
for usage / I/O failures (no spec dir, bad `--date`, path outside the tree).

Rules (severity):
    L1 missing-metadata  warn   required doc without frontmatter / sources / last_verified
    L2 dead-source       error  a `sources` entry matches no file
    L3 broken-link       error  relative `.md` link whose target does not exist
    L4 stale             warn   sources committed after `last_verified`
    L5 placeholder       info   `To fill` rows / `(To be filled by the team)` bodies
    L6 missing-section   warn   layer index.md lacking Pre-Development Checklist / Quality Check
    L7 unlisted-doc      warn   layer leaf doc not linked from its index.md
    invalid-metadata     error  frontmatter syntax / date shape
    invalid-source       error  absolute path or `..` in a `sources` entry
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path
from urllib.parse import unquote

from .config import get_packages
from .git import run_git
from .io import write_text_atomic
from .paths import DIR_SPEC, DIR_WORKFLOW, get_repo_root
from .spec_meta import (
    DATE_RE,
    KEY_LAST_VERIFIED,
    KEY_SOURCES,
    FrontmatterResult,
    build_block,
    detect_eol,
    extract_markdown_sources,
    parse_frontmatter,
    set_last_verified,
)
from .spec_trace import collect_provenance

SEV_ERROR = "error"
SEV_WARN = "warn"
SEV_INFO = "info"
_SEVERITY_RANK = {SEV_ERROR: 0, SEV_WARN: 1, SEV_INFO: 2}
_SEVERITY_LABEL = {SEV_ERROR: "ERROR", SEV_WARN: "WARN", SEV_INFO: "INFO"}

KIND_LEAF = "leaf"      # spec/<layer>/*.md or spec/<pkg>/<layer>/*.md — metadata required
KIND_INDEX = "index"    # any index.md
KIND_GUIDE = "guide"    # spec/guides/*.md — metadata optional
KIND_OTHER = "other"    # anything else (e.g. spec/<pkg>/README.md) — optional

GUIDES_DIR = "guides"
INDEX_NAME = "index.md"
REQUIRED_INDEX_SECTIONS = ("Pre-Development Checklist", "Quality Check")
PLACEHOLDER_MARKERS = ("(To be filled by the team)", "To fill")

_GLOB_CHARS = ("*", "?", "[")
_LINK_RE = re.compile(r"\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")
_CODE_SPAN_RE = re.compile(r"`[^`]*`")
_FENCE_RE = re.compile(r"^\s*(```|~~~)")
_HEADING_RE = re.compile(r"^#{1,6}\s+(.*?)\s*#*\s*$")
_SCHEME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*:")
_DRIVE_RE = re.compile(r"^[A-Za-z]:[\\/]")


class SpecLintError(Exception):
    """Usage or I/O failure — the CLI maps it to exit 2."""


@dataclass
class Finding:
    rule: str
    severity: str
    path: str
    line: int
    message: str
    detail: dict = field(default_factory=dict)

    def to_json(self) -> dict:
        return {
            "rule": self.rule,
            "severity": self.severity,
            "path": self.path,
            "line": self.line,
            "message": self.message,
            "detail": self.detail,
        }


@dataclass
class Doc:
    path: Path
    rel: str
    kind: str
    is_layer_index: bool
    text: str
    fm: FrontmatterResult
    body_lines: list[str] = field(default_factory=list)


@dataclass
class LintContext:
    repo_root: Path
    spec_root: Path
    docs: list[Doc]
    # Resolved per doc during L2 so L4 reuses the match instead of re-globbing.
    resolved_sources: dict[str, list[Path]] = field(default_factory=dict)


# =============================================================================
# Discovery
# =============================================================================


def _posix_rel(path: Path, repo_root: Path) -> str:
    return path.relative_to(repo_root).as_posix()


def _classify(rel_parts: tuple[str, ...], packages: dict | None) -> tuple[str, bool]:
    """Return ``(kind, is_layer_index)`` for a doc path relative to spec root.

    A layer dir is ``spec/<layer>/`` in a single repo and ``spec/<pkg>/<layer>/``
    in a monorepo; a monorepo keeps accepting ``spec/<layer>/`` for layouts
    that predate its packages block. ``guides/`` is never a layer.
    """
    name = rel_parts[-1]
    parent = rel_parts[:-1]
    if parent and parent[0] == GUIDES_DIR:
        return (KIND_INDEX if name == INDEX_NAME else KIND_GUIDE), False

    if packages is None:
        is_layer = len(parent) == 1
    else:
        is_layer = len(parent) == 2 or (
            len(parent) == 1 and parent[0] not in packages
        )

    if name == INDEX_NAME:
        return KIND_INDEX, is_layer
    return (KIND_LEAF if is_layer else KIND_OTHER), False


def _strip_code(lines: list[str]) -> list[str]:
    """Blank out fenced code blocks and inline code spans, keeping line count."""
    out: list[str] = []
    fence: str | None = None
    for line in lines:
        m = _FENCE_RE.match(line)
        if m:
            marker = m.group(1)
            if fence is None:
                fence = marker
            elif marker == fence:
                fence = None
            out.append("")
            continue
        if fence is not None:
            out.append("")
            continue
        out.append(_CODE_SPAN_RE.sub("", line))
    return out


def load_doc(path: Path, repo_root: Path, spec_root: Path, packages: dict | None) -> Doc:
    try:
        # newline="" keeps \r\n intact so verify / init-meta write the doc
        # back in its own line endings instead of normalizing them to \n.
        with path.open(encoding="utf-8", newline="") as fh:
            text = fh.read()
    except (OSError, UnicodeDecodeError) as exc:
        raise SpecLintError(f"cannot read {path}: {exc}") from exc
    rel_parts = path.relative_to(spec_root).parts
    kind, is_layer_index = _classify(rel_parts, packages)
    fm = parse_frontmatter(text)
    lines = text.split("\n")
    body = list(lines)
    if fm.block_span is not None:
        for idx in range(fm.block_span[0], fm.block_span[1] + 1):
            body[idx] = ""
    return Doc(
        path=path,
        rel=_posix_rel(path, repo_root),
        kind=kind,
        is_layer_index=is_layer_index,
        text=text,
        fm=fm,
        body_lines=_strip_code(body),
    )


def _resolve_under_spec(raw: str, repo_root: Path, spec_root: Path) -> Path:
    candidate = Path(raw)
    if not candidate.is_absolute():
        candidate = repo_root / candidate
    try:
        resolved = candidate.resolve()
        resolved.relative_to(spec_root.resolve())
    except (OSError, ValueError):
        raise SpecLintError(
            f"{raw} is not under {_posix_rel(spec_root, repo_root)}"
        ) from None
    if not resolved.exists():
        raise SpecLintError(f"{raw} does not exist")
    # Spell the path through the repo's own spec dir so `rel` stays lexical
    # even when the repo sits behind a symlink (/tmp on macOS does).
    return spec_root / resolved.relative_to(spec_root.resolve())


def discover_docs(
    repo_root: Path,
    paths: list[str] | None = None,
    package: str | None = None,
) -> LintContext:
    spec_root = repo_root / DIR_WORKFLOW / DIR_SPEC
    if not spec_root.is_dir():
        raise SpecLintError(f"no spec directory at {_posix_rel(spec_root, repo_root)}")

    packages = get_packages(repo_root)
    roots: list[Path] = []
    if package:
        pkg_dir = spec_root / package
        if not pkg_dir.is_dir():
            raise SpecLintError(f"no spec directory for package '{package}'")
        roots.append(pkg_dir)
    for raw in paths or []:
        roots.append(_resolve_under_spec(raw, repo_root, spec_root))
    if not roots:
        roots.append(spec_root)

    files: dict[Path, None] = {}
    for root in roots:
        if root.is_file():
            if root.suffix == ".md":
                files[root] = None
            continue
        for md in sorted(root.rglob("*.md")):
            if md.is_file():
                files[md] = None

    docs = [load_doc(p, repo_root, spec_root, packages) for p in sorted(files)]
    return LintContext(repo_root=repo_root, spec_root=spec_root, docs=docs)


# =============================================================================
# Rules
# =============================================================================


def _sources(doc: Doc) -> list[str] | None:
    value = doc.fm.meta.get(KEY_SOURCES)
    return value if isinstance(value, list) else None


def _last_verified(doc: Doc) -> str | None:
    value = doc.fm.meta.get(KEY_LAST_VERIFIED)
    if isinstance(value, str) and DATE_RE.match(value):
        return value
    return None


def check_metadata_syntax(doc: Doc, _ctx: LintContext) -> list[Finding]:
    """`invalid-metadata`: parser errors, bad `last_verified`, non-list `sources`."""
    out = [
        Finding("invalid-metadata", SEV_ERROR, doc.rel, line, msg)
        for line, msg in doc.fm.errors
    ]
    if not doc.fm.has_block:
        return out
    lv = doc.fm.meta.get(KEY_LAST_VERIFIED)
    if lv is not None and not (isinstance(lv, str) and DATE_RE.match(lv)):
        out.append(Finding(
            "invalid-metadata", SEV_ERROR, doc.rel,
            doc.fm.key_lines.get(KEY_LAST_VERIFIED, 1),
            f"{KEY_LAST_VERIFIED} must be YYYY-MM-DD, got {lv!r}",
        ))
    src = doc.fm.meta.get(KEY_SOURCES)
    if src is not None and not isinstance(src, list):
        out.append(Finding(
            "invalid-metadata", SEV_ERROR, doc.rel,
            doc.fm.key_lines.get(KEY_SOURCES, 1),
            f"{KEY_SOURCES} must be a list, got {src!r}",
        ))
    return out


def check_missing_metadata(doc: Doc, _ctx: LintContext) -> list[Finding]:
    """L1: required docs declare frontmatter with sources and last_verified."""
    if doc.kind != KIND_LEAF:
        return []
    if not doc.fm.has_block:
        return [Finding(
            "missing-metadata", SEV_WARN, doc.rel, 1,
            f"no frontmatter block; run spec.py init-meta {doc.rel}",
        )]
    out: list[Finding] = []
    block_span = doc.fm.block_span
    assert block_span is not None  # guaranteed by has_block above
    sources = _sources(doc)
    if not sources:
        out.append(Finding(
            "missing-metadata", SEV_WARN, doc.rel,
            doc.fm.key_lines.get(KEY_SOURCES, block_span[0] + 1),
            f"{KEY_SOURCES} is empty; list the code paths this doc describes",
        ))
    if KEY_LAST_VERIFIED not in doc.fm.meta:
        out.append(Finding(
            "missing-metadata", SEV_WARN, doc.rel, block_span[1] + 1,
            f"no {KEY_LAST_VERIFIED}; re-check the doc, then run spec.py verify {doc.rel}",
        ))
    return out


def _normalize_source(entry: str) -> str:
    posix = entry.strip().replace("\\", "/")
    while posix.startswith("./"):
        posix = posix[2:]
    return posix


def check_sources(doc: Doc, ctx: LintContext) -> list[Finding]:
    """`invalid-source` + L2 `dead-source`; records matches for L4."""
    sources = _sources(doc)
    if not sources:
        return []
    out: list[Finding] = []
    matched: list[Path] = []
    item_lines = doc.fm.item_lines.get(KEY_SOURCES) or []
    for idx, raw in enumerate(sources):
        line = item_lines[idx] if idx < len(item_lines) else doc.fm.key_lines.get(KEY_SOURCES, 1)
        entry = _normalize_source(raw)
        if (
            not entry
            or entry.startswith("/")
            or _DRIVE_RE.match(entry)
            or ".." in entry.split("/")
        ):
            out.append(Finding(
                "invalid-source", SEV_ERROR, doc.rel, line,
                f"{raw!r} must be a repo-relative path without `..`",
                {"source": raw},
            ))
            continue
        # A directory entry is kept as the directory: git accepts it as a
        # pathspec for L4, and expanding it would put every file on the
        # command line for nothing.
        if any(ch in entry for ch in _GLOB_CHARS):
            try:
                hits = [p for p in ctx.repo_root.glob(entry) if p.exists()]
            except (ValueError, NotImplementedError, OSError):
                hits = []
        else:
            target = ctx.repo_root / entry
            hits = [target] if target.exists() else []
        if not hits:
            out.append(Finding(
                "dead-source", SEV_ERROR, doc.rel, line,
                f"{entry} matches no file; fix or remove the entry",
                {"source": entry},
            ))
            continue
        matched.extend(hits)
    ctx.resolved_sources[doc.rel] = matched
    return out


def check_links(doc: Doc, _ctx: LintContext) -> list[Finding]:
    """L3: relative `.md` links must resolve from the doc's directory."""
    out: list[Finding] = []
    for idx, line in enumerate(doc.body_lines):
        for m in _LINK_RE.finditer(line):
            target = m.group(1)
            if target.startswith("#") or target.startswith("/") or _SCHEME_RE.match(target):
                continue
            path_part = unquote(target.split("#", 1)[0])
            if not path_part.endswith(".md"):
                continue
            if not (doc.path.parent / path_part).is_file():
                out.append(Finding(
                    "broken-link", SEV_ERROR, doc.rel, idx + 1,
                    f"link target {target} does not exist",
                    {"target": target},
                ))
    return out


def _newest_source_date(files: list[Path], ctx: LintContext) -> tuple[str, str] | None:
    """``(YYYY-MM-DD, path)`` of the most recent change across ``files``."""
    if not files:
        return None
    rel_files = sorted({f.relative_to(ctx.repo_root).as_posix() for f in files})
    rc, out, _ = run_git(
        ["log", "-1", "--format=%ci", "--name-only", "--", *rel_files],
        cwd=ctx.repo_root,
    )
    if rc == 0 and out.strip():
        lines = [ln.strip() for ln in out.splitlines() if ln.strip()]
        when = lines[0][:10]
        if DATE_RE.match(when):
            touched = [ln for ln in lines[1:] if ln in rel_files]
            return when, (touched[0] if touched else rel_files[0])

    newest: tuple[float, str] | None = None
    for f in files:
        try:
            mtime = f.stat().st_mtime
        except OSError:
            continue
        if newest is None or mtime > newest[0]:
            newest = (mtime, f.relative_to(ctx.repo_root).as_posix())
    if newest is None:
        return None
    return datetime.fromtimestamp(newest[0]).strftime("%Y-%m-%d"), newest[1]


def check_stale(doc: Doc, ctx: LintContext) -> list[Finding]:
    """L4: newest commit over the sources is later than last_verified."""
    last = _last_verified(doc)
    files = ctx.resolved_sources.get(doc.rel)
    if not last or not files:
        return []
    newest = _newest_source_date(files, ctx)
    if newest is None or newest[0] <= last:
        return []
    return [Finding(
        "stale", SEV_WARN, doc.rel, doc.fm.key_lines.get(KEY_LAST_VERIFIED, 1),
        f"sources changed {newest[0]} after {KEY_LAST_VERIFIED} {last} ({newest[1]}); "
        f"re-check the doc, then run spec.py verify {doc.rel}",
        {"changed": newest[0], "last_verified": last, "source": newest[1]},
    )]


def check_placeholders(doc: Doc, _ctx: LintContext) -> list[Finding]:
    """L5: `To fill` status cells and placeholder phrases in the body."""
    out: list[Finding] = []
    for idx, line in enumerate(doc.body_lines):
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("|"):
            cells = [c.strip() for c in stripped.strip("|").split("|")]
            if "To fill" in cells:
                out.append(Finding(
                    "placeholder", SEV_INFO, doc.rel, idx + 1,
                    "index row status is 'To fill'; fill the doc or delete the row",
                    {"marker": "To fill"},
                ))
            continue
        for marker in PLACEHOLDER_MARKERS:
            if marker in line:
                out.append(Finding(
                    "placeholder", SEV_INFO, doc.rel, idx + 1,
                    f"placeholder text {marker!r}; fill or delete",
                    {"marker": marker},
                ))
                break
    return out


def _headings(doc: Doc) -> list[str]:
    out: list[str] = []
    for line in doc.body_lines:
        m = _HEADING_RE.match(line)
        if m:
            out.append(m.group(1).strip())
    return out


def check_index_sections(doc: Doc, _ctx: LintContext) -> list[Finding]:
    """L6: layer index.md carries the two sections the workflow reads."""
    if not doc.is_layer_index:
        return []
    headings = _headings(doc)
    return [
        Finding(
            "missing-section", SEV_WARN, doc.rel, 0,
            f"no `## {section}` section; add it so agents can load it",
            {"section": section},
        )
        for section in REQUIRED_INDEX_SECTIONS
        if section not in headings
    ]


def check_unlisted(doc: Doc, _ctx: LintContext) -> list[Finding]:
    """L7: layer leaf docs are linked from their sibling index.md."""
    if doc.kind != KIND_LEAF:
        return []
    index_path = doc.path.parent / INDEX_NAME
    index_rel = f"{doc.rel.rsplit('/', 1)[0]}/{INDEX_NAME}"
    try:
        index_text = index_path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return [Finding(
            "unlisted-doc", SEV_WARN, doc.rel, 0,
            f"no {index_rel} to list this doc; create the index",
            {"index": index_rel},
        )]
    pattern = re.compile(r"\]\((?:\./)?" + re.escape(doc.path.name) + r"(?:#[^)]*)?\)")
    if pattern.search(index_text):
        return []
    return [Finding(
        "unlisted-doc", SEV_WARN, doc.rel, 0,
        f"not linked from {index_rel}; add an index row",
        {"index": index_rel},
    )]


RULES = (
    check_metadata_syntax,
    check_missing_metadata,
    check_sources,
    check_links,
    check_stale,
    check_placeholders,
    check_index_sections,
    check_unlisted,
)


def run_lint(ctx: LintContext) -> list[Finding]:
    findings: list[Finding] = []
    for doc in ctx.docs:
        for rule in RULES:
            findings.extend(rule(doc, ctx))
    findings.sort(key=lambda f: (_SEVERITY_RANK[f.severity], f.path, f.line, f.rule))
    return findings


def summarize(findings: list[Finding]) -> dict[str, int]:
    return {
        "errors": sum(1 for f in findings if f.severity == SEV_ERROR),
        "warnings": sum(1 for f in findings if f.severity == SEV_WARN),
        "info": sum(1 for f in findings if f.severity == SEV_INFO),
    }


# =============================================================================
# Reporters
# =============================================================================


def _plural(n: int, word: str) -> str:
    return f"{n} {word}" if n == 1 else f"{n} {word}s"


def render_text(
    docs: int,
    findings: list[Finding],
    provenance: dict[str, list[dict]] | None = None,
) -> str:
    lines: list[str] = []
    for f in findings:
        lines.append(
            f"{_SEVERITY_LABEL[f.severity]:<5} {f.rule:<16} {f.path}:{f.line}  {f.message}"
        )
    if provenance:
        lines.append("provenance:")
        for rel in sorted(provenance):
            latest = provenance[rel][0]
            when = latest.get("completedAt") or "unarchived"
            lines.append(f"  {rel}  last changed by {latest['task']} ({when})")
    summary = summarize(findings)
    if not findings:
        lines.append(f"spec lint: {_plural(docs, 'doc')}, 0 findings")
    else:
        lines.append(
            f"spec lint: {_plural(docs, 'doc')}, {_plural(summary['errors'], 'error')}, "
            f"{_plural(summary['warnings'], 'warning')}, {summary['info']} info"
        )
    return "\n".join(lines)


def render_json(
    docs: int,
    findings: list[Finding],
    provenance: dict[str, list[dict]] | None = None,
) -> str:
    payload: dict = {
        "docs": docs,
        "findings": [f.to_json() for f in findings],
        "summary": summarize(findings),
    }
    if provenance is not None:
        payload["provenance"] = provenance
    return json.dumps(payload, indent=2, ensure_ascii=False)


# =============================================================================
# Commands
# =============================================================================


def cmd_lint(args: argparse.Namespace) -> int:
    repo_root = get_repo_root()
    ctx = discover_docs(repo_root, args.paths, args.package)
    findings = run_lint(ctx)

    provenance: dict[str, list[dict]] | None = None
    if args.provenance:
        in_scope = {d.rel for d in ctx.docs}
        provenance = {
            rel: entries
            for rel, entries in collect_provenance(repo_root).items()
            if rel in in_scope
        }

    if args.json:
        print(render_json(len(ctx.docs), findings, provenance))
    else:
        print(render_text(len(ctx.docs), findings, provenance))

    if args.strict and summarize(findings)["errors"] > 0:
        return 1
    return 0


def _parse_date_arg(raw: str | None) -> str:
    if raw is None:
        return date.today().isoformat()
    if not DATE_RE.match(raw):
        raise SpecLintError(f"--date must be YYYY-MM-DD, got {raw!r}")
    try:
        date.fromisoformat(raw)
    except ValueError as exc:
        raise SpecLintError(f"--date is not a real date: {raw}") from exc
    return raw


def cmd_verify(args: argparse.Namespace) -> int:
    repo_root = get_repo_root()
    stamp = _parse_date_arg(args.date)
    ctx = discover_docs(repo_root, args.paths, None)
    if not ctx.docs:
        raise SpecLintError("no spec docs matched the given paths")

    failed = False
    for doc in ctx.docs:
        if doc.fm.errors:
            line, msg = doc.fm.errors[0]
            print(f"skip {doc.rel}:{line}: {msg}", file=sys.stderr)
            failed = True
            continue
        updated = set_last_verified(doc.text, stamp)
        if updated == doc.text:
            print(f"unchanged {doc.rel} ({KEY_LAST_VERIFIED} already {stamp})")
            continue
        if not write_text_atomic(doc.path, updated, newline=""):
            print(f"error: could not write {doc.rel}", file=sys.stderr)
            failed = True
            continue
        print(f"verified {doc.rel} ({KEY_LAST_VERIFIED}: {stamp})")
    return 2 if failed else 0


def _doc_last_commit_date(doc: Doc, repo_root: Path) -> str:
    rc, out, _ = run_git(["log", "-1", "--format=%ci", "--", doc.rel], cwd=repo_root)
    when = out.strip()[:10] if rc == 0 else ""
    return when if DATE_RE.match(when) else date.today().isoformat()


def cmd_init_meta(args: argparse.Namespace) -> int:
    repo_root = get_repo_root()
    ctx = discover_docs(repo_root, args.paths, None)
    explicit_files = set()
    for raw in args.paths or []:
        candidate = Path(raw)
        if not candidate.is_absolute():
            candidate = repo_root / candidate
        if candidate.is_file():
            explicit_files.add(candidate.resolve())

    seeded = 0
    for doc in ctx.docs:
        if doc.fm.has_block or doc.fm.errors:
            continue
        # Directory scans seed only the docs where metadata is required;
        # a file named on the command line is seeded whatever its kind.
        if doc.kind != KIND_LEAF and doc.path.resolve() not in explicit_files:
            continue
        sources = extract_markdown_sources(doc.text)
        block = build_block(
            sources, _doc_last_commit_date(doc, repo_root), detect_eol(doc.text)
        )
        label = f"{doc.rel} ({len(sources)} sources)"
        if args.dry_run:
            print(f"would seed {label}")
            seeded += 1
            continue
        if not write_text_atomic(doc.path, block + doc.text, newline=""):
            print(f"error: could not write {doc.rel}", file=sys.stderr)
            return 2
        print(f"seeded {label}")
        seeded += 1
    verb = "would seed" if args.dry_run else "seeded"
    print(f"spec init-meta: {verb} {_plural(seeded, 'doc')}")
    return 0


# =============================================================================
# CLI
# =============================================================================


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="spec.py",
        description="Spec doc freshness lint and metadata tools",
    )
    sub = parser.add_subparsers(dest="command")

    p_lint = sub.add_parser("lint", help="Report stale, broken, or placeholder spec docs")
    p_lint.add_argument("paths", nargs="*", help="Files or directories under .arbor/spec")
    p_lint.add_argument("--package", help="Limit to .arbor/spec/<package>/")
    p_lint.add_argument("--json", action="store_true", help="Machine-readable output")
    p_lint.add_argument("--strict", action="store_true", help="Exit 1 when errors exist")
    p_lint.add_argument(
        "--provenance",
        action="store_true",
        help="Show which archived task last changed each doc",
    )

    p_verify = sub.add_parser("verify", help="Stamp last_verified after re-checking a doc")
    p_verify.add_argument("paths", nargs="+", help="Spec docs to stamp")
    p_verify.add_argument("--date", help="YYYY-MM-DD (default: today)")

    p_init = sub.add_parser("init-meta", help="Seed frontmatter on docs that lack it")
    p_init.add_argument("paths", nargs="*", help="Files or directories under .arbor/spec")
    p_init.add_argument("--dry-run", action="store_true", help="Print without writing")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    handlers = {"lint": cmd_lint, "verify": cmd_verify, "init-meta": cmd_init_meta}
    handler = handlers.get(args.command)
    if handler is None:
        parser.print_help()
        return 2
    try:
        return handler(args)
    except SpecLintError as exc:
        print(f"spec {args.command}: {exc}", file=sys.stderr)
        return 2
