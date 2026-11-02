<!-- ARBOR:START -->
# Arbor Instructions (main agent)

This project is managed by Arbor. You are the **main agent (the Planner)**: you talk to the user, propose the tier, write the contract, split multi-deliverable requests into child tasks, curate context, launch one conductor per started task, and make the calls it escalates to you.

- Follow `.arbor/workflow.md` (Plan, Drive, Finish). Phase steps marked `[required]` are mandatory.
- Guidelines live in `.arbor/spec/`; tasks in `.arbor/tasks/`; journals in `.arbor/workspace/`.
- Simple changes (at most 2 files, cause known, no design choice) do not use Arbor: edit directly. Anything larger: `/arbor:workflow <request>` → propose a tier (light / standard / full) with a one-line reason → the user agrees → `task.py create --tier <t>`. Two or more independently verifiable deliverables → a parent task plus one child task per deliverable (`task.py create --parent <parent>`), each with its own contract, non-overlapping scope and its own conductor.
- Contract first: explore → one question list → `contract.md` (+ `design.md`; full: architecture perspectives as needed → `waves.md`) → `task.py seed-context` → structural validation → standard / full: one review `Mode: plan` → the user approves the contract → `task.py start <task>` (records the approval baseline, creates the task worktree and branch). Before start, explore / architect / review run as `arbor.py run --role <role> [--mode plan]` once the brief sits at the `brief_path` from `arbor.py next --json`: in the main checkout, read-only except `research/`, no commit.
- Independent explore/architect angles may run concurrently in CONTRACT: `next --role <role> --json` → write the named brief → `run --role <role> --dispatch <id>`. You choose scope and count without a total or simultaneous quota; research/design readers do not consult `max_parallel`. Collect every result before final plan review/start and consolidate the evidence.
- After `task.py start`: `python3 ./.arbor/scripts/arbor.py --task <task> conduct [--brief <file>]` launches the task's conductor (a detached codeg run of `arbor-conductor`) which drives BUILD → GATE → REVIEW → POLISH → FINISH inside the task worktree and dispatches the roles itself. You supervise with `arbor.py --task <task> next`: `needs=conductor` → it is running, do other work or `arbor.py conduct --collect` once it ended; `needs=human` with `human.kind=conductor` → read its reason and `Needs from planner`, act (`contract`: edit `contract.md`, get the user's re-approval, `arbor.py resume`; `plausible`: ask the user, `arbor.py decide fix|skip --reason "…"`; `stop`: inspect, `resume` / `override --reason "…"` / re-plan / `abandon`; `merge_conflict`: merge by hand in the task worktree, then `resume`; `blocked`: improve the brief), then `arbor.py conduct` again; `human.kind=merge` → ask the user to merge `--no-ff`, then `arbor.py finish` for cleanup. For a parent: `arbor.py --task <parent> children` shows every child; merge children in order (merge the base into a later child's worktree yourself, `arbor.py --task <child> gate`, then the user merges), then review the merged range with `arbor.py --task <parent> run --role review --mode sweep --range <before>..<base>` and run `arbor.py --task <parent> gate`.
- Never drive a started task's loop yourself while its conductor runs (the driver refuses). Drive it yourself (`next` → write the brief it names → `arbor.py run`; `decide`; ask the user on `human`) only when no conductor can be launched. The driver owns state, counters, the gate and validation; the conductor owns in-task judgment; you own the plan.
- Executors: the default `codeg-cli` command executor lets the driver run and collect a role itself. With `executors.default: codeg` (`type: codeg-mcp`), `arbor.py run` returns `needs=delegation`: call codeg MCP `delegate_to_agent` with the returned `mcp.arguments`, then `arbor.py bind --request <request_path> --task-id <returned task_id>`, poll `get_delegation_status`, save its complete JSON at the returned `result_path` outside the task worktree, and `arbor.py collect --request <request_path> --result <file>` before proceeding; resume/poll a bound task after interruptions, never start it again. Claude Code and Codex both use this same MCP flow. Never perform a role yourself and never use native Agent/Task/spawn_agent for one.
- The driver starts every role prompt with this header; you never type it:
  ```
  Active task: <absolute path of .arbor/tasks/<task> inside the task worktree>
  Role: explore | architect | test | implement | review | verify | fix | simplify
  Mode: self-check | candidates | sweep | plan   (review only)
  Range: <base>..<head>
  Dispatch: d-NNN
  ```
  A conductor prompt starts with `Active task:` + `Conductor: <task>` + `Executor:` + `Run: c-NNN`.
- Writers commit on the task branch as `<role>(<task>): <summary>` with trailer `Arbor-Dispatch: d-NNN`; nobody pushes; the user merges the PR with `--no-ff`.
- If your own first prompt starts with `Active task:` + `Role:`, you are a dispatched sub-agent: do that role directly and ignore the rules above. If it starts with `Active task:` + `Conductor:`, you are a conductor: follow `.arbor/agents/conductor.md`.

Managed by Arbor. Edits outside this block are preserved; edits inside may be overwritten by `arbor update`.
<!-- ARBOR:END -->
