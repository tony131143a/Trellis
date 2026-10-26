# Workflow on Pi + DeepSeek

Run the Arbor workflow with every dispatched role (implement / check / research) on the **pi** target (pi agent with DeepSeek, cheaper and faster) for this checkout, then continue the current task. The choice is sticky: all later dispatches in this project use pi until `/arbor:workflow-star` or `/arbor:dispatch-target clear`.

Optional argument: a requirement or task description. If given and there is no active task, start Phase 1 with it.

---

## Step 1: Switch the target

```bash
{{PYTHON_CMD}} ./.arbor/scripts/dispatch.py target set pi
```

## Step 2: Confirm the three assistants

```bash
{{PYTHON_CMD}} ./.arbor/scripts/dispatch.py resolve --role implement --json
{{PYTHON_CMD}} ./.arbor/scripts/dispatch.py resolve --role check --json
{{PYTHON_CMD}} ./.arbor/scripts/dispatch.py resolve --role research --json
```

Each line must show `"target": "pi"` and a numeric `assistant_id`. If any `assistant_id` is `null`, run `{{PYTHON_CMD}} ./.arbor/scripts/dispatch.py codeg-setup` once (it reads the ids from codeg) and resolve again. Tell the user in one line which assistants will be used, e.g. `implement → arbor-implement-pi (id N)`.

## Step 3: Continue the workflow

```bash
{{PYTHON_CMD}} ./.arbor/scripts/get_context.py
{{PYTHON_CMD}} ./.arbor/scripts/get_context.py --mode phase
```

Route exactly as `/arbor:continue` does, by the active task's `status`:

- no active task → Phase 1 (`arbor-brainstorm`), using the argument as the requirement if one was given
- `planning` → finish the planning artifacts and the context manifests, then `task.py start`
- `in_progress` → Phase 2 (serial) or Phase 2P (`meta.execution=parallel`): dispatch `implement`, then `check`, final pass `check [finish]`, then Phase 3

From here on every dispatch resolves to the pi assistants through `.arbor/.runtime/dispatch-target`; do not add a conflicting `Target:` header line. Everything else in `.arbor/workflow.md` is unchanged: the task text still starts with `Active task:` + `Role:`, roles never run through the built-in Agent/Task tool, and only you commit.
