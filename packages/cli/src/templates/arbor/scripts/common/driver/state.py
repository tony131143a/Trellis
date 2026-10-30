"""
The driver's state table, counters and progress rules.

``task.json`` carries the state; every function here mutates that dict and
nothing else (no git, no subprocesses), so ``arbor next`` stays cheap.

    state     step        needs    what happens next
    BUILD     test        brief    test -> red check: valid red -> implement,
                                   else decide (red_check: impl|tests|contract)
    BUILD     implement   brief    -> GATE (then REVIEW)
    BUILD     partitions  (below)  a wave of named partitions, see "Waves"
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
    POLISH    sweep       brief    full only, once: review sweep base..HEAD ->
                                   prefilter -> verify -> fix -> GATE -> FINISH
    CONTRACT  approve     human    edit contract.md; ``arbor resume`` re-approves
    FINISH    finish      human    wave-3 finish (scorecard, PR, merge)
    STOP      -           human    ``arbor resume`` / ``override`` / ``abandon``

Progress (only the driver changes ``counters``): a GATE round progresses when
the failing id set shrinks or a previously failing check passes; a REVIEW /
POLISH round when its finding id set changes; a failed dispatch never does.
Two consecutive rounds without progress -> STOP(NO_PROGRESS); a round cap ->
STOP(BUDGET).

Waves. ``wave`` indexes the contract's Waves. A wave that is just
``[default]`` runs on the task branch with the BUILD rows above. Any other
wave runs each partition in its own worktree; ``partitions[<name>]`` holds
``wave, branch, worktree, base, step, next_dispatch, running, counters,
dispatches, merged`` and the partition steps are

    step       needs    what happens next
    -          run      `arbor run` creates the partition worktrees
    test       brief    -> red check of the partition's own auto checks:
                           valid -> implement, else decide (red_check)
    implement  brief    -> done
    decide     decide   impl | tests | contract (``--partition``)
    done       -        every partition done -> run: merge wave N --no-ff,
                        in wave order; conflict -> human (merge_conflict),
                        ``arbor resume`` once merged by hand
    (merged)   -        remove the worktrees; next wave -> BUILD, last -> GATE

Partitions run in parallel: ``plan`` returns the first partition that needs
something plus ``pending`` (others that need a brief now). Each partition
gets its dispatch id when it enters a brief step (``next_dispatch``, filled
by the caller under the task lock), so parallel runs never collide. Failed
dispatches count against the partition's own ``no_progress``.
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
    ("POLISH", "sweep"): "review",
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
DEFAULT_PARTITION = "default"
PARTITION_BRIEF_STEPS = ("test", "implement")
PARTITION_DONE = "done"


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
    partition: str | None = None  # the partition this step belongs to (None: the task branch)
    dispatch: str | None = None  # pre-assigned dispatch id (partition steps)
    pending: list[str] = field(default_factory=list)  # other partitions needing a brief now
    action: str | None = None  # needs=run: gate | start_wave | merge


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


def _round(data: dict, progressed: bool, what: str, counters: dict | None = None) -> bool:
    """Count one round; True when it tripped STOP(NO_PROGRESS)."""
    counters = data["counters"] if counters is None else counters
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


def plan(data: dict, tier: str, waves=None, partition: str | None = None) -> Step:
    """The single next step for the task in ``data``. ``waves`` are the
    contract's waves (default: one ``[default]`` wave); ``partition`` asks
    for that partition's step in a multi-partition wave."""
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
        return Step("human", "FINISH: ready for wave-3 finish (scorecard, PR, merge)", human={"kind": "merge"})
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
    if state == "BUILD":
        parts = wave_partitions(waves, data.get("wave", 1))
        if is_partitioned(parts):
            return _plan_wave(data, parts, partition)
    if partition not in (None, DEFAULT_PARTITION):
        raise StateError(f"{state}/{step} has no partition {partition!r}")
    if state == "GATE" and step == "gate":
        return Step("run", "GATE: run `arbor gate` (project checks + contract auto checks)", action="gate")

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
    elif step == "sweep":
        mode, range_from = "sweep", (data.get("polish") or {}).get("range_from") or base
        note = " (Mode: sweep over the whole task range, once)"
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


