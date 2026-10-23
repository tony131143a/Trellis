# Agents (Assistant Instruction Sources)

Arbor has three roles: `research`, `implement`, and `check`. In Arbor they are not platform-native sub-agents and there are no `.claude/agents/` or `.starFactory/agents/` files. The main agent dispatches each role to a codeg assistant running on `star` (Claude Code fork) or `pi` (pi + DeepSeek). See `../local-architecture/dispatch.md` for the mechanism.

## Instruction Sources

| File | Role |
| --- | --- |
| `.arbor/agents/research.md` | Investigate a question and write findings into the current task's `research/`. |
| `.arbor/agents/implement.md` | Implement against `prd.md`, optional `design.md` / `implement.md`, `implement.jsonl`, and referenced spec/research. |
| `.arbor/agents/check.md` | Review changes, fix discovered issues, run required checks. |

These are plain markdown with no frontmatter. They are the source text for the codeg assistants: `python3 ./.arbor/scripts/dispatch.py codeg-setup` renders each target x role pair to `.arbor/.runtime/codeg-assistants/<target>-<role>.md`, which is pasted into the codeg UI or installed with `--install`.

## What The Files Contain

- Identity and recursion guard: the role never dispatches, never spawns sub-agents.
- Session identity: no `ARBOR_CONTEXT_ID`; never run `task.py start/current/finish`.
- Context loading: use the inlined `<!-- arbor-hook-injected -->` payload, else read the JSONL manifest, `prd.md`, `design.md`, `implement.md`.
- Hard limits: no commits, merges, or stash; stay inside the working directory; never write under `.arbor/`.
- A fixed final report format.

## Context Loading

Context normally arrives by hook push: the PreToolUse hook inlines it into the dispatched `task` text when it starts with the header protocol. When the hook did not run (for example the terminal fallback without the header), the instructions tell the role to pull the same files itself.

## Local Change Scenarios

| User need | Edit location |
| --- | --- |
| Implement role must follow extra restrictions | `.arbor/agents/implement.md`, then re-run `dispatch.py codeg-setup`. |
| Check role must run project-specific commands | `.arbor/agents/check.md` (and `.arbor/spec/` for durable rules). |
| Research role must output a fixed format | `.arbor/agents/research.md`. |
| Role cannot read task context | `inject-delegation-context.py` hook or the context-loading section of the role file. |

Editing a file under `.arbor/agents/` does not change an already-installed codeg assistant; the rendered text must be re-pasted or re-installed.

## Modification Principles

1. Keep one responsibility per role.
2. Specify read order and write boundaries explicitly.
3. Keep the hard limits (no commit, no `.arbor/` writes, no dispatch).
4. Long-term rules belong in `.arbor/spec/`; the role files only tell the role to read them.
