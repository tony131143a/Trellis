# Continue Current Task

Resume work on the current task — pick up where `.arbor/workflow.md` and the driver say you are.

---

## Step 1: Load Current Context

```bash
python3 ./.arbor/scripts/get_context.py
```

Confirms: current task, git state, recent commits.

## Step 2: Load the Phase Index

```bash
python3 ./.arbor/scripts/get_context.py --mode phase
```

Shows the Phase Index (Plan / Drive / Finish), the state machine, tiers and human gates.

## Step 3: Decide Where You Are

`get_context.py` shows the active task's `status` and `Tier:` line. This command does not itself approve anything.

- `status=planning` (Phase 1, CONTRACT):
  - no `contract.md`, or it has no acceptance criteria yet → **1.1** explore / **1.2** questions / **1.3** write the contract
  - standard / full without `design.md`, or full without the user's architect choice and `waves.md` → **1.4**
  - `implement.jsonl` / `check.jsonl` empty → **1.5** (`task.py seed-context <task>`, then adjust)
  - contract not validated, or standard / full without a plan review → **1.6**
  - everything present → **1.7** (planning summary, wait for the user's approval, then `task.py start`)
  - explore / architect / review in this phase: write the brief at the `brief_path` from `arbor.py next --json`, then `arbor.py run --role <role> [--mode plan]` (main checkout, no commit)
- `status=in_progress` (Phase 2, driven) → run the driver and do the one thing it names:
  ```bash
  python3 ./.arbor/scripts/arbor.py next
  ```
  `needs=brief` → write the brief at `brief_path`, then `arbor.py run`; `needs=run` → `arbor.py gate`; `needs=decide` → `arbor.py decide <choice> --reason "…"`; `needs=human` → ask the user (`human.kind`: `approve_contract` → re-approval, then `arbor.py resume`; `plausible` → `arbor.py decide fix|skip --reason "…"`; `merge` → Phase 3); `done` → Phase 3. A `STOP` state: report it; the user chooses `resume`, `override --reason "…" (--to STATE[/step] | --role <role>)` or `abandon [--reason "…"]`.
- `status=completed` (rare; usually archived immediately) → `/arbor:finish-work`

Roles are never performed in this session and never through the built-in `Agent`/`Task` tool; only `arbor.py run` executes them.

## Step 4: Load the Specific Step

```bash
python3 ./.arbor/scripts/get_context.py --mode phase --step <X.X> --platform claude
```

Follow the loaded instructions. After each `[required]` step completes, move to the next.

---

## Reference

Full workflow and detailed phase steps live in `.arbor/workflow.md`. This command is only an entry point — the canonical guidance is there.
