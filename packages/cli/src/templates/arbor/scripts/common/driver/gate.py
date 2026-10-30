"""
Level-0 verification: the project's gate commands plus every ``auto`` check
of the contract's Verification map, run in the task worktree.

Gate commands come from ``gate.commands`` in ``.arbor/config.yaml`` and are
reported as ``GATE-1``, ``GATE-2``, ...; map checks keep their criterion id.
The same runner serves the red check after the ``test`` dispatch, where every
check must fail and a collection / import error is not a valid red.
"""

from __future__ import annotations

import re
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

from ..contract import Contract

#: Upper bound for one check; a hung test runner must not hang the driver.
CHECK_TIMEOUT_S = 30 * 60
OUTPUT_TAIL_LINES = 30

# Output that means the checks never ran (collection/import/syntax errors),
# as opposed to an assertion failing.
_COLLECTION_ERROR_RE = re.compile(
    r"(ModuleNotFoundError|ImportError|SyntaxError|IndentationError"
    r"|ERROR collecting|errors? during collection|no tests ran|collected 0 items"
    r"|No test files found|Failed to load|Cannot find module|Transform failed)",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class CheckResult:
    id: str
    command: str
    exit_code: int | None  # None: timed out / could not start
    output: str  # tail of combined stdout+stderr

    @property
    def passed(self) -> bool:
        return self.exit_code == 0

    @property
    def collection_error(self) -> bool:
        return not self.passed and bool(_COLLECTION_ERROR_RE.search(self.output))


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
    return [(e.id, e.check) for e in contract.auto_checks() if e.check.strip()]


def run_gate(gate_commands: list[str], contract: Contract, worktree: Path) -> GateResult:
    """Gate commands first, then every auto map check; all of them run."""
    checks = [
        run_check(f"GATE-{i}", command, worktree)
        for i, command in enumerate(gate_commands, start=1)
    ]
    checks += [run_check(cid, command, worktree) for cid, command in auto_checks(contract)]
    return GateResult(checks)


@dataclass(frozen=True)
class RedResult:
    checks: list[CheckResult]

    @property
    def passing(self) -> list[str]:
        """Checks that already pass: they prove nothing yet."""
        return [c.id for c in self.checks if c.passed]

    @property
    def errored(self) -> list[str]:
        """Checks that fail for a collection/import reason, not an assertion."""
        return [c.id for c in self.checks if c.collection_error]

    @property
    def valid(self) -> bool:
        return not self.passing and not self.errored


def run_red_check(contract: Contract, worktree: Path) -> RedResult:
    """After ``test``: every auto check must fail, and for the right reason."""
    return RedResult([run_check(cid, command, worktree) for cid, command in auto_checks(contract)])


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
