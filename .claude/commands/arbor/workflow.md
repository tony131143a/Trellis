# Arbor Workflow

Start an Arbor task from a request, or continue the current one. Every role (explore / architect / test / implement / review / verify / fix / simplify) runs through the driver, `python3 ./.arbor/scripts/arbor.py`, and the executor configured under `executors:` in `.arbor/config.yaml`.

Arguments: `[--tier light|standard|full] [request]`

- `[--tier light|standard|full]` (optional): the tier for the task created from `[request]` (see the Tiers table in `.arbor/workflow.md`). Omit it to propose one yourself.
- `[request]` (optional): a requirement or task description. With no active task it counts as consent to create one; the tier still needs the user's agreement unless `--tier` was given.

---

## Step 1: Load the state

```bash
python3 ./.arbor/scripts/get_context.py
python3 ./.arbor/scripts/get_context.py --mode phase
```

## Step 2: Intake (no active task)

1. Propose a tier (light / standard / full) with a one-line reason, unless `--tier` was given, and wait for the user's answer. A request that looks simple still gets a light task here, because the user explicitly asked for the workflow.
2. Create the task (step 1.0):
   ```bash
   python3 ./.arbor/scripts/task.py create "<title>" --description "<summary>" --slug <name> --tier <tier>
   ```
3. Continue with Step 3.

## Step 3: Contract (status `planning`)

Phase 1 of `.arbor/workflow.md`: explore (soft cap light 1 / standard 3 / full 5) → one numbered question list → `contract.md` (+ `design.md`; full: 3 architect perspectives → the user picks → `waves.md`) → `task.py seed-context <task>` → structural validation → standard / full: one review `Mode: plan` → planning summary → the user approves the contract → `task.py start <task>`.

Roles in this phase (explore, architect, review `Mode: plan`) run before `task.py start`:

```bash
python3 ./.arbor/scripts/arbor.py next --json   # gives the next `dispatch` id and its `brief_path`
# write the brief at brief_path, then:
python3 ./.arbor/scripts/arbor.py run --role explore|architect|review [--mode plan]
```

They run in the main checkout and commit nothing; explore and architect may write only the task's `research/`. Read the reply in `reports/<id>.md`. `task.py start` commits the task directory later.

## Step 4: Drive (status `in_progress`)

```bash
python3 ./.arbor/scripts/arbor.py next
```

Do the one thing it names, then run `next` again:

- `needs=brief` → write the brief for the named role at `brief_path`, then `python3 ./.arbor/scripts/arbor.py run`
- `needs=run` (GATE) → `python3 ./.arbor/scripts/arbor.py gate`
- `needs=decide` → `python3 ./.arbor/scripts/arbor.py decide <choice> --reason "<evidence>"`
- `needs=human` → ask the user, by `human.kind`: `approve_contract` (they re-approve the edited contract, then `arbor.py resume`), `plausible` (`arbor.py decide fix|skip --reason "…"`), `stop` (see below), `merge` (Phase 3)
- `done` → Phase 3 (`/arbor:finish-work`)

On STOP, report the reason and the last evidence; the user decides between `arbor.py resume`, `arbor.py override --reason "…" (--to STATE[/step] | --role <role>)` and `arbor.py abandon [--reason "…"]`.

Never perform a role in this session and never use the built-in Agent/Task tool for one. The driver writes the dispatch header and injects the contract, design and diff; your brief carries only what those do not say.
