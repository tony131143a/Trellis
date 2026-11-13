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

## Parallel planning readers

`next --json` lists `pending_workers`. Run `arbor.py sync` for every existing worker; do not start it again (a prepared, not started one: `arbor.py run --dispatch <id>`). The main agent runs inside Orca and ends its turn after starting workers; Orca wakes it. For another independent explore/architect angle in CONTRACT, use `next --role <role> --json`, write its brief and `run --role <role> --dispatch <id>`. The main agent chooses the scopes and number of perspectives without a total quota, collects results in any order, then consolidates the plan. There is no total or simultaneous reader-count limit; final plan review and start/resume wait for collection.

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
  python3 ./.arbor/scripts/arbor.py --task <task> next
  ```
  `needs=brief` → write the brief at `brief_path`, then `arbor.py run` (with `batch`: every listed reader's brief, then `run --dispatch <id>` for each in parallel); `needs=worker` → end your turn, then `arbor.py sync` (see below); `needs=run` → `arbor.py gate`; `needs=decide` → `arbor.py decide <choice> --reason "…"`; `needs=human` → `approve_contract` → re-approval + `resume`; `plausible` → ask the user, `arbor.py decide fix|skip --reason "…"`; `stop` → inspect, then `resume` / `override --reason "…" (--to STATE[/step] | --role <role>)` / `abandon`; `merge_conflict` → hand-merge, `resume`; `merge` → Phase 3. `human.mandate` (`ask` / `auto`, from `mandate:` in `.arbor/config.yaml` per tier or `task.py create --mandate`) says whether the gate asks the user; with `auto` the driver itself skips PLAUSIBLE findings and, at FINISH, `arbor.py finish` merges a small clean, in-scope, reviewed branch (only when the user opted in to `merge=auto`); STOP and scope changes are always asked. Parent task → `arbor.py --task <parent> children`; each child is driven from its own session. `done` → Phase 3.
- `status=completed` (rare; usually archived immediately) → `/arbor:finish-work`

Roles are never performed in this session and never through the built-in `Agent`/`Task` tool; you dispatch them through the driver, which records observations for judgment.

## Step 4: Load the Specific Step

```bash
python3 ./.arbor/scripts/get_context.py --mode phase --step <X.X> --platform claude
```

Follow the loaded instructions. After each `[required]` step completes, move to the next.

---

## Reference

Full workflow and detailed phase steps live in `.arbor/workflow.md`. This command is only an entry point — the canonical guidance is there.

## Orca workers (executor `orca`)

With the `orca` executor (`executors.default: orca`), `arbor.py run` assembles the prompt in `.arbor/.runtime/prompts/<task>/`, writes the worker's task spec (the dispatch header plus `Prompt:` and `Report:` lines) and starts the worker itself with `orca orchestration worker-start` in the task's Orca Run; it prints `needs: "worker"`, `orca_dispatch`, `prompt_path` and `reply_path`. You never call a tool to start a role. The worker reads the `Prompt:` file, writes its complete report to the `Report:` file and sends Orca's `worker_done` once; the driver takes the verdict from the report file, not from `--outcome`. After starting every ready item, end your turn: Orca wakes you when a worker reports, asks a question or stops (if the wake names an `orca orchestration check` command, run it). Then run `arbor.py sync` (`--dispatch d-NNN`, `--wait <duration>` polls until a worker settles or needs attention), then `arbor.py next`. `sync` validates the report of every settled worker and advances the task, even when the worker failed, exited or timed out in Orca but wrote its report; a settled worker without a report is collected as a failed dispatch, and one that sent `worker_done` with an empty report file is collected for judgment (`decide retry` or `decide accept --report <file>`; read the output with `orca orchestration worker-read --dispatch <id>`). It prints `waiting for a person (...)` for a permission prompt the user answers in the worker's Orca tab, `running (orca dispatch <id>)` for a worker still going, and `its turn ended without a report or worker_done` for a worker that stopped silently (answer its question if it asked one, otherwise `orca orchestration send --to dispatch:<orca dispatch> --subject "finish" --body "Write the report to <reply file>, then send worker_done."`). Past the executor `timeout` it stops the worker and collects it only when Orca confirms the stop; otherwise it prints `not collected`: inspect `orca orchestration worker-show --dispatch <id>`, then `sync` again. A failed start is not a failed dispatch: `arbor.py run` exits 1 and prints why on stderr (usually environmental: agent CLI missing, a trust prompt, Orca unreachable) and the request stays prepared (`needs: worker`, not started). Fix the cause and run `arbor.py run --dispatch d-NNN` again; it is safe to repeat, and the third failed start in a row fails the dispatch. Never retry with a new dispatch to get around it. A missing Orca CLI is an error (set `executors.<name>.command`). A worker's question arrives as Orca mail: answer with `orca orchestration reply --id <message_id> --body "..."`. Do not substitute native Agent/Task/spawn_agent for a role.
