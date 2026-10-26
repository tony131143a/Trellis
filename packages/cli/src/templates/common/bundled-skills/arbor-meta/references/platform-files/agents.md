# Agents (Assistant Instruction Sources)

Arbor has seven roles: `explore`, `architect`, `implement`, `review`, `verify`, `fix`, and `simplify`. In Arbor they are not platform-native sub-agents and there are no `.claude/agents/` or `.starFactory/agents/` files. The main agent dispatches each role to a codeg assistant running on `star` (Claude Code fork) or `pi` (pi + DeepSeek). See `../local-architecture/dispatch.md` for the mechanism.

## Instruction Sources

| File | Role |
| --- | --- |
| `.arbor/agents/explore.md` | Trace code or fetch external docs for one aspect; write `research/<topic>.md` and return 5-10 essential files. |
| `.arbor/agents/architect.md` | Produce one design blueprint from an assigned perspective into `research/design-<perspective>.md`. |
| `.arbor/agents/implement.md` | Implement against `prd.md`, optional `design.md` / `implement.md`, `implement.jsonl`, and referenced spec/research. |
| `.arbor/agents/review.md` | Review a `Diff:` for correctness bugs (`Mode: self-check`, `candidates`, or `sweep`); report `PASS`/`FAIL` with JSON findings; never edits code. |
| `.arbor/agents/verify.md` | Judge each candidate finding as CONFIRMED, PLAUSIBLE, or REFUTED against the diff. |
| `.arbor/agents/fix.md` | Apply the findings the main agent chose, report fixed or skipped per finding. |
| `.arbor/agents/simplify.md` | Behavior-preserving cleanup of a diff (reuse, duplication, needless complexity). |

These are plain markdown with no frontmatter. They are the source text for the codeg assistants: `python3 ./.arbor/scripts/dispatch.py codeg-setup` renders each target x role pair to `.arbor/.runtime/codeg-assistants/<target>-<role>.md`, which is pasted into the codeg UI or installed with `--install`.

## What The Files Contain

- Identity and recursion guard: the role never dispatches, never spawns sub-agents.
- Session identity: no `ARBOR_CONTEXT_ID`; never run `task.py start/current/finish`.
- Context loading: use the inlined `<!-- arbor-hook-injected -->` payload, else read the JSONL manifest (`implement.jsonl` for architect/implement, `check.jsonl` for review/verify/fix/simplify), `prd.md`, `design.md`, `implement.md`, and the `Diff:` file.
- Hard limits: no commits, merges, or stash; stay inside the working directory; never write under `.arbor/` (`explore` and `architect` may write only `<task>/research/*.md`; no role updates `.arbor/spec/`).
- A fixed final report format.

## Context Loading

Context normally arrives by hook push: the PreToolUse hook inlines it into the dispatched `task` text when it starts with the header protocol. When the hook did not run (for example the terminal fallback without the header), the instructions tell the role to pull the same files itself.

## Local Change Scenarios

| User need | Edit location |
| --- | --- |
| Implement role must follow extra restrictions | `.arbor/agents/implement.md`, then re-run `dispatch.py codeg-setup`. |
| Review must apply extra project-specific angles | `.arbor/agents/review.md` (and `.arbor/spec/` for durable rules). |
| Fix or verify must follow stricter rules | `.arbor/agents/fix.md` / `.arbor/agents/verify.md`. |
| Explore or architect must output a fixed format | `.arbor/agents/explore.md` / `.arbor/agents/architect.md`. |
| Role cannot read task context | `inject-delegation-context.py` hook or the context-loading section of the role file. |

Editing a file under `.arbor/agents/` does not change an already-installed codeg assistant; the rendered text must be re-pasted or re-installed.

## Modification Principles

1. Keep one responsibility per role.
2. Specify read order and write boundaries explicitly.
3. Keep the hard limits (no commit, no `.arbor/` writes, no dispatch).
4. Long-term rules belong in `.arbor/spec/`; the role files only tell the role to read them.
