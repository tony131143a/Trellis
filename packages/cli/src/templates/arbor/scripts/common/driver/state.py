"""
The driver's state table, counters and progress rules (single partition).

``task.json`` carries the state; every function here mutates that dict and
nothing else (no git, no subprocesses), so ``arbor next`` stays cheap.

    state     step        needs    what happens next
    BUILD     test        brief    test -> red check: valid red -> implement,
                                   else decide (red_check: impl|tests|contract)
    BUILD     implement   brief    -> GATE (then REVIEW)
    GATE      gate        run      green -> after_gate; red -> decide (gate_red)
    GATE      fix|test    brief    -> GATE gate
    REVIEW    review      brief    review self-check: PASS -> FINISH (light) or
                                   POLISH; FAIL -> fix (round cap per tier)
    REVIEW    fix         brief    -> GATE -> REVIEW review (last_reviewed..HEAD)
    POLISH    simplify    brief    commit -> GATE -> candidates; No Change -> candidates
    POLISH    candidates  brief    N review candidates -> prefilter -> verify
    POLISH    verify      brief    PLAUSIBLE -> plausible; CONFIRMED -> fix; none -> FINISH
    POLISH    plausible   human    decide fix|skip
    POLISH    fix         brief    -> GATE -> next candidates round (cap 2)
    CONTRACT  approve     human    edit contract.md; ``arbor resume`` re-approves
    FINISH    finish      run      ``arbor finish``: scorecard, then PR or merge command
                          human    a person merges the task branch (``--no-ff``)
                          run      merged: ``arbor finish`` cleans up -> DONE
    STOP      -           human    ``arbor resume`` / ``override`` / ``abandon``

Progress (only the driver changes ``counters``): a GATE round progresses when
the failing id set shrinks or a previously failing check passes; a REVIEW /
POLISH round when its finding id set changes; a failed dispatch never does.
Two consecutive rounds without progress -> STOP(NO_PROGRESS); a round cap ->
STOP(BUDGET).
"""

from __future__ import annotations

from dataclasses import dataclass, field

STATES = ("CONTRACT", "BUILD", "GATE", "REVIEW", "POLISH", "FINISH", "DONE", "STOP")
STOP_REASONS = ("NO_PROGRESS", "BUDGET", "VIOLATION", "HUMAN")
DEFAULT_STEP = {
    "CONTRACT": "approve",
    "BUILD": "test",
    "GATE": "gate",
    "REVIEW": "review",
    "POLISH": "simplify",
    "FINISH": "finish",
    "DONE": "done",
    "STOP": "stop",
}
# Steps that dispatch a role: (state, step) -> role.
DISPATCH_STEPS = {
    ("BUILD", "test"): "test",
    ("BUILD", "implement"): "implement",
    ("GATE", "fix"): "fix",
    ("GATE", "test"): "test",
    ("REVIEW", "review"): "review",
    ("REVIEW", "fix"): "fix",
    ("POLISH", "simplify"): "simplify",
    ("POLISH", "candidates"): "review",
    ("POLISH", "verify"): "verify",
    ("POLISH", "fix"): "fix",
}
DECIDE_CHOICES = ("impl", "tests", "contract")
PLAUSIBLE_CHOICES = ("fix", "skip")

REVIEW_ROUND_CAP = {"light": 2, "standard": 1, "full": 1}
POLISH_ROUND_CAP = 2
GATE_RED_CAP = 4  # consecutive red gate rounds
CANDIDATE_READERS = {"standard": 2, "full": 3}
VERIFY_BATCH = 8
NO_PROGRESS_LIMIT = 2
NEW_COUNTERS = {"gate": 0, "review": 0, "polish": 0, "no_progress": 0}


class StateError(RuntimeError):
    """The requested action is not allowed in the current state."""


@dataclass
class Step:
    needs: str  # brief | run | decide | human | done
    summary: str
    role: str | None = None
    mode: str | None = None
    range_from: str | None = None  # sha; the driver appends ..<HEAD>
    decision: dict | None = None
    human: dict | None = None
    extra: dict = field(default_factory=dict)


# =============================================================================
# Fields
# =============================================================================


def ensure_fields(data: dict) -> dict:
    data.setdefault("state", "BUILD")
    counters = data.get("counters")
    if not isinstance(counters, dict):
        counters = data["counters"] = {}
    for key, value in NEW_COUNTERS.items():
        counters.setdefault(key, value)
    if not isinstance(data.get("dispatches"), list):
        data["dispatches"] = []
    data.setdefault("wave", 1)
    return data


def step_of(data: dict) -> str:
    return data.get("step") or DEFAULT_STEP.get(data.get("state", ""), "")


