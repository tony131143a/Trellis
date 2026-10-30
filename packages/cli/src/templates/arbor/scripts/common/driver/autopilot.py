"""
``arbor run --autopilot``: after contract approval and before the merge, keep
taking the next step while every rung is green.

Each iteration asks ``next``: ``needs: run`` runs it (gate, wave merge, or
``finish`` in FINISH); ``needs: brief`` dispatches when ``briefs/<id>.md``
exists or a role default ``briefs/default-<role>.md`` can be copied there.
Anything else stops it: a decision, a human gate (merge included), STOP, a
missing brief, a red gate, a non-ok dispatch, or the iteration cap. The
callbacks' own output is shown only when an iteration stops the loop.
"""

from __future__ import annotations

import contextlib
import io
import shutil
from pathlib import Path
from typing import Callable

MAX_ITERATIONS = 50


def default_brief(task_dir: Path, role: str | None) -> Path | None:
    path = task_dir / "briefs" / f"default-{role}.md"
    return path if role and path.is_file() else None


def _quiet(fn: Callable[[], int]) -> tuple[int, str]:
    out = io.StringIO()
    try:
        with contextlib.redirect_stdout(out):
            rc = fn()
    except Exception as e:  # the driver's own errors end the loop with their message
        return 1, out.getvalue() + f"Error: {e}\n"
    return rc, out.getvalue()


def run(next_payload: Callable[[], dict], run_step: Callable[[], int], finish: Callable[[], int],
        task_dir: Callable[[], Path], max_iterations: int = MAX_ITERATIONS) -> int:
    """0 when it stopped at a step that waits for a person or a brief; 1 on a
    red / failed / refused step or the iteration cap."""
    for i in range(1, max_iterations + 1):
        payload = next_payload()
        needs, state = payload.get("needs"), payload.get("state")
        label = f"[autopilot {i}] {state}"
        if payload.get("role"):
            label += f" {payload['role']}{'/' + payload['mode'] if payload.get('mode') else ''}"
            label += f" {payload.get('dispatch', '')}"

        if needs == "run":
            rc, output = _quiet(finish if state == "FINISH" else run_step)
        elif needs == "brief":
            brief = Path(payload["brief_path"])
            if not brief.is_file():
                fallback = default_brief(task_dir(), payload.get("role"))
                if fallback is None:
                    print(f"{label}: stop, no brief: write {brief} (or briefs/default-{payload.get('role')}.md)")
                    return 0
                brief.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(fallback, brief)
            rc, output = _quiet(run_step)
        else:
            print(f"{label}: stop, needs {needs}: {payload.get('summary', '')}")
            return 0

        if rc != 0:
            print(f"{label}: stop, {needs} failed")
            if output.strip():
                print(output.rstrip())
            return 1
        print(f"{label}: ok")
    print(f"[autopilot] stop: {max_iterations} iterations without reaching a gate")
    return 1
