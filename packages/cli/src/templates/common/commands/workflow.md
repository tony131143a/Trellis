# Arbor Workflow

Start an Arbor task from a request, or continue the current one. You are the main agent: you plan, get the contract approved, then drive the started task yourself and dispatch every role (explore / architect / implement / review / fix; simplify on demand) through the driver, `{{PYTHON_CMD}} ./.arbor/scripts/arbor.py`, and the executor configured under `executors:` in `.arbor/config.yaml` (default: Orca workers).

Arguments: `[--tier light|standard|full] [request]`

- `[--tier light|standard|full]` (optional): the tier for the task created from `[request]` (see the Tiers table in `.arbor/workflow.md`). Omit it to propose one yourself. The driver may later escalate a light task to standard by itself (`next --json` shows `escalated`).
- `[request]` (optional): a requirement or task description. With no active task it counts as consent to create one; the tier still needs the user's agreement unless `--tier` was given.

---

## Step 1: Load the state

```bash
{{PYTHON_CMD}} ./.arbor/scripts/get_context.py
{{PYTHON_CMD}} ./.arbor/scripts/get_context.py --mode phase
```

## Step 2: Intake (no active task)

1. Propose a tier (light / standard / full) with a one-line reason, unless `--tier` was given, and wait for the user's answer. A request that looks simple still gets a light task here, because the user explicitly asked for the workflow. Two or more independently verifiable deliverables → propose a parent task plus one child per deliverable (each child with its own tier).
2. Create the task (step 1.0):
   ```bash
   {{PYTHON_CMD}} ./.arbor/scripts/task.py create "<title>" --description "<summary>" --slug <name> --tier <tier>
   # children: ... --parent <parent-dir>
   ```
3. Continue with Step 3 (for a parent: its contract first, then one contract per child).

## Step 3: Contract (status `planning`)

Phase 1 of `.arbor/workflow.md`: explore (main agent chooses independent angles; no total quota) → one numbered question list → `contract.md` (+ `design.md`; full: main-agent-selected architecture perspectives → consolidated → `waves.md`) → `task.py seed-context <task>` → structural validation → standard / full: one review `Mode: plan` → planning summary → the user approves the contract → `task.py start <task>`.

Roles in this phase (explore, architect, review `Mode: plan`) run before `task.py start`:

```bash
{{PYTHON_CMD}} ./.arbor/scripts/arbor.py next --json   # gives the next `dispatch` id and its `brief_path`
# write the brief at brief_path, then:
{{PYTHON_CMD}} ./.arbor/scripts/arbor.py run --role explore|architect|review [--mode plan]
```

For multiple independent research or architecture angles, use `next --role explore|architect --json`, write each named brief, then `run --role <role> --dispatch <id>`. Each `run` starts a worker; their execution overlaps with no Arbor reader-count limit; the main agent chooses how many to dispatch. `next --json` lists all `pending_workers`; `arbor.py sync` collects in any completion order. Each reader writes `research/<dispatch>-*.md`. No tier imposes a total role count or a fixed three-perspective design set. The main agent consolidates evidence before plan review/start. Started tasks in CONTRACT support the same replanning path.

They run in the main checkout and commit nothing; explore and architect may write only the task's `research/`. Read the reply in `reports/<id>.md`. `task.py start` commits the task directory later.

## Step 4: Drive (status `in_progress`)

Right after `task.py start`, drive the loop from this session:

```bash
{{PYTHON_CMD}} ./.arbor/scripts/arbor.py --task <task> next   # do the one thing it names, then next again
```

Act on `next`:

