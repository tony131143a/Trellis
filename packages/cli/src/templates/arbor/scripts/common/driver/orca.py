"""Orca workers: every role dispatch runs as one supervised Orca worker.

The driver prepares a durable request record, starts the worker itself
(``orca orchestration worker-start``) and later reads its state back
(``orca orchestration worker-show``). The worker writes its complete reply to
the request's reply file; Orca's ``worker_done`` only settles the dispatch.

Every worker of a task belongs to the task's Orca Run. A start carries the
record's request id (``--retry-request``), so starting the same record again
replays Orca's answer instead of starting a second worker. A start that
failed after Orca created its Dispatch is retried on the same Orca Task
(``--retry-of``).
"""
from __future__ import annotations

import json
import re
import shlex
import subprocess
import uuid
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path

from ..invariants import RefSnapshot
from ..io import write_json
from .executor import ExecResult, Executor, ExecutorError, utc_now

REQUESTS = ".arbor/.runtime/workers"
CALL_TIMEOUT_S = 60
# worker-start waits for the agent's composer before it sends the prompt.
START_TIMEOUT_S = 300
# Orca refuses a fourth start in one --retry-of chain; the dispatch then fails.
MAX_FAILED_STARTS = 3
# Orca shows a fresh worker as not working until its first turn is observed.
IDLE_GRACE_S = 60

