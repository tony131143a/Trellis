# Continue Current Task

Resume work on the current task — pick up at the right phase/step in `.arbor/workflow.md`.

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

Shows the Phase Index (Plan / Execute / Finish) with routing + skill mapping.

## Step 3: Decide Where You Are

`get_context.py` shows the active task's `status` field. Route by `status` + artifact presence. This command replaces the user needing to remember the Arbor flow; it does not itself approve implementation.

- `status=planning` + no `prd.md` → **1.1** (load `arbor-brainstorm`)
- `status=planning` + `prd.md` only → decide whether the task is lightweight or complex. Lightweight can move to **1.4** review; complex returns to **1.1** to add `design.md` + `implement.md`.
- `status=planning` + complex artifacts complete + `implement.jsonl` / `check.jsonl` not curated (empty, or only a legacy `_example` placeholder row) → **1.3**
- `status=planning` + required artifacts complete + both jsonl curated → **1.4** (decide serial vs parallel execution mode; ask for start review; only run `task.py start` after user confirms)
- `status=in_progress` + `meta.execution` is not `parallel` (serial) + implementation not started → **2.1** (dispatch the implement role)
- `status=in_progress` + serial + implementation done, not yet checked → **2.2** (dispatch the check role)
- `status=in_progress` + `meta.execution=parallel` (the `<workflow-state>` breadcrumb key is `in_progress-parallel`) → **Phase 2P**. Resume at the first unfinished step:
  - children not created, or file ownership not written → **2P.0**
  - children exist, no worktrees → **2P.1**
  - worktrees exist, children not all implemented → **2P.2** (only re-dispatch the children that are not done)
  - implemented children not checked/committed → **2P.3**
  - checked children not all merged → **2P.4** (merge serially; `git branch --merged` and `git worktree list` tell you which are merged)
  - all merged, no final check → **2P.5**
  - final check passed → **2P.6**, then **3.3** and **3.4** on the parent task
- `status=in_progress` + check passed → **3.3** (spec update) → **3.4** (commit)
- `status=completed` (rare; usually archived immediately) → archive flow

Implement / check / research are never done in this session and never through the built-in `Agent`/`Task` tool. Dispatch them with `delegate_to_agent` (codeg) or `python3 ./.arbor/scripts/dispatch.py run --role <role>`, with the `Active task:` / `Role:` header. See the Dispatch section of `.arbor/workflow.md`.

Phase rules (full detail in `.arbor/workflow.md`):

1. Run steps **in order** within a phase — `[required]` steps must not be skipped
2. `[once]` steps are already done if the required output exists. `prd.md` alone can be enough only for lightweight tasks; complex tasks also need `design.md` and `implement.md`.
3. You may go back to an earlier phase if discoveries require it

## Step 4: Load the Specific Step

Once you know which step to resume at:

```bash
python3 ./.arbor/scripts/get_context.py --mode phase --step <X.X> --platform claude
```

Follow the loaded instructions. After each `[required]` step completes, move to the next.

---

## Reference

Full workflow and detailed phase steps live in `.arbor/workflow.md`. This command is only an entry point — the canonical guidance is there.