- `needs=brief` → write the brief at `brief_path` (decisions, pitfalls, files to stay out of), then `arbor.py run`. With the default `orca` executor `run` starts an Orca worker and returns `needs: worker`: see below.
- `needs=run` → `arbor.py gate` (GATE) or `arbor.py run` (wave merge). `needs=wait` → end your turn until a running partition or reader worker reports (Orca wakes you), then `arbor.py sync` and `next`.
- `batch` in `next --json` → the step's readers may run in parallel (REVIEW candidate readers for standard / full): write every listed brief, then `arbor.py run --dispatch <id>` for each without waiting.
- `needs=decide` → `arbor.py decide <choice> --reason "<evidence>"` (`impl` / `contract` after a red gate; `fix` / `skip` for PLAUSIBLE findings).
- `needs=human` → `human.kind` says which: `approve_contract` → edit `contract.md`, get the user's re-approval, `arbor.py resume`; `plausible` → put the findings to the user once, most severe first, with your recommendation, then `arbor.py decide fix|skip --reason "…"`; `stop` → inspect the reason and evidence, then `arbor.py resume`, `override --reason "…" (--to STATE[/step] | --role <role>)`, a re-plan, or `abandon`; `merge_conflict` → merge the named branch by hand in the task worktree, commit, `arbor.py resume`; `merge` → Phase 3 (`{{CMD_REF:finish-work}}`): the user merges `--no-ff`, then `arbor.py finish`. `human.mandate` (`ask` / `auto`, from `mandate:` in `.arbor/config.yaml` per tier or `task.py create --mandate`) says whether the gate asks the user; with `auto` the driver itself skips PLAUSIBLE findings and, at FINISH, `arbor.py finish` merges a small clean, in-scope, reviewed branch; merge into the baseline is `ask` in every tier unless the user opts in; STOP and scope changes are always asked.
- More than one entry in `items` (`next --json`) → act on every one in this turn (each brief at its own `brief_path`, dispatch them all), then end your turn and wait for `running`; the driver computes the ready set, never add to it.
- `done` → Phase 3.
- Parent task: each child is driven from its own session (one Orca agent session per child, `--task <child>` on every call); `arbor.py --task <parent> children` lists every child's state and merge status. Start every child without an unmet dependency. The first started child creates the parent's integration branch `arbor/<parent>`; children are cut from it and the child's second `arbor.py finish` merges it back there by itself (catch-up merge, gate, scope and review-head checks; a failed check prints the merge command and becomes a human merge). A child skips REVIEW (`review_deferred`): BUILD → GATE → merge. The baseline is untouched until every child is merged: then `task.py integrate <parent>` starts the integration review (the parent takes the integration worktree; `arbor.py --task <parent> next` drives candidates → fix on the integration branch → GATE → recheck → FINISH); `arbor.py --task <parent> finish` prints the `--no-ff` merge command, the user merges (always asked), and `finish` again cleans up and archives the parent.

Never perform a role in this session and never use the built-in Agent/Task tool for one. The driver writes the dispatch header and injects the contract, design and diff; a brief carries only what those do not say.


## Orca workers (executor `orca`)

With the `orca` executor (`executors.default: orca`), `arbor.py run` assembles the prompt in `.arbor/.runtime/prompts/<task>/`, writes the worker's task spec (the dispatch header plus `Prompt:` and `Report:` lines) and starts the worker itself with `orca orchestration worker-start` in the task's Orca Run; it prints `needs: "worker"`, `orca_dispatch`, `prompt_path` and `reply_path`. You never call a tool to start a role. The worker reads the `Prompt:` file, writes its complete report to the `Report:` file and sends Orca's `worker_done` once; the driver takes the verdict from the report file, not from `--outcome`. After starting every ready item, end your turn: Orca wakes you when a worker reports, asks a question or stops (if the wake names an `orca orchestration check` command, run it). Then run `arbor.py sync` (`--dispatch d-NNN`, `--wait <duration>` polls until a worker settles or needs attention), then `arbor.py next`. `sync` validates the report of every settled worker and advances the task, even when the worker failed, exited or timed out in Orca but wrote its report; a settled worker without a report is collected as a failed dispatch, and one that sent `worker_done` with an empty report file is collected for judgment (`decide retry` or `decide accept --report <file>`; read the output with `orca orchestration worker-read --dispatch <id>`). It prints `waiting for a person (...)` for a permission prompt the user answers in the worker's Orca tab, `running (orca dispatch <id>)` for a worker still going, and `its turn ended without a report or worker_done` for a worker that stopped silently (answer its question if it asked one, otherwise `orca orchestration send --to dispatch:<orca dispatch> --subject "finish" --body "Write the report to <reply file>, then send worker_done."`). Past the executor `timeout` it stops the worker and collects it only when Orca confirms the stop; otherwise it prints `not collected`: inspect `orca orchestration worker-show --dispatch <id>`, then `sync` again. A failed start is not a failed dispatch: `arbor.py run` exits 1 and prints why on stderr (usually environmental: agent CLI missing, a trust prompt, Orca unreachable) and the request stays prepared (`needs: worker`, not started). Fix the cause and run `arbor.py run --dispatch d-NNN` again; it is safe to repeat, and the third failed start in a row fails the dispatch. Never retry with a new dispatch to get around it. A missing Orca CLI is an error (set `executors.<name>.command`). A worker's question arrives as Orca mail: answer with `orca orchestration reply --id <message_id> --body "..."`. Do not substitute native Agent/Task/spawn_agent for a role.
