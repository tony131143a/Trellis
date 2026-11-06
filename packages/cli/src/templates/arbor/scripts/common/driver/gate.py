"""
Level-0 verification: the project's gate commands plus every ``auto`` check
of the contract's Verification map, run in the task worktree.

Gate commands come from ``gate.commands`` in ``.arbor/config.yaml`` and are
reported as ``GATE-1``, ``GATE-2``, ...; map checks keep their criterion id.
After a review fix the gate also runs the ``exec`` repro of every fixed
CONFIRMED finding as ``REPRO-1``, ``REPRO-2``, ... (each must exit 0).
"""

from __future__ import annotations

import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Sequence

from ..contract import Contract
from ..git import run_git

#: Upper bound for one check; a hung test runner must not hang the driver.
CHECK_TIMEOUT_S = 30 * 60
OUTPUT_TAIL_LINES = 30


@dataclass(frozen=True)
class CheckResult:
    id: str
    command: str
    exit_code: int | None  # None: timed out / could not start
    output: str  # tail of combined stdout+stderr

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
        proc = subprocess.run(
            command,
            shell=True,
            cwd=worktree,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=CHECK_TIMEOUT_S,
        )
    except subprocess.TimeoutExpired:
        return CheckResult(check_id, command, None, f"timed out after {CHECK_TIMEOUT_S}s")
    except OSError as e:
        return CheckResult(check_id, command, None, f"could not run: {e}")
    tail = "\n".join(proc.stdout.splitlines()[-OUTPUT_TAIL_LINES:])
    return CheckResult(check_id, command, proc.returncode, tail)


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


def untouched_test_files(contract: Contract, worktree: Path, base: str) -> list[str]:
    """Warnings for auto checks whose map ``file`` the task never changed
    (``base..HEAD``): such a check may pass on tests that already existed."""
    rc, out, _ = run_git(["diff", "--name-only", f"{base}..HEAD"], cwd=worktree)
    if rc != 0:
        return []
    changed = set(out.split())
    warnings = []
    for e in contract.auto_checks():
        file = (e.file or "").split("::")[0].strip()  # a pytest node id names its file first
        if e.check.strip() and file not in ("", "-", "—") and file not in changed:
            warnings.append(f"{e.id}: `{file}` is unchanged since the task base; its check may pass on existing tests")
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
