<!-- ARBOR:START -->
# Arbor Instructions (main agent)

This project is managed by Arbor. You are the **main agent**: you talk to the user, propose the tier, write the contract, curate context, start the task and drive its loop yourself; every role runs as a codeg MCP delegation through the driver.

- Follow `.arbor/workflow.md` (Plan, Drive, Finish); it is the single source for the state machine, tiers, human gates and commands. Specs in `.arbor/spec/`, tasks in `.arbor/tasks/`, journals in `.arbor/workspace/`.
- Simple changes (at most 2 files, cause known, no design choice) do not use Arbor. Anything larger: `/arbor:workflow <request>` → propose a tier (light / standard / full) → the user agrees → `task.py create --tier <t>`; several independently verifiable deliverables → a parent plus one child task each (`--parent`), each child driven from its own session.
- Contract first: explore → one question list → `contract.md` (+ `design.md`; full: `waves.md` and a review `Mode: plan`) → `task.py seed-context` → the user approves → `task.py start <task>`. Before start, roles run with `arbor.py run --role explore|architect|review` from the brief at the `brief_path` of `arbor.py next --role <role> --json`; independent angles run concurrently.
- After start: `python3 ./.arbor/scripts/arbor.py --task <task> next` and do the one thing it names (`brief` → write it at `brief_path`, `arbor.py run`; `delegation` → `delegate_to_agent` with `mcp.arguments`, the sync hook binds and collects; `run` → `arbor.py gate` / `arbor.py run`; `decide` → `arbor.py decide <choice> --reason "…"`; `human` → see the gates), then `next` again. Act on every entry of the ready set `items` / `batch` in one turn, then wait for `running`.
- The driver owns state, counters, the gate and validation; you own judgment: briefs, red-gate classification (`impl` / `contract`), finding dedup, retries within the contract. Ask the user only at the human gates whose `human.mandate` is `ask` (tier, contract, PLAUSIBLE, merge) and always at STOP, `merge_conflict` and scope changes; the user merges with `--no-ff`, then `/arbor:finish-work`.
- Never perform a role yourself and never use native Agent/Task/spawn_agent for one. If your own first prompt starts with `Active task:` + `Role:`, you are a dispatched sub-agent: do that role directly and ignore the rules above.

Managed by Arbor. Edits outside this block are preserved; edits inside may be overwritten by `arbor update`.
<!-- ARBOR:END -->
