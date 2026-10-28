# Workflow on One Target

Run the Arbor workflow with every dispatched role (explore / architect / implement / review / verify / fix / simplify) on one dispatch target for this session, then continue the current task. The choice is sticky and per session: all later dispatches in this session use that target until `/arbor:workflow <other>` or `{{PYTHON_CMD}} ./.arbor/scripts/dispatch.py target clear`. Other sessions on the same checkout keep their own target (`target set --repo <target>` sets the checkout-wide fallback they share).

Arguments: `<target> [--tier light|standard|full] [request]`

- `<target>` (required): a name under `dispatch.targets` in `.arbor/config.yaml`. Shipped targets: `star` (Claude Code fork, same model class as the main agent), `pi` (pi agent with DeepSeek, cheaper and faster), `codex` (Codex CLI in full-access mode).
- `[--tier light|standard|full]` (optional): the tier for the task created from `[request]` (see the Tiers table in `.arbor/workflow.md`). Omit it to use your own classification.
- `[request]` (optional): a requirement or task description. If given and there is no active task, it counts as consent to create a task: create it with `--tier` (or your own classification; a quick-looking request still gets a light task here, because the user explicitly asked for the workflow) and go to 1.1 brainstorm.

If no target was given, run `{{PYTHON_CMD}} ./.arbor/scripts/dispatch.py target get`, report the current target and ask the user which one to use. Do not guess.

---

## Step 1: Switch the target

```bash
{{PYTHON_CMD}} ./.arbor/scripts/dispatch.py target set <target>
```

Exit code 2 with `unknown dispatch target` means the name is not configured; the message lists the known targets. Show them to the user and stop. A stderr line about missing session identity means the target was written checkout-wide instead; tell the user in one line.

## Step 2: Confirm the assistants

```bash
for role in explore architect implement review verify fix simplify; do
  {{PYTHON_CMD}} ./.arbor/scripts/dispatch.py resolve --role $role --json
done
```

Each of the seven lines must show `"target": "<target>"` and a numeric `assistant_id`. If any `assistant_id` is `null`, run `{{PYTHON_CMD}} ./.arbor/scripts/dispatch.py codeg-setup` once (it reads the ids from codeg) and resolve again. Tell the user in one line which assistants will be used, e.g. `review → arbor-review-<target> (id N)`.

## Step 3: Continue the workflow

```bash
{{PYTHON_CMD}} ./.arbor/scripts/get_context.py
{{PYTHON_CMD}} ./.arbor/scripts/get_context.py --mode phase
```

Route exactly as `/arbor:continue` does, by the active task's `status` and tier:

- no active task → create one (`task.py create "<title>" --description "<summary>" --slug <name> --tier <tier>`, step 1.0), then Phase 1.1 (`arbor-brainstorm`), using the request as the requirement
- `planning` → the artifacts for the tier (light `prd.md`; standard + `design.md`; full + `implement.md`; 1.2 explore & design dispatches `explore` / `architect` as needed), then the context manifests via `task.py seed-context` (adjust the entries), then the final planning summary and `task.py start` after the user approves
- `in_progress` → Phase 2 (`implement`, then one gate review `Mode: self-check` ⇄ `fix`), then Phase 2F for standard / full (`simplify`, final `review`, `verify`, `fix`) or Phase 2P for full with `meta.execution=parallel`, then Phase 3

From here on every dispatch in this session resolves to the `<target>` assistants (the delegation hook also swaps an `assistant_id` from another target to the matching `<target>` assistant); do not add a conflicting `Target:` header line. Everything else in `.arbor/workflow.md` is unchanged: the task text still starts with `Active task:` + `Role:` (plus `Mode:` / `Diff:` where the role takes them), roles never run through the built-in Agent/Task tool, and only you commit.
