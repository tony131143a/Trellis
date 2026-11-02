"""The conductor: a long-running sub-agent that drives one started task.

The Planner (the user's session) launches it with ``arbor conduct``. The
driver builds the prompt, starts the run through ``conductor.command`` (a
detached codeg run that prints its run id), records it in task.json and later
collects the terminal report with ``arbor conduct --collect``. Inside its run
the conductor calls the driver with ``--as-conductor c-NNN`` so the driver can
tell it apart from the Planner.

task.json::

    "conductor": {"run": "c-001", "run_id": "...", "status": "running|done|escalated|failed",
                  "started": "...", "ended": null, "prompt_path": "...", "outcome": null,
                  "reason": null, "needs_from_planner": null}
    "conductor_runs": [ ...earlier records... ]
"""

from __future__ import annotations

import re
import subprocess
from dataclasses import dataclass
from pathlib import Path

from ..arbor_config import get_conductor_config
from ..paths import DIR_WORKFLOW
from .executor import ExecutorError, build_command, child_env

OUTCOMES = ("DONE", "ESCALATE", "FAILED")
REASONS = ("done", "contract", "plausible", "stop", "merge_conflict", "blocked", "executor", "timeout", "canceled")
STATUS_OF_OUTCOME = {"DONE": "done", "ESCALATE": "escalated", "FAILED": "failed"}
STILL_RUNNING_EXIT = 6  # codeg-cli result: the run had not ended
MARKER = "<!-- arbor-hook-injected -->"
_ARTIFACT_CAP = 64 * 1024
_HEADER_RE = re.compile(r"^##\s*Conductor\s+(DONE|ESCALATE|FAILED)\b", re.MULTILINE)
_FIELDS = ("Reason", "State", "Dispatches", "Summary", "Needs from planner")
_RUN_ID_RE = re.compile(r"[\w.:-]+")


@dataclass(frozen=True)
class ConductorConfig:
    command: str
    result_command: str
    cancel_command: str
    executor: str


@dataclass(frozen=True)
class Report:
    outcome: str | None  # DONE | ESCALATE | FAILED | None (unparseable)
    reason: str | None
    state: str | None
    summary: str
    needs_from_planner: str | None
    problem: str | None = None

    @property
    def status(self) -> str:
        return STATUS_OF_OUTCOME.get(self.outcome or "", "failed")


def resolve_config(config: dict) -> ConductorConfig:
    section = get_conductor_config(config)
    for key in ("command", "result_command", "cancel_command"):
        if not str(section.get(key) or "").strip():
            raise ExecutorError(f"conductor.{key} is empty in .arbor/config.yaml")
    return ConductorConfig(section["command"], section["result_command"], section["cancel_command"],
                           str(section.get("executor") or "").strip() or "codeg-cli")


# =============================================================================
# task.json records
# =============================================================================


def current(data: dict) -> dict | None:
    record = data.get("conductor")
    return record if isinstance(record, dict) and record.get("run") else None


def running(data: dict) -> dict | None:
    record = current(data)
    return record if record and record.get("status") == "running" else None


def next_run(data: dict) -> str:
    ids = [r.get("run", "") for r in [*(data.get("conductor_runs") or []), data.get("conductor") or {}]
           if isinstance(r, dict)]
    numbers = [int(i[2:]) for i in ids if isinstance(i, str) and i.startswith("c-") and i[2:].isdigit()]
    return f"c-{max(numbers, default=0) + 1:03d}"


def archive_current(data: dict) -> None:
    record = current(data)
    if record:
        data.setdefault("conductor_runs", []).append(record)
    data.pop("conductor", None)


# =============================================================================
# Prompt
# =============================================================================


def _read_capped(path: Path) -> str | None:
    try:
        raw = path.read_bytes()
    except OSError:
        return None
    text = raw[:_ARTIFACT_CAP].decode("utf-8", errors="replace")
    if len(raw) > _ARTIFACT_CAP:
        text += f"\n\n[truncated at {_ARTIFACT_CAP} bytes; read {path} for the rest]"
    return text


def build_prompt(control_worktree: Path, task_dir: Path, name: str, executor: str, run: str,
                 driver_state: str, brief: str) -> str:
    """Header + conductor instructions + task artifacts + driver state + Planner brief."""
    instructions_file = control_worktree / DIR_WORKFLOW / "agents" / "conductor.md"
    instructions = (_read_capped(instructions_file) or "").strip() or (
        f"Read `{instructions_file}` for your instructions before proceeding. "
        "If unavailable, end with `## Conductor FAILED` and `Reason: blocked`."
    )
    driver = Path(__file__).resolve().parents[2] / "arbor.py"
    parts = [
        f"Active task: {task_dir}\nConductor: {name}\nExecutor: {executor}\nRun: {run}\n"
        f"Driver: python3 {driver} --task {task_dir} --executor {executor} --as-conductor {run}",
        f"{MARKER}\n## Conductor Instructions\n\n{instructions}",
    ]
    for file_name, label in (("contract.md", "Contract"), ("design.md", "Technical Design"),
                             ("waves.md", "Waves")):
        text = _read_capped(task_dir / file_name)
        if text and text.strip():
            parts.append(f"## {label} (`{task_dir / file_name}`)\n\n{text.strip()}")
    parts.append(f"## Driver state at launch\n\n```json\n{driver_state.strip()}\n```")
    parts.append("## Planner brief\n\n" + (brief.strip() or "(none)"))
    return "\n\n".join(parts) + "\n"


