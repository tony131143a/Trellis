"""The whole prompt of a worker: the Orca spec file."""

from __future__ import annotations

from pathlib import Path

WRITER_RULES = """\
- The brief hands over what the coordinator already found: anchors (path and symbol; line numbers are hints, earlier merges move them), causes ruled out, often the first change. Start there: open the anchors and confirm them; do not survey again what the brief or the reports below already cover. Where the code contradicts the brief, follow the code and say so in the report.
- Match the conventions of the surrounding code.
- Change only files inside your paths. If the work needs anything else, stop and say so in the report.
- Commit your work on the current branch (subject "{task}/{node}: <summary>"). Leave nothing uncommitted or untracked.
- Never push, merge, rebase, switch branches, run arbor.py or start other agents.
- Do not ask questions: decide, and note the assumption in the report.
- Finish by writing the report file (at most 30 lines: what changed, with the files and the interfaces as committed; the result of each check; where the brief was wrong or missing something; what the coordinator or a later node must know), then send Orca's worker_done once with --report-path set to it. When you are blocked, write why in the report and still send worker_done."""

READER_RULES = """\
- Start from the anchors the brief names and the reports below; do not survey again what they already cover. Match what you report to the code as it is.
- Never push, merge, rebase, switch branches, run arbor.py or start other agents.
- Do not ask questions: decide, and note the assumption in the report.
- Finish by writing the report file (findings with file:line references, and what you checked and ruled out), then send Orca's worker_done once with --report-path set to it. When you are blocked, write why in the report and still send worker_done."""

REVIEW_BRIEF = """\
Review a diff you did not write, against the contract. This is not a read-through: run things.

Diff: git diff {base}..{head}   (in this directory; read the surrounding code of every change, not only the hunks)
Already green at {head}, do not just rerun them:
{checks}

Look for: behaviour that breaks an acceptance criterion or existing callers; wrong results on real inputs (boundaries, empty input, error paths, concurrency); acceptance criteria that no test or check really exercises; tests that cannot fail.
Test your suspicions: run the code, a targeted test, or a scratch script or test you write for the purpose. Dependencies are installed here. Remove every scratch file afterwards.

Each finding: `path:line`, one sentence stating the defect; the input or state that triggers it and what happens; severity `blocker` (a criterion is not met, data loss, or a crash on a normal path) or `should-fix`; evidence `shown` (the exact command or test you ran, pasted so it can be rerun, and the relevant output) or `read` (argued from the code only; say why you could not run it).
No style remarks, no rewrites, no praise. A suspicion that did not survive a run or a careful read is left out.
End the report with the line `findings: <n>` (0 is a valid result), then what you ran and what you did not review."""


def worker_spec(task: str, node: str, contract: Path, paths: list[str], checks: list[tuple[str, str]],
                report: Path, brief: str, workdir: Path, inline: bool = False,
                handover: list[tuple[str, Path]] | None = None) -> str:
    """``paths`` empty: a read-only node working in ``workdir``. ``handover``: (label, report) pairs
    of the nodes this one comes after and of its own earlier attempts."""
    if paths:
        scope = f"Paths you own: {', '.join(paths)}"
    else:
        scope = (f"You work read-only in {workdir}: you may run commands (tests, builds, scripts), but leave the "
                 "tree as you found it: no edits to tracked files, no commits, no stash, no checkout; delete every "
                 "scratch file you create (build output and caches that git ignores may stay). Your result is the report.")
    lines = [
        f"Arbor node: {task}/{node}",
        "",
        "You are one worker of a larger task. Do the work described under \"Brief\" in this git worktree, "
        "on the branch that is checked out." if paths else
        "You are one worker of a larger task. Do the work described under \"Brief\" in this directory.",
        "",
        f"Contract (what done means for the whole task; read it): {contract}",
        scope,
    ]
    if checks:
        lines += ["Checks that must pass:", *(f"{cid}: {command}" for cid, command in checks)]
    if handover:
        lines += ["Reports to start from (what earlier workers found and changed; read them before the code):",
                  *(f"{path} ({label})" for label, path in handover)]
    rules = READER_RULES.split("- Finish by")[0] + (
        "- Finish by writing the report file (findings with file:line references, and what you checked and ruled out); "
        "it is your result. "
        "When you are blocked, write why in the report." if inline else "- Finish by" + READER_RULES.split("- Finish by")[1])
    lines += [f"Report file: {report}", "", "Rules",
              (WRITER_RULES if paths else rules).format(task=task, node=node), "", "Brief", brief.strip(), ""]
    return "\n".join(lines)


def review_brief(contract: Path, workdir: Path, base: str, head: str, checks: list[tuple[str, str]]) -> str:
    listed = "\n".join(f"{cid}: {command}" for cid, command in checks) or "(none)"
    return (f"Contract: {contract}\nWorktree: {workdir}\n\n"
            + REVIEW_BRIEF.format(base=base, head=head, checks=listed))
