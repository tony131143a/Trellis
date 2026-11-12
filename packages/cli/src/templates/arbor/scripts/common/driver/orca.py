"""Orca workers: every role dispatch runs as one supervised Orca worker.

The driver prepares a durable request record, starts the worker itself
(``orca orchestration worker-start``) and later reads its state back
(``orca orchestration worker-show``). The worker writes its complete reply to
the request's reply file; Orca's ``worker_done`` only settles the dispatch.
"""
from __future__ import annotations

import json
import re
import shlex
import subprocess
import sys
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path

from ..invariants import RefSnapshot
from ..io import write_json
from .executor import ExecResult, Executor, ExecutorError, resolve_executor, utc_now

REQUESTS = ".arbor/.runtime/workers"
CALL_TIMEOUT_S = 60
# worker-start waits for the agent's composer before it sends the prompt.
START_TIMEOUT_S = 300
# Display only, and some callers hold the task lock.
REGISTER_TIMEOUT_S = 15

SPEC_NOTE = (
    "Read the file named by `Prompt:` in full before doing anything else: it is your complete dispatch "
    "prompt (this header, your role instructions, the injected context and the brief).\n\n"
    "When the work is done, write your complete final report, in the exact format your role instructions "
    "define, to the file named by `Report:` (overwrite it). It is the only reply the Arbor driver reads, "
    "and the one file you may write outside your role's write boundary. Then send Orca's `worker_done` "
    "once, with `--report-path` set to that file. `--outcome succeeded` means the report is written, "
    "whatever its verdict (a FAIL, Blocked or Partial report is still `succeeded`); use `--outcome failed` "
    "only when you could not write a report."
)
RUNNING_NOTE = (
    "The worker runs in Orca. Start every other ready item, then end your turn: Orca wakes you when a "
    "worker reports, asks or stops. Then run `arbor.py sync` (it collects every settled worker) and "
    "`arbor.py next`. Answer a worker's question with `orca orchestration reply`. Never start the same "
    "dispatch twice and never do the role yourself."
)


def snapshot_dict(before: RefSnapshot) -> dict:
    return {**asdict(before), "dirty": sorted(before.dirty)}


def snapshot_from(data: dict) -> RefSnapshot:
    return RefSnapshot(data["head"], data["head_ref"], data["branches"], data["remotes"],
                       frozenset(data["dirty"]))


def spec_text(prompt: str, prompt_path: Path, reply_path: Path) -> str:
    """The worker's task spec: the dispatch header plus pointers to the
    assembled prompt file (often >100 KB, never inline) and the reply file."""
    header, _, _ = prompt.partition("\n\n")
    return f"{header}\nPrompt: {prompt_path}\nReport: {reply_path}\n\n{SPEC_NOTE}\n"


def request_path(main: Path, task: str, dispatch: str) -> Path:
    if not all(re.fullmatch(r"[\w.-]+", s) and s not in (".", "..") for s in (task, dispatch)):
        raise ExecutorError("invalid worker request path")
    return main / REQUESTS / task / f"{dispatch}.json"


