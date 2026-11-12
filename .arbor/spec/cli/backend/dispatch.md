---
sources:
  - packages/cli/src/templates/arbor/scripts/arbor.py
  - packages/cli/src/templates/arbor/scripts/common/dispatch_context.py
  - packages/cli/src/templates/arbor/scripts/common/driver/executor.py
  - packages/cli/src/templates/arbor/scripts/common/driver/orca.py
  - packages/cli/src/templates/shared-hooks/guard-builtin-agent.py
last_verified: 2026-11-02
---
# Driver Prompt Contract

The driver assembles role prompts; the main agent drives a started task through
that driver. Workflow wording lives in `.arbor/workflow.md` (Driver, Phase 2 and
Parent / Child Task Trees). The command surface is in
[commands-dispatch.md](./commands-dispatch.md).

---

## Roles and executors

Roles are `explore`, `architect`, `implement`, `review`, `fix` and
`simplify` (`implement` writes code and tests together). Their instructions live
in `.arbor/agents/<role>.md` of the driver's own install (the main checkout),
read at every dispatch (`DRIVER_ARBOR_DIR` in `common/dispatch_context.py`). `arbor.py run` uses the executor named by
`executors.default` in `.arbor/config.yaml`.
The main agent (the user's session, normally one Orca agent session per task)
writes the briefs and runs the loop; roles are Orca workers the driver starts.

Native Agent/Task/spawn_agent tools cannot dispatch Arbor roles.
`guard-builtin-agent.py` denies recognisable headers or an `arbor-` agent type
inside an Arbor project.

## Header protocol

The driver, rather than the brief author, writes the role header:

```text
Active task: <absolute task directory in the execution checkout>
Role: explore | architect | implement | review | fix | simplify
Mode: self-check | candidates | sweep | plan
Range: <base>..<head>
Dispatch: d-NNN
Prompt: <absolute path of .arbor/.runtime/prompts/<task>/d-NNN.md>
```

`Mode:` applies only to review. `Range:` accompanies roles that read or write
a diff; explore and architect do not accept it. Before start the task is in the
main checkout; after start it is inside its task worktree. The assembler
normalizes the task path, resolves review mode and preserves the dispatch id.

`Prompt:` and `Report:` are written by the `orca` executor into the worker's
task spec (`d-NNN.spec.md`, after Orca's dispatch preamble, under
`=== TASK ===`): the `Prompt:` line names the assembled prompt file (header,
injected context and brief) that the role reads first, the `Report:` line the
reply file (`.arbor/.runtime/replies/<task>/d-NNN.md`) it writes its complete
final report to.

Role context carries `<!-- arbor-hook-injected -->`. The normal artifact order
is jsonl entries → `contract.md` → `design.md` if present → `waves.md` if present,
then `git diff <Range>` when supplied, followed by the brief. Architect and
implement use `implement.jsonl`; review, fix and simplify use
`check.jsonl`. Architect also receives task research. Explore receives the spec
overview and, when a task is supplied, its contract and research file list.
Without the marker the role pulls its required context itself (as an Orca worker:
by reading the `Prompt:` file first).

## Resolution order

`--task DIR` selects the task, otherwise the session's active task is resolved.
The option precedes the subcommand. A child task driven from its own
Orca agent session passes `--task` on every call.

The only executor type is `orca`; `timeout` accepts seconds or an `s`, `m`
or `h` suffix (missing or zero means no timeout) and bounds one worker.

## The Orca worker path

- **Orca**: `type: orca` (`executors.default: orca`). `arbor.py run` writes the
  prompt and the worker's task spec and starts the worker itself:
  `orca orchestration worker-start --spec-file <spec> --task-title "<task> d-NNN <role>"
  --worktree path:<worktree> --agent <agent> [--model m] [--effort e] [--keep-open] --json`.
  It prints `needs: "worker"` with `orca_dispatch`, `request_path`, `prompt_path`,
  `reply_path`, `timeout_s` and `started`. The worker writes its report to the
  `Report:` file and sends `worker_done` (`--outcome succeeded` = report written).
  The main agent ends its turn; Orca wakes it; it runs `arbor.py sync
  [--dispatch d-NNN] [--wait DURATION]`, which reads `orca orchestration
  worker-show --dispatch <id> --json` and validates settled replies, collects
  failed or `worker_done`-less workers, stops (`worker-stop`) and collects workers
  past `timeout`, prints `waiting for a person (...)` for a permission prompt, and
  collects an empty reply file for judgment. A failed start is recorded at once;
  with the Orca CLI missing or Orca unreachable the request stays prepared
  (`next`: `needs: worker`, "not started") and `arbor.py run --dispatch d-NNN`
  starts it; never start a dispatch twice. Worker questions arrive as Orca mail
  (`orca orchestration reply`). Never replace this flow with a native agent.
- **Workspaces.** One task = one Orca workspace; every role is a worker in it;
  CONTRACT-phase roles run in the main checkout's workspace; partitions and child
  tasks are child workspaces (`orca worktree set --parent-worktree`, display only).

## Executor configuration

```yaml
executors:
  default: orca
  orca:
    type: orca
    command: orca
    agent: codex
    timeout: 90m
    max_parallel: 5
    keep_open: false
    roles:
      explore: {agent: omp, model: "@worker"}
```

`command` is the Orca CLI (an absolute path when not on PATH); `agent` is the
Orca agent id every role starts as, with per-role overrides of `agent`, `model`
and `effort` under `roles`. Request records live in
`.arbor/.runtime/workers/<task>/<dispatch>.json` (`task.json` key `workers`). A
collected request cannot be collected twice.

## Sub-agent self-identification

A prompt carrying `Active task:` plus `Role:` (after Orca's dispatch preamble)
identifies a dispatched worker. It performs that role directly, writes its
complete report to the `Report:` file, sends `worker_done`, never delegates, never runs task lifecycle
commands and has no `ARBOR_CONTEXT_ID`. Started-task writers commit with
`Arbor-Dispatch: d-NNN` and stay inside their assigned paths; `review` may
write only its repro scripts under the task's `research/repro/` (candidates /
sweep mode; the driver commits them with the report). CONTRACT research
roles may write only task research and do not commit.

Any other prompt belongs to a main agent: it writes briefs and calls the
driver; it never performs a role itself.

## Parallel variant

Independent deliverables use child tasks created with `task.py create --parent`.
Each ready child has its own worktree and branch and is driven from its own
session (`--task <child>` on every call). A child skips REVIEW
(`review_deferred`): BUILD -> GATE -> automatic merge into the integration
branch. The parent's session watches `arbor.py --task <parent> children`; once
every child is merged, `task.py integrate <parent>` turns the parent into a
started task on the integration worktree in REVIEW/candidates, and the ordinary
`next` loop reviews and fixes all children at once; the parent's `gate` runs
the cross-child `auto` checks in the integration worktree.

Within a task, named wave partitions receive separate branches and worktrees;
`next` identifies pending partitions and `run --partition <name>` executes each.
There is one writer per branch. Completed partitions merge back in wave order;
conflicts require a hand merge and `resume`.

## Invariants

- The driver owns prompt assembly, state, executable checks and observations.
- Roles stay inside their execution worktree and assigned write boundary.
- Writers commit; roles never push, merge, rebase or switch branches.
- The main agent drives the loop, writes briefs and asks the user only at the
  human gates; roles never dispatch.
- Header identity prevents recursive dispatch even if a host exposes main-session
  breadcrumbs to a role.
- Child process environments strip parent session identity variables.

## Required tests

- Driver prompts preserve normalized headers, manifest/artifact order and diffs.
- Executor/Orca tests cover preparation, worker start, restart, `sync` collection
  and refusal of duplicate collection.
- Worker spec tests cover the `Prompt:` and `Report:` pointers.
- The native agent guard denies `Active task:` / `Role:` dispatch prompts.
- Backend doc regression checks pin these protocols and concrete source paths.
