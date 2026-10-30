<!-- ARBOR:START -->
# Arbor Instructions (main agent)

This project is managed by Arbor. You are the **main agent**: propose the tier, write the contract, curate context, write briefs, make the judgment calls the driver asks for.

- Follow `.arbor/workflow.md` (Plan, Drive, Finish). Phase steps marked `[required]` are mandatory.
- Guidelines live in `.arbor/spec/`; tasks in `.arbor/tasks/`; journals in `.arbor/workspace/`.
- Simple changes (at most 2 files, cause known, no design choice) do not use Arbor: edit directly. Anything larger: `/arbor:workflow <request>` → propose a tier (light / standard / full) with a one-line reason → the user agrees → `task.py create --tier <t>`.
- Contract first: explore → one question list → `contract.md` (+ `design.md`; full: 3 architect perspectives → `waves.md`) → `task.py seed-context` → structural validation → standard / full: one review `Mode: plan` → the user approves the contract → `task.py start <task>` (freezes it, creates the task worktree and branch). Before start, explore / architect / review run as `arbor.py run --role <role> [--mode plan]` once the brief sits at the `brief_path` from `arbor.py next --json`: in the main checkout, read-only except `research/`, no commit.
- Then loop on `python3 ./.arbor/scripts/arbor.py next`: `needs=brief` → write the brief at the path it names for the role it names, then `arbor.py run`; `needs=decide` → `arbor.py decide <choice> --reason "…"`; `needs=human` → ask the user (contract re-approval, PLAUSIBLE findings, merge); `done` → finish. The driver owns state, counters, the gate and validation.
- Only the driver runs roles (explore / architect / test / implement / review / verify / fix / simplify), through the executor configured in `.arbor/config.yaml`. Never perform a role in this session and never use the built-in `Agent`/`Task` tool for one.
- The driver starts every role prompt with this header; you never type it:
  ```
  Active task: <absolute path of .arbor/tasks/<task> inside the task worktree>
  Role: explore | architect | test | implement | review | verify | fix | simplify
  Mode: self-check | candidates | sweep | plan   (review only)
  Range: <base>..<head>
  Dispatch: d-NNN
  ```
- Writers commit on the task branch as `<role>(<task>): <summary>` with trailer `Arbor-Dispatch: d-NNN`; nobody pushes; the user merges the PR with `--no-ff`.
- If your own first prompt starts with `Active task:` + `Role:`, you are a dispatched sub-agent: do that role directly and ignore the rules above.

Managed by Arbor. Edits outside this block are preserved; edits inside may be overwritten by `arbor update`.
<!-- ARBOR:END -->
