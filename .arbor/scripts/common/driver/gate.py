"""
Level-0 verification: the project's gate commands plus every ``auto`` check
of the contract's Verification map, run in the task worktree.

Gate commands come from ``gate.commands`` in ``.arbor/config.yaml`` and are
reported as ``GATE-1``, ``GATE-2``, ...; map checks keep their criterion id.
After a review fix the gate also runs the ``exec`` repro of every fixed
CONFIRMED finding as ``REPRO-1``, ``REPRO-2``, ... (each must exit 0).

A check that times out is killed with everything it started. From pytest's
summary a check keeps the ids of its failed tests and its skip count, so a
gate can be compared with the gate of the task's base (``compare``).
"""

from __future__ import annotations

import os
import re
import signal
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Sequence

from ..contract import Contract
from ..git import run_git

#: Upper bound for one check; a hung test runner must not hang the driver.
CHECK_TIMEOUT_S = 30 * 60
OUTPUT_TAIL_LINES = 30
# pytest -q / -rf summary lines: "FAILED tests/x.py::test_y - AssertionError", "ERROR tests/z.py"
_FAILED_RE = re.compile(r"^(?:FAILED|ERROR) (\S+)", re.MULTILINE)
_SKIPPED_RE = re.compile(r"\b(\d+) skipped\b")


@dataclass(frozen=True)
class CheckResult:
    id: str
    command: str
    exit_code: int | None  # None: timed out / could not start
    output: str  # tail of combined stdout+stderr
    failed_tests: tuple[str, ...] = ()  # test ids from a pytest summary
    skipped: int | None = None  # from a pytest summary

    @property
    def passed(self) -> bool:
        return self.exit_code == 0


@dataclass(frozen=True)
class GateResult:
    checks: list[CheckResult] = field(default_factory=list)

    @property
    def failing(self) -> list[str]:
        return [c.id for c in self.checks if not c.passed]

    @property
    def green(self) -> bool:
        return not self.failing


def run_check(check_id: str, command: str, worktree: Path) -> CheckResult:
    try:
        # Its own process group: a timeout kills the test runner too, not only the shell.
        proc = subprocess.Popen(command, shell=True, cwd=worktree, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace",
                                start_new_session=True)
    except OSError as e:
        return CheckResult(check_id, command, None, f"could not run: {e}")
    try:
        out, _ = proc.communicate(timeout=CHECK_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except OSError:
            pass
        out, _ = proc.communicate()
        tail = "\n".join(out.splitlines()[-OUTPUT_TAIL_LINES:])
        return CheckResult(check_id, command, None, f"{tail}\ntimed out after {CHECK_TIMEOUT_S}s".strip())
    tail = "\n".join(out.splitlines()[-OUTPUT_TAIL_LINES:])
    skipped = _SKIPPED_RE.findall(out[-2000:])
    return CheckResult(check_id, command, proc.returncode, tail, tuple(sorted(set(_FAILED_RE.findall(out)))),
                       int(skipped[-1]) if skipped else None)


def compare(checks: list[CheckResult], baseline: dict | None) -> tuple[list[str], list[str]]:
    """(the failing checks that block, notes) against the gate of the task's
    base. A check that failed there too blocks only with a test that did not
    fail there; when no test ids can be read it blocks, noted as red at the
    base too. More skips than at the base are noted."""
    base = (baseline or {}).get("checks") or {}
    blocking, notes = [], []
    for c in checks:
        was = base.get(c.id)
        if was and c.skipped is not None and was.get("skipped") is not None and c.skipped > was["skipped"]:
            notes.append(f"{c.id} skips {c.skipped} tests, {was['skipped']} at the base")
        if c.passed:
            continue
        if not was or was.get("passed"):
            blocking.append(c.id)
            continue
        new = sorted(set(c.failed_tests) - set(was.get("failed_tests") or ()))
        if c.failed_tests and was.get("failed_tests") and not new:
            notes.append(f"{c.id} fails only where the base fails ({len(c.failed_tests)} tests): not blocking")
        else:
            blocking.append(c.id)
            notes.append(f"{c.id} is red at the base too" + (f"; new failures: {', '.join(new[:10])}" if new else ""))
    return blocking, notes


def baseline_record(sha: str, checks: list[CheckResult]) -> dict:
    return {"sha": sha, "checks": {c.id: {"passed": c.passed, "failed_tests": list(c.failed_tests),
                                         "skipped": c.skipped} for c in checks}}


def auto_checks(contract: Contract) -> list[tuple[str, str]]:
    """``(id, command)`` of the auto checks."""
    return [(e.id, e.check) for e in contract.auto_checks() if e.check.strip()]


def run_gate(gate_commands: list[str], contract: Contract, worktree: Path,
             repros: Sequence[tuple[str, str]] = ()) -> GateResult:
    """Gate commands first, then every auto map check, then the
    ``(finding id, command)`` repros as ``REPRO-n``; all of them run."""
    checks = [
        run_check(f"GATE-{i}", command, worktree)
        for i, command in enumerate(gate_commands, start=1)
    ]
    checks += [run_check(cid, command, worktree) for cid, command in auto_checks(contract)]
    checks += [run_check(f"REPRO-{i}", command, worktree)
               for i, (_, command) in enumerate(repros, start=1)]
    return GateResult(checks)


def map_warnings(contract: Contract, worktree: Path, base: str) -> list[str]:
    """Warnings for auto checks that may pass without testing their criterion:
    the map ``file`` is unchanged since the task base (``base..HEAD``), or
    neither the check command, the file's path nor its text names the
    criterion id (implement names tests after it, e.g. ``ac8`` for AC-8)."""
    rc, out, _ = run_git(["diff", "--name-only", f"{base}..HEAD"], cwd=worktree)
    changed = set(out.split()) if rc == 0 else None
    warnings = []
    for e in contract.auto_checks():
        file = (e.file or "").split("::")[0].strip()  # a pytest node id names its file first
        if not e.check.strip() or file in ("", "-", "—"):
            continue
        if changed is not None and file not in changed:
            warnings.append(f"{e.id}: `{file}` is unchanged since the task base; its check may pass on existing tests")
            continue
        number = e.id.split("-", 1)[-1]
        named = re.compile(rf"(?<![a-z0-9])ac[-_ ]?{re.escape(number)}(?!\d)", re.IGNORECASE)
        try:
            text = (worktree / file).read_text(encoding="utf-8", errors="replace")
        except OSError:
            text = ""
        if not any(named.search(x) for x in (e.check, file, text)):
            warnings.append(f"{e.id}: no test in `{file}` names {e.id} and the check does not select one; "
                            "it may pass on unrelated tests")
    return warnings


def format_checks(checks: list[CheckResult]) -> str:
    """Markdown block for reports and ``arbor gate`` output."""
    lines: list[str] = []
    for c in checks:
        status = "pass" if c.passed else ("timeout" if c.exit_code is None else f"exit {c.exit_code}")
        lines.append(f"- {c.id}: {status}  `{c.command}`")
        if not c.passed and c.output.strip():
            lines.append("  ```")
            lines += [f"  {line}" for line in c.output.splitlines()]
            lines.append("  ```")
    return "\n".join(lines)
