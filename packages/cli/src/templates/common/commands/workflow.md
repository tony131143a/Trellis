# Arbor Workflow

Start an Arbor task from a request, or continue the current one. Every role (explore / architect / test / implement / review / verify / fix / simplify) runs through the driver, `{{PYTHON_CMD}} ./.arbor/scripts/arbor.py`, and the executor configured under `executors:` in `.arbor/config.yaml`.

Arguments: `[--tier light|standard|full] [request]`

- `[--tier light|standard|full]` (optional): the tier for the task created from `[request]` (see the Tiers table in `.arbor/workflow.md`). Omit it to propose one yourself.
- `[request]` (optional): a requirement or task description. With no active task it counts as consent to create one; the tier still needs the user's agreement unless `--tier` was given.

---

## Step 1: Load the state

```bash
{{PYTHON_CMD}} ./.arbor/scripts/get_context.py
{{PYTHON_CMD}} ./.arbor/scripts/get_context.py --mode phase
```

## Step 2: Intake (no active task)

1. Propose a tier (light / standard / full) with a one-line reason, unless `--tier` was given, and wait for the user's answer. A request that looks simple still gets a light task here, because the user explicitly asked for the workflow.
2. Create the task (step 1.0):
   ```bash
   {{PYTHON_CMD}} ./.arbor/scripts/task.py create "<title>" --description "<summary>" --slug <name> --tier <tier>
   ```
3. Continue with Step 3.

## Step 3: Contract (status `planning`)

Phase 1 of `.arbor/workflow.md`: explore (soft cap light 1 / standard 3 / full 5) → one numbered question list → `contract.md` (+ `design.md`; full: 3 architect perspectives → the user picks → `waves.md`) → `task.py seed-context <task>` → structural validation → standard / full: one review `Mode: plan` → planning summary → the user approves the contract → `task.py start <task>`.

## Step 4: Drive (status `in_progress`)

```bash
{{PYTHON_CMD}} ./.arbor/scripts/arbor.py next
```

Do the one thing it names, then run `next` again:

- `needs=brief` → write the brief for the named role at `brief_path`, then `{{PYTHON_CMD}} ./.arbor/scripts/arbor.py run`
- `needs=run` → `{{PYTHON_CMD}} ./.arbor/scripts/arbor.py run`
- `needs=decide` → `{{PYTHON_CMD}} ./.arbor/scripts/arbor.py decide <choice> --reason "<evidence>"`
- `needs=human` → ask the user (contract re-approval, PLAUSIBLE findings, merge) and record the answer
- `done` → Phase 3 (`{{CMD_REF:finish-work}}`)

On STOP, report the reason and the last evidence; the user decides between `arbor.py resume`, `arbor.py override --reason "…"` and `arbor.py abandon`.

Never perform a role in this session and never use the built-in Agent/Task tool for one. The driver writes the dispatch header and injects the contract, design and diff; your brief carries only what those do not say.