def goto(data: dict, state: str, step: str | None = None) -> None:
    data["state"] = state
    data["step"] = step or DEFAULT_STEP[state]
    data.pop("decision", None)


def stop(data: dict, reason: str, detail: str, **extra) -> None:
    """Enter STOP, remembering where to resume."""
    prev = {"state": data.get("state"), "step": step_of(data)}
    if data.get("state") == "STOP":
        prev = (data.get("stop") or {}).get("prev") or prev
    data["stop"] = {"reason": reason, "detail": detail, "prev": prev, **extra}
    data["state"] = "STOP"
    data["step"] = "stop"


def _cap(data: dict, counter: str, base: int) -> int:
    return base + int((data.get("caps_extra") or {}).get(counter, 0))


def _round(data: dict, progressed: bool, what: str) -> bool:
    """Count one round; True when it tripped STOP(NO_PROGRESS)."""
    counters = data["counters"]
    if progressed:
        counters["no_progress"] = 0
        return False
    counters["no_progress"] = counters.get("no_progress", 0) + 1
    if counters["no_progress"] >= NO_PROGRESS_LIMIT:
        stop(data, "NO_PROGRESS", f"{counters['no_progress']} consecutive rounds without progress ({what})")
        return True
    return False


# =============================================================================
# The state table (read-only)
# =============================================================================


def plan(data: dict, tier: str) -> Step:
    """The single next step for the task in ``data``."""
    state, step = data.get("state", ""), step_of(data)
    base = data.get("base")

    override = data.get("override_role")
    if isinstance(override, dict) and override.get("role") and state != "STOP":
        return Step("brief", f"{state} override: write the brief for role {override['role']}, then `arbor run`",
                    role=override["role"], mode=override.get("mode"), range_from=base)

    if state == "STOP":
        info = data.get("stop") or {}
        return Step("human", f"STOP ({info.get('reason', '?')}): {info.get('detail', '')} "
                    "-> `arbor resume`, `arbor override --reason`, or `arbor abandon`",
                    human={"kind": "stop", "reason": info.get("reason"), "detail": info.get("detail")})
    if state == "CONTRACT":
        return Step("human", "CONTRACT: revise contract.md; a human approves it with `arbor resume`",
                    human={"kind": "approve_contract"})
    if state == "FINISH":
        # The driver refines this with git (scorecard present? branch merged?).
        return Step("human", "FINISH: `arbor finish` (scorecard, then a PR or the merge command)",
                    human={"kind": "merge"})
    if state == "DONE":
        return Step("done", "DONE")

    decision = data.get("decision")
    if step == "decide" and isinstance(decision, dict):
        failing = ", ".join(decision.get("failing") or []) or "-"
        what = "red check" if decision.get("kind") == "red_check" else "gate red"
        return Step("decide", f"{state} {what} ({failing}): `arbor decide impl|tests|contract --reason ...`",
                    decision=decision)
    if step == "plausible":
        return Step("human", "POLISH: PLAUSIBLE findings need a human call: `arbor decide fix|skip --reason ...`",
                    human={"kind": "plausible"}, decision=decision)
    if state == "GATE" and step == "gate":
        return Step("run", "GATE: run `arbor gate` (project checks + contract auto checks)")

    role = DISPATCH_STEPS.get((state, step))
    if role is None:
        raise StateError(f"no step '{step}' in state {state}")
    mode = None
    range_from = base
    note = ""
    if state == "REVIEW" and step == "review":
        mode, range_from = "self-check", data.get("last_reviewed") or base
    elif step == "fix" and state in ("REVIEW", "POLISH"):
        range_from = data.get("review_from") or base
    elif step in ("candidates", "verify"):
        polish = data.get("polish") or {}
        range_from = polish.get("range_from") or base
        if step == "candidates":
            mode = "candidates"
            note = f" ({polish.get('candidates_done', 0) + 1}/{CANDIDATE_READERS.get(tier, 2)})"
        else:
            batches = polish.get("verify_batches", 1)
            note = f" (batch {polish.get('verify_done', 0) + 1}/{batches}; candidates in {polish.get('candidates_file')})"
    elif state == "GATE" and step == "fix":
        note = f" (failing: {', '.join(data.get('gate_failing') or []) or '-'}; tests are frozen)"
    return Step("brief", f"{state}: write the brief for role {role}{note}, then `arbor run`",
                role=role, mode=mode, range_from=range_from)


# =============================================================================
# Transitions
# =============================================================================


def on_dispatch_failed(data: dict, role: str) -> None:
    """A failed dispatch is a round without progress; the step repeats."""
    _round(data, False, f"{role} dispatch failed")


