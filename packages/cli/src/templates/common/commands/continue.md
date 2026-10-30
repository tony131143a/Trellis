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
  {{PYTHON_CMD}} ./.arbor/scripts/arbor.py next
  ```
  `needs=brief` → write the brief at `brief_path`, then `arbor.py run`; `needs=run` → `arbor.py gate`; `needs=decide` → `arbor.py decide <choice> --reason "…"`; `needs=human` → ask the user (`human.kind`: `approve_contract` → re-approval, then `arbor.py resume`; `plausible` → `arbor.py decide fix|skip --reason "…"`; `merge` → Phase 3); `done` → Phase 3. A `STOP` state: report it; the user chooses `resume`, `override --reason "…" (--to STATE[/step] | --role <role>)` or `abandon [--reason "…"]`.
- `status=completed` (rare; usually archived immediately) → `{{CMD_REF:finish-work}}`

Roles are never performed in this session and never through the built-in `Agent`/`Task` tool; the driver prepares and validates them; codeg MCP executes the prepared delegation.

## Step 4: Load the Specific Step

```bash
{{PYTHON_CMD}} ./.arbor/scripts/get_context.py --mode phase --step <X.X> --platform {{CLI_FLAG}}
```

Follow the loaded instructions. After each `[required]` step completes, move to the next.

---

## Reference

Full workflow and detailed phase steps live in `.arbor/workflow.md`. This command is only an entry point — the canonical guidance is there.


## codeg MCP delegation

With the `codeg-mcp` executor, `arbor.py run` returns `needs=delegation`. Call codeg MCP `delegate_to_agent` with the returned `mcp.arguments` (resolve the named assistant from the MCP roster if no id is configured), then immediately run `arbor.py bind --request <request_path> --task-id <returned task_id>`. Poll `get_delegation_status`, save its complete JSON response at the returned `result_path` outside the task worktree, and run `arbor.py collect --request <request_path> --result <file>` before proceeding. Resume/poll a bound task after interruptions; never start it again. If the configured timeout expires, cancel it through `cancel_delegation` and collect the terminal report. Claude Code and Codex both use this same MCP flow. Do not substitute `codeg-cli run` or native Agent/Task/spawn_agent.
