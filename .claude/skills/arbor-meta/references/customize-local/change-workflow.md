# Change Local Workflow

When the user wants to change Arbor phases, next-action hints, whether to create tasks, whether to dispatch roles to codeg assistants, or when to check/wrap up, edit `.arbor/workflow.md` first.

## Read These Files First

1. `.arbor/workflow.md`
2. Entry files for the platform, such as skills and commands
3. The current task's `task.json` and `prd.md`

## Common Needs And Edit Points

| Need | Edit point |
| --- | --- |
| Change phase names or phase order | `Phase Index` and the corresponding Phase sections. |
| Change whether to create a task when there is no task | `[workflow-state:no_task]` state block. |
| Change the next step during planning | Phase 1 and `[workflow-state:planning]`. |
| Change whether an agent is required during in_progress | Phase 2 and `[workflow-state:in_progress]`. |
| Change wrap-up after completion | Phase 3 and `[workflow-state:completed]`. |
| Change which skill a user intent triggers | `Skill Routing` table. |

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

## Example: Do Not Dispatch A Role

If the user wants the main agent to do a role's work itself (for example review), change the routing for that role in `.arbor/workflow.md` (Dispatch, Phase 2, Phase 2F) rather than deleting `.arbor/agents/review.md`. Remember the guard hook still denies the built-in Agent/Task tool for Arbor roles.

## `/arbor:continue` Route Table

`/arbor:continue` resumes a task by deciding which phase step to load next. The decision combines `task.json.status`, the tier (`meta.tier`, else inferred from the artifacts), and the presence of artifacts inside the task directory. The mapping is fixed in the command itself; forks that add custom statuses must extend both the workflow.md tag block and this table.

| `status` | Artifact state | Resume at |
| --- | --- | --- |
| `planning` | `prd.md` missing | Phase 1.1 (load `arbor-brainstorm`) |
| `planning` | tier artifacts missing (light `prd.md`; standard + `design.md`; full + `implement.md`) | Phase 1.1 / 1.2 |
| `planning` | `prd.md` done, technical facts or design choices still open | Phase 1.2 (explore & design: `explore`, clarify, `architect`) |
| `planning` | manifests empty or only a legacy `_example` row | Phase 1.3 (`task.py seed-context`, then adjust) |
| `planning` | tier artifacts complete, manifests curated | final planning summary, then `task.py start` after approval |
| `in_progress` | implementation not started | Phase 2.1 (snapshot S0, dispatch `implement`) |
| `in_progress` | implementation done, gate review not clean | Phase 2.2 (one review self-check ⇄ fix; light at most 2 rounds, standard / full at most 1) |
| `in_progress` | gate review clean, tier standard / full, polish not done | Phase 2F (2F.1–2F.4) |
| `in_progress` | tier full, `meta.execution=parallel` | Phase 2P (2P.3 is gate review + commit) |
| `in_progress` | gate review clean (light) or polish done, quality checks not run | 2F.5 (run the Quality Check commands yourself) |
| `in_progress` | quality checks passed | Phase 3.3 (spec update) → 3.4 (commit) |
| `completed` | task is still in active tree | Phase 3.5 (run `/arbor:finish-work` to archive) |

When you add a custom status (e.g. `in-review`), add a `[workflow-state:in-review]` block in `.arbor/workflow.md` for the per-turn breadcrumb AND extend this route table — usually by editing the `/arbor:continue` command file (`.claude/commands/arbor/continue.md` or `.starFactory/commands/arbor/continue.md`) to add a row that decides where to resume from. Without the route entry, `/arbor:continue` will fall through to a default branch and the user will not land on the step you intended.

## Notes

`.arbor/workflow.md` is the local project workflow, not an immutable template. The user can adapt it to team habits. After editing it, skill and command files may still contain old descriptions, so inspect them too.
