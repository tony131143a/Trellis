# Arbor Workflow

Start an Arbor task from a request, or continue the current one. You are the main agent: you plan, get the contract approved, then drive the started task yourself and dispatch every role (explore / architect / test / implement / review / verify / fix / simplify) through the driver, `{{PYTHON_CMD}} ./.arbor/scripts/arbor.py`, and the executor configured under `executors:` in `.arbor/config.yaml` (default: codeg MCP delegation).

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

For multiple independent research or architecture angles, use `next --role explore|architect --json`, write each named brief, then `run --role <role> --dispatch <id>`. Delegate and bind every returned request; their execution overlaps with no Arbor reader-count limit; the main agent chooses how many to dispatch. `next --json` lists all pending delegations; collect in any completion order. Each reader writes `research/<dispatch>-*.md`. No tier imposes a total role count or a fixed three-perspective design set. The main agent consolidates evidence before plan review/start. Started tasks in CONTRACT support the same replanning path.

They run in the main checkout and commit nothing; explore and architect may write only the task's `research/`. Read the reply in `reports/<id>.md`. `task.py start` commits the task directory later.

## Step 4: Drive (status `in_progress`)

Right after `task.py start`, drive the loop from this session:

```bash
{{PYTHON_CMD}} ./.arbor/scripts/arbor.py --task <task> next   # do the one thing it names, then next again
```

Act on `next`:

- `needs=brief` → write the brief at `brief_path` (decisions, pitfalls, files to stay out of), then `arbor.py run`. With the default `codeg` executor `run` returns `needs=delegation`: see below.
- `needs=run` → `arbor.py gate` (GATE) or `arbor.py run` (wave merge). `needs=wait` → wait for the running partitions, then `next`.
- `needs=decide` → `arbor.py decide <choice> --reason "<evidence>"` (`impl` / `tests` / `contract` after a red gate; `fix` / `skip` for PLAUSIBLE findings).
- `needs=human` → `human.kind` says which: `approve_contract` → edit `contract.md`, get the user's re-approval, `arbor.py resume`; `plausible` → put the findings to the user once, most severe first, with your recommendation, then `arbor.py decide fix|skip --reason "…"`; `stop` → inspect the reason and evidence, then `arbor.py resume`, `override --reason "…" (--to STATE[/step] | --role <role>)`, a re-plan, or `abandon`; `merge_conflict` → merge the named branch by hand in the task worktree, commit, `arbor.py resume`; `merge` → Phase 3 (`{{CMD_REF:finish-work}}`): the user merges `--no-ff`, then `arbor.py finish`. `human.mandate` (`ask` / `auto`, from `mandate:` in `.arbor/config.yaml` per tier or `task.py create --mandate`) says whether the gate asks the user; with `auto` the driver itself skips PLAUSIBLE findings, resumes the first STOP and, at FINISH, `arbor.py finish` merges a small clean branch; scope changes are always asked.
- `done` → Phase 3.
- Parent task: each child is driven from its own session (one codeg conversation per child, `--task <child>` on every call); `arbor.py --task <parent> children` lists every child's state and merge status. Start every child without an unmet dependency; merge children in order (for a later child: `git -C <child worktree> merge <base>` yourself, resolve, `arbor.py --task <child> gate`, then the user merges); then `arbor.py --task <parent> run --role review --mode sweep --range <before-first-merge>..<base>` (brief at `brief_path` from `next --role review --json`) and `arbor.py --task <parent> gate`; fixes become a light child; `task.py archive <parent>`.

Never perform a role in this session and never use the built-in Agent/Task tool for one. The driver writes the dispatch header and injects the contract, design and diff; a brief carries only what those do not say.


## codeg MCP delegation (executor `codeg`)

With the `codeg-mcp` executor (`executors.default: codeg`, the default; or `arbor.py --executor codeg`), `arbor.py run` returns `needs=delegation`. The returned `mcp.arguments.task` is the dispatch header plus a `Prompt:` line naming the assembled prompt file in `.arbor/.runtime/prompts/<task>/`; the role reads that file first, so do not paste the prompt into the tool call. Call codeg MCP `delegate_to_agent` with the returned `mcp.arguments` (resolve the named assistant from the MCP roster if no id is configured), then immediately run `arbor.py bind --request <request_path> --task-id <returned task_id>`. Poll `get_delegation_status`, save its complete JSON response at the returned `result_path` outside the task worktree, and run `arbor.py collect --request <request_path> --result <file>` before proceeding. With the Arbor PostToolUse hook installed (`sync-delegation.py`, registered by `arbor init`/`update`), the bind and the collect happen by themselves after each `delegate_to_agent` call and each terminal `get_delegation_status` reply and the hook's note tells you what it did; run `bind` / `collect` by hand only when the note says so or no hook is installed. Resume/poll a bound task after interruptions; never start it again. If the configured timeout expires, cancel it through `cancel_delegation` and collect the terminal report. Claude Code and Codex both use this same MCP flow. Do not substitute native Agent/Task/spawn_agent for a role.
