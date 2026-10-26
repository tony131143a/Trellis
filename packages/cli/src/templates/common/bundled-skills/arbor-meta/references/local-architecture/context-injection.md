# Local Context Injection System

Arbor context injection aims to make AI read the right files at the right time instead of relying on model memory. In a user project, injection is implemented by `.arbor/` scripts together with platform hooks, agents, and skills.

## Injected Context Types

| Type | Source | Purpose |
| --- | --- | --- |
| session context | `.arbor/scripts/get_context.py` | Current developer, git status, active task, active tasks, journal, packages. |
| workflow context | `.arbor/workflow.md` | Current Arbor flow and next action. |
| spec context | `.arbor/spec/` + task JSONL | Specs that must be followed during implementation/checking. |
| task context | `.arbor/tasks/<task>/prd.md`, `design.md`, `implement.md`, `research/` | Current task requirements, design, execution plan, and research. |
| platform context | `.claude/` or `.starFactory/` hooks and settings | Lets the AI tool read the files above through its hook events. |

## session-start

The SessionStart hook injects an Arbor overview when a session starts, clears, or compacts. Injected content usually includes:

- workflow summary.
- current task status.
- active tasks.
- spec index paths.
- developer identity and git status.
- a `<dispatch>` section with the codeg assistant ids per role.

If the user feels the AI does not know the current task in a new session, first check whether the session-start hook is registered in `settings.json` and running.

## workflow-state

workflow-state is a lightweight hint injected around each user turn. Based on current task status, it selects a block from `.arbor/workflow.md`, such as `no_task`, `planning`, `in_progress`, or `completed`.

If the user wants to change "what the AI should do next in a given state," edit the corresponding state block in `.arbor/workflow.md` first.

## dispatched-role context

Dispatched roles (explore, architect, implement, review, verify, fix, simplify) run in separate codeg sessions and need task context. Arbor has two loading modes:

1. **hook push**: the PreToolUse hook on `delegate_to_agent` inlines jsonl-referenced files (`implement.jsonl` for architect and implement, `check.jsonl` for review, verify, fix, and simplify) plus `prd.md`, `design.md` if present, `implement.md` if present, and the `Diff:` file if given into the `task` text when it starts with the `Active task:` / `Role:` header. The same text is built by `dispatch.py` for the terminal fallback. See `dispatch.md`.
2. **role pull**: the instructions in `.arbor/agents/<role>.md` tell the role to read the active task, jsonl context, and task artifacts itself when no `<!-- arbor-hook-injected -->` marker is present.

In both modes, JSONL files in the task directory are the manifest for spec/research context. Task artifacts are read separately in this order: `prd.md` -> `design.md if present` -> `implement.md if present` -> the `Diff:` file when the header has one.

## JSONL Reading Rules

`implement.jsonl` and `check.jsonl` contain one JSON object per line:

```jsonl
{"file": ".arbor/spec/backend/index.md", "reason": "Backend rules"}
```

Readers should skip rows without a `file` field (e.g. legacy `_example` placeholders). When configuring JSONL, the AI should include only spec/research files, not pre-register code files that will be modified.

## Active Task And Context Key

Active task state lives in `.arbor/.runtime/sessions/` and is isolated per session. Hooks resolve the context key from hook events, environment variables, transcript paths, or `ARBOR_CONTEXT_ID`. Dispatched roles have no context key by design.

If shell commands cannot see the same context key, `task.py current --source` may report no active task. In that case, check whether the platform passes session identity into the shell instead of hand-writing a global current-task file.

## Local Customization Points

| Need | Edit location |
| --- | --- |
| Change session-start injected content | `session-start.py` in `.claude/hooks/` / `.starFactory/hooks/`, or `session_context.py`. |
| Change per-turn workflow-state rules | `[workflow-state:STATUS]` block in `.arbor/workflow.md`. The workflow-state hook parses these blocks verbatim and embeds no fallback text. |
| Change how dispatched roles get context | The `inject-delegation-context` hook, or `.arbor/agents/<role>.md`. |
| Change JSONL validation/display | `.arbor/scripts/common/task_context.py`. |
| Change active task resolution | `.arbor/scripts/common/active_task.py`. |

When modifying context injection, verify two things: new sessions can see the correct task, and dispatched roles can see the correct task artifacts/spec/research.
