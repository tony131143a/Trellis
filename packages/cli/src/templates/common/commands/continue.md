# Continue Current Task

Resume work on the current task — pick up at the right phase/step in `.arbor/workflow.md`.

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

Shows the Phase Index (Plan / Execute / Finish) with routing + skill mapping.

## Step 3: Decide Where You Are

`get_context.py` shows the active task's `status` field. Route by `status` + artifact presence. This command replaces the user needing to remember the Arbor flow; it does not itself approve implementation.

- `status=planning` + no `prd.md` → **1.1** (load `arbor-brainstorm`)
- `status=planning` + `prd.md` only → decide whether the task is lightweight or complex. Lightweight can move to **1.4** review; complex returns to **1.1** to add `design.md` + `implement.md`.
- `status=planning` + `prd.md` (+ `design.md` for complex) but technical facts or design choices still open → **1.2** (explore / clarify / architect; complex tasks need the user's design choice before `design.md` is written)
- `status=planning` + complex artifacts complete + `implement.jsonl` / `check.jsonl` not curated (empty, or only a legacy `_example` placeholder row) → **1.3**
- `status=planning` + required artifacts complete + both jsonl curated → **1.4** (decide serial vs parallel execution mode; ask for start review; only run `task.py start` after user confirms)
- `status=in_progress` + `meta.execution` is not `parallel` (serial) + implementation not started → **2.1** (snapshot S0, dispatch the implement role)
- `status=in_progress` + serial + implementation done, review loop not clean → **2.2** (review → verify → fix, at most 2 rounds; diffs are taken against the S0 snapshot)
- `status=in_progress` + `meta.execution=parallel` (the `<workflow-state>` breadcrumb key is `in_progress-parallel`) → **Phase 2P**. Resume at the first unfinished step:
  - children not created, or file ownership not written → **2P.0**
  - children exist, no worktrees → **2P.1**
  - worktrees exist, children not all implemented → **2P.2** (only re-dispatch the children that are not done)
  - implemented children not reviewed/committed → **2P.3**
  - reviewed children not all merged → **2P.4** (merge serially; `git branch --merged` and `git worktree list` tell you which are merged)
  - all merged, worktrees still present → **2P.5** (cleanup)
  - worktrees removed → **Phase 2F** on the parent task, then **3.3** and **3.4**
- `status=in_progress` + review loop clean + complex task (`design.md` present) + polish not done → **Phase 2F** (2F.1 simplify → 2F.2 final review → 2F.3 user decision → 2F.4 fix → 2F.5 quality checks)
- `status=in_progress` + review loop clean + lightweight task → **2F.5** (quality checks), then **3.3** (spec update) → **3.4** (commit)
- `status=in_progress` + 2F.5 passed → **3.3** (spec update) → **3.4** (commit)
- `status=completed` (rare; usually archived immediately) → archive flow

The seven roles (explore / architect / implement / review / verify / fix / simplify) are never done in this session and never through the built-in `Agent`/`Task` tool. Dispatch them with `delegate_to_agent` (codeg) or `python3 ./.arbor/scripts/dispatch.py run --role <role>`, with the `Active task:` / `Role:` header (review adds `Mode:`; review/verify/fix/simplify add `Diff:`). See the Dispatch section of `.arbor/workflow.md`.

Phase rules (full detail in `.arbor/workflow.md`):

1. Run steps **in order** within a phase — `[required]` steps must not be skipped
2. `[once]` steps are already done if the required output exists. `prd.md` alone can be enough only for lightweight tasks; complex tasks also need `design.md` and `implement.md`.
3. You may go back to an earlier phase if discoveries require it

## Step 4: Load the Specific Step

Once you know which step to resume at:

```bash
{{PYTHON_CMD}} ./.arbor/scripts/get_context.py --mode phase --step <X.X> --platform {{CLI_FLAG}}
```

Follow the loaded instructions. After each `[required]` step completes, move to the next.

---

## Reference

Full workflow and detailed phase steps live in `.arbor/workflow.md`. This command is only an entry point — the canonical guidance is there.