SPEC_NOTE = (
    "Read the file named by `Prompt:` in full before doing anything else: it is your complete dispatch "
    "prompt (this header, your role instructions, the injected context and the brief).\n\n"
    "When the work is done, write your complete final report, in the exact format your role instructions "
    "define, to the file named by `Report:` (overwrite it). It is the only reply the Arbor driver reads, "
    "and the one file you may write outside your role's write boundary. Then send Orca's `worker_done` "
    "once, with `--report-path` set to that file. The driver takes the verdict from the report file, "
    "not from `--outcome`."
)
RUNNING_NOTE = (
    "The worker runs in Orca. Start every other ready item, then end your turn: Orca wakes you when a "
    "worker reports, asks or stops. Then run `arbor.py sync` (it collects every settled worker) and "
    "`arbor.py next`. Answer a worker's question with `orca orchestration reply`; a worker that stopped "
    "without reporting gets `orca orchestration send --to dispatch:<orca_dispatch>`. Never do the role yourself."
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
    failed = (record.get("failed_starts") or [{}])[-1].get("error")
    return {
        "needs": "worker", "dispatch": record["dispatch"], "role": record["role"],
        "request_path": str(path), "orca_dispatch": started,
        "prompt_path": record["prompt_path"], "reply_path": record["reply_path"],
        "timeout_s": record.get("timeout_s"), "started": record["started"],
        "instructions": RUNNING_NOTE if started else (
            (f"The last start failed ({failed}). Fix its cause, then " if failed else
             "The worker is not started. Unless another `arbor.py run` is starting it right now, ")
            + f"`arbor.py run --dispatch {record['dispatch']}` starts it."),
    }


def new_request_id() -> str:
    return str(uuid.uuid4())


def call(executor: Executor, args: list[str], timeout: float = CALL_TIMEOUT_S) -> tuple[dict, str | None]:
    """Run one Orca CLI command with ``--json``: (its result object, why it
    failed). The reason starts with Orca's error code when it gave one."""
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
        code, message = error.get("code"), error.get("message")
        error = f"{code}: {message}" if code and message and code != message else message or code
    tail = (proc.stderr or proc.stdout).strip().splitlines()[-1:]
    return result, str(error or (tail[0] if tail else f"`orca {name}` exited {proc.returncode}"))


def create_run(executor: Executor, task: str) -> str:
    """A new Orca Run for ``task``, bound to this coordinator (the agent
    session that runs the driver)."""
    result, error = call(executor, ["orchestration", "run-create", "--objective", f"arbor {task}"])
    if error or not result.get("runId"):
        raise ExecutorError(f"orca run-create failed: {error or 'no Run id in the answer'}")
    return str(result["runId"])


def start(executor: Executor, record: dict) -> tuple[dict | None, str | None]:
    """Start the worker of ``record``: (its Orca ids, None) once Orca accepted
    the dispatch, otherwise (ids when a Dispatch exists, why the start failed)."""
    agent = executor.agent_for(record["role"])
    retry = next((f for f in reversed(record.get("failed_starts") or []) if f.get("dispatch_id")), None)
    if retry:
        # The failed start may still hold its terminal; a retry does not clean it up.
        call(executor, ["orchestration", "worker-release", "--dispatch", retry["dispatch_id"]])
        what = ["--task", retry["task_id"], "--retry-of", retry["dispatch_id"]]
    else:
        what = ["--spec-file", record["spec_path"],
                "--task-title", f"{record['task']} {record['dispatch']} {record['role']}"]
    args = ["orchestration", "worker-start", *what, "--run", record["run"],
            "--worktree", f"path:{record['worktree']}", "--agent", agent]
    if executor.keep_open:
        args.append("--keep-open")

    def attempt(request_id: str) -> tuple[dict, str | None]:
        return call(executor, [*args, "--retry-request", request_id], START_TIMEOUT_S)

    result, error = attempt(record["request_id"])
    if error and error.startswith("consumer_fenced"):
        # Another agent session coordinated the task's Run: this one takes it over. Nothing was started.
        if call(executor, ["orchestration", "run-use", "--id", record["run"]])[1] is None:
            result, error = attempt(new_request_id())
    ids = None
    if result.get("dispatchId"):
        ids = {"dispatch_id": result["dispatchId"], "task_id": result.get("taskId"),
               "run_id": result.get("runId") or (result.get("run") or {}).get("id"),
               "agent": agent}
    # A start whose first turn was not observed yet is usually slow, not dead: Orca exits 0 for it.
    if ids and result.get("state") != "failed" and (error is None or result.get("state") == "outcome_unknown"):
        return {**ids, "started": utc_now()}, None
    stage = result.get("failedStage") or result.get("stage")
    last = " ".join(str(result.get("lastError") or error or "no Dispatch id").split())
    return ids, f"worker-start failed{f' at {stage}' if stage else ''}: {last}"


def stop(executor: Executor, record: dict) -> bool:
    """Stop the worker; True only when Orca proved it stopped (a request to
    stop is not proof: ``stop_unknown``)."""
    result, error = call(executor, ["orchestration", "worker-stop", "--dispatch", str(dispatch_id(record))])
    return error is None and (result.get("state") == "stopped" or bool(result.get("alreadySettled")))


def observe(executor: Executor, record: dict) -> tuple[str, str | None]:
    """A started worker now:

    - ``("done", None)``: it sent ``worker_done``
    - ``("failed", why)``: it reported failure, exited, or ran past the
      executor timeout and was stopped
    - ``("waiting", what)``: a prompt only a person can answer
    - ``("idle", None)``: its turn ended without ``worker_done``
    - ``("unstopped", why)``: past the timeout, and Orca could not prove the stop
    - ``("running", None)``
    """
    orca_id = dispatch_id(record)
    # Orca >= 1.4.257 answers a concise view by default; `--full` carries dispatch/projection/observation.
    result, error = call(executor, ["orchestration", "worker-show", "--dispatch", str(orca_id), "--full"])
    dispatch = result.get("dispatch")
    if not isinstance(dispatch, dict):
        raise ExecutorError(f"orca worker-show {orca_id}: {error or 'no dispatch in the answer'}")
    status = dispatch.get("status")
    if status == "completed":
        return "done", None
    if status in ("failed", "circuit_broken"):
        return "failed", f"the worker settled as {status}" + _failure(dispatch, result)
    wait = (result.get("observation") or {}).get("agentWait")
    if wait:
        return "waiting", str(wait.get("reason") or wait.get("source") or "a prompt")
    projection = result.get("projection") or {}
    if (projection.get("liveness") or {}).get("verdict") == "exited":
        return "failed", "the worker exited without worker_done"
    timeout = record.get("timeout_s")
    if timeout and elapsed_s(record) > timeout:
        if stop(executor, record):
            return "failed", f"timeout after {timeout:g}s (worker stopped)"
        return "unstopped", f"timeout after {timeout:g}s, and Orca could not prove the worker stopped"
    if (projection.get("stage") or {}).get("activity") == "done" and elapsed_s(record["orca"]) > IDLE_GRACE_S:
        return "idle", None
    return "running", None


def _failure(dispatch: dict, result: dict) -> str:
    """Why a settled Dispatch failed, as Orca recorded it."""
    try:
        last = json.loads(dispatch.get("lastFailure") or "null")
    except ValueError:
        last = dispatch.get("lastFailure")
    if isinstance(last, dict):
        last = last.get("subject") or last.get("body")
    last = last or dispatch.get("terminationReason") or (result.get("worker") or {}).get("lastError")
    return f": {last}" if last else ""


def elapsed_s(record: dict) -> float:
    started = datetime.fromisoformat(record["started"].replace("Z", "+00:00"))
    return (datetime.now(timezone.utc) - started).total_seconds()


def _reply(record: dict) -> str:
    reply_file = Path(record["reply_path"])
    return reply_file.read_text(encoding="utf-8", errors="replace") if reply_file.is_file() else ""


def has_reply(record: dict) -> bool:
    """The worker wrote its report to the reply file."""
    return bool(_reply(record).strip())


def result_of(record: dict, error: str | None) -> ExecResult:
    """The dispatch result: the reply file's text, and ``error`` when the
    worker did not finish."""
    reply = _reply(record)
    return ExecResult(record["executor"], f"orca worker {dispatch_id(record) or '(not started)'}",
                      0 if error is None else 1, reply, "", record["started"], utc_now(),
                      round(elapsed_s(record), 3), error)
