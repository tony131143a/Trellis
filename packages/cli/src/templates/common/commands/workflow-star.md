# Workflow on StarFactory

Run the Arbor workflow with every dispatched role (explore / architect / implement / review / verify / fix / simplify) on the **star** target (Claude Code fork, same model class as the main agent) for this checkout, then continue the current task. The choice is sticky: all later dispatches in this project use star until `/arbor:workflow-pi`.

Optional argument: a requirement or task description. If given and there is no active task, start Phase 1 with it.

---

## Step 1: Switch the target

```bash
{{PYTHON_CMD}} ./.arbor/scripts/dispatch.py target set star
```

## Step 2: Confirm the assistants

```bash
for role in explore architect implement review verify fix simplify; do
  {{PYTHON_CMD}} ./.arbor/scripts/dispatch.py resolve --role $role --json
done
```

Each of the seven lines must show `"target": "star"` and a numeric `assistant_id`. If any `assistant_id` is `null`, run `{{PYTHON_CMD}} ./.arbor/scripts/dispatch.py codeg-setup` once (it reads the ids from codeg) and resolve again. Tell the user in one line which assistants will be used, e.g. `review → arbor-review-star (id N)`.

## Step 3: Continue the workflow

```bash
{{PYTHON_CMD}} ./.arbor/scripts/get_context.py
{{PYTHON_CMD}} ./.arbor/scripts/get_context.py --mode phase
```

Route exactly as `/arbor:continue` does, by the active task's `status`:

- no active task → Phase 1 (`arbor-brainstorm`), using the argument as the requirement if one was given
- `planning` → finish the planning artifacts (1.2 explore & design dispatches `explore` / `architect`) and the context manifests, then `task.py start`
- `in_progress` → Phase 2 (serial) or Phase 2P (`meta.execution=parallel`): dispatch `implement`, run the review loop (`review` → `verify` → `fix`), then for complex tasks Phase 2F (`simplify`, final `review`), then Phase 3

From here on every dispatch resolves to the star assistants through `.arbor/.runtime/dispatch-target`; do not add a conflicting `Target:` header line. Everything else in `.arbor/workflow.md` is unchanged: the task text still starts with `Active task:` + `Role:` (plus `Mode:` / `Diff:` where the role takes them), roles never run through the built-in Agent/Task tool, and only you commit.