def wave_partitions(waves, wave: int) -> tuple[str, ...]:
    """Partition names of wave ``wave`` (1-based); () past the last wave."""
    waves = tuple(waves or ((DEFAULT_PARTITION,),))
    return tuple(waves[wave - 1]) if 1 <= wave <= len(waves) else ()


def is_partitioned(parts) -> bool:
    """A wave runs in partition worktrees unless it is exactly ``[default]``."""
    return bool(parts) and tuple(parts) != (DEFAULT_PARTITION,)


def wave_started(data: dict, parts) -> bool:
    records = data.get("partitions") or {}
    wave = data.get("wave", 1)
    return bool(parts) and all((records.get(p) or {}).get("wave") == wave for p in parts)


def _running(records: dict, names) -> str:
    return ", ".join(f"{records[p]['running'].get('dispatch')} ({p})" for p in names if records[p].get("running"))


def _plan_partition(data: dict, name: str) -> Step:
    rec = data["partitions"][name]
    step = rec.get("step")
    if step == "decide":
        decision = rec.get("decision") or {}
        failing = ", ".join(decision.get("failing") or []) or "-"
        return Step("decide", f"BUILD {name} red check ({failing}): "
                    f"`arbor decide impl|tests|contract --partition {name} --reason ...`",
                    decision=decision, partition=name)
    if step not in PARTITION_BRIEF_STEPS:
        raise StateError(f"partition {name} has no step '{step}'")
    return Step("brief", f"BUILD {name}: write the brief for role {step}, then `arbor run --partition {name}`",
                role=step, range_from=data.get("base"), partition=name, dispatch=rec.get("next_dispatch"))


def _plan_wave(data: dict, parts: tuple[str, ...], partition: str | None) -> Step:
    wave = data.get("wave", 1)
    if partition is not None and partition not in parts:
        raise StateError(f"wave {wave} has no partition {partition!r} (it runs {', '.join(parts)})")
    if not wave_started(data, parts):
        return Step("run", f"BUILD wave {wave}: `arbor run` creates the partition worktrees ({', '.join(parts)})",
                    action="start_wave")
    conflict = data.get("merge_conflict")
    if isinstance(conflict, dict):
        files = ", ".join(conflict.get("files") or []) or "-"
        return Step("human", f"BUILD wave {wave}: merging {conflict.get('branch')} into {conflict.get('into')} "
                    f"conflicts ({files}); merge it by hand in the task worktree, commit, then `arbor resume`",
                    human={"kind": "merge_conflict", **conflict}, partition=conflict.get("partition"))
    records = data["partitions"]
    if all(records[p].get("step") == PARTITION_DONE for p in parts):
        return Step("run", f"BUILD merge wave {wave}: `arbor run` merges {', '.join(parts)} into the task branch",
                    action="merge")
    ready = [p for p in parts if not records[p].get("running") and records[p].get("step") != PARTITION_DONE]
    if partition is not None:
        rec = records[partition]
        if rec.get("running"):
            return Step("wait", f"BUILD {partition}: {rec['running'].get('dispatch')} is running", partition=partition)
        if rec.get("step") == PARTITION_DONE:
            others = _running(records, parts) or ", ".join(ready)
            return Step("wait", f"BUILD {partition}: done; the wave waits for {others}", partition=partition)
        chosen = partition
    elif ready:
        chosen = ready[0]
    else:
        return Step("wait", f"BUILD wave {wave}: waiting for {_running(records, parts)}")
    step = _plan_partition(data, chosen)
    step.pending = [p for p in ready if p != chosen and records[p].get("step") in PARTITION_BRIEF_STEPS]
    return step


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
        if (data.get("polish") or {}).get("sweep"):
            data["after_gate"] = {"state": "FINISH"}
        else:
            data["after_gate"] = {"state": "POLISH", "step": "candidates"}
        goto(data, "GATE")


