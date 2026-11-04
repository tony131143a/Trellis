"""
The driver's state table, counters and progress rules.

``task.json`` carries the state; every function here mutates that dict and
nothing else (no git, no subprocesses), so ``arbor next`` stays cheap.

    state     step        needs    what happens next
    BUILD     implement   brief    implement (code + tests, auto checks green) -> GATE
    BUILD     partitions  (below)  a wave of named partitions, see "Waves"
    GATE      gate        run      green -> after_gate; red -> decide (impl|contract)
    GATE      fix         brief    -> GATE gate
    REVIEW    review      brief    one review self-check over last_reviewed..HEAD (light
                                   entry; every tier after a fix): PASS -> FINISH (full:
                                   sweep first); FAIL -> fix (round cap)
    REVIEW    candidates  brief    standard / full entry: N review candidates -> prefilter
                                   -> verify
    REVIEW    verify      brief    PLAUSIBLE -> plausible; CONFIRMED (with a repro, else
                                   read as PLAUSIBLE) -> fix; none -> FINISH
    REVIEW    plausible   human    decide fix|skip
    REVIEW    fix         brief    -> GATE -> recheck: the fix delta (last_reviewed..HEAD)
                                   within ``recheck_max_lines`` -> review (self-check);
                                   larger -> candidates; small and every fixed finding's
                                   exec repro passed as REPRO-n in that gate -> FINISH
                                   (full: sweep) without the self-check
    REVIEW    sweep       brief    full only, once: review sweep base..HEAD ->
                                   prefilter -> verify -> fix -> GATE -> recheck

A child started on its parent's integration branch carries ``review_deferred``:
BUILD -> GATE -> FINISH, and the parent reviews every child at once on the
integration branch (``task.py integrate``). ``simplify`` is no longer a step of
its own; ``arbor override --role simplify`` runs it on demand.
    CONTRACT  approve     human    edit contract.md; ``arbor resume`` re-approves
    FINISH    finish      run      ``arbor finish``: scorecard, then PR or merge command
                          human    a person merges the task branch (``--no-ff``)
                          run      merged: ``arbor finish`` cleans up -> DONE
    STOP      -           human    ``arbor resume`` / ``override`` / ``abandon``

Escalation. A light task becomes standard (``meta.tier``, ``tier_history``)
when ``maybe_escalate`` sees a signal: two consecutive red gates, an implement
report Partial / Blocked, or at a BUILD gate a diff over ESCALATE_MAX_LINES
lines or over more than one configured package. The green gate then enters
REVIEW the standard way (candidates -> verify). ``meta.tier_lock`` opts out.

Reader batches. REVIEW candidates (``CANDIDATE_READERS`` per tier) and
REVIEW verify (one per batch of 8) are read-only readers of the same range:
when the step opens, the caller assigns every reader its dispatch id under
the task lock (``batch.ids``, like a partition's ``next_dispatch``) and the
readers may run concurrently; ``batch.running`` holds the ones in flight.
The step completes when all of them are done.

Progress (only the driver changes ``counters``): a GATE round progresses when
the failing id set shrinks or a previously failing check passes; a REVIEW
round when its finding id set changes; a failed dispatch never does.
Counters describe history for the main agent. They do not automatically STOP
execution; legacy STOP records and explicit abandon remain supported.

Waves. ``wave`` indexes the contract's Waves. A wave that is just
``[default]`` runs on the task branch with the BUILD rows above. Any other
wave runs each partition in its own worktree; ``partitions[<name>]`` holds
``wave, branch, worktree, base, step, next_dispatch, running, counters,
dispatches, merged`` and the partition steps are

    step       needs    what happens next
    -          run      `arbor run` creates the partition worktrees
    implement  brief    -> done
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
from typing import Sequence

STATES = ("CONTRACT", "BUILD", "GATE", "REVIEW", "FINISH", "DONE", "STOP")
STOP_REASONS = ("NO_PROGRESS", "BUDGET", "VIOLATION", "HUMAN")
DEFAULT_STEP = {
    "CONTRACT": "approve",
    "BUILD": "implement",
    "GATE": "gate",
    "REVIEW": "review",
    "FINISH": "finish",
    "DONE": "done",
    "STOP": "stop",
}
# Steps that dispatch a role: (state, step) -> role.
DISPATCH_STEPS = {
    ("BUILD", "implement"): "implement",
    ("GATE", "fix"): "fix",
    ("REVIEW", "review"): "review",
    ("REVIEW", "candidates"): "review",
    ("REVIEW", "verify"): "verify",
    ("REVIEW", "fix"): "fix",
    ("REVIEW", "sweep"): "review",
}
DECIDE_CHOICES = ("impl", "contract")
PLAUSIBLE_CHOICES = ("fix", "skip")

REVIEW_ROUND_CAP = 2  # fix rounds, every tier
GATE_RED_CAP = 4  # consecutive red gate rounds
RECHECK_MAX_LINES = 200  # a fix delta up to this many lines is re-reviewed by one self-check reader
CANDIDATE_READERS = {"standard": 2, "full": 3}
BATCH_STEPS = (("REVIEW", "candidates"), ("REVIEW", "verify"))
VERIFY_BATCH = 8
NO_PROGRESS_LIMIT = 2
NEW_COUNTERS = {"gate": 0, "review": 0, "no_progress": 0}
# One-way light -> standard escalation (``maybe_escalate``).
ESCALATE_GATE_REDS = 2  # consecutive red gates
ESCALATE_MAX_LINES = 300  # changed lines of base..HEAD at a BUILD gate
ESCALATE_STATUSES = ("Partial", "Blocked")  # implement report status
DEFAULT_PARTITION = "default"
PARTITION_BRIEF_STEPS = ("implement",)
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
    batch: list[str] = field(default_factory=list)  # reader ids of this step that may run concurrently


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


def review_entry(tier: str | None) -> str:
    """The first REVIEW step of a tier: light one self-check, the others the candidate readers."""
    return "review" if tier == "light" else "candidates"


def tier_locked(data: dict) -> bool:
    """``meta.tier_lock`` (``task.py set-meta <task> tier_lock true``) keeps the tier."""
    lock = (data.get("meta") or {}).get("tier_lock")
    return lock is True or str(lock).strip().lower() in ("1", "true", "yes", "on")


def maybe_escalate(data: dict, tier: str | None, signals: dict) -> str | None:
    """Promote a light task to standard when it proves bigger than planned;
    returns the new tier, None when nothing changes. Signals, first match wins:
    ``gate_reds`` >= ESCALATE_GATE_REDS, ``implement_status`` in
    ESCALATE_STATUSES, ``changed_lines`` > ESCALATE_MAX_LINES, ``packages``
    (names) spanning more than one. One way only; never for a locked tier or a
    child whose review is deferred to its parent."""
    if tier != "light" or tier_locked(data) or data.get("review_deferred"):
        return None
    status = str(signals.get("implement_status") or "")
    packages = list(signals.get("packages") or [])
    if int(signals.get("gate_reds") or 0) >= ESCALATE_GATE_REDS:
        signal, detail = "gate_reds", f"{signals['gate_reds']} consecutive red gates"
    elif status.capitalize() in ESCALATE_STATUSES:
        signal, detail = f"implement_{status.lower()}", f"implement reported {status.capitalize()}"
    elif int(signals.get("changed_lines") or 0) > ESCALATE_MAX_LINES:
        signal, detail = "diff_lines", f"{signals['changed_lines']} changed lines (> {ESCALATE_MAX_LINES})"
    elif len(packages) > 1:
        signal, detail = "packages", f"changes span packages {', '.join(packages)}"
    else:
        return None
    data.setdefault("meta", {})["tier"] = "standard"
    data.setdefault("tier_history", []).append({
        "from": "light", "to": "standard", "signal": signal, "detail": detail, "at": signals.get("at") or "",
    })
    return "standard"


def after_build(data: dict, tier: str | None) -> dict:
    """Where a green gate goes once BUILD is done: a child with a deferred review
    (its parent reviews the integration branch) finishes; everything else enters REVIEW."""
    if data.get("review_deferred"):
        return {"state": "FINISH"}
    return {"state": "REVIEW", "step": review_entry(tier)}


def goto(data: dict, state: str, step: str | None = None) -> None:
    data["state"] = state
    data["step"] = step or DEFAULT_STEP[state]
    data.pop("decision", None)
    data.pop("batch", None)


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
    if counters["no_progress"] >= _cap(data, "no_progress", NO_PROGRESS_LIMIT):
        stop(data, "NO_PROGRESS", what, counter="no_progress")
        return True
    return False


def _budget(data: dict, counter: str, value: int, base: int, what: str) -> bool:
    """STOP(BUDGET) when a round counter passed its cap (``caps_extra`` raises it)."""
    cap = _cap(data, counter, base)
    if value > cap:
        stop(data, "BUDGET", f"{what} ({value} > {cap}); resume grants one more round",
             counter=counter, value=value, cap=cap)
        return True
    return False


# =============================================================================
# Reader batches
# =============================================================================


def step_key(data: dict) -> str:
    return f"{data.get('state')}/{step_of(data)}"


def batch_of(data: dict) -> dict:
    """The reader batch of the current step ({} when there is none)."""
    batch = data.get("batch")
    return batch if isinstance(batch, dict) and batch.get("key") == step_key(data) else {}


def batch_size(data: dict, tier: str | None) -> int:
    """How many readers the current step has in all (0: not a reader step)."""
    key = (data.get("state"), step_of(data))
    if key not in BATCH_STEPS or data.get("override_role"):
        return 0
    if key == ("REVIEW", "candidates"):
        return CANDIDATE_READERS.get(tier or "", 2)
    return int((data.get("cycle") or {}).get("verify_batches", 1))


def _batch_done(data: dict) -> int:
    key = (data.get("state"), step_of(data))
    cycle = data.get("cycle") or {}
    return int(cycle.get("candidates_done" if key == ("REVIEW", "candidates") else "verify_done", 0))


def unassigned_batch(data: dict, tier: str | None) -> int:
    """Readers of the current step that still need a dispatch id."""
    size = batch_size(data, tier)
    if not size:
        return 0
    batch = batch_of(data)
    key = step_key(data)
    judged = sum(1 for p in (data.get("report_pending") or {}).values()
                 if f"{(p.get('job') or {}).get('state')}/{(p.get('job') or {}).get('step')}" == key)
    return max(0, size - _batch_done(data) - len(batch.get("ids") or []) - len(batch.get("running") or {}) - judged)


def on_batch_assigned(data: dict, ids: list[str]) -> None:
    batch = batch_of(data) or {"key": step_key(data), "ids": [], "running": {}}
    batch["ids"] = list(batch.get("ids") or []) + list(ids)
    data["batch"] = batch


def on_batch_dispatch(data: dict, dispatch: str, pid: int, force: bool = False) -> bool:
    """A reader of the current batch starts; False when ``dispatch`` is not one
    (``force``: count it anyway, e.g. a reader of a task upgraded mid-step)."""
    batch = batch_of(data)
    if dispatch not in (batch.get("ids") or []):
        if not force:
            return False
        batch = batch or {"key": step_key(data), "ids": [], "running": {}}
        data["batch"] = batch
    else:
        batch["ids"].remove(dispatch)
    batch.setdefault("running", {})[dispatch] = {"pid": pid}
    return True


def on_batch_finished(data: dict, dispatch: str) -> None:
    batch = data.get("batch")
    if isinstance(batch, dict):
        (batch.get("running") or {}).pop(dispatch, None)


# =============================================================================
# The state table (read-only)
# =============================================================================


def plan(data: dict, tier: str, waves=None, partition: str | None = None) -> Step:
    """The single next step for the task in ``data``. ``waves`` are the
    contract's waves (default: one ``[default]`` wave); ``partition`` asks
    for that partition's step in a multi-partition wave."""
    state, step = data.get("state", ""), step_of(data)
    base = data.get("base")

    pending = data.get("report_pending") or {}
    if pending and state != "STOP":
        dispatch = next(iter(pending))
        return Step("decide", f"Report {dispatch} needs main-agent judgment: "
                    "`arbor decide accept --report <interpretation> --reason ...` or "
                    "`arbor decide retry --reason ...`; do not ask the user for routine interpretation",
                    decision={"kind": "report", "dispatch": dispatch, "options": ["accept", "retry"]})
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
        return Step("decide", f"{state} gate red ({failing}): `arbor decide impl|contract --reason ...`",
                    decision=decision)
    if step == "plausible":
        return Step("human", "REVIEW: PLAUSIBLE findings need a human call: `arbor decide fix|skip --reason ...`",
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
    batch = batch_of(data) if (state, step) in BATCH_STEPS else {}
    ids = list(batch.get("ids") or [])
    if not ids and batch.get("running"):
        return Step("wait", f"{state} {step}: waiting for {', '.join(sorted(batch['running']))}")
    mode = None
    range_from = base
    note = ""
    cycle = data.get("cycle") or {}
    if state == "REVIEW" and step == "review":
        mode, range_from = "self-check", data.get("last_reviewed") or base
    elif state == "REVIEW" and step == "fix":
        range_from = data.get("review_from") or base
    elif step == "sweep":
        mode, range_from = "sweep", cycle.get("range_from") or base
        note = " (Mode: sweep over the whole task range, once)"
    elif step in ("candidates", "verify"):
        range_from = cycle.get("range_from") or base
        if step == "candidates":
            mode = "candidates"
            note = f" ({cycle.get('candidates_done', 0) + 1}/{CANDIDATE_READERS.get(tier, 2)})"
        else:
            batches = cycle.get("verify_batches", 1)
            note = f" (batch {cycle.get('verify_done', 0) + 1}/{batches}; candidates in {cycle.get('candidates_file')})"
    elif state == "GATE" and step == "fix":
        note = f" (failing: {', '.join(data.get('gate_failing') or []) or '-'})"
    if len(ids) > 1:
        note += (f"; readers {', '.join(ids)} may run concurrently: write each brief, then "
                 "`arbor run --dispatch <id>` for each")
    return Step("brief", f"{state}: write the brief for role {role}{note}, then `arbor run`",
                role=role, mode=mode, range_from=range_from, dispatch=ids[0] if ids else None, batch=ids)


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
        if conflict.get("reason") == "scope":
            return Step("human", f"BUILD wave {wave}: partition {conflict.get('partition')} changed files outside "
                        f"its paths ({files}); ask the user: revert them on {conflict.get('branch')} or merge it by "
                        "hand in the task worktree to accept them, then `arbor resume`",
                        human={"kind": "merge_conflict", **conflict}, partition=conflict.get("partition"))
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
    data.setdefault("observations", []).append({"dispatch": dispatch, "role": role, "changes": violations})


def on_writer_done(data: dict, state: str, step: str, committed: bool, tier: str | None,
                   verdict: str | None = None, at: str = "") -> None:
    """After an ok writer dispatch; ``verdict`` is the report's status word."""
    if state == "BUILD" and step == "implement":
        tier = maybe_escalate(data, tier, {"implement_status": verdict, "at": at}) or tier
        data["after_gate"] = after_build(data, tier)
        goto(data, "GATE")
    elif state == "GATE":
        goto(data, "GATE")
    elif state == "REVIEW" and step == "fix":
        data["after_gate"] = {"state": "REVIEW", "step": "recheck"}  # re-review the fix delta
        goto(data, "GATE")


def on_gate(data: dict, failing: list[str], tier: str | None = None, *,
            delta_lines: int | None = None, recheck_max_lines: int = RECHECK_MAX_LINES,
            repros_run: Sequence[str] = (), head: str | None = None,
            signals: dict | None = None) -> None:
    """Record one gate run in GATE state. ``delta_lines`` is the size of
    ``last_reviewed..HEAD`` when the gate follows a fix (step ``recheck``): a
    delta within ``recheck_max_lines`` goes to one self-check reader, a larger
    one to a full candidate cycle. ``repros_run`` are the finding ids whose
    ``exec`` repro ran in this gate: when they cover every fixed finding and the
    delta is small, the passing repros stand in for the self-check (``head``
    becomes ``last_reviewed``). ``signals`` (``escalate.build_signals``) feed
    ``maybe_escalate`` at a BUILD gate; a red gate adds its own count."""
    counters = data["counters"]
    counters["gate"] = counters.get("gate", 0) + 1
    previous = data.get("gate_failing")
    data["gate_failing"] = list(failing)
    if not failing:
        data["gate_reds"] = 0
        counters["no_progress"] = 0
        dest = data.pop("after_gate", None) or after_build(data, tier)
        if dest.get("step") != "recheck":
            tier = maybe_escalate(data, tier, signals or {}) or tier
            if data.get("tier_history"):
                # after_gate was planned at writer time; an escalation since changes the REVIEW entry
                dest = after_build(data, tier)
        if dest.get("step") == "recheck":
            small = delta_lines is not None and delta_lines <= recheck_max_lines
            cycle = data.get("cycle") or {}
            fixed = list(cycle.get("fix") or [])
            if small and fixed and set(fixed) <= set(repros_run):
                record = {"reason": "repros", "findings": fixed}
                cycle["recheck_skipped"] = record
                data.setdefault("recheck_skips", []).append({**record, "gate": counters["gate"]})
                if head:
                    data["last_reviewed"] = head
                _cycle_done(data, tier)
                return
            dest = {"state": "REVIEW", "step": "review" if small else "candidates"}
        if dest.get("step") == "candidates":
            start_cycle(data)
        else:
            goto(data, dest["state"], dest.get("step"))
        return

    data["gate_reds"] = int(data.get("gate_reds", 0)) + 1
    maybe_escalate(data, tier, {"gate_reds": data["gate_reds"], "at": (signals or {}).get("at", "")})
    progressed = previous is None or bool(set(previous) - set(failing)) or len(failing) < len(previous)
    # The decision is recorded first so that a STOP resumes at GATE/decide.
    data["step"] = "decide"
    data["decision"] = {"kind": "gate_red", "options": list(DECIDE_CHOICES), "failing": list(failing)}
    if _round(data, progressed, f"gate failing {', '.join(failing)}"):
        return
    _budget(data, "gate", data["gate_reds"], GATE_RED_CAP, "consecutive red gates")


def on_review(data: dict, verdict: str, finding_ids: list[str], range_from: str, range_to: str,
              tier: str | None = None) -> None:
    """An ok review dispatch in REVIEW review (self-check: the light entry, or the
    recheck of a fix delta in any tier)."""
    counters = data["counters"]
    data["last_reviewed"] = range_to
    previous = data.get("review_ids")
    data["review_ids"] = sorted(finding_ids)
    if verdict == "PASS":
        counters["no_progress"] = 0
        _cycle_done(data, tier)
        return
    progressed = previous is None or set(previous) != set(finding_ids)
    if _round(data, progressed, "review findings unchanged"):
        return
    counters["review"] = counters.get("review", 0) + 1
    data["review_from"] = range_from
    goto(data, "REVIEW", "fix")  # a STOP(BUDGET) resumes here, at the fix
    _budget(data, "review", counters["review"], REVIEW_ROUND_CAP, "review fix rounds")


def start_cycle(data: dict) -> None:
    """Open one candidates -> verify -> fix cycle over the unreviewed range."""
    rounds = data["counters"].get("review", 0)
    base = data.get("base")
    data["cycle"] = {
        "range_from": base if rounds == 0 else (data.get("last_reviewed") or base),
        "candidates_done": 0,
        "candidate_dispatches": [],
    }
    goto(data, "REVIEW", "candidates")


def on_candidate(data: dict, tier: str, dispatch: str, range_to: str) -> bool:
    """One candidates review done; True when the cycle's readers are complete."""
    cycle = data.setdefault("cycle", {})
    cycle["candidates_done"] = cycle.get("candidates_done", 0) + 1
    cycle.setdefault("candidate_dispatches", []).append(dispatch)
    cycle["range_to"] = range_to
    return cycle["candidates_done"] >= CANDIDATE_READERS.get(tier, 2)


def _cycle_done(data: dict, tier: str | None) -> None:
    """The candidate cycle is over (gate green): full runs its one sweep first."""
    if tier == "full" and not data.get("sweep_done"):
        data["cycle"] = {"sweep": True, "range_from": data.get("base")}
        goto(data, "REVIEW", "sweep")
    else:
        data.pop("cycle", None)
        goto(data, "FINISH")


def _start_verify(data: dict, kept_ids: list[str], candidates_file: str) -> None:
    data["cycle"].update({
        "candidates_file": candidates_file,
        "candidates": len(kept_ids),
        "verify_batches": -(-len(kept_ids) // VERIFY_BATCH),
        "verify_done": 0,
        "confirmed": [],
        "plausible": [],
    })
    goto(data, "REVIEW", "verify")


def on_sweep_filtered(data: dict, kept_ids: list[str], candidates_file: str, range_to: str) -> None:
    """After the sweep review and its prefilter; the sweep never repeats."""
    data["sweep_done"] = True
    cycle = data.setdefault("cycle", {"sweep": True, "range_from": data.get("base")})
    cycle["range_to"] = range_to
    data["last_reviewed"] = range_to
    data["review_from"] = cycle.get("range_from")
    data["sweep_ids"] = sorted(kept_ids)
    data["counters"]["no_progress"] = 0
    if not kept_ids:
        _cycle_done(data, None)  # sweep_done: FINISH
        return
    _start_verify(data, kept_ids, candidates_file)


def on_candidates_filtered(data: dict, kept_ids: list[str], candidates_file: str, tier: str | None = None) -> None:
    """After the mechanical prefilter of one cycle's candidates."""
    counters = data["counters"]
    cycle = data["cycle"]
    data["last_reviewed"] = cycle.get("range_to") or data.get("last_reviewed")
    data["review_from"] = cycle.get("range_from")
    previous = data.get("cycle_ids")
    data["cycle_ids"] = sorted(kept_ids)
    if not kept_ids:
        counters["no_progress"] = 0
        _cycle_done(data, tier)
        return
    counters["review"] = counters.get("review", 0) + 1
    progressed = previous is None or set(previous) != set(kept_ids)
    if _round(data, progressed, "review candidates unchanged"):
        return
    if _budget(data, "review", counters["review"], REVIEW_ROUND_CAP, "review fix rounds"):
        return
    _start_verify(data, kept_ids, candidates_file)


def on_verify(data: dict, confirmed: list[str], plausible: list[str], tier: str | None = None,
              repros: dict | None = None) -> None:
    """One verify batch. ``repros`` maps CONFIRMED ids to their reproduction
    (the recheck gate runs the ``exec`` ones as ``REPRO-n``)."""
    cycle = data["cycle"]
    if repros:
        cycle.setdefault("repros", {}).update({k: v for k, v in repros.items() if k in confirmed})
    cycle["confirmed"] = cycle.get("confirmed", []) + confirmed
    cycle["plausible"] = cycle.get("plausible", []) + plausible
    cycle["verify_done"] = cycle.get("verify_done", 0) + 1
    if cycle["verify_done"] < cycle.get("verify_batches", 1):
        return
    if cycle["plausible"]:
        data["step"] = "plausible"
        data["decision"] = {"kind": "plausible", "options": list(PLAUSIBLE_CHOICES),
                            "failing": list(cycle["plausible"])}
    else:
        _fix_or_done(data, list(cycle["confirmed"]), tier)


def _fix_or_done(data: dict, fix: list[str], tier: str | None) -> None:
    """Fix the verified findings, or close the cycle when there are none."""
    data["cycle"]["fix"] = fix
    if fix:
        goto(data, "REVIEW", "fix")
    else:
        _cycle_done(data, tier)


def decide(data: dict, choice: str, tier: str | None = None) -> dict:
    """Apply a ``decide`` choice; returns the decision it answered."""
    state, step = data.get("state"), step_of(data)
    decision = data.get("decision")
    if step == "plausible" and isinstance(decision, dict):
        if choice not in PLAUSIBLE_CHOICES:
            raise StateError(f"PLAUSIBLE findings take `decide fix|skip`, not {choice!r}")
        cycle = data["cycle"]
        fix = list(cycle.get("confirmed", []))
        if choice == "fix":
            fix += cycle.get("plausible", [])
        _fix_or_done(data, fix, tier)
        return decision
    if step != "decide" or not isinstance(decision, dict):
        raise StateError(f"nothing to decide in {state}/{step}")
    if choice not in DECIDE_CHOICES:
        raise StateError(f"expected one of {', '.join(DECIDE_CHOICES)}, got {choice!r}")
    if choice == "impl":
        goto(data, "GATE", "fix")
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
        prev = info.get("prev") or {"state": "BUILD", "step": "implement"}
        counter = info.get("counter")
        if info.get("reason") == "BUDGET" and counter:
            # One more round: the cap moves past the value that tripped it.
            extra = data.setdefault("caps_extra", {})
            over = max(int(info.get("value", 0)) - int(info.get("cap", 0)), 0)
            extra[counter] = int(extra.get(counter, 0)) + over + 1
        data["counters"]["no_progress"] = 0
        for rec in (data.get("partitions") or {}).values():
            if isinstance(rec, dict) and isinstance(rec.get("counters"), dict):
                rec["counters"]["no_progress"] = 0
        prev_state = prev.get("state") if prev.get("state") in DEFAULT_STEP else "BUILD"
        if prev_state == "STOP":
            prev_state = "BUILD"
        data["state"], data["step"] = prev_state, prev.get("step") or DEFAULT_STEP[prev_state]
        return f"resumed {data['state']}/{data['step']}"
    if state == "CONTRACT":
        dest = data.pop("resume_to", None) or {"state": "BUILD", "step": "implement"}
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
        if isinstance(running, dict) and not running.get("external") and not alive(int(running.get("pid") or 0)):
            rec.pop("running")
            reaped.append(str(running.get("dispatch")))
    batch = data.get("batch")
    for dispatch, run in list(((batch or {}).get("running") or {}).items()) if isinstance(batch, dict) else []:
        if isinstance(run, dict) and not run.get("external") and not alive(int(run.get("pid") or 0)):
            batch["running"].pop(dispatch)
            reaped.append(str(dispatch))
    for entry in data.get("dispatches") or []:
        if entry.get("id") in reaped and entry.get("status") == "running":
            entry["status"] = "aborted"
    return reaped


def on_partition_failed(data: dict, name: str, role: str) -> None:
    """A failed partition dispatch: a round without progress for that partition."""
    rec = data["partitions"][name]
    rec.setdefault("counters", {"no_progress": 0})
    _round(data, False, f"{name}: {role} dispatch failed", rec["counters"])


def on_partition_implemented(data: dict, name: str) -> None:
    rec = data["partitions"][name]
    rec["counters"]["no_progress"] = 0
    rec["step"] = PARTITION_DONE


def on_partition_merged(data: dict, name: str, sha: str) -> None:
    data["partitions"][name]["merged"] = sha


def on_merge_conflict(data: dict, conflict: dict) -> None:
    data["merge_conflict"] = dict(conflict)


def on_conflict_resolved(data: dict, sha: str) -> str:
    """The human merged the conflicting partition; returns its name."""
    conflict = data.pop("merge_conflict")
    on_partition_merged(data, conflict["partition"], sha)
    return conflict["partition"]


def on_wave_merged(data: dict, wave_count: int, tier: str | None) -> None:
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
        data["after_gate"] = after_build(data, tier)
        goto(data, "GATE")
