# Local Context Injection System

Arbor context injection aims to make AI read the right files at the right time instead of relying on model memory. In a user project, injection is implemented by `.arbor/` scripts together with platform hooks, agents, and skills.

## Injected Context Types

| Type | Source | Purpose |
| --- | --- | --- |
| session context | `.arbor/scripts/get_context.py` | Current developer, git status, active task, active tasks, journal, packages. |
| workflow context | `.arbor/workflow.md`, `arbor.py next` | Current Arbor flow and the driver's next step. |
| spec context | `.arbor/spec/` + task JSONL | Specs that must be followed during implementation/checking. |
| task context | `.arbor/tasks/<task>/contract.md`, `design.md`, `waves.md`, `research/` | Current task contract, design, partitions / waves, and research. |
| platform context | `.claude/` or `.starFactory/` hooks and settings | Lets the AI tool read the files above through its hook events. |

## session-start

The SessionStart hook injects an Arbor overview when a session starts, clears, or compacts. Injected content usually includes:

- workflow summary.
- current task status.
- active tasks.
- spec index paths.
- developer identity and git status.
- for a started task, the driver's one-line next step (`arbor.py next --json` → `summary` and `needs`).

If the user feels the AI does not know the current task in a new session, first check whether the session-start hook is registered in `settings.json` and running.

## workflow-state

workflow-state is a short hint injected around each user turn. With an active task, the hook runs `python3 .arbor/scripts/arbor.py next --json` (with this session's `ARBOR_CONTEXT_ID`) and injects only its one-line `summary` plus `needs`. Without a task, with an unreadable task record, or when the driver is missing, fails or times out, it falls back silently to a block from `.arbor/workflow.md` selected by status: `no_task`, `task_error`, `planning`, `in_progress`, or `completed` (a `<status>-<tier>` block wins when one exists).

To change "what the AI should do next" for a started task, change the driver's step summaries; for the no-task, planning and fallback text, edit the state block in `.arbor/workflow.md`.

## dispatched-role context

Dispatched roles (explore, architect, test, implement, review, verify, fix, simplify) run in separate executor sessions and need task context. Arbor has two loading modes:

1. **driver push**: `arbor.py run` assembles the prompt (`common/dispatch_context.py`): the header, then jsonl-referenced files (`implement.jsonl` for architect, test and implement, `check.jsonl` for review, verify, fix, and simplify), `contract.md`, `design.md` if present, `waves.md` if present, and `git diff <Range>`, then the brief. See `dispatch.md`.
2. **role pull**: the instructions in `.arbor/agents/<role>.md` tell the role to read the jsonl context and task artifacts itself when no `<!-- arbor-hook-injected -->` marker is present.

In both modes, JSONL files in the task directory are the manifest for spec/research context. Task artifacts are read separately in this order: `contract.md` (legacy `prd.md`) -> `design.md if present` -> `waves.md if present` (legacy `implement.md`) -> `git diff <Range>` when the header has one.

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
| Change per-turn workflow-state rules | Started task: the driver's step summaries in `.arbor/scripts/common/driver/`. Otherwise the `[workflow-state:STATUS]` block in `.arbor/workflow.md`; the hook parses these blocks verbatim and embeds no fallback text. |
| Change how dispatched roles get context | `.arbor/scripts/common/dispatch_context.py`, the task's jsonl manifests, or `.arbor/agents/<role>.md`. |
| Change JSONL validation/display | `.arbor/scripts/common/task_context.py`. |
| Change active task resolution | `.arbor/scripts/common/active_task.py`. |

When modifying context injection, verify two things: new sessions can see the correct task, and dispatched roles can see the correct task artifacts/spec/research.
