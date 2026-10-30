# Change Local Hooks

Hooks are the automation layer that connects Claude Code or StarFactory to Arbor. When the user wants to change "when context is injected," "how shell commands inherit a session," or "which files are read before an agent starts," hooks are usually the edit point.

## Read These Files First

1. `.claude/settings.json` and/or `.starFactory/settings.json`
2. `.claude/hooks/` and/or `.starFactory/hooks/`
3. `.arbor/scripts/common/active_task.py`
4. `.arbor/scripts/common/session_context.py`
5. `.arbor/workflow.md`

## Common Hook Types

| Hook | Purpose |
| --- | --- |
| session-start | Injects a Arbor overview when a session starts, clears, or compacts. |
| workflow-state | Injects a state hint on each user input. |
| dispatch guard | PreToolUse on `Agent\|Task`: denies the built-in tool for Arbor roles; roles run only through `arbor.py run`. |
| shell session bridge | Lets `task.py` commands in shell see the same session identity. |

## Modification Steps

1. Find the hook registration in settings/config.
2. Confirm the registered script path exists.
3. Read the hook script and identify inputs, outputs, and called `.arbor/scripts/`.
4. Modify hook behavior.
5. If the hook depends on workflow content, synchronize `.arbor/workflow.md`.

## Example: Change New-Session Injection Content

First find the session-start hook:

```text
.claude/settings.json
.claude/hooks/session-start.py
```

If the hook ultimately calls `.arbor/scripts/get_context.py` or `session_context.py`, editing the local script is usually more robust than hard-coding content in the hook.

## Example: Agent Did Not Read JSONL

First confirm:

```bash
python3 ./.arbor/scripts/task.py current --source
python3 ./.arbor/scripts/task.py validate <task>
```

If the task and JSONL are correct, inspect the assembled prompt with `arbor.py prompt --dispatch d-NNN --print` (see `../local-architecture/dispatch.md`). Then edit `.arbor/scripts/common/dispatch_context.py` or `.arbor/agents/<role>.md`.

## Notes

- Settings handle registration, hook scripts handle behavior; inspect both together.
- Hook command paths include the platform directory; do not copy `.claude/settings.json` to `.starFactory/` without rewriting them.
- Hooks should read project-local `.arbor/`; they should not depend on Arbor upstream source paths.
- Hook failures should produce visible errors so AI does not silently lose context.
