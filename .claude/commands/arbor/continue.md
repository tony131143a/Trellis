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
- `status=planning`: read the `Tier:` line that `get_context.py` prints (`Tier: standard` or `Tier: standard (inferred)`; pin it with `task.py set-meta <task> tier <t>`), then:
  - tier artifacts missing (light = `prd.md`; standard = + `design.md`; full = + `implement.md`) → **1.1** / **1.2**
  - open questions or design choices (full: the user has not picked an architect design) → **1.2** (explore as needed, then ask all open questions as ONE numbered list)
  - `implement.jsonl` / `check.jsonl` empty, or only the legacy `_example` row → **1.3** (`task.py seed-context <task>`, then adjust the entries)
  - artifacts complete + both manifests curated → **1.4** (final planning summary, wait for the user's approval, then `task.py start`; for full, decide serial vs parallel execution mode first)
- `status=in_progress` + `meta.execution` is not `parallel` (serial):
  - implementation not started → **2.1** (snapshot S0, dispatch the implement role)
  - implementation done, gate review not clean → **2.2** (one review `Mode: self-check` on the diff against S0, then fix; light at most 2 rounds, standard / full at most 1)
  - gate review clean, tier light → **2F.5** (quality checks) → **3.3** (spec update) → **3.4** (commit)
  - gate review clean, tier standard / full → **2F.1** (simplify) → **2F.2** (final review) → **2F.3** (decide) → **2F.4** (fix) → **2F.5** (quality checks) → **3.3** → **3.4**
- `status=in_progress` + tier full + `meta.execution=parallel` (the `<workflow-state>` breadcrumb key is `in_progress-parallel`) → **Phase 2P**. Resume at the first unfinished step:
  - children not created, or file ownership not written → **2P.0**
  - children exist, no worktrees → **2P.1**
  - worktrees exist, children not all implemented → **2P.2** (only re-dispatch the children that are not done)
  - implemented children not gate-reviewed or not committed → **2P.3** (Gate review + commit)
  - reviewed children not all merged → **2P.4** (merge serially; `git branch --merged` and `git worktree list` tell you which are merged)
  - all merged, worktrees still present → **2P.5** (cleanup)
  - worktrees removed → **Phase 2F** on the parent task, then **3.3** and **3.4**
- `status=in_progress` + 2F.5 passed → **3.3** (spec update) → **3.4** (commit)
- `status=completed` (rare; usually archived immediately) → archive flow

The seven roles (explore / architect / implement / review / verify / fix / simplify) are never done in this session and never through the built-in `Agent`/`Task` tool. Dispatch them with `delegate_to_agent` (codeg) or `python3 ./.arbor/scripts/dispatch.py run --role <role>`, with the `Active task:` / `Role:` header (review adds `Mode:`; review/verify/fix/simplify add `Diff:`). See the Dispatch section of `.arbor/workflow.md`.

Phase rules (full detail in `.arbor/workflow.md`):

1. Run steps **in order** within a phase — `[required]` steps must not be skipped
2. `[once]` steps are already done if the required output exists. Light tasks need only `prd.md`; standard tasks also need `design.md`; full tasks also need `implement.md`.
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
