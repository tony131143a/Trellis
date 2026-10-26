# Arbor

Spec-driven AI engineering workflow where the implement, check and research roles run as [codeg](https://github.com/spacering-net/codeg) assistants on other models.

Arbor keeps specs, tasks and journals in your repo (`.arbor/`). The main agent (Claude Code or StarFactory) plans, curates context, dispatches work to codeg assistants backed by `star` (a Claude Code fork) or `pi` + DeepSeek, verifies the result, and commits.

> **Provenance.** Arbor is a derivative work of [Trellis](https://github.com/mindfold-ai/Trellis) by Mindfold LLC, forked at commit `8c792c38` under AGPL-3.0-or-later. It is a personal fork, not affiliated with or endorsed by upstream. See `NOTICE`, `COPYRIGHT` and `.arbor/spec/tech/repo/provenance.md`.

## Why

- Trellis gives the workflow: Plan, Execute, Finish, with specs auto-injected, task PRDs, and journals that survive across sessions.
- codeg gives multi-model dispatch: the model that plans is not the model that writes or reviews the code.
- Arbor joins the two. The built-in `Agent`/`Task` tool is blocked for the arbor roles, and every dispatch carries a header that makes a hook inline the right task context.

## Architecture

```
 main agent (Claude Code / StarFactory)
 in codeg or in a terminal
        |
        |  hooks (.claude/hooks, Python)
        |    SessionStart       -> workflow context + <dispatch> section
        |    UserPromptSubmit   -> workflow-state breadcrumb
        |    PreToolUse         -> inject-delegation-context.py (inline task context)
        |                          guard-builtin-agent.py (deny Agent/Task)
        v
 dispatch  "Active task: ... / Role: ... / Target: ..."
        |
        +-- codeg MCP present --> delegate_to_agent / get_delegation_status
        +-- plain terminal -----> dispatch.py run  -> codeg-cli run
        v
 codeg assistants   arbor-<role>-<target>   (role: implement | check | research)
        |                       |
        v                       v
   target: star            target: pi
   (Claude Code fork)      (pi + DeepSeek)
```

## Install

Not published to npm. Requires Node.js >= 18, pnpm, Python >= 3.9, and codeg for dispatch.

```bash
pnpm install && pnpm build && (cd packages/cli && npm link)
```

Commands:

| Command | Purpose |
| --- | --- |
| `arbor init [--claude] [--star] [-y] [-u <name>]` | Set up `.arbor/` and the platform files in the current repo |
| `arbor update` | Update managed files to the installed version |
| `arbor uninstall` | Remove Arbor from the repo |
| `arbor platforms` | List supported platforms |

## Quick start

```bash
cd your-repo
arbor init --claude -u your-name          # or --star, or both
python3 ./.arbor/scripts/dispatch.py codeg-setup            # print manual codeg steps
python3 ./.arbor/scripts/dispatch.py codeg-setup --install  # macOS: write assistants into codeg's database
```

Run the workflow on one target with `/arbor:workflow-star` or `/arbor:workflow-pi` (sets the target for the checkout and continues the task).

First task, following `.arbor/workflow.md`:

1. **Plan.** Describe the change. The main agent brainstorms, writes `prd.md`, optionally dispatches `research`, fills `implement.jsonl` and `check.jsonl` with the spec files the assistants need, then runs `task.py start`.
2. **Execute.** The main agent dispatches `implement`, then `check`, each time with the header below. A hook inlines the jsonl files, `prd.md`, `design.md` and `implement.md`. Failures are re-dispatched with a tighter brief.
3. **Finish.** The main agent commits, then `/arbor:finish-work` archives the task and writes the journal. Assistants never commit.

Header protocol, first lines of every dispatch `task`:

```
Active task: <absolute path of the task dir in the main checkout>
Role: implement | check | check [finish] | research
Target: star | pi              (optional)
Workspace: <absolute worktree> (optional, parallel variant)
```

## Two dispatch paths

- **Inside codeg** (MCP tools present): `delegate_to_agent(task, working_dir, assistant_id)`, then `get_delegation_status` to collect.
- **Plain terminal**: `dispatch.py run` wraps `codeg-cli run`. For flags and resolution order see the Dispatch section of `.arbor/workflow.md`.

## Parallel variant

For work that splits into disjoint child tasks, mark the parent with `task.py set-meta <parent> execution parallel` and create children with `--parent`. Each child gets a git worktree and branch, up to `dispatch.max_parallel` implement roles run at once, each child is checked in its worktree, the main agent merges serially with `--no-ff`, and one final `check [finish]` runs on the merged tree. Details: Phase 2P in `.arbor/workflow.md`.

## Removed relative to Trellis

- 21 of 23 main-agent platforms; only Claude Code and StarFactory remain.
- Platform-native sub-agent definitions, replaced by codeg dispatch.
- The `channel`, `mem`, `ablate`/`restore`, `upgrade` and `workflow` commands.
- The `packages/core` library, the docs site, the marketplace and the remote spec-template registry.

Full list and the rename table: `.arbor/spec/tech/repo/provenance.md`.

## Repository layout

```
packages/cli/            TypeScript CLI (src/, test/), templates shipped to user projects
packages/cli/src/templates/   source of truth for files that `arbor init` installs
.arbor/                  Arbor's own project: workflow.md, config.yaml, scripts/, agents/, spec/, tasks/, workspace/
.claude/                 Claude Code hooks, commands and skills for this repo
docs/plans/              design plans
NOTICE, COPYRIGHT        provenance and licence record
```

## Development

```bash
pnpm install
pnpm build
pnpm lint         # ESLint
pnpm typecheck
pnpm test         # vitest (default per-test timeout 10 s)
pnpm --filter @tony131143a/arbor lint:py   # basedpyright
```

- **Dogfood byte-identity.** `.arbor/scripts/*.py` must stay byte-identical to `packages/cli/src/templates/arbor/scripts/`. Edit both in the same change; a regression test fails on drift.
- **Slow tests.** `packages/cli/test/regression.test.ts` is very large. While iterating, run a subset with `cd packages/cli && npx vitest run test/regression.test.ts -t "<name>"`.
- **Spec lint.** `python3 ./.arbor/scripts/spec.py lint` reports stale or broken spec docs.

See `CONTRIBUTING.md`.

## License

AGPL-3.0-or-later, the same license as the upstream project it derives from (Trellis, Copyright (C) 2026 Mindfold LLC). See `LICENSE`, `COPYRIGHT` and `NOTICE`. Because the license is AGPL, anyone who runs a modified Arbor as a network service must offer the corresponding source to its users.
