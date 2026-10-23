# Dispatch Target

Switch which codeg assistant family the implement / check / research roles are dispatched to: `star` (Claude Code fork) or `pi` (pi + DeepSeek).

Argument (one of): `star`, `pi`, `clear`.

## Step 1: Apply

- `star` or `pi`:

  ```bash
  {{PYTHON_CMD}} ./.arbor/scripts/dispatch.py target set <arg>
  ```

- `clear` (fall back to the configured default):

  ```bash
  {{PYTHON_CMD}} ./.arbor/scripts/dispatch.py target clear
  ```

If no argument was given, show the current value instead:

```bash
{{PYTHON_CMD}} ./.arbor/scripts/dispatch.py target get
```

## Step 2: Echo the effective resolution

```bash
{{PYTHON_CMD}} ./.arbor/scripts/dispatch.py resolve --role implement
```

Report the effective target and the assistant that `implement` resolves to, so the user sees what the switch changed. If `codeg-assistants.json` has the ids, use the printed `assistant_id` for the next `delegate_to_agent` call.

## Resolution order (highest wins)

1. `Target: <t>` line in the dispatch header, or `--target` on `dispatch.py run`
2. `.arbor/.runtime/dispatch-target` (what this command writes)
3. `ARBOR_DISPATCH_TARGET` environment variable
4. `dispatch.default_target` in `.arbor/config.yaml`

The setting is local to this checkout (runtime state, gitignored). It affects future dispatches only; runs already in flight keep their target.
