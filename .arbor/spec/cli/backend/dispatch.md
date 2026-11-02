---
sources:
  - packages/cli/src/templates/arbor/scripts/arbor.py
  - packages/cli/src/templates/arbor/scripts/common/dispatch_context.py
  - packages/cli/src/templates/arbor/scripts/common/driver/executor.py
  - packages/cli/src/templates/arbor/scripts/common/driver/mcp.py
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

Roles are `explore`, `architect`, `test`, `implement`, `review`, `verify`, `fix`
and `simplify`. Their instructions live in `.arbor/agents/<role>.md`.
`arbor.py run` selects an executor from `executors:` in `.arbor/config.yaml`.
The main agent (the user's session, normally one codeg conversation per task)
writes the briefs and runs the loop; roles are its depth-1 codeg delegations.

Native Agent/Task/spawn_agent tools cannot dispatch Arbor roles.
`guard-builtin-agent.py` denies recognisable headers or an `arbor-` agent type
inside an Arbor project.

## Header protocol

The driver, rather than the brief author, writes the role header:

```text
Active task: <absolute task directory in the execution checkout>
Role: explore | architect | test | implement | review | verify | fix | simplify
Mode: self-check | candidates | sweep | plan
Range: <base>..<head>
Dispatch: d-NNN
Prompt: <absolute path of .arbor/.runtime/prompts/<task>/d-NNN.md>
```

`Mode:` applies only to review. `Range:` accompanies roles that read or write
a diff; explore and architect do not accept it. Before start the task is in the
main checkout; after start it is inside its task worktree. The assembler
normalizes the task path, resolves review mode and preserves the dispatch id.

`Prompt:` is written only by the `codeg-mcp` executor: the MCP `task` text is
the header lines alone, and the `Prompt:` line names the assembled prompt file
(header, injected context and brief) that the role reads first. Command
executors receive the assembled file directly and carry no `Prompt:` line.

Role context carries `<!-- arbor-hook-injected -->`. The normal artifact order
is jsonl entries → `contract.md` → `design.md` if present → `waves.md` if present,
then `git diff <Range>` when supplied, followed by the brief. Architect, test and
implement use `implement.jsonl`; review, verify, fix and simplify use
`check.jsonl`. Architect also receives task research. Explore receives the spec
overview and, when a task is supplied, its contract and research file list.
Without the marker the role pulls its required context itself (with codeg MCP:
by reading the `Prompt:` file first).

## Resolution order

The global `--executor NAME` selects `executors.<name>`; otherwise the driver uses
`executors.default`. `--task DIR` selects the task, otherwise the session's active
task is resolved. These options precede the subcommand. A child task driven from
its own conversation passes `--task` on every call.

Executor types are `command` and `codeg-mcp`. For a command executor, `command`
is required; `timeout` accepts seconds or an `s`, `m` or `h` suffix. Missing or
zero timeout means no timeout. Role command placeholders are `{role}`, `{prompt}`
(the assembled prompt file), `{worktree}`, `{task}` and `{dispatch}`. Values are
shell-quoted; the process runs in the assigned worktree, stdout is the report
and stderr is retained. A non-zero exit or timeout fails the dispatch.

## Two paths

- **codeg MCP (default)**: `type: codeg-mcp` (`executors.default: codeg`)
  returns `needs=delegation` with durable request metadata and `mcp.arguments`
  (`task` = header plus `Prompt:` pointer). Call `delegate_to_agent` once,
  then `arbor.py bind --request <request_path> --task-id <returned id>`. Poll
  `get_delegation_status`, save its complete terminal JSON at the returned
  `result_path` outside the task worktree and run
  `arbor.py collect --request <request_path> --result <file>`. The shared
  PostToolUse hook `sync-delegation.py` (Claude Code and Codex) performs the
  bind and the collect itself after those two MCP calls and reports the
  outcome as `additionalContext`; the manual commands stay valid. Resume bound
  ids after interruption. If timeout expires, cancel through `cancel_delegation`
  and collect the terminal report; never replace this flow with a native agent.
- **Command executor**: `arbor.py --executor codeg-cli run` invokes the
  configured command, waits, validates the report and records the result. The
  shipped command executor is named `codeg-cli`; it suits terminal sessions
  without codeg MCP.

## Executor configuration

```yaml
executors:
  default: codeg
  codeg:
    type: codeg-mcp
    assistant: arbor-{role}
    timeout: 90m
```

For MCP, `assistant_ids` may map role names to configured assistant ids. Without
a mapped id, a configured `agent_type` is passed directly; otherwise resolve the
returned assistant name from the MCP roster. Request and snapshot
records live in `.arbor/.runtime/delegations/<task>/<dispatch>.json`. A collected
request cannot be collected twice.

## Sub-agent self-identification

A first prompt starting with `Active task:` plus `Role:` identifies a dispatched
role. It performs that role directly, never delegates, never runs task lifecycle
commands and has no `ARBOR_CONTEXT_ID`. Started-task writers commit with
`Arbor-Dispatch: d-NNN` and stay inside their assigned paths; reader roles remain
read-only. CONTRACT research roles may write only task research and do not commit.

Any other first prompt belongs to a main agent: it writes briefs and calls the
driver; it never performs a role itself.

## Parallel variant

Independent deliverables use child tasks created with `task.py create --parent`.
Each ready child has its own worktree and branch and is driven from its own
session (`--task <child>` on every call). The parent's session watches
`arbor.py --task <parent> children`, merges children in dependency order, then
prepares the parent's review brief and invokes
`run --role review --mode sweep --range <before-first-merge>..<base>`.
The parent's `gate` runs cross-child `auto` checks before archive.

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
- Executor/MCP tests cover preparation, binding, restart, terminal collection and
  refusal of duplicate collection.
- MCP request tests cover the `Prompt:` pointer in `mcp.arguments.task`.
- The native agent guard denies `Active task:` / `Role:` dispatch prompts.
- Backend doc regression checks pin these protocols and concrete source paths.