# =============================================================================
# codeg-cli calls
# =============================================================================


def _run(command: str, cwd: Path, timeout: float) -> tuple[int | None, str, str]:
    try:
        proc = subprocess.run(command, shell=True, cwd=cwd, env=child_env(), stdin=subprocess.DEVNULL,
                              capture_output=True, text=True, encoding="utf-8", errors="replace",
                              timeout=timeout)
    except subprocess.TimeoutExpired as e:
        def _s(v: object) -> str:
            return v.decode("utf-8", "replace") if isinstance(v, bytes) else str(v or "")
        return None, _s(e.stdout), _s(e.stderr) + f"\ncommand timed out after {timeout:g}s"
    except OSError as e:
        return None, "", f"could not start: {e}"
    return proc.returncode, proc.stdout, proc.stderr


def start(cfg: ConductorConfig, *, prompt_path: Path, worktree: Path, task: str, run: str) -> tuple[str, str]:
    """Launch the detached run; returns (run_id, command)."""
    command = build_command(cfg.command, {"prompt": str(prompt_path), "worktree": str(worktree),
                                          "task": task, "run": run})
    rc, out, err = _run(command, worktree, 300)
    if rc != 0:
        raise ExecutorError(f"conductor command exited {rc}: {err.strip()[-800:] or out.strip()[-800:]}")
    run_id = next((line.strip() for line in out.splitlines() if line.strip()), "")
    if not run_id or not _RUN_ID_RE.fullmatch(run_id):
        raise ExecutorError(f"conductor command printed no run id (stdout: {out.strip()[:200]!r})")
    return run_id, command


def result(cfg: ConductorConfig, run_id: str, worktree: Path) -> tuple[str, str, str]:
    """('running' | 'finished' | 'error', stdout, stderr)."""
    command = build_command(cfg.result_command, {"run_id": run_id})
    rc, out, err = _run(command, worktree, 600)
    if rc == STILL_RUNNING_EXIT:
        return "running", out, err
    if rc == 0:
        return "finished", out, err
    return "error", out, f"result command exited {rc}: {err.strip()[-800:]}"


def cancel(cfg: ConductorConfig, run_id: str, worktree: Path) -> str | None:
    rc, _, err = _run(build_command(cfg.cancel_command, {"run_id": run_id}), worktree, 120)
    return None if rc == 0 else f"cancel command exited {rc}: {err.strip()[-400:]}"


# =============================================================================
# Report
# =============================================================================


def parse_report(text: str) -> Report:
    """The conductor's terminal message (format in agents/conductor.md)."""
    match = _HEADER_RE.search(text)
    if match is None:
        return Report(None, None, None, text.strip()[:2000], None,
                      "no `## Conductor DONE|ESCALATE|FAILED` header in the reply")
    outcome = match.group(1)
    body = text[match.end():]
    fields: dict[str, str] = {}
    pattern = re.compile(r"^(" + "|".join(re.escape(f) for f in _FIELDS) + r"):\s*(.*)$", re.MULTILINE)
    starts = list(pattern.finditer(body))
    for i, m in enumerate(starts):
        end = starts[i + 1].start() if i + 1 < len(starts) else len(body)
        fields[m.group(1)] = (m.group(2) + body[m.end():end]).strip()
    reason = (fields.get("Reason") or "").split()[0].lower() if fields.get("Reason") else None
    problem = None
    if outcome == "DONE":
        reason = reason or "done"
    elif reason not in REASONS:
        problem = f"Reason: must be one of {', '.join(REASONS)}"
    needs = fields.get("Needs from planner")
    if needs and needs.lower() == "none":
        needs = None
    return Report(outcome, reason, fields.get("State"), fields.get("Summary") or body.strip()[:2000],
                  needs, problem)


def write_report(task_dir: Path, run: str, reply: str, report: Report, notes: list[str]) -> Path:
    lines = [reply.rstrip(), "", "---", "", f"## Driver: {run} conductor {report.status}", ""]
    lines += [f"- outcome: {report.outcome or '-'}", f"- reason: {report.reason or '-'}",
              f"- state: {report.state or '-'}"]
    if report.problem:
        lines.append(f"- problem: {report.problem}")
    if notes:
        lines += ["", *notes]
    path = task_dir / "reports" / f"{run}.md"
    path.parent.mkdir(exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path
