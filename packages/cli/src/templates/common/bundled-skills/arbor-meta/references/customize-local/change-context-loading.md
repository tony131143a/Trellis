# Change Local Context Loading

Context loading determines when AI reads workflow, task, spec, research, workspace, and git status. Read this page when the user says "AI does not know the current task," "the agent did not read specs," or "there is too much/too little context."

## Read These Files First

1. `.arbor/workflow.md`
2. `.arbor/scripts/get_context.py`
3. `.arbor/scripts/common/session_context.py`
4. `.arbor/scripts/common/task_context.py`
5. `.arbor/scripts/common/active_task.py`
6. Current hooks and `.arbor/agents/*.md`
7. The current task's `implement.jsonl` / `check.jsonl`

## Context Sources

| Source | Purpose |
| --- | --- |
| `.arbor/workflow.md` | Workflow and next-action hints. |
| `.arbor/tasks/<task>/prd.md` | Current task requirements. |
| `.arbor/tasks/<task>/design.md` | Complex task technical design. |
| `.arbor/tasks/<task>/implement.md` | Complex task execution plan. |
| `.arbor/tasks/<task>/implement.jsonl` | Spec/research for the `architect` and `implement` roles. |
| `.arbor/tasks/<task>/check.jsonl` | Spec/research for the `review`, `verify`, `fix`, and `simplify` roles. |
| `.arbor/spec/` | Project specs. |
| `.arbor/workspace/` | Session records. |
| git status | Current working tree changes. |

## Common Needs And Edit Points

| Need | Edit point |
| --- | --- |
| Inject more/less information in new sessions | `session_context.py` or the `session-start.py` hook. |
| Change hints on each user input | `[workflow-state:STATUS]` block in `.arbor/workflow.md`. The `inject-workflow-state` hook is parser-only and reads the block verbatim. |
| Agent did not read specs | Task JSONL, `.arbor/agents/<role>.md`, `inject-delegation-context.py` hook, and the dispatch header (`dispatch.md`). |
| Active task is lost | `active_task.py` and session identity propagation. |
| Change JSONL validation rules | `task_context.py`. |

## JSONL Rules

`implement.jsonl` / `check.jsonl` are the key context loading interface:

```jsonl
{"file": ".arbor/spec/backend/index.md", "reason": "Backend conventions"}
{"file": ".arbor/tasks/04-28-x/research/api.md", "reason": "API research"}
```

Include only spec/research files. Do not put code files that will be modified into these manifests; agents read code files themselves during implementation.

## Change Session Context

If the user wants every new session to see more project state, edit:

- `.arbor/scripts/common/session_context.py`
- the `session-start.py` hook

Context cannot grow without bound. Prefer injecting indexes and paths so the AI can read detailed files on demand.

## Change Dispatched-Role Context

Two paths feed a dispatched role:

- hook push: edit `inject-delegation-context.py` (and the shared assembler it uses). `dispatch.py` builds the same text.
- role pull: edit the read steps in `.arbor/agents/<role>.md`, then re-run `dispatch.py codeg-setup`.

In both modes, make sure the agent ultimately reads:

1. active task
2. the corresponding JSONL
3. spec/research referenced by the JSONL
4. `prd.md`
5. `design.md` if present
6. `implement.md` if present

## Troubleshooting Order

```bash
python3 ./.arbor/scripts/task.py current --source
python3 ./.arbor/scripts/task.py list-context <task>
python3 ./.arbor/scripts/task.py validate <task>
python3 ./.arbor/scripts/get_context.py --mode packages
```

Confirm the task and JSONL are correct before editing hooks or role files. `dispatch.py print-context` shows what a role would receive.