def on_violation(data: dict, role: str, dispatch: str, violations: list[str]) -> None:
    stop(data, "VIOLATION", f"{dispatch} ({role}) broke its boundary: {'; '.join(violations)}")


def on_red_check(data: dict, passing: list[str], errored: list[str]) -> None:
    """After a successful ``test`` dispatch in BUILD."""
    if not passing and not errored:
        goto(data, "BUILD", "implement")
        return
    data["step"] = "decide"
    data["decision"] = {
        "kind": "red_check",
        "options": list(DECIDE_CHOICES),
        "failing": sorted(set(passing) | set(errored)),
        "passing": passing,
        "errored": errored,
    }


def on_writer_done(data: dict, state: str, step: str, committed: bool) -> None:
    """After an ok writer dispatch (other than BUILD test)."""
    if state == "BUILD" and step == "implement":
        data["after_gate"] = {"state": "REVIEW", "step": "review"}
        goto(data, "GATE")
    elif state == "GATE":
        goto(data, "GATE")
    elif state == "REVIEW":
        data["after_gate"] = {"state": "REVIEW", "step": "review"}
        goto(data, "GATE")
    elif state == "POLISH" and step == "simplify":
        if committed:
            data["after_gate"] = {"state": "POLISH", "step": "candidates"}
            goto(data, "GATE")
        else:
            _start_polish_round(data)
    elif state == "POLISH" and step == "fix":
        data["after_gate"] = {"state": "POLISH", "step": "candidates"}
        goto(data, "GATE")


def on_gate(data: dict, failing: list[str]) -> None:
    """Record one gate run in GATE state."""
    counters = data["counters"]
    counters["gate"] = counters.get("gate", 0) + 1
    previous = data.get("gate_failing")
    data["gate_failing"] = list(failing)
    if not failing:
        data["gate_reds"] = 0
        counters["no_progress"] = 0
        dest = data.pop("after_gate", None) or {"state": "REVIEW", "step": "review"}
        if dest.get("step") == "candidates":
            if counters.get("polish", 0) >= _cap(data, "polish", POLISH_ROUND_CAP):
                stop(data, "BUDGET", f"POLISH round cap ({POLISH_ROUND_CAP}) reached with an unreviewed delta",
                     counter="polish")
                return
            _start_polish_round(data)
            return
        goto(data, dest["state"], dest.get("step"))
        return

    data["gate_reds"] = int(data.get("gate_reds", 0)) + 1
    progressed = previous is None or bool(set(previous) - set(failing)) or len(failing) < len(previous)
    if _round(data, progressed, f"gate failing {', '.join(failing)}"):
        return
    if data["gate_reds"] > _cap(data, "gate", GATE_RED_CAP):
        stop(data, "BUDGET", f"{data['gate_reds']} consecutive red gate rounds", counter="gate")
        return
    data["step"] = "decide"
    data["decision"] = {"kind": "gate_red", "options": list(DECIDE_CHOICES), "failing": list(failing)}


def on_review(data: dict, tier: str, verdict: str, finding_ids: list[str], range_from: str, range_to: str) -> None:
    """An ok review dispatch in REVIEW (self-check)."""
    counters = data["counters"]
    data["last_reviewed"] = range_to
    previous = data.get("review_ids")
    data["review_ids"] = sorted(finding_ids)
    if verdict == "PASS":
        counters["no_progress"] = 0
        if tier == "light":
            goto(data, "FINISH")
        else:
            goto(data, "POLISH", "simplify")
        return
    progressed = previous is None or set(previous) != set(finding_ids)
    if _round(data, progressed, "review findings unchanged"):
        return
    counters["review"] = counters.get("review", 0) + 1
    cap = _cap(data, "review", REVIEW_ROUND_CAP.get(tier, 1))
    data["review_from"] = range_from
    goto(data, "REVIEW", "fix")
    if counters["review"] > cap:
        # Resuming continues with the fix this review asked for.
        stop(data, "BUDGET", f"REVIEW round cap ({cap}) reached and the review still fails", counter="review")


def _start_polish_round(data: dict) -> None:
    rounds = data["counters"].get("polish", 0)
    base = data.get("base")
    data["polish"] = {
        "range_from": base if rounds == 0 else (data.get("last_reviewed") or base),
        "candidates_done": 0,
        "candidate_dispatches": [],
    }
    goto(data, "POLISH", "candidates")


def on_candidate(data: dict, tier: str, dispatch: str, range_to: str) -> bool:
    """One candidates review done; True when the round's readers are complete."""
    polish = data.setdefault("polish", {})
    polish["candidates_done"] = polish.get("candidates_done", 0) + 1
    polish.setdefault("candidate_dispatches", []).append(dispatch)
    polish["range_to"] = range_to
    return polish["candidates_done"] >= CANDIDATE_READERS.get(tier, 2)


