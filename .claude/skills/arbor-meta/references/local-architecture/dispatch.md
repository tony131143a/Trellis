# Dispatch To codeg Assistants

In Arbor the `implement`, `check`, and `research` roles are not platform sub-agents. The main agent (Claude Code, inside the codeg desktop app or a terminal) dispatches each role to a codeg assistant that runs on `star` (a Claude Code fork) or `pi` (pi + DeepSeek). Role instruction text lives in `.arbor/agents/{implement,check,research}.md` (plain markdown, no frontmatter).

## Role x Target Matrix

| Role | `star` assistant | `pi` assistant |
| --- | --- | --- |
| implement | `arbor-implement-star` | `arbor-implement-pi` |
| check | `arbor-check-star` | `arbor-check-pi` |
| research | `arbor-research-star` | `arbor-research-pi` |

Names are defaults (`arbor-<role>-<target>`) and can be overridden in the `dispatch:` section of `.arbor/config.yaml`.

Target resolution, highest priority first:

1. `Target:` header line, or `--target` on `dispatch.py run`
2. `.arbor/.runtime/dispatch-target` (written by `/arbor:dispatch-target star|pi|clear`)
3. env `ARBOR_DISPATCH_TARGET`
4. `dispatch.default_target` in `.arbor/config.yaml`

## Inside codeg (MCP tools)

1. Look up the integer `assistant_id` in the `<dispatch>` section printed by the SessionStart hook, or run `python3 ./.arbor/scripts/dispatch.py resolve --role <role>`.
2. Call `delegate_to_agent(task, working_dir, assistant_id)`; it is async and returns a `task_id`.
3. Poll with `get_delegation_status(task_ids, wait_ms)`.

## Header Protocol

The `task` text must start with these lines so the hook can inline context:

```text
Active task: <absolute task dir in the main checkout>
Role: implement | check | check [finish] | research
Target: star | pi            (optional)
Workspace: <worktree path>   (optional; parallel variant)
```

followed by the brief.

## PreToolUse Hook And Assembler

Two shared PreToolUse hooks are installed under `.claude/hooks/` or `.starFactory/hooks/`. `inject-delegation-context.py` (matcher `^mcp__codeg[-_]mcp__delegate_to_agent$`, timeout 30) resolves the role from the `Role:` header, else from `.arbor/.runtime/codeg-assistants.json` `by_id[assistant_id].role`, else does nothing. It skips tasks already carrying the marker. Otherwise it rewrites `task` to include, in order: the files listed in `implement.jsonl` (or `check.jsonl` for check roles), then `prd.md`, `design.md`, `implement.md`, marked with `<!-- arbor-hook-injected -->`. Size caps come from `context_injection:` in `.arbor/config.yaml`. A shared assembler builds this text for both the hook and `dispatch.py`, so the two paths produce identical context.

## Guard Hook And Sub-Agent Exemption

`guard-builtin-agent.py` (matcher `^(Agent|Task)$`, timeout 10) denies the built-in Agent/Task tool for Arbor roles, so roles cannot silently run as native sub-agents. A session whose first prompt starts with `Active task:` plus `Role:` is treated as a dispatched sub-agent: it does its role, never dispatches, never commits, never calls `task.py start/current/finish`, and has no `ARBOR_CONTEXT_ID`.

## Terminal Fallback: dispatch.py

When codeg MCP tools are unavailable:

```bash
python3 ./.arbor/scripts/dispatch.py run --role <role> [--target star|pi] [--task <dir>] [--workspace <wt>] [--wait] [--detach] [--prompt TEXT | --prompt-file F | stdin]
```

It shells out to `codeg-cli run -A <assistant> -w <dir> ...`. Other subcommands:

| Subcommand | Purpose |
| --- | --- |
| `wait` | Wait for a detached run. |
| `resolve --role <role>` | Print effective target, assistant name, and `assistant_id`. |
| `target get\|set\|clear` | Manage `.arbor/.runtime/dispatch-target`. |
| `codeg-setup [--install]` | Prepare the codeg assistants (below). |
| `print-context` | Print the assembled context without dispatching. |

## codeg-setup

`dispatch.py codeg-setup` renders each target x role instruction file to `.arbor/.runtime/codeg-assistants/<target>-<role>.md` and prints the codeg UI steps. `--install` (macOS only) upserts rows into the codeg database with column validation and a backup. Both modes then try `codeg-cli assistants` and write the name-to-id map to `.arbor/.runtime/codeg-assistants.json`. Re-run it after editing any `.arbor/agents/*.md`.

## Config: `dispatch:` In `.arbor/config.yaml`

Holds `default_target`, assistant names per target and role (default `arbor-<role>-<target>`), `max_parallel`, permissions, and timeout. Read the file in the project for the exact keys.

## Parallel Variant

A parent task is marked with `task.py set-meta <dir> execution parallel`; child tasks are created with `task.py create --parent`. Each child gets one git worktree and is dispatched with a `Workspace:` header. The main agent merges serially with `git merge --no-ff`; the breadcrumb key is `in_progress-parallel`. Invariants: sub-agents never commit or merge, never touch paths outside their worktree, never write under `.arbor/`.

## Debugging

- `python3 ./.arbor/scripts/dispatch.py print-context --role <role> --task <dir>`: see exactly what a role would receive.
- `dispatch.py run ... --dry-run`: show the resolved assistant and command without running.
- `dispatch.py run ... --print-prompt`: show the final prompt text.
- No context in the dispatched run: check that the `task` begins with `Active task:` and `Role:`, that the hook is registered in `settings.json`, and that the JSONL manifest is non-empty.
- Wrong assistant: run `dispatch.py resolve --role <role>` and walk the target resolution order above.
- Stale assistant text: re-run `dispatch.py codeg-setup`.
