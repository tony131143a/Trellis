"""
The plan is the task's ``nodes/`` directory: one file per node.

    ---
    title: Add the redis channel adapter
    repo: api                     # default: the task's default repo
    paths: [src/channel/**]       # absent or empty: a read-only node
    after: [n1, n2]
    tier: strong
    checks: [AC-1]
    ---
    <the brief>

A node's file is read again on every ``sync`` until the node starts; then its
hash is recorded and later edits are ignored.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from pathlib import Path

from ..contract import paths_overlap

NODE_ID_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,39}")
KEYS = ("title", "repo", "paths", "after", "tier", "checks")
LIST_KEYS = ("paths", "after", "checks")
# A started node: its file was frozen when the driver first tried to start it.
FROZEN = "file_hash"


class NodeError(ValueError):
    pass


@dataclass
class NodeFile:
    id: str
    hash: str
    title: str = ""
    repo: str = ""
    paths: list[str] = field(default_factory=list)
    after: list[str] = field(default_factory=list)
    tier: str = "strong"
    checks: list[str] = field(default_factory=list)
    brief: str = ""
    error: str | None = None


def _unquote(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
        return value[1:-1]
    return value


def _items(value: str) -> list[str]:
    value = value.strip()
    if value.startswith("[") and value.endswith("]"):
        value = value[1:-1]
    return [item for item in (_unquote(v) for v in value.split(",")) if item]


def parse(text: str) -> tuple[dict, str]:
    """(frontmatter fields, brief). Lists may be ``[a, b]``, ``a, b`` or a
    block of ``- item`` lines; ``# …`` after whitespace is a comment."""
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        raise NodeError("no frontmatter: the file must start with a --- line")
    try:
        end = next(i for i in range(1, len(lines)) if lines[i].strip() == "---")
    except StopIteration:
        raise NodeError("frontmatter is not closed by a --- line") from None
    fields: dict = {}
    block: str | None = None
    for raw in lines[1:end]:
        line = re.sub(r"(^|\s)#.*$", "", raw).rstrip()
        if not line.strip():
            continue
        if line.lstrip().startswith("- "):
            if block is None:
                raise NodeError(f"list item outside a list: {raw.strip()!r}")
            fields[block] += _items(line.lstrip()[2:])
            continue
        key, sep, value = line.partition(":")
        key = key.strip()
        if not sep or line[0].isspace() or key not in KEYS:
            raise NodeError(f"unknown frontmatter line {raw.strip()!r} (keys: {', '.join(KEYS)})")
        if key in fields:
            raise NodeError(f"{key} is given twice")
        block = None
        if key in LIST_KEYS:
            fields[key] = _items(value)
            block = key if not value.strip() else None
        else:
            fields[key] = _unquote(value)
    return fields, "\n".join(lines[end + 1:]).strip()


def read(path: Path, default_repo: str) -> NodeFile:
    data = path.read_bytes()
    node = NodeFile(path.stem, hashlib.sha256(data).hexdigest(), title=path.stem, repo=default_repo)
    if not NODE_ID_RE.fullmatch(node.id):
        node.error = "bad id: the file name must match [a-z0-9][a-z0-9-]{0,39}.md"
        return node
    try:
        fields, node.brief = parse(data.decode("utf-8", errors="replace"))
    except NodeError as e:
        node.error = str(e)
        return node
    for key, value in fields.items():
        if value or key in LIST_KEYS:
            setattr(node, key, value)
    bad = [p for p in node.paths if p.startswith("/") or ".." in p.split("/")]
    if bad:
        node.error = f"paths must be relative and without '..': {', '.join(bad)}"
    return node


@dataclass(frozen=True)
class Known:
    """What a node may name."""
    repos: set[str]
    tiers: set[str]
    checks: dict[str, tuple[str, str]]  # map row id -> (kind, repo)


def _check(node: NodeFile, known: Known) -> str | None:
    if node.repo not in known.repos:
        return f"unknown repo {node.repo!r} (known: {', '.join(sorted(known.repos))})"
    if node.tier not in known.tiers:
        return f"unknown tier {node.tier!r} (known: {', '.join(sorted(known.tiers))})"
    for cid in node.checks:
        kind, repo = known.checks.get(cid, ("", ""))
        if kind != "auto":
            return f"checks: {cid} is not an auto row of the Verification map"
        if repo != node.repo:
            return f"checks: {cid} runs in repo {repo!r}, not {node.repo!r}"
    return None


