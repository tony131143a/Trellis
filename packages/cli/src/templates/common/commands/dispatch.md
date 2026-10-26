# Dispatch a Role

Dispatch one implement / check / research run to a codeg assistant, choosing the model target for this run only. Use it when you want to decide by hand which model does the next step instead of relying on the default target.

Arguments: `<role> [target] [brief...]`

- `role` (required): `implement`, `check`, `check-finish` (the final full-scope check), or `research`
- `target` (optional): `star` or `pi`. Omitted → the current default (`dispatch.py target get`)
- `brief` (optional): everything after the target is the task brief. Omitted → write the brief yourself from the task artifacts (see Step 3)

Examples: `/arbor:dispatch implement star`, `/arbor:dispatch research pi compare the two cache strategies`, `/arbor:dispatch check-finish`.

---

## Step 1: Resolve the assistant

```bash
{{PYTHON_CMD}} ./.arbor/scripts/dispatch.py resolve --role <implement|check|research> [--target <star|pi>] --json
```

Read `assistant`, `assistant_id`, and `target` from the JSON. If `assistant_id` is `null`, run `{{PYTHON_CMD}} ./.arbor/scripts/dispatch.py codeg-setup` once (it reads the ids from codeg) and resolve again. `check-finish` resolves as role `check`.

## Step 2: Find the task

```bash
{{PYTHON_CMD}} ./.arbor/scripts/task.py current --json
```

`implement` and `check` need an active task in `in_progress`; stop and tell the user if there is none (`/arbor:continue` or Phase 1 first). `research` may run without a task.

The `Active task:` header line must be the **absolute** path of the task directory in the main checkout.

## Step 3: Write the brief

If the user gave a brief, use it. Otherwise write one from `prd.md`, `design.md`, and `implement.md`: what to do, acceptance criteria, files or areas to touch, the project's check commands (lint / typecheck / tests). Keep it self-contained; the hook inlines the curated specs and task artifacts, the brief supplies intent and scope. Never tell the assistant to delegate, commit, or run `task.py start/current/finish`.

## Step 4: Dispatch

The task text is the header block followed by a blank line and the brief:

```
Active task: <absolute task dir>
Role: implement | check | check [finish] | research
Target: <star|pi>

<brief>
```

Use `Role: check [finish]` for `check-finish`.

- **Inside codeg** (`mcp__codeg-mcp__delegate_to_agent` is in your tools): call `delegate_to_agent(assistant_id=<id from Step 1>, working_dir=<repo root>, task=<text above>)`, then `get_delegation_status(task_ids=[...], wait_ms=60000)` until it is terminal.
- **Plain terminal**: run with the brief on stdin:

  ```bash
  {{PYTHON_CMD}} ./.arbor/scripts/dispatch.py run --role <role> --target <star|pi> [--finish] --wait
  ```

Never use the built-in Agent/Task tool for these roles; a hook denies it.

## Step 5: Report and continue

Summarise the assistant's report (files changed, verification, open questions), skim `git diff --stat`, and continue the workflow: after `implement` the next step is `check`; after a passing `check [finish]` go to Phase 3 (`arbor-update-spec`, commit, `/arbor:finish-work`). The target chosen here applies to this run only; `/arbor:dispatch-target` changes the default.
