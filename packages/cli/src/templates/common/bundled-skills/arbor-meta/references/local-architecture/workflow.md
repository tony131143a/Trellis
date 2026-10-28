# Local Workflow System

`.arbor/workflow.md` is the Arbor workflow source of truth inside the user project. An AI does not need Arbor source code to understand how the current project should move tasks forward; this file is enough.

## File Responsibilities

`.arbor/workflow.md` has three responsibilities:

1. **Explain workflow phases**: Plan, Execute, Finish.
2. **Define skill routing**: which skill or agent the AI should use when the user expresses a certain intent.
3. **Provide workflow-state prompt blocks**: hooks can inject the prompt block for the current state into the conversation.

## Current Phase Model

```text
Phase 1: Plan    -> classify the tier (quick / light / standard / full), clarify what to build, explore and design (1.2), produce prd.md (+ design.md for standard, + implement.md for full)
Phase 2: Execute -> implement against the PRD and specs, then one gate review and fix (2.2); parallel tasks (full only) use Phase 2P
Phase 2F: Polish -> standard / full: simplify, final review, verify, fix; every task: quality checks (2F.5)
Phase 3: Finish  -> preserve lessons (spec update), commit, and wrap up
```

Each phase contains numbered steps, such as `1.3 Configure context`. These numbers are not runtime fields in `task.json`; they are workflow structure for AI and humans to read.

## Skill Routing

`workflow.md` routes work by intent. For exploration, design, implementation, review, verification, fixing, and simplification, the main agent dispatches the matching role (`explore`, `architect`, `implement`, `review`, `verify`, `fix`, `simplify`) to a codeg assistant (see `dispatch.md`) rather than doing it in its own session. The task tier (quick / light / standard / full) is stored in `task.json.meta.tier` (`task.py create --tier`, `task.py set-meta <task> tier <t>`); when absent it is inferred from the artifacts (`implement.md` is full, `design.md` is standard, otherwise light), and it decides which roles take part and how long the review chain and polish are. Small steps such as reading skills like `before-dev` stay in the main session.

When changing local AI behavior, update the routing descriptions in `workflow.md` first, then check whether the corresponding skill, command, or `.arbor/agents/*.md` file needs to stay in sync.

## Workflow-State Prompt Blocks

The bottom of `workflow.md` can contain state blocks like this:

```text
[workflow-state:no_task]
...
[/workflow-state:no_task]
```

Hooks choose the right block based on current task status and inject it into the conversation. Common states include:

| State | Meaning |
| --- | --- |
| `no_task` | The current session has no active task. |
| `planning` | The task is still in requirements, exploration and design, or context configuration. |
| `in_progress-light` / `in_progress-standard` / `in_progress-full` | The task has entered implementation, review, and polish; one block per tier. |
| `in_progress-parallel` | Tier full with `meta.execution=parallel` (Phase 2P). |
| `in_progress` | Fallback only, shown when no block exists for the task's tier. |
| `completed` | The task is complete and waiting for wrap-up or archive. |

If the user wants to change policies such as "whether to create a task when there is no task," "when task creation may be skipped," or "whether sub-agents are required," edit these state blocks and the routing table above them.

## Local Modification Patterns

Common changes:

| Goal | Edit point |
| --- | --- |
| Add a phase | Update the Phase Index, phase body, routing, and state blocks. |
| Change task creation policy | Update the `no_task` state block and Phase 1 description. |
| Change the default implementation/review path | Update Phase 2 (2.2 gate review), Phase 2F, and skill routing. |
| Change the wrap-up flow | Update Phase 3 and `finish-work` related descriptions. Note the current split: Phase 3.4 = AI-driven code commits (batched, user-confirmed), Phase 3.5 = `/finish-work` (archive + record session). `/finish-work` refuses to run if the working tree is dirty. |
| Change dispatch behavior | Update Phase 2 routing, and `dispatch.md`-related config in `.arbor/config.yaml`. |

After editing, make the AI reread `.arbor/workflow.md`; do not assume the flow from the old conversation is still valid.

## Relationship To Platform Files

`workflow.md` is the semantic center of the local workflow, but each platform directory also has its own entry files:

- skills, such as `brainstorm` and `check`.
- commands, such as continue, finish-work, and workflow.
- hooks, such as session-start or workflow-state injection.

If only `workflow.md` changes, platform entry files may still contain old language. When the user wants to change "what the AI actually does," also inspect `.claude/` and `.starFactory/`.
