# Arbor

Arbor is a spec-driven AI engineering workflow for **Claude Code and Codex**. The Python driver assembles task context, dispatches roles through a configured executor, records reports, Git observations and task state. Your session's main agent plans, gets the contract approved and drives the loop itself; the roles run as Orca workers; executable quality checks remain enforced.

## Install and initialize

```bash
pnpm install
pnpm build
node packages/cli/bin/arbor.js init --codex --yes
# Or: init --claude --yes
```

Run init from the project that should receive Arbor. Adding `--codex` to an existing Arbor project installs the Codex layer. Existing model/provider/MCP settings in `.codex/config.toml` are not overwritten.

| Platform | Entry points | Project files |
|---|---|---|
| Claude Code | `/arbor:workflow`, `/arbor:continue`, `/arbor:finish-work` | `.claude/` |
| Codex | `$arbor-workflow`, `$arbor-continue`, `$arbor-finish-work` | `.agents/skills/`, `.codex/hooks.json`, `.codex/hooks/` |

Codex loads repo instructions from `AGENTS.md`. SessionStart and UserPromptSubmit hooks provide session context and the next workflow step. Project hooks require a trusted project and review of their definitions through `/hooks`. If automatic hooks are unavailable or not yet trusted, invoke `$arbor-start`. Current Codex enables hooks by default; older installations may require `[features] hooks = true` in their user configuration.

StarFactory is no longer an installable Arbor platform. Update can remove unchanged historical Arbor templates after backing them up; locally modified files remain available for review. Uninstall only processes tracked Arbor files and preserves unrelated user content.

## Roles and execution

Arbor ships eight role instructions under `.arbor/agents/`:

- `explore`: inspect code and gather evidence.
- `architect`: design a solution.
- `test`: write acceptance tests.
- `implement`: implement the requested behavior.
- `review`: inspect a commit range, verify each finding and reproduce the ones it confirms; never edits code.
- `fix`: repair confirmed issues.
- `simplify`: simplify the implementation.

The driver includes each role's instructions, task context, brief and report requirements in its dispatch prompt. Roles run through the executor in `.arbor/config.yaml`; native Codex sub-agent definitions are not required.

Two kinds of agent take part. The **main agent** is your session (Claude Code or Codex, normally one Orca agent session per task): it talks to you, writes the contract, splits multi-deliverable requests into child tasks, starts the task and drives BUILD → GATE → REVIEW → FINISH with `arbor.py next`, dispatching the **roles** through the executor. It asks you only at the human gates: tier, contract approval, surviving PLAUSIBLE findings, round caps (STOP) and the merge; which of those actually ask is the task's mandate (`mandate:` in `.arbor/config.yaml` per tier, `task.py create --mandate`): with `auto` the driver skips PLAUSIBLE findings, resumes the first STOP and `arbor.py finish` merges a small clean, in-scope, reviewed branch itself when you opt in to `merge=auto`; by default merging into your base branch is always your call. Child tasks run in parallel, each from its own session, skip their own review and merge into the parent's integration branch on their own; the parent then reviews and fixes them all at once there (`task.py integrate`), and only that branch reaches your base branch, through you. Inside a task, readers run in parallel (the 2 / 3 candidate readers of standard / full, which may only add their own repro scripts); writers run only the contract's targeted checks and GATE runs the full suite once.

The only executor is Orca (the multi-agent desktop app; its CLI is `orca`): the driver starts every role as an Orca worker inside the task's Orca workspace, and the main agent runs in an Orca agent tab of the repository's workspace:

```yaml
executors:
  default: orca
  orca:
    type: orca
    command: orca          # the Orca CLI; an absolute path when not on PATH (macOS: /Applications/Orca.app/Contents/Resources/bin/orca)
    agent: codex           # Orca agent id every role starts as (codex, claude, omp, ...)
    timeout: 90m
    max_parallel: 5
    keep_open: false       # true: a finished worker stays open in Orca
    roles:                 # per-role agent override
      explore:
        agent: omp
```

One-time setup: the repository (and every `git: true` package repository) is a project in Orca (`orca repo add --path <repo>`); the main agent runs inside Orca; in Orca Settings, Agents, set each agent's permission mode so workers do not stop on prompts (codex and claude have a Yolo preset; omp needs `--approval-mode yolo` as its launch arguments). A project that has Arbor's Codex hooks installed (`.codex/hooks.json`) makes Codex show "Hooks need review" on its first start; trust them once (start `codex` in the repository and choose "Trust all and continue"), otherwise a Codex worker fails to start with `agent_readiness: Agent startup blocked: agent-hooks-review-prompt`.

Orca creates and removes every worktree (`orca worktree create` / `orca worktree rm`) and chooses its path (by default `~/orca/workspaces/<repo>/<name>`); the workspace is named `<task>` for a task, `<task>-<partition>` for a partition and `<parent task>` for a parent's integration branch. Orca's own setup hooks follow the repository's policy in Orca; `worktree.setup` in `.arbor/config.yaml` still runs synchronously and a non-zero exit fails the start.

`arbor.py run` assembles the prompt (`.arbor/.runtime/prompts/<task>/d-NNN.md`), writes the worker's task spec beside it (the dispatch header plus `Prompt:` and `Report:` lines) and starts the worker itself with `orca orchestration worker-start`, in the task's Orca Run (`arbor <task>`, created by the task's first dispatch). The worker reads the prompt, writes its complete report to the `Report:` file (`.arbor/.runtime/replies/<task>/d-NNN.md`) and sends Orca's `worker_done` once; the driver takes the verdict from the report file, not from `--outcome`. The main agent ends its turn after starting every ready item; Orca wakes it when a worker reports, asks a question or stops, and it runs `arbor.py sync` (validates the report of every settled worker, collects a settled worker without a report as a failed dispatch, shows `waiting for a person` for a permission prompt you answer in the worker's Orca tab) and then `arbor.py next`. A worker's question arrives as Orca mail (`orca orchestration reply --id <message_id> --body "..."`). A failed start (agent CLI missing, a trust prompt, Orca unreachable) is not a failed dispatch: `arbor.py run` exits 1 and prints why, the request stays prepared, and `arbor.py run --dispatch d-NNN` retries it once the cause is fixed (it is safe to repeat; the third failed start in a row fails the dispatch). Do not substitute native Agent/Task/spawn_agent for a role.

## Workflow and maintenance

Project workflow, specs, tasks and journals live under `.arbor/`. See `.arbor/workflow.md` for the v2 contract, worktree and verification flow. Small changes can be edited and checked directly; explicit user instructions take precedence over the default workflow.

```bash
python3 .arbor/scripts/arbor.py next --json
python3 .arbor/scripts/arbor.py status
arbor platforms --json
arbor update --dry-run
arbor update
arbor uninstall --dry-run
```

## Development

```bash
pnpm lint
pnpm typecheck
pnpm build
pnpm test
pnpm --filter @tony131143a/arbor lint:py
```

`packages/cli/src/templates/` is the source for installed project files. Every Python file under `.arbor/scripts/` must remain byte-identical to its counterpart under `packages/cli/src/templates/arbor/scripts/`.

## License

AGPL-3.0-or-later, inherited from Trellis (Copyright (C) 2026 Mindfold LLC). See `LICENSE`, `COPYRIGHT` and `NOTICE`.
