# Agents (Role Instruction Sources)

Arbor has six roles: `explore`, `architect`, `implement`, `review`, `fix`, and `simplify`. In Arbor they are not platform-native sub-agents and there are no `.claude/agents/` or `.starFactory/agents/` files. The driver (`.arbor/scripts/arbor.py`) prepares and validates roles through the Orca executor in `.arbor/config.yaml` (workers started with `orca orchestration worker-start`). The main agent of the session drives the loop and dispatches the roles. See `../local-architecture/dispatch.md` for the mechanism.

## Instruction Sources

| File | Role |
| --- | --- |
| `.arbor/agents/explore.md` | Trace code or fetch external docs for one aspect; write `research/<dispatch>-<topic>.md` and return 5-10 essential files. |
| `.arbor/agents/architect.md` | Produce one design blueprint from an assigned perspective into `research/<dispatch>-design-<perspective>.md`, with a partition / wave suggestion. |
| `.arbor/agents/test.md` | Commit failing tests for the contract's acceptance criteria, only inside the test paths; report the criterion → test map and the red run. |
| `.arbor/agents/implement.md` | Make the committed tests pass against `contract.md`, optional `design.md` / `waves.md`, `implement.jsonl`, and referenced spec/research; commit; never touch test paths. |
| `.arbor/agents/review.md` | Review a commit `Range:` for correctness bugs (`Mode: self-check`, `candidates`, `sweep`, or `plan`); verify each finding (candidates / sweep: reproduce the CONFIRMED ones under `research/repro/`); report `PASS`/`FAIL` with JSON findings; never edits code. |
| `.arbor/agents/fix.md` | Apply the chosen findings, commit, report fixed or skipped per finding. |
| `.arbor/agents/simplify.md` | Behavior-preserving cleanup of a range (reuse, duplication, needless complexity); commit or report no change. |

These are plain markdown with no frontmatter. The driver inlines these role instructions into the prepared worker prompt, read at every dispatch from the `.arbor/agents/` of the install it runs from (the main checkout), so an edit applies to every open task from its next dispatch on. The `executors.orca` agent (with the per-role overrides) selects the underlying agent; keep the agent's own instructions empty, so the role file is the only copy.

## What The Files Contain

- Identity and recursion guard: the role never dispatches, never spawns sub-agents.
- Session identity: no `ARBOR_CONTEXT_ID`; never run `arbor.py` or `task.py start/current/finish`.
- Context loading: use the inlined `<!-- arbor-hook-injected -->` payload, else read the JSONL manifest (`implement.jsonl` for architect/test/implement, `check.jsonl` for review/fix/simplify), `contract.md`, `design.md`, `waves.md`, and `git diff <Range>`.
- Write boundary and commits: readers leave the tree clean (`explore` / `architect` write only `<task>/research/`); writers commit on their own branch as `<role>(<task>): <summary>` with trailer `Arbor-Dispatch: d-NNN`; nobody pushes, merges, rebases or switches branches.
- A fixed final report format.

## Context Loading

Context normally arrives by driver push: `arbor.py run` assembles it into the prompt after the header. When the marker is missing, the instructions tell the role to pull the same files itself.

## Local Change Scenarios

| User need | Edit location |
| --- | --- |
| Implement role must follow extra restrictions | `.arbor/agents/implement.md`, then refresh the executor's copy. |
| Tests must follow a project convention | `.arbor/agents/test.md` (and `.arbor/spec/` for durable rules). |
| Review must apply extra project-specific angles | `.arbor/agents/review.md` (and `.arbor/spec/` for durable rules). |
| Review verdicts or fix must follow stricter rules | `.arbor/agents/review.md` / `.arbor/agents/fix.md`. |
| Explore or architect must output a fixed format | `.arbor/agents/explore.md` / `.arbor/agents/architect.md`. |
| Role cannot read task context | `.arbor/scripts/common/dispatch_context.py`, the task's jsonl manifests, or the context-loading section of the role file. |

## Modification Principles

1. Keep one responsibility per role.
2. Specify read order and write boundaries explicitly; the driver enforces the boundaries anyway.
3. Keep the hard limits (no push / merge / rebase, no `.arbor/` writes outside the task directory, no dispatch).
4. Long-term rules belong in `.arbor/spec/`; the role files only tell the role to read them.
