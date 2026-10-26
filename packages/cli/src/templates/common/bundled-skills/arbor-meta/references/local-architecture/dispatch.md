# Dispatch To codeg Assistants

In Arbor the seven roles (`explore`, `architect`, `implement`, `review`, `verify`, `fix`, `simplify`) are not platform sub-agents. The main agent (Claude Code, inside the codeg desktop app or a terminal) dispatches each role to a codeg assistant that runs on `star` (a Claude Code fork) or `pi` (pi + DeepSeek). Role instruction text lives in `.arbor/agents/<role>.md` (plain markdown, no frontmatter). Roles never commit, and none writes under `.arbor/spec/`; `explore` and `architect` may write only `<task>/research/*.md`. Spec updates happen in Phase 3.3 by the main agent.

## Role x Target Matrix

| Role | Purpose | `star` assistant | `pi` assistant |
| --- | --- | --- | --- |
| explore | Trace code or fetch external docs; writes `research/<topic>.md` | `arbor-explore-star` | `arbor-explore-pi` |
| architect | One design blueprint per perspective; writes `research/design-<perspective>.md` | `arbor-architect-star` | `arbor-architect-pi` |
| implement | Write code (no commits) | `arbor-implement-star` | `arbor-implement-pi` |
| review | Find bugs in a diff (`Mode: self-check`, `candidates`, or `sweep`) | `arbor-review-star` | `arbor-review-pi` |
| verify | Confirm or refute candidate findings | `arbor-verify-star` | `arbor-verify-pi` |
| fix | Apply chosen findings | `arbor-fix-star` | `arbor-fix-pi` |
| simplify | Behavior-preserving cleanup of a diff | `arbor-simplify-star` | `arbor-simplify-pi` |

Names are defaults (`arbor-<role>-<target>`, 14 assistants) and can be overridden in the `dispatch:` section of `.arbor/config.yaml`. The earlier `check` and `research` roles are retired; `codeg-setup --install` soft-deletes their old assistants. Running finder and `verify` roles on different targets makes verification independent.

Target resolution, highest priority first:

1. `Target:` header line, or `--target` on `dispatch.py run`
2. `.arbor/.runtime/dispatch-target` (written by `dispatch.py target set` via `/arbor:workflow-star` or `/arbor:workflow-pi`; `dispatch.py target clear` removes it)
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
Role: explore | architect | implement | review | verify | fix | simplify
Mode: self-check | candidates | sweep   (optional; review only; default self-check)
Diff: <absolute path of a .diff file>   (optional; review / verify / fix / simplify)
Target: star | pi            (optional)
Workspace: <worktree path>   (optional; parallel variant)
```

followed by the brief. `explore` is the only role that may run without `Active task:`. Briefs are self-contained: goal, essential files, decisions made, check commands; review briefs add an `Angles:` line, verify and fix briefs carry the findings JSON.

## PreToolUse Hook And Assembler

Two shared PreToolUse hooks are installed under `.claude/hooks/` or `.starFactory/hooks/`. `inject-delegation-context.py` (matcher `^mcp__codeg[-_]mcp__delegate_to_agent$`, timeout 30) resolves the role from the `Role:` header, else from `.arbor/.runtime/codeg-assistants.json` `by_id[assistant_id].role`, else does nothing. It skips tasks already carrying the marker. Otherwise it rewrites `task` to include, in order: the files listed in `implement.jsonl` (for `architect` and `implement`) or `check.jsonl` (for `review`, `verify`, `fix`, `simplify`), then `prd.md`, `design.md`, `implement.md`, and the `Diff:` file when given (`explore` gets the spec overview plus `prd.md` and the research file list instead of a manifest), marked with `<!-- arbor-hook-injected -->`. Size caps come from `context_injection:` in `.arbor/config.yaml`. A shared assembler builds this text for both the hook and `dispatch.py`, so the two paths produce identical context.

## Guard Hook And Sub-Agent Exemption

`guard-builtin-agent.py` (matcher `^(Agent|Task)$`, timeout 10) denies the built-in Agent/Task tool for Arbor roles, so roles cannot silently run as native sub-agents. A session whose first prompt starts with `Active task:` plus `Role:` is treated as a dispatched sub-agent: it does its role, never dispatches, never commits, never calls `task.py start/current/finish`, and has no `ARBOR_CONTEXT_ID`.

## Terminal Fallback: dispatch.py

When codeg MCP tools are unavailable:

```bash
python3 ./.arbor/scripts/dispatch.py run --role <role> [--mode M] [--diff F] [--target star|pi] [--task <dir>] [--workspace <wt>]
    [--prompt TEXT | --prompt-file F | stdin] [--detach] [--wait] [--worktree[=NAME]]
    [--standalone] [--data-dir DIR] [--url URL] [--dry-run] [--print-prompt]
