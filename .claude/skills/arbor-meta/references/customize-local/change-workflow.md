# Change Local Workflow

When the user wants to change Arbor phases, next-action hints, whether to create tasks, how the contract is written, or when to check/wrap up, edit `.arbor/workflow.md` first. State transitions, caps and counters of a started task live in the driver (`.arbor/scripts/arbor.py` and `.arbor/scripts/common/driver/`); change them there and keep the workflow tables in sync.

## Read These Files First

1. `.arbor/workflow.md`
2. Entry files for the platform, such as skills and commands
3. The current task's `task.json` and `contract.md`

## Common Needs And Edit Points

| Need | Edit point |
| --- | --- |
| Change phase names or phase order | `Phase Index` and the corresponding Phase sections. |
| Change whether to create a task when there is no task | `[workflow-state:no_task]` state block. |
| Change the next step during planning | Phase 1 and `[workflow-state:planning]`. |
| Change what happens after the contract is approved | The driver's state table, then the State Machine table and Phase 2. |
| Change wrap-up after completion | Phase 3 and `[workflow-state:completed]`. |
| Change which skill a user intent triggers | `Request Triage` and the Phase 1 steps. |

## Modification Steps

1. Find the relevant section in `.arbor/workflow.md`.
2. When changing rules, keep explicit trigger conditions and next actions.
3. If adding or renaming a skill/agent, synchronize the corresponding files in `.claude/`, `.starFactory/`, and `.arbor/agents/`.
4. Workflow-state changes only need an edit to the `[workflow-state:STATUS]` block in `.arbor/workflow.md`. The hook is parser-only — it reads whatever you put in the block. Keep the opening and closing tags' STATUS strings identical (`[workflow-state:foo]…[/workflow-state:foo]`); mismatched STATUS pairs are silently dropped.
5. Make the AI reread `.arbor/workflow.md`; do not keep using rules from the old conversation.

## Example: Relax Task Creation Requirements

To change when task creation can be skipped, usually edit `[workflow-state:no_task]`:

```md
[workflow-state:no_task]
Task is not required when the answer is a one-reply explanation, no files are changed, and no research is needed.
[/workflow-state:no_task]
```

If the formal Phase 1 flow also needs to change, synchronize the Phase 1 section.

## Example: Run A Role Elsewhere

If the user wants a role to run on a different tool or model, change `executors:` in `.arbor/config.yaml` (or the executor's own per-role configuration) rather than the workflow; the workflow only knows roles. Skipping a role entirely means changing the driver's state table, not deleting `.arbor/agents/<role>.md`. The guard hook still denies the built-in Agent/Task tool for Arbor roles.

## `/arbor:continue` Route Table

`/arbor:continue` resumes a task. While the task is in planning it routes by artifact presence; once `task.py start` has run, it asks the driver (`arbor.py next`). Forks that add custom statuses must extend both the workflow.md tag block and this table.

| `status` | State | Resume at |
| --- | --- | --- |
| `planning` | no `contract.md`, or no acceptance criteria yet | Phase 1.1 – 1.3 (load `arbor-brainstorm`) |
| `planning` | standard / full design missing; full without the user's architect choice | Phase 1.4 |
| `planning` | manifests empty or only a legacy `_example` row | Phase 1.5 (`task.py seed-context`, then adjust) |
| `planning` | contract not validated, or no plan review (standard / full) | Phase 1.6 |
| `planning` | everything present | Phase 1.7 (planning summary, then `task.py start` after approval) |
| `in_progress` | any driver state | `arbor.py next`, then do the one step it names |
| `completed` | task is still in active tree | `/arbor:finish-work` |

When you add a custom status (e.g. `in-review`), add a `[workflow-state:in-review]` block in `.arbor/workflow.md` for the per-turn breadcrumb AND extend this route table — usually by editing the `/arbor:continue` command file (`.claude/commands/arbor/continue.md` or `.starFactory/commands/arbor/continue.md`) to add a row that decides where to resume from. Without the route entry, `/arbor:continue` will fall through to a default branch and the user will not land on the step you intended.

## Notes

`.arbor/workflow.md` is the local project workflow, not an immutable template. The user can adapt it to team habits. After editing it, skill and command files may still contain old descriptions, so inspect them too.
