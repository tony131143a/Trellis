"""Mandate: which human gates the main agent must put to the user.

The driver stops at three human gates: contract approval, PLAUSIBLE findings
and the merge. A mandate says, per gate, whether the main agent asks the user
(``ask``) or proceeds on its own (``auto``). STOP (a round cap or no progress)
and scope changes are always asked; they are not gates here.

Resolution: the built-in default for the task's tier, then the ``mandate:``
section of ``.arbor/config.yaml`` (per tier), then ``meta.mandate`` in
task.json (``"contract=auto,merge=ask"``, set with ``task.py create
--mandate`` or ``task.py set-meta <task> mandate``). A light task the driver
escalated (``state.maybe_escalate``) carries ``meta.tier: standard`` and
resolves the standard defaults from then on.

One gate the driver can act on by itself when it is ``auto``: ``plausible``
(record ``decide skip``). ``contract`` only tells the main agent whether to ask; ``merge``
lets ``arbor.py finish`` merge a small, clean branch into its baseline
itself. ``merge`` is ``ask`` in every tier by default: the baseline is only
merged automatically when the user opts in. A child's merge into its
parent's integration branch is not a gate at all (``integration.py``).
"""
from __future__ import annotations

from . import state as sm
from .executor import utc_now

GATES = ("contract", "plausible", "merge")
CHOICES = ("ask", "auto")
AUTO_MERGE_MAX_LINES = 200
HUMAN_KIND_GATE = {"approve_contract": "contract", "plausible": "plausible", "merge": "merge"}

DEFAULTS: dict[str, dict[str, str]] = {
    "light": {"contract": "auto", "plausible": "auto", "merge": "ask"},
    "standard": {"contract": "ask", "plausible": "auto", "merge": "ask"},
    "full": {"contract": "ask", "plausible": "ask", "merge": "ask"},
}


class MandateError(ValueError):
    pass


def parse_spec(text: str | None) -> dict[str, str]:
    """``"contract=auto, merge=ask"`` -> ``{"contract": "auto", "merge": "ask"}``."""
    out: dict[str, str] = {}
    for item in (text or "").replace(";", ",").split(","):
        item = item.strip()
        if not item:
            continue
        gate, sep, choice = item.partition("=")
        gate, choice = gate.strip().lower(), choice.strip().lower()
        if not sep or gate not in GATES or choice not in CHOICES:
            raise MandateError(f"invalid mandate {item!r}: expected <gate>=<ask|auto> with gate in "
                               f"{', '.join(GATES)}")
        out[gate] = choice
    return out


def _section(config: dict) -> dict:
    section = config.get("mandate") if isinstance(config, dict) else None
    return section if isinstance(section, dict) else {}


def resolve(config: dict, tier: str, task_data: dict | None = None) -> dict:
    """The effective mandate of a task: one of ``ask``/``auto`` per gate plus
    ``auto_merge_max_lines``. Invalid config values are ignored; an invalid
    task override raises :class:`MandateError`."""
    section = _section(config)
    merged = dict(DEFAULTS.get(tier, DEFAULTS["light"]))
    per_tier = section.get(tier)
    if isinstance(per_tier, dict):
        for gate in GATES:
            value = per_tier.get(gate)
            if isinstance(value, str) and value.strip().lower() in CHOICES:
                merged[gate] = value.strip().lower()
    meta = (task_data or {}).get("meta") if isinstance(task_data, dict) else None
    spec = meta.get("mandate") if isinstance(meta, dict) else None
    if isinstance(spec, str) and spec.strip():
        merged.update(parse_spec(spec))
    limit = section.get("auto_merge_max_lines")
    try:
        merged["auto_merge_max_lines"] = int(limit) if limit not in (None, "") else AUTO_MERGE_MAX_LINES
    except (TypeError, ValueError):
        merged["auto_merge_max_lines"] = AUTO_MERGE_MAX_LINES
    return merged


def describe(mandate: dict) -> str:
    return ", ".join(f"{gate}={mandate.get(gate, 'ask')}" for gate in GATES)


def apply(data: dict, mandate: dict, tier: str) -> list[dict]:
    """Take the automatic decisions the mandate allows on the current state;
    returns the decision records it appended to ``data['decisions']``.

    - PLAUSIBLE findings with ``plausible=auto``: ``decide skip``; the
      findings stay listed in the review reports and the scorecard.
    """
    taken: list[dict] = []
    if sm.step_of(data) == "plausible" and mandate.get("plausible") == "auto":
        decision = sm.decide(data, "skip", tier)
        taken.append({"ts": utc_now(), "kind": decision.get("kind"), "choice": "skip",
                      "reason": "mandate plausible=auto: PLAUSIBLE findings skipped without asking",
                      "failing": decision.get("failing"), "mandate": True})
    if taken:
        data.setdefault("decisions", []).extend(taken)
    return taken
