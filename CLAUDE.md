# CLAUDE.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

<!-- ARBOR:START -->
# Arbor Instructions (main agent)

This project is managed by Arbor. You are the **main agent**: you talk to the user, propose the tier, write the contract, curate context, start the task and drive its loop yourself; every role runs as an Orca worker the driver starts (you run inside Orca).

- Follow `.arbor/workflow.md` (Plan, Drive, Finish); it is the single source for the state machine, tiers, human gates and commands. Specs in `.arbor/spec/`, tasks in `.arbor/tasks/`, journals in `.arbor/workspace/`.
- Simple changes (at most 2 files, cause known, no design choice) do not use Arbor. Anything larger: `/arbor:workflow <request>` → propose a tier (light / standard / full) → the user agrees → `task.py create --tier <t>`; several independently verifiable deliverables → a parent plus one child task each (`--parent`), each child driven from its own session.
- Contract first: explore → one question list → `contract.md` (+ `design.md`; full: `waves.md` and a review `Mode: plan`) → `task.py seed-context` → the user approves → `task.py start <task>`. Before start, roles run with `arbor.py run --role explore|architect|review` from the brief at the `brief_path` of `arbor.py next --role <role> --json`; independent angles run concurrently.
- After start: `python3 ./.arbor/scripts/arbor.py --task <task> next` and do the one thing it names (`brief` → write it at `brief_path`, `arbor.py run`; `worker` → end your turn, Orca wakes you when a worker reports, then `arbor.py sync`; `run` → `arbor.py gate` / `arbor.py run`; `decide` → `arbor.py decide <choice> --reason "…"`; `human` → see the gates), then `next` again. Act on every entry of the ready set `items` / `batch` in one turn, then wait for `running`.
- The driver owns state, counters, the gate and validation; you own judgment: briefs, red-gate classification (`impl` / `contract`), finding dedup, retries within the contract. Ask the user only at the human gates whose `human.mandate` is `ask` (tier, contract, PLAUSIBLE, merge) and always at STOP, `merge_conflict` and scope changes; the user merges with `--no-ff`, then `/arbor:finish-work`.
- Never perform a role yourself and never use native Agent/Task/spawn_agent for one. If your prompt carries `Active task:` + `Role:` (after Orca's dispatch preamble), you are a dispatched worker: do that role directly, write the report to the `Report:` file, send `worker_done` and ignore the rules above.

Managed by Arbor. Edits outside this block are preserved; edits inside may be overwritten by `arbor update`.
<!-- ARBOR:END -->