```

It writes the prompt to `.arbor/.runtime/dispatch/<stamp>.md` and pipes it to `codeg-cli run -A <assistant> -w <workspace or repo root> --permissions <dispatch.permissions> --timeout <dispatch.timeout> --title "arbor <role> <task>" -o <stamp>.result.md -p -`. With `--detach` the run id goes to stdout and `<stamp>.run`; `--detach --wait` then waits for it. `--standalone` starts a throwaway `codeg-server` whose data directory has no assistants, so pair it with `--data-dir <codeg data dir>` (only while the desktop app is closed). The `codeg-cli` binary is `dispatch.codeg_cli`, else `$CODEG_CLI`, else `codeg-cli` on PATH, else the macOS app bundle. A brief that itself starts with header lines supplies the values the flags leave unset. Exit codes are codeg-cli's (3 timeout, 4 codeg unreachable, 6 still running).

| Subcommand | Purpose |
| --- | --- |
| `wait RUN... [-o OUT] [--timeout DUR] [--url URL]` | Wait for detached runs (`codeg-cli result RUN --wait`); exit 6 keeps waiting until the timeout, results go to the run's `<stamp>.result.md`. |
| `resolve --role <role> [--target T] [--json]` | Print effective target, assistant name, and `assistant_id` (from `codeg-assistants.json`). |
| `target get\|set <T>\|clear` | Manage `.arbor/.runtime/dispatch-target`. |
| `snapshot [-C DIR]` | Print a tree id of the working tree (untracked files included, index untouched). |
| `diff A [B] --name N [-C DIR]` | Write the diff between two snapshots, commits, or branches (B defaults to the working tree now) to `.arbor/.runtime/dispatch/diffs/N.diff`, print its path, and report the changed-line count on stderr. Excludes `.arbor/`. |
| `codeg-setup [--target T] [--install] [--db PATH] [--codeg-cli PATH]` | Prepare the codeg assistants (below). |
| `print-context --role <role> [--task DIR] [--mode M] [--diff F] [--target T] [--workspace WT]` | Print exactly the task text the hook would build for the same header and brief. |

## codeg-setup

`dispatch.py codeg-setup` renders each target x role instruction file (7 roles x 2 targets = 14 assistants) (`.arbor/agents/<role>.md` plus a one-line target note) to `.arbor/.runtime/codeg-assistants/<target>-<role>.md` and prints the codeg UI steps (name, description, agent type, options, instructions file). `--install` (macOS, or any platform with `--db`) upserts rows into the codeg database: it refuses and falls back to the printed steps (exit 2) unless the `assistant` table has exactly the 15 expected columns, backs the database up to `.arbor/.runtime/codeg-db-backups/`, and matches rows by a stable uid so re-running updates them in place. Both modes then run `codeg-cli assistants --json` and write `{"by_name": {name: id}, "by_id": {id: {"role", "target"}}}` to `.arbor/.runtime/codeg-assistants.json`; when codeg is unreachable that step is skipped (after `--install` the ids come from the database instead). Re-run it after editing any `.arbor/agents/*.md`. `--install` also soft-deletes the retired `arbor-check-*` / `arbor-research-*` assistants.

## Config: `dispatch:` In `.arbor/config.yaml`

Holds `default_target`, assistant names per target and role (default `arbor-<role>-<target>`), `max_parallel`, permissions, and timeout. Read the file in the project for the exact keys.

## Snapshots, Diffs, And The Review Loop

Sub-agents never commit, so the main agent slices the uncommitted working tree with snapshots: `S0=$(dispatch.py snapshot)` before implementation, `dispatch.py diff $S0 --name r1` to scope a review, a new snapshot before each `fix`, and `dispatch.py diff $F0 --name r2` to re-review only the fix delta. Tier follows the artifacts: no `design.md` is lightweight (one `review` `Mode: self-check`), `design.md` present is complex (three `review` `Mode: candidates` for 300+ changed lines, then `verify`, `fix`, re-review). The loop runs at most 2 rounds. Complex tasks then run Phase 2F (`simplify`, five `review` candidates, `verify`, one `review` `Mode: sweep`, `verify`, `fix`); every task ends with the main agent running the Quality Check commands itself (2F.5).

## Parallel Variant

A parent task is marked with `task.py set-meta <dir> execution parallel`; child tasks are created with `task.py create --parent`. Each child gets one git worktree and is dispatched with a `Workspace:` header; the review loop runs in every worktree with diffs taken via `dispatch.py diff <task-branch> -C <worktree>`. The main agent merges serially with `git merge --no-ff`; the breadcrumb key is `in_progress-parallel`. Invariants: sub-agents never commit or merge, never touch paths outside their worktree, never write under `.arbor/`.

## Debugging

- `python3 ./.arbor/scripts/dispatch.py print-context --role <role> --task <dir>`: see exactly what a role would receive.
- `dispatch.py run ... --dry-run`: show the resolved assistant and command without running.
- `dispatch.py run ... --print-prompt`: show the final prompt text.
- No context in the dispatched run: check that the `task` begins with `Active task:` and `Role:`, that the hook is registered in `settings.json`, and that the JSONL manifest is non-empty.
- Wrong assistant: run `dispatch.py resolve --role <role>` and walk the target resolution order above.
- Stale assistant text: re-run `dispatch.py codeg-setup`.
