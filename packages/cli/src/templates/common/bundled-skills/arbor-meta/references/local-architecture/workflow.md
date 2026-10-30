# Local Workflow System

`.arbor/workflow.md` is the Arbor workflow source of truth inside the user project. An AI does not need Arbor source code to understand how the current project should move tasks forward; this file is enough.

## File Responsibilities

`.arbor/workflow.md` has three responsibilities:

1. **Explain workflow phases and the state machine**: Plan (INTAKE, CONTRACT), Drive (BUILD, GATE, REVIEW, POLISH), Finish.
2. **Define skill routing**: which skill or agent the AI should use when the user expresses a certain intent.
3. **Provide workflow-state prompt blocks**: hooks can inject the prompt block for the current state into the conversation.

## Current Phase Model

```text
Phase 1: Plan    -> INTAKE (tier light / standard / full, consent) -> CONTRACT (explore, one question list, contract.md, + design.md for standard, + waves.md for full, seed-context, validation, plan review, human approval, task.py start)
Phase 2: Drive   -> `arbor.py next` loop: BUILD (test red -> implement green) -> GATE -> REVIEW -> POLISH (standard / full)
Phase 3: Finish  -> scorecard, spec update, PR, human --no-ff merge, cleanup
```

Each phase contains numbered steps, such as `1.5 Configure context`. These numbers are not runtime fields in `task.json`; they are workflow structure for AI and humans to read.

## Skill Routing

`workflow.md` routes work by intent. Exploration, design, tests, implementation, review, verification, fixing, and simplification are roles (`explore`, `architect`, `test`, `implement`, `review`, `verify`, `fix`, `simplify`) that only the driver runs (see `dispatch.md`); the main agent writes their briefs. Simple changes (at most 2 files, cause known, no design choice) do not use Arbor. The task tier (light / standard / full) is stored in `task.json.meta.tier` (`task.py create --tier`, `task.py set-meta <task> tier <t>`); when absent it is inferred from the artifacts (`waves.md` is full, `design.md` is standard, otherwise light), and it decides how much contract work happens and how high the verification ladder climbs. Small steps such as reading skills like `before-dev` stay in the main session.

When changing local AI behavior, update the routing descriptions in `workflow.md` first, then check whether the corresponding skill, command, or `.arbor/agents/*.md` file needs to stay in sync.

## Workflow-State Prompt Blocks

The bottom of `workflow.md` can contain state blocks like this:

```text
[workflow-state:no_task]
...
[/workflow-state:no_task]
```

For a started task the per-turn hook shows the driver's one-line `arbor.py next` summary instead; the blocks cover the rest. Hooks choose the right block based on current task status:

| State | Meaning |
| --- | --- |
| `no_task` | The current session has no active task. |
| `task_error` | The active task record cannot be read. |
| `planning` | The task is in CONTRACT: exploration, questions, contract, design, context configuration, approval. |
| `in_progress` | Fallback only, shown when the driver gives no summary for a started task. |
| `completed` | The task is archived (normally unreachable). |

If the user wants to change policies such as "whether to create a task when there is no task" or "when task creation may be skipped," edit these state blocks and the triage rules above them. State transitions, caps and counters live in the driver, not in `workflow.md`.

## Local Modification Patterns

Common changes:

| Goal | Edit point |
| --- | --- |
| Add a phase | Update the Phase Index, phase body, routing, and state blocks. |
| Change task creation policy | Update the `no_task` state block and Phase 1 description. |
| Change the build / review path | The driver's state table (`.arbor/scripts/common/driver/`), then the State Machine table and Phase 2 steps in `workflow.md`. |
| Change the wrap-up flow | Update Phase 3 and `finish-work`. Roles commit on the task branch; the human merges the PR; the driver archives and writes the journal after the merge; `/finish-work` records the session. |
| Change how roles are executed | `executors:` in `.arbor/config.yaml` (see `dispatch.md`). |

After editing, make the AI reread `.arbor/workflow.md`; do not assume the flow from the old conversation is still valid.

## Relationship To Platform Files

`workflow.md` is the semantic center of the local workflow, but each platform directory also has its own entry files:

- skills, such as `brainstorm` and `check`.
- commands, such as continue, finish-work, and workflow.
- hooks, such as session-start or workflow-state injection.

If only `workflow.md` changes, platform entry files may still contain old language. When the user wants to change "what the AI actually does," also inspect `.claude/` and `.starFactory/`.
