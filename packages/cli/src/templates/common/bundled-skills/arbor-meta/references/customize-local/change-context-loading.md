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
| `.arbor/tasks/<task>/contract.md` | The approved contract: goal, scope, acceptance criteria, Verification map, Interface pins. |
| `.arbor/tasks/<task>/design.md` | Technical design for standard and full tasks. |
| `.arbor/tasks/<task>/waves.md` | Partitions and wave order for full tasks. |
| `.arbor/tasks/<task>/implement.jsonl` | Spec/research for the `architect`, `test` and `implement` roles. |
| `.arbor/tasks/<task>/check.jsonl` | Spec/research for the `review`, `verify`, `fix`, and `simplify` roles. |
| `.arbor/spec/` | Project specs. |
| `.arbor/workspace/` | Session records. |
| git status | Current working tree changes. |

## Common Needs And Edit Points

| Need | Edit point |
| --- | --- |
| Inject more/less information in new sessions | `session_context.py` or the `session-start.py` hook. |
| Change hints on each user input | Started task: the driver's step summaries (`arbor.py next`). Otherwise the `[workflow-state:STATUS]` block in `.arbor/workflow.md`; the `inject-workflow-state` hook reads it verbatim. |
| Agent did not read specs | Task JSONL, `.arbor/agents/<role>.md`, `.arbor/scripts/common/dispatch_context.py`, and the dispatch header (`dispatch.md`). |
| Active task is lost | `active_task.py` and session identity propagation. |
| Change JSONL validation rules | `task_context.py`. |

## JSONL Rules

`implement.jsonl` / `check.jsonl` are the key context loading interface:

```jsonl
{"file": ".arbor/spec/backend/index.md", "reason": "Backend conventions"}
{"file": ".arbor/tasks/04-28-x/research/api.md", "reason": "API research"}
```

`task.py seed-context <task> [--package <pkg> ...]` fills both manifests with the package's spec layer index files, the guides index, and the task's research files (idempotent); adjust the entries afterwards. Include only spec/research files. Do not put code files that will be modified into these manifests; agents read code files themselves during implementation.

## Change Session Context

If the user wants every new session to see more project state, edit:

- `.arbor/scripts/common/session_context.py`
- the `session-start.py` hook

Context cannot grow without bound. Prefer injecting indexes and paths so the AI can read detailed files on demand.

## Change Dispatched-Role Context

Two paths feed a dispatched role:

- driver push: edit the assembler `.arbor/scripts/common/dispatch_context.py`, which `arbor.py run` uses to build every role prompt.
- role pull: edit the read steps in `.arbor/agents/<role>.md`, then refresh the executor's copy of it.

In both modes, make sure the agent ultimately reads:

1. active task
2. the corresponding JSONL
3. spec/research referenced by the JSONL
4. `contract.md`
5. `design.md` if present
6. `waves.md` if present
7. `git diff <Range>` when the header has one

## Troubleshooting Order

```bash
python3 ./.arbor/scripts/task.py current --source
python3 ./.arbor/scripts/task.py list-context <task>
python3 ./.arbor/scripts/task.py validate <task>
python3 ./.arbor/scripts/get_context.py --mode packages
```

Confirm the task and JSONL are correct before editing hooks or role files. `arbor.py prompt --dispatch d-NNN --print` shows what a role received.
