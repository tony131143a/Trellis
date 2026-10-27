# Dispatch Contract

> How the implement / check / research roles reach codeg assistants. Runtime
> mechanics for the dispatch hook, `dispatch.py`, and the workflow text that
> drives them. Workflow wording lives in `.arbor/workflow.md` (Dispatch
> subsection, Phase 2, Phase 2P); this spec is the contract behind it.

---

## Roles and targets

Three roles (`implement`, `check`, `research`), two targets (`star`, `pi`).
Each role-target pair is one codeg assistant, named `arbor-<role>-<target>` by
default (overridable under `dispatch:` in `.arbor/config.yaml`). The
assistant instructions come from `.arbor/agents/<role>.md` (plain markdown, no
frontmatter) via `dispatch.py codeg-setup`.

The built-in `Agent`/`Task` tool is forbidden for these roles; a guard hook
denies it.

## Header protocol

The dispatch `task` text starts with:

```
Active task: <absolute path of the task dir in the MAIN checkout>
Role: implement | check | check [finish] | research
Target: star | pi              (optional)
Workspace: <absolute worktree> (optional, parallel variant)
```

When the header is present, the PreToolUse hook (codeg path) or `dispatch.py`
(terminal path) prepends context built by one shared assembler, marked
`<!-- arbor-hook-injected -->`. Order: files listed in `implement.jsonl`
(`check.jsonl` for check) -> `prd.md` -> `design.md` if present ->
`implement.md` if present. Without the header nothing is injected, and the
assistant falls back to pulling the same files itself.

`Role: check [finish]` is the final full-scope check; it may edit
`.arbor/spec/`.

## Resolution order

Target (highest wins):

1. `Target:` header line, or `--target` on `dispatch.py run`
2. this session's `.arbor/.runtime/sessions/<context>.dispatch-target` (`dispatch.py target set|clear`; `/arbor:workflow <target>` calls `target set`; session identity as for the active task)
3. checkout-wide `.arbor/.runtime/dispatch-target` (`target set|clear --repo`; fallback without session identity)
4. `ARBOR_DISPATCH_TARGET`
5. `dispatch.default_target` in `.arbor/config.yaml`

The delegation hook swaps an `assistant_id` registered under another target
for the effective target's assistant (`reconcile_assistant`).

Assistant name: `dispatch.targets.<target>.<role>` in config, else
`arbor-<role>-<target>`. Assistant id (codeg path only): looked up in
`.arbor/.runtime/codeg-assistants.json` (written by `codeg-setup`) and
printed in the SessionStart `<dispatch>` section or by
`dispatch.py resolve --role <role>`.

## Two paths

- **codeg MCP tools present**: `delegate_to_agent(task, working_dir, assistant_id)`
  returns a task id; `get_delegation_status(task_ids, wait_ms)` collects.
- **Plain terminal**: `dispatch.py run --role <role> [--finish] [--target]
  [--task] [--workspace] [--wait|--detach] [--prompt|--prompt-file|stdin]`
  (also `arbor dispatch run ...`), which pipes the assembled prompt to
  `codeg-cli run -A <assistant> ... -p -`. `dispatch.py wait RUN...` collects
  detached runs. Full CLI surface, runtime files, and exit codes:
  [`commands-dispatch.md`](./commands-dispatch.md).

## Assistant registry

`dispatch.py codeg-setup` writes `.arbor/.runtime/codeg-assistants.json`:

```json
{"generated_at": "…Z", "by_name": {"arbor-implement-pi": 12},
 "by_id": {"12": {"role": "implement", "target": "pi"}}}
```

Readers: the delegation hook (`by_id[assistant_id].role` when the header has
no `Role:`), `dispatch.py resolve` (`by_name`), and the SessionStart
`<dispatch>` section, which prints each role of the effective target as
`- <role>: <name> (id <N>)`, or `(id unknown — run python3
./.arbor/scripts/dispatch.py codeg-setup)` when the registry lacks it. Only
names that `dispatch:` maps to a role are recorded.

## Sub-agent self-identification

A session whose first prompt starts with `Active task:` + `Role:` is a
dispatched sub-agent. It does the role's work, never dispatches, never
commits, never calls `task.py start/current/finish`, and has no
`ARBOR_CONTEXT_ID`. The `in_progress` and `in_progress-parallel` breadcrumbs,
`CLAUDE.md`, `AGENTS.md`, and `.arbor/agents/*.md` all state this.

## Parallel variant

Enabled by `task.py set-meta <parent> execution parallel` (stored as
`task.json` `meta.execution = "parallel"`); breadcrumb key
`in_progress-parallel`. Children are created with
`task.py create ... --parent <parent-dir>`.

1. One worktree and branch per child: `<repo>-wt/<parent>-<child>`, branch `wip/<parent>/<child>`.
2. Up to `dispatch.max_parallel` implement roles at once; `working_dir` = the worktree, `Workspace:` = the worktree, `Active task:` = the child dir in the main checkout.
3. Check per worktree; the main agent commits in the worktree.
4. The main agent merges serially in the main checkout with `git merge --no-ff`.
5. One final `Role: check [finish]` on the merged tree, `Active task:` = the parent.
6. Remove merged worktrees and branches; Phase 3 runs on the parent; `/arbor:finish-work` archives parent and children.

## Invariants

- Sub-agents never commit, push, or merge.
- Sub-agents never touch paths outside their working directory.
- Sub-agents never write under `.arbor/` (exceptions: `check [finish]` may edit `.arbor/spec/`; research writes `<task>/research/*.md`).
- `Active task:` always names the task directory in the main checkout, even when `working_dir` is a worktree.
- Runtime state (`.arbor/.runtime`, `.arbor/.developer`) is resolved from the main checkout only; `.arbor/tasks` inside a worktree is a read-only copy.
- Only the main agent commits (workflow Phase 3.4).

## Required tests

- Dispatch text always begins with the header and, for hook and `dispatch.py`, is byte-identical for the same inputs.
- The guard hook denies the built-in Agent/Task tool for arbor roles.
- Missing `in_progress-parallel` block falls back to `in_progress` (see `workflow-state-contract.md`).
