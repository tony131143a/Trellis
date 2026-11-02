# Continue Current Task

Resume work on the current task — pick up where `.arbor/workflow.md` and the driver say you are.

---

## Step 1: Load Current Context

```bash
{{PYTHON_CMD}} ./.arbor/scripts/get_context.py
```

Confirms: current task, git state, recent commits.

## Step 2: Load the Phase Index

```bash
{{PYTHON_CMD}} ./.arbor/scripts/get_context.py --mode phase
```

Shows the Phase Index (Plan / Drive / Finish), the state machine, tiers and human gates.

## Parallel planning readers

`next --json` lists `pending_delegations`. Resume/poll every existing bound task; do not relaunch it. For another independent explore/architect angle in CONTRACT, use `next --role <role> --json`, write its brief and `run --role <role> --dispatch <id>`. The main agent chooses the scopes and number of perspectives without a total quota, collects results in any order, then consolidates the plan. There is no total or simultaneous reader-count limit; final plan review and start/resume wait for collection.

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
  {{PYTHON_CMD}} ./.arbor/scripts/arbor.py --task <task> next
  ```
  `needs=brief` → write the brief at `brief_path`, then `arbor.py run`; `needs=delegation` → delegate, bind, poll, collect (see below); `needs=run` → `arbor.py gate`; `needs=decide` → `arbor.py decide <choice> --reason "…"`; `needs=human` → `approve_contract` → re-approval + `resume`; `plausible` → ask the user, `arbor.py decide fix|skip --reason "…"`; `stop` → inspect, then `resume` / `override --reason "…" (--to STATE[/step] | --role <role>)` / `abandon`; `merge_conflict` → hand-merge, `resume`; `merge` → Phase 3. `human.mandate` (`ask` / `auto`, from `mandate:` in `.arbor/config.yaml` per tier or `task.py create --mandate`) says whether the gate asks the user; with `auto` the driver itself skips PLAUSIBLE findings, resumes the first STOP and, at FINISH, `arbor.py finish` merges a small clean branch; scope changes are always asked. Parent task → `arbor.py --task <parent> children`; each child is driven from its own session. `done` → Phase 3.
- `status=completed` (rare; usually archived immediately) → `{{CMD_REF:finish-work}}`

Roles are never performed in this session and never through the built-in `Agent`/`Task` tool; you dispatch them through the driver, which records observations for judgment.

## Step 4: Load the Specific Step

```bash
{{PYTHON_CMD}} ./.arbor/scripts/get_context.py --mode phase --step <X.X> --platform {{CLI_FLAG}}
```

Follow the loaded instructions. After each `[required]` step completes, move to the next.

---

## Reference

Full workflow and detailed phase steps live in `.arbor/workflow.md`. This command is only an entry point — the canonical guidance is there.


## codeg MCP delegation (executor `codeg`)

With the `codeg-mcp` executor (`executors.default: codeg`, the default; or `arbor.py --executor codeg`), `arbor.py run` returns `needs=delegation`. The returned `mcp.arguments.task` is the dispatch header plus a `Prompt:` line naming the assembled prompt file in `.arbor/.runtime/prompts/<task>/`; the role reads that file first. Call codeg MCP `delegate_to_agent` with the returned `mcp.arguments` (resolve the named assistant from the MCP roster if no id is configured), then immediately run `arbor.py bind --request <request_path> --task-id <returned task_id>`. Poll `get_delegation_status`, save its complete JSON response at the returned `result_path` outside the task worktree, and run `arbor.py collect --request <request_path> --result <file>` before proceeding. With the Arbor PostToolUse hook installed (`sync-delegation.py`, registered by `arbor init`/`update`), the bind and the collect happen by themselves after each `delegate_to_agent` call and each terminal `get_delegation_status` reply and the hook's note tells you what it did; run `bind` / `collect` by hand only when the note says so or no hook is installed. Resume/poll a bound task after interruptions; never start it again. If the configured timeout expires, cancel it through `cancel_delegation` and collect the terminal report. Claude Code and Codex both use this same MCP flow. Do not substitute native Agent/Task/spawn_agent for a role.
