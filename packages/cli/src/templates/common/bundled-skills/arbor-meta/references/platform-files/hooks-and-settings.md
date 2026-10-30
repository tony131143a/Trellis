# Hooks And Settings

Hooks and settings connect the AI tool to Arbor. `.claude/settings.json` and `.starFactory/settings.json` register command hooks; the hook scripts under `.claude/hooks/` and `.starFactory/hooks/` define behavior. Both platforms use Claude-shaped hook events.

## Registered Hooks

| Event | Script | Purpose |
| --- | --- | --- |
| SessionStart (startup, clear, compact) | `session-start.py` | Injects the Arbor overview: workflow summary, current task, active tasks, spec indexes, git status; for a started task, the driver's one-line next step. |
| UserPromptSubmit | `inject-workflow-state.py` | With an active task, runs `.arbor/scripts/arbor.py next --json` and emits its one-line `summary` plus `needs`. Otherwise, or when the driver is missing or fails, parses `[workflow-state:STATUS]` blocks from `.arbor/workflow.md` and emits the body matching the task status; `Refer to workflow.md for current step.` when no block matches. |
| PreToolUse, matcher `^(Agent\|Task)$`, timeout 10 | `guard-builtin-agent.py` | Denies built-in Agent/Task for Arbor role dispatches (`Active task:` / `Role:` prompt, or `subagent_type` starting `arbor-`); roles run only through `arbor.py run`. |
| PreToolUse (Bash) | `inject-shell-session-context.py` | Lets shell commands inherit Arbor session identity (`ARBOR_CONTEXT_ID`). |

Read `settings.json` in the project for the exact matchers and the set actually registered. Claude Code may additionally have `.claude/hooks/statusline.py` when a statusline was configured.

The scripts are generated from `shared-hooks` templates, so `.claude/hooks/` and `.starFactory/hooks/` contain the same logic with different platform directory names.

## Local Change Scenarios

| User need | Edit location |
| --- | --- |
| AI should see more/less context in a new session | `session-start.py` or `.arbor/scripts/common/session_context.py`. |
| Per-turn hint policy should change | Started task: the driver's step summaries. Otherwise the `[workflow-state:STATUS]` block in `.arbor/workflow.md`; no script edit needed. |
| Dispatched role cannot read the contract or spec | `.arbor/scripts/common/dispatch_context.py`, and the task's `implement.jsonl` / `check.jsonl`. |
| `task.py current` in shell shows no active task | Shell/session bridge hook or session environment. |
| Disable an automatic injection | Remove the corresponding hook registration in `settings.json`. |

## Modification Principles

1. Settings wire things up; hooks define behavior. Change both when needed.
2. Hooks read local `.arbor/`, never upstream source.
3. Errors must be visible: a hook failure should say what was not injected.
4. Apply the same change to `.claude/` and `.starFactory/` when both exist.

## Troubleshooting Path

If the user says "the AI did not read Arbor state":

1. Check that `settings.json` registers the hook and the script file exists.
2. Run `python3 ./.arbor/scripts/get_context.py` or `task.py current --source` manually.
3. Check for active task state in `.arbor/.runtime/sessions/`.
4. Check that the shell passes session identity.
5. For dispatch problems, use `arbor.py status` and `arbor.py prompt --dispatch d-NNN --print` (see `../local-architecture/dispatch.md`).