def _cycles(graph: dict[str, list[str]]) -> dict[str, str]:
    """Nodes on a dependency cycle -> the cycle."""
    found: dict[str, str] = {}
    state: dict[str, int] = {}
    stack: list[str] = []

    def visit(n: str) -> None:
        state[n] = 1
        stack.append(n)
        for dep in graph.get(n, []):
            if state.get(dep) == 1:
                cycle = stack[stack.index(dep):] + [dep]
                for member in cycle:
                    found.setdefault(member, " -> ".join(cycle))
            elif dep in graph and not state.get(dep):
                visit(dep)
        stack.pop()
        state[n] = 2

    for n in sorted(graph):
        if not state.get(n):
            visit(n)
    return found


def update(nodes: dict, nodes_dir: Path, default_repo: str, known: Known) -> tuple[list[str], int]:
    """Read ``nodes_dir`` into the task's ``nodes``: add new nodes, refresh
    pending and invalid ones, drop pending ones whose file is gone, note a
    started node's changed file once. Returns (events, new writer nodes)."""
    files = {p.stem: read(p, default_repo) for p in sorted(nodes_dir.glob("*.md"))} if nodes_dir.is_dir() else {}
    events: list[str] = []
    for nid in [n for n, rec in nodes.items() if n not in files and not rec.get(FROZEN)
                and rec["status"] in ("pending", "invalid")]:
        del nodes[nid]
        events.append(f"{nid} removed (its file is gone)")
    open_ids = {n for n in files if n not in nodes
                or (nodes[n]["status"] in ("pending", "invalid") and not nodes[n].get(FROZEN))}
    graph = {n: list(rec.get("after") or []) for n, rec in nodes.items()}
    graph.update({n: files[n].after for n in open_ids})
    cycles = _cycles(graph)
    new_writers = 0
    for nid in sorted(open_ids):
        f = files[nid]
        error = f.error or _check(f, known)
        if not error:
            unknown = [d for d in f.after if d not in graph]
            error = (f"after: unknown node(s) {', '.join(unknown)}" if unknown
                     else f"dependency cycle: {cycles[nid]}" if nid in cycles else None)
        rec = nodes.get(nid)
        if rec is None:
            rec = nodes[nid] = {"seq": max((r["seq"] for r in nodes.values()), default=0) + 1,
                                "status": "pending", "attempt": 1}
            new_writers += bool(f.paths) and not error
            events.append(f"{nid} added" + (f" (invalid: {error})" if error else ""))
        elif rec["status"] == "invalid" and not error:
            events.append(f"{nid} is valid now")
        elif error and rec.get("reason") != error:
            events.append(f"{nid} invalid: {error}")
        rec.update(title=f.title, repo=f.repo, tier=f.tier, paths=f.paths, after=f.after, checks=f.checks,
                   status="invalid" if error else "pending", reason=error)
    for nid, rec in nodes.items():
        f = files.get(nid)
        if rec.get(FROZEN) and f and f.hash != rec[FROZEN] and not rec.get("changed_noted"):
            rec["changed_noted"] = True
            events.append(f"node {nid} changed after it started; ignored")
    return events, new_writers


def is_writer(node: dict) -> bool:
    return bool(node.get("paths"))


def ready(nodes: dict, limit: int | None, writers: bool) -> tuple[list[str], dict[str, str]]:
    """(nodes to start now in ``seq`` order, pending node -> the dependency
    that blocks it for good). Two writers of one repo whose paths may overlap
    never run together; read-only nodes only when ``writers`` is False."""
    running = [n for n, r in nodes.items() if r["status"] == "running"]
    slots = None if limit is None else max(0, limit - len(running))
    chosen: list[str] = []
    blocked: dict[str, str] = {}
    for nid in sorted((n for n, r in nodes.items() if r["status"] == "pending"), key=lambda n: nodes[n]["seq"]):
        rec = nodes[nid]
        deps = [nodes.get(d) for d in rec.get("after") or []]
        bad = next((d for d, r in zip(rec.get("after") or [], deps)
                    if r is None or r["status"] in ("failed", "cancelled", "invalid")), None)
        if bad:
            blocked[nid] = bad
            continue
        if any(r["status"] not in ("merged", "done") for r in deps if r):
            continue
        if is_writer(rec):
            if not writers or any(
                    nodes[o]["repo"] == rec["repo"] and is_writer(nodes[o])
                    and paths_overlap(nodes[o]["paths"], rec["paths"]) for o in running + chosen):
                continue
        if slots is not None and len(chosen) >= slots:
            continue
        chosen.append(nid)
    return chosen, blocked