def store(path: Path, record: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not write_json(path, record):
        raise ExecutorError(f"cannot write worker request {path}")


def load(main: Path, path: str) -> tuple[Path, dict]:
    resolved = Path(path).resolve()
    root = (main / REQUESTS).resolve()
    if not resolved.is_relative_to(root):
        raise ExecutorError(f"a worker request must be a driver-created {REQUESTS} file")
    record = json.loads(resolved.read_text(encoding="utf-8"))
    if record.get("schema") != 2 or record.get("main") != str(main):
        raise ExecutorError("worker request belongs to another checkout or schema")
    return resolved, record


def dispatch_id(record: dict) -> str | None:
    """Orca's Dispatch id of a started worker."""
    return (record.get("orca") or {}).get("dispatch_id")


def envelope(path: Path, record: dict) -> dict:
    started = dispatch_id(record)
    return {
        "needs": "worker", "dispatch": record["dispatch"], "role": record["role"],
        "request_path": str(path), "orca_dispatch": started,
        "prompt_path": record["prompt_path"], "reply_path": record["reply_path"],
        "timeout_s": record.get("timeout_s"), "started": record["started"],
        "instructions": RUNNING_NOTE if started else (
            f"The worker is not started. Unless another `arbor.py run` is starting it right now, "
            f"`arbor.py run --dispatch {record['dispatch']}` starts it."),
    }


def _call(executor: Executor, args: list[str], timeout: float = CALL_TIMEOUT_S) -> tuple[dict, str | None]:
    """Run one Orca CLI command with ``--json``: (its result object, why it failed)."""
    argv = [*shlex.split(executor.command), *args, "--json"]
    name = " ".join(args[:2])
    try:
        proc = subprocess.run(argv, capture_output=True, text=True, encoding="utf-8", errors="replace",
                              timeout=timeout)
    except FileNotFoundError:
        raise ExecutorError(f"Orca CLI not found: {executor.command!r} "
                            f"(set executors.{executor.name}.command in .arbor/config.yaml)") from None
    except subprocess.TimeoutExpired:
        return {}, f"`orca {name}` did not answer in {timeout:g}s"
    try:
        payload = json.loads(proc.stdout)
    except ValueError:
        payload = {}
    if not isinstance(payload, dict):
        payload = {}
    result = payload.get("result", payload)
    result = result if isinstance(result, dict) else {}
    if proc.returncode == 0 and payload.get("ok", True):
        return result, None
    error = payload.get("error")
    if isinstance(error, dict):
        error = error.get("message") or error.get("code")
    tail = (proc.stderr or proc.stdout).strip().splitlines()[-1:]
    return result, str(error or (tail[0] if tail else f"`orca {name}` exited {proc.returncode}"))


def start(executor: Executor, record: dict) -> tuple[dict | None, str | None]:
    """Start the worker of ``record``: (its Orca ids, None) once Orca accepted
    the dispatch, otherwise (ids when a Dispatch exists, why the start failed)."""
    launch = executor.launch(record["role"])
    args = ["orchestration", "worker-start", "--spec-file", record["spec_path"],
            "--task-title", f"{record['task']} {record['dispatch']} {record['role']}",
            "--worktree", f"path:{record['worktree']}", "--agent", launch.agent]
    if launch.model:
        args += ["--model", launch.model]
    if launch.effort:
        args += ["--effort", launch.effort]
    if executor.keep_open:
        args.append("--keep-open")
    result, error = _call(executor, args, START_TIMEOUT_S)
    ids = None
    if result.get("dispatchId"):
        ids = {"dispatch_id": result["dispatchId"], "task_id": result.get("taskId"),
               "run_id": result.get("runId") or (result.get("run") or {}).get("id"),
               "agent": launch.agent, "model": launch.model, "effort": launch.effort}
    # A start whose first turn was not observed yet is usually slow, not dead: Orca exits 0 for it.
    if ids and result.get("state") != "failed" and (error is None or result.get("state") == "outcome_unknown"):
        return ids, None
    stage = result.get("failedStage") or result.get("stage")
    why = f"worker-start failed{f' at {stage}' if stage else ''}: {result.get('lastError') or error or 'no Dispatch id'}"
    if ids:
        why += (f"; inspect `orca orchestration worker-show --dispatch {ids['dispatch_id']}` and release what "
                "it left before another start")
    return ids, why


def stop(executor: Executor, record: dict) -> None:
    _call(executor, ["orchestration", "worker-stop", "--dispatch", str(dispatch_id(record))])


def observe(executor: Executor, record: dict) -> tuple[str, str | None]:
    """A started worker now: ``("done", its last report)``, ``("failed", why)``,
    ``("waiting", what it waits for)`` (a prompt only a person can answer) or
    ``("running", None)``. A worker past the executor timeout is stopped."""
    orca_id = dispatch_id(record)
    # Orca >= 1.4.257 answers a concise view by default; `--full` carries dispatch/projection/observation.
    result, error = _call(executor, ["orchestration", "worker-show", "--dispatch", str(orca_id), "--full"])
    dispatch = result.get("dispatch")
    if not isinstance(dispatch, dict):
        raise ExecutorError(f"orca worker-show {orca_id}: {error or 'no dispatch in the answer'}")
    status = dispatch.get("status")
    last = result.get("lastReport") or (result.get("worker") or {}).get("lastError")
    if status == "completed":
        return "done", last
    if status in ("failed", "circuit_broken"):
        return "failed", f"the worker reported {status}" + (f": {last}" if last else "")
    wait = (result.get("observation") or {}).get("agentWait")
    if wait:
        return "waiting", str(wait.get("reason") or wait.get("source") or "a prompt")
    liveness = ((result.get("projection") or {}).get("liveness") or {}).get("verdict")
    if liveness == "exited":
        return "failed", "the worker exited without worker_done"
    timeout = record.get("timeout_s")
    if timeout and elapsed_s(record) > timeout:
        stop(executor, record)
        return "failed", f"timeout after {timeout:g}s (worker stopped)"
    return "running", None


def elapsed_s(record: dict) -> float:
    started = datetime.fromisoformat(record["started"].replace("Z", "+00:00"))
    return (datetime.now(timezone.utc) - started).total_seconds()


def result_of(record: dict, error: str | None) -> ExecResult:
    """The dispatch result: the reply file's text, and ``error`` when the
    worker did not finish."""
    reply_file = Path(record["reply_path"])
    reply = reply_file.read_text(encoding="utf-8", errors="replace") if reply_file.is_file() else ""
    return ExecResult(record["executor"], f"orca worker {dispatch_id(record) or '(not started)'}",
                      0 if error is None else 1, reply, "", record["started"], utc_now(),
                      round(elapsed_s(record), 3), error)


def register_worktree(config: dict, worktree: Path, parent: Path, name: str) -> None:
    """Show a driver-created worktree in Orca as a child workspace of
    ``parent``. Display only: a failure is a note, never an error."""
    try:
        _, error = _call(resolve_executor(config), [
            "worktree", "set", "--worktree", f"path:{worktree}",
            "--parent-worktree", f"path:{parent}", "--display-name", name], REGISTER_TIMEOUT_S)
    except ExecutorError as e:
        error = str(e)
    if error:
        print(f"Note: Orca does not show {worktree} under {parent}: {error}", file=sys.stderr)
