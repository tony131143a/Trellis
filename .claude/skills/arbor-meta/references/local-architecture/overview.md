# Local Arbor Architecture Overview

`arbor-meta` is for user projects that have already run `arbor init`. The user's machine usually has only the npm-installed `arbor` command plus the Arbor files generated inside the project; it may not have the Arbor CLI source code.

Therefore, when an AI uses this skill, the default customization target is local files inside the user project:

- `.arbor/`: workflow, tasks, specs, journals, scripts, and runtime state.
- `.arbor/agents/`: assistant instruction sources for the implement, check, and research roles.
- Platform directories: `.claude/` (Claude Code) and `.starFactory/` (StarFactory, a Claude Code fork).
- Root files `CLAUDE.md` and `AGENTS.md`, which contain a managed block between `<!-- ARBOR:START -->` and `<!-- ARBOR:END -->`.

Do not default to guiding the user to fork the Arbor CLI repository. Treat upstream source code as the operating target only when the user explicitly says they want to change Arbor upstream source, publish an npm package, or contribute a PR.

## Local System Model

Arbor provides four layers inside a user project:

1. **Workflow layer**: `.arbor/workflow.md` defines phases, routing, next actions, and prompt blocks.
2. **Persistence layer**: `.arbor/tasks/`, `.arbor/spec/`, and `.arbor/workspace/` store tasks, specs, and session journals.
3. **Platform integration layer**: hooks, settings, skills, and commands in `.claude/` and `.starFactory/` connect the Arbor workflow to the AI tool.
4. **Dispatch layer**: the main agent hands implement/check/research work to codeg assistants running on `star` or `pi` (see `dispatch.md`).

All four layers live inside the user project, so an AI can read and modify them directly.

## Core Paths

| Path | Purpose |
| --- | --- |
| `.arbor/workflow.md` | Workflow phases, skill routing, and workflow-state prompt blocks. |
| `.arbor/config.yaml` | Project configuration, task lifecycle hooks, monorepo package configuration, and journal configuration. |
| `.arbor/spec/` | The user's project-specific coding conventions and thinking guides. |
| `.arbor/tasks/` | Each task's PRD, technical notes, research files, and JSONL context. |
| `.arbor/workspace/` | Per-developer journals. |
| `.arbor/agents/` | Assistant instruction sources (`implement.md`, `check.md`, `research.md`) installed into codeg assistants. |
| `.arbor/scripts/` | Local Python runtime used by commands, hooks, and context injection. |
| `.arbor/.runtime/` | Session-level runtime state, such as the current task pointer. |
| `.arbor/.template-hashes.json` | Template hashes for Arbor-managed files, used by update to determine whether local files were modified by the user. |

## AI Customization Principles

1. **Find the local source of truth first**: Do not edit from memory. Read `.arbor/workflow.md`, `.arbor/config.yaml`, the relevant platform directory, and related task files first.
2. **Edit the user project, not the npm package cache**: Modify generated files inside the project, not `node_modules` or the global npm install directory.
3. **Keep platform files aligned with `.arbor/`**: If workflow routing changes, also check whether platform skills or commands still describe the same flow.
4. **Put project-specific rules in `.arbor/spec/` or a local skill**: Do not put team conventions into `arbor-meta`.
5. **Preserve user changes**: If a file was already modified locally, work from the current content instead of overwriting it with a default template.

## How To Use This Directory

- To understand which files exist after init, read `generated-files.md`.
- To change phases, routing, or next actions, read `workflow.md`.
- To change the task model, JSONL context, or active task behavior, read `task-system.md`.
- To change coding convention injection, read `spec-system.md`.
- To understand journals, read `workspace-memory.md`.
- To understand how roles are dispatched to codeg assistants, read `dispatch.md`.
- To change hooks or dispatched-role context loading, read `context-injection.md`.