def on_gate(data: dict, failing: list[str], tier: str | None = None) -> None:
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
                if tier == "full" and not data.get("sweep_done"):
                    _polish_done(data, tier)  # the sweep covers the unreviewed delta
                    return
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


def _polish_done(data: dict, tier: str | None) -> None:
    """The candidate cycle is over (gate green): full runs its one sweep first."""
    if tier == "full" and not data.get("sweep_done"):
        data["polish"] = {"sweep": True, "range_from": data.get("base")}
        goto(data, "POLISH", "sweep")
    else:
        goto(data, "FINISH")


def _start_verify(data: dict, kept_ids: list[str], candidates_file: str) -> None:
    data["polish"].update({
        "candidates_file": candidates_file,
        "candidates": len(kept_ids),
        "verify_batches": -(-len(kept_ids) // VERIFY_BATCH),
        "verify_done": 0,
        "confirmed": [],
        "plausible": [],
    })
    goto(data, "POLISH", "verify")


def on_sweep_filtered(data: dict, kept_ids: list[str], candidates_file: str, range_to: str) -> None:
    """After the sweep review and its prefilter; the sweep never repeats."""
    data["sweep_done"] = True
    polish = data.setdefault("polish", {"sweep": True, "range_from": data.get("base")})
    polish["range_to"] = range_to
    data["last_reviewed"] = range_to
    data["review_from"] = polish.get("range_from")
    data["sweep_ids"] = sorted(kept_ids)
    data["counters"]["no_progress"] = 0
    if not kept_ids:
        goto(data, "FINISH")
        return
    _start_verify(data, kept_ids, candidates_file)


def on_candidates_filtered(data: dict, kept_ids: list[str], candidates_file: str, tier: str | None = None) -> None:
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
        _polish_done(data, tier)
        return
    progressed = previous is None or set(previous) != set(kept_ids)
    if _round(data, progressed, "polish candidates unchanged"):
        return
    _start_verify(data, kept_ids, candidates_file)


def on_verify(data: dict, confirmed: list[str], plausible: list[str], tier: str | None = None) -> None:
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
        _polish_done(data, tier)


def decide(data: dict, choice: str, tier: str | None = None, partition: str | None = None) -> dict:
    """Apply a ``decide`` choice; returns the decision it answered.
    ``partition`` picks a partition's red-check decision (default: the first
    partition waiting for one)."""
    state, step = data.get("state"), step_of(data)
    if state == "BUILD" and step == "partitions":
        return _decide_partition(data, choice, partition)
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
            _polish_done(data, tier)
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


# =============================================================================
# Waves (multi-partition BUILD)
# =============================================================================


def on_wave_started(data: dict, records: dict[str, dict]) -> None:
    """``records``: name -> {branch, worktree, base, step} in wave order."""
    wave = data.get("wave", 1)
    data["partitions"] = {
        name: {"wave": wave, **rec, "next_dispatch": None, "counters": {"no_progress": 0}, "dispatches": []}
        for name, rec in records.items()
    }
    data.pop("merge_conflict", None)
    goto(data, "BUILD", "partitions")


def unassigned_partitions(data: dict) -> list[str]:
    """Partitions in a brief step without a dispatch id yet (wave order)."""
    return [
        name for name, rec in (data.get("partitions") or {}).items()
        if rec.get("step") in PARTITION_BRIEF_STEPS and not rec.get("running") and not rec.get("next_dispatch")
    ]


def on_partition_dispatch(data: dict, name: str, dispatch: str, pid: int) -> None:
    rec = data["partitions"][name]
    rec["running"] = {"dispatch": dispatch, "pid": pid}
    rec["next_dispatch"] = None
    rec.setdefault("dispatches", []).append(dispatch)


def on_partition_finished(data: dict, name: str) -> None:
    """The dispatch ended (any outcome); apply the outcome separately."""
    data["partitions"][name].pop("running", None)


def reap_stale(data: dict, alive) -> list[str]:
    """Clear ``running`` markers whose run process is gone (``alive(pid)`` is
    False); their dispatch entries become ``aborted``. Returns their ids."""
    reaped: list[str] = []
    for rec in (data.get("partitions") or {}).values():
        running = rec.get("running")
        if isinstance(running, dict) and not alive(int(running.get("pid") or 0)):
            rec.pop("running")
            reaped.append(str(running.get("dispatch")))
    for entry in data.get("dispatches") or []:
        if entry.get("id") in reaped and entry.get("status") == "running":
            entry["status"] = "aborted"
    return reaped


def on_partition_failed(data: dict, name: str, role: str) -> None:
    """A failed partition dispatch: a round without progress for that partition."""
    rec = data["partitions"][name]
    rec.setdefault("counters", {"no_progress": 0})
    if not _round(data, False, f"{name}: {role} dispatch failed", rec["counters"]):
        return
    # _round stopped on the partition counter; resuming starts it from zero.
    rec["counters"]["no_progress"] = 0


def on_partition_red_check(data: dict, name: str, passing: list[str], errored: list[str]) -> None:
    rec = data["partitions"][name]
    rec["counters"]["no_progress"] = 0
    if not passing and not errored:
        rec["step"] = "implement"
        rec.pop("decision", None)
        return
    rec["step"] = "decide"
    rec["decision"] = {
        "kind": "red_check",
        "partition": name,
        "options": list(DECIDE_CHOICES),
        "failing": sorted(set(passing) | set(errored)),
        "passing": passing,
        "errored": errored,
    }


def on_partition_implemented(data: dict, name: str) -> None:
    rec = data["partitions"][name]
    rec["counters"]["no_progress"] = 0
    rec["step"] = PARTITION_DONE


def _decide_partition(data: dict, choice: str, partition: str | None) -> dict:
    records = data.get("partitions") or {}
    waiting = [n for n, r in records.items() if r.get("step") == "decide"]
    name = partition or (waiting[0] if waiting else None)
    if name is None or name not in waiting:
        raise StateError(f"no red-check decision pending{' for partition ' + partition if partition else ''}")
    if choice not in DECIDE_CHOICES:
        raise StateError(f"expected one of {', '.join(DECIDE_CHOICES)}, got {choice!r}")
    rec = records[name]
    decision = rec.pop("decision")
    rec["step"] = "implement" if choice == "impl" else "test"
    if choice == "contract":
        data["resume_to"] = {"state": "BUILD", "step": "partitions"}
        goto(data, "CONTRACT")
    return decision


def on_partition_merged(data: dict, name: str, sha: str) -> None:
    data["partitions"][name]["merged"] = sha


def on_merge_conflict(data: dict, conflict: dict) -> None:
    data["merge_conflict"] = dict(conflict)


def on_conflict_resolved(data: dict, sha: str) -> str:
    """The human merged the conflicting partition; returns its name."""
    conflict = data.pop("merge_conflict")
    on_partition_merged(data, conflict["partition"], sha)
    return conflict["partition"]


def on_wave_merged(data: dict, wave_count: int) -> None:
    """Every partition of the wave is merged and its worktree removed."""
    wave = data.get("wave", 1)
    data.setdefault("wave_history", []).append({
        "wave": wave,
        "partitions": {
            name: {"branch": rec.get("branch"), "base": rec.get("base"), "merge": rec.get("merged"),
                   "dispatches": rec.get("dispatches", [])}
            for name, rec in (data.get("partitions") or {}).items()
        },
    })
    data["partitions"] = {}
    data.pop("merge_conflict", None)
    if wave < wave_count:
        data["wave"] = wave + 1
        goto(data, "BUILD")
    else:
        data["after_gate"] = {"state": "REVIEW", "step": "review"}
        goto(data, "GATE")