def on_candidates_filtered(data: dict, kept_ids: list[str], candidates_file: str) -> None:
    """After the mechanical prefilter of one round's candidates."""
    counters = data["counters"]
    counters["polish"] = counters.get("polish", 0) + 1
    polish = data["polish"]
    data["last_reviewed"] = polish.get("range_to") or data.get("last_reviewed")
    data["review_from"] = polish.get("range_from")
    previous = data.get("polish_ids")
    data["polish_ids"] = sorted(kept_ids)
    if not kept_ids:
        counters["no_progress"] = 0
        goto(data, "FINISH")
        return
    progressed = previous is None or set(previous) != set(kept_ids)
    if _round(data, progressed, "polish candidates unchanged"):
        return
    polish.update({
        "candidates_file": candidates_file,
        "candidates": len(kept_ids),
        "verify_batches": -(-len(kept_ids) // VERIFY_BATCH),
        "verify_done": 0,
        "confirmed": [],
        "plausible": [],
    })
    goto(data, "POLISH", "verify")


def on_verify(data: dict, confirmed: list[str], plausible: list[str]) -> None:
    polish = data["polish"]
    polish["confirmed"] = polish.get("confirmed", []) + confirmed
    polish["plausible"] = polish.get("plausible", []) + plausible
    polish["verify_done"] = polish.get("verify_done", 0) + 1
    if polish["verify_done"] < polish.get("verify_batches", 1):
        return
    if polish["plausible"]:
        data["step"] = "plausible"
        data["decision"] = {"kind": "plausible", "options": list(PLAUSIBLE_CHOICES),
                            "failing": list(polish["plausible"])}
    elif polish["confirmed"]:
        polish["fix"] = list(polish["confirmed"])
        goto(data, "POLISH", "fix")
    else:
        goto(data, "FINISH")


def decide(data: dict, choice: str) -> dict:
    """Apply a ``decide`` choice; returns the decision it answered."""
    state, step = data.get("state"), step_of(data)
    decision = data.get("decision")
    if step == "plausible" and isinstance(decision, dict):
        if choice not in PLAUSIBLE_CHOICES:
            raise StateError(f"PLAUSIBLE findings take `decide fix|skip`, not {choice!r}")
        polish = data["polish"]
        fix = list(polish.get("confirmed", []))
        if choice == "fix":
            fix += polish.get("plausible", [])
        polish["fix"] = fix
        if fix:
            goto(data, "POLISH", "fix")
        else:
            goto(data, "FINISH")
        return decision
    if step != "decide" or not isinstance(decision, dict):
        raise StateError(f"nothing to decide in {state}/{step}")
    if choice not in DECIDE_CHOICES:
        raise StateError(f"expected one of {', '.join(DECIDE_CHOICES)}, got {choice!r}")

    if decision.get("kind") == "red_check":
        if choice == "impl":
            goto(data, "BUILD", "implement")
        elif choice == "tests":
            goto(data, "BUILD", "test")
        else:
            data["resume_to"] = {"state": "BUILD", "step": "test"}
            goto(data, "CONTRACT")
    else:
        if choice == "impl":
            goto(data, "GATE", "fix")
        elif choice == "tests":
            goto(data, "GATE", "test")
        else:
            data["resume_to"] = {"state": "GATE", "step": "gate"}
            goto(data, "CONTRACT")
    return decision


def resume(data: dict) -> str:
    """Leave STOP (back to where it stopped) or CONTRACT (after re-approval).
    Returns a one-line description."""
    state = data.get("state")
    if state == "STOP":
        info = data.pop("stop", None) or {}
        prev = info.get("prev") or {"state": "BUILD", "step": "test"}
        counter = info.get("counter")
        if info.get("reason") == "BUDGET" and counter:
            extra = data.setdefault("caps_extra", {})
            extra[counter] = int(extra.get(counter, 0)) + 1
        data["counters"]["no_progress"] = 0
        prev_state = prev.get("state") if prev.get("state") in DEFAULT_STEP else "BUILD"
        if prev_state == "STOP":
            prev_state = "BUILD"
        data["state"], data["step"] = prev_state, prev.get("step") or DEFAULT_STEP[prev_state]
        return f"resumed {data['state']}/{data['step']}"
    if state == "CONTRACT":
        dest = data.pop("resume_to", None) or {"state": "BUILD", "step": "test"}
        goto(data, dest["state"], dest.get("step"))
        data["counters"]["no_progress"] = 0
        return f"contract re-approved; resumed {data['state']}/{data['step']}"
    raise StateError(f"nothing to resume in {state}")
