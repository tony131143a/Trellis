# Arbor

Spec-driven AI engineering workflow where seven roles (explore, architect, implement, review, verify, fix, simplify) run as [codeg](https://github.com/spacering-net/codeg) assistants on other models.

Arbor keeps specs, tasks and journals in your repo (`.arbor/`). The main agent (Claude Code or StarFactory) plans, curates context, dispatches work to codeg assistants backed by `star` (a Claude Code fork) or `pi` + DeepSeek, verifies the result, and commits.

> **Provenance.** Arbor is a derivative work of [Trellis](https://github.com/mindfold-ai/Trellis) by Mindfold LLC, forked at commit `8c792c38` under AGPL-3.0-or-later. It is a personal fork, not affiliated with or endorsed by upstream. See `NOTICE`, `COPYRIGHT` and `.arbor/spec/tech/repo/provenance.md`.

## Why

- Trellis gives the workflow: Plan, Execute, Polish, Finish, with specs auto-injected, task PRDs, and journals that survive across sessions.
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
 codeg assistants   arbor-<role>-<target>   (role: explore | architect | implement | review | verify | fix | simplify)
        |                       |
        v                       v
   target: star            target: pi
   (Claude Code fork)      (pi + DeepSeek)
```

## Requirements

- Node.js >= 18, pnpm, Python >= 3.9
- [codeg](https://github.com/spacering-net/codeg) with `codeg-cli`
- At least one dispatch target: `star` (reachable through `star acp`) or `pi` configured for DeepSeek

## Install

Not published to npm. Build from source on the `arbor` branch and link the CLI:

```bash
pnpm install && pnpm build && (cd packages/cli && npm link)
arbor --version     # 0.1.0
```

After source changes, `pnpm build` is enough; the link stays in place.

| Command | Purpose |
| --- | --- |
| `arbor init` | Set up Arbor in the current repo (options below) |
| `arbor update` | Update managed files to the installed version |
| `arbor uninstall` | Remove Arbor from the repo |
| `arbor platforms` | List configured platforms |
| `arbor dispatch <args>` | Same as `python3 ./.arbor/scripts/dispatch.py <args>` |

## Set up a repository

### New repository

```bash
cd your-repo
arbor init --claude -u your-name
```

| Option | Effect |
| --- | --- |
| `--claude` | Install into `.claude/` (main agent: Claude Code) |
| `--star` | Install into `.starFactory/` (main agent: StarFactory); can be combined with `--claude` |
| `-u <name>` | Developer identity; journals go to `.arbor/workspace/<name>/` |
| `-y` | No prompts, use defaults |
| `--with-statusline` | Install the Arbor status line for Claude Code (off by default) |
| `-f` / `-s` | Overwrite / skip existing files without asking |
| `--monorepo` / `--no-monorepo` | Force / skip monorepo detection |

What `init` writes:

- `.arbor/`: `workflow.md` (the authoritative workflow), `config.yaml`, `scripts/` (task.py, dispatch.py, get_context.py, add_session.py, spec.py), `spec/`, `tasks/`, `workspace/`.
- `.claude/` and/or `.starFactory/`: `hooks/` (four Python hooks), `settings.json`, `commands/arbor/`, `skills/arbor-*`.
- A managed `<!-- ARBOR:START -->` block in `CLAUDE.md` and `AGENTS.md`; your own text outside the block is kept.
- A bootstrap task `00-bootstrap-guidelines` that walks you through writing the project's real conventions into `.arbor/spec/`.

Do the bootstrap task first. Dispatched assistants only see the spec files listed in a task's jsonl manifests; with an empty spec they write generic code.

### Existing Arbor repository (fresh clone or new checkout)

`.arbor/` and the platform files are committed, so do not set the repo up again. Two pieces of per-checkout state are gitignored and must be recreated:

```bash
python3 ./.arbor/scripts/init_developer.py your-name   # developer identity (.arbor/.developer)
python3 ./.arbor/scripts/dispatch.py codeg-setup        # assistant id registry (.arbor/.runtime/)
```

`arbor init -u your-name` also works on a fresh clone: it sets the identity and adds a `00-join-<slug>` onboarding task.

### Connect codeg

```bash
python3 ./.arbor/scripts/dispatch.py codeg-setup            # print manual steps and read assistant ids from codeg
python3 ./.arbor/scripts/dispatch.py codeg-setup --install  # macOS: write the assistants into codeg's database (backed up first)
```

- Twenty-one assistants, named `arbor-<role>-<target>`: roles `explore`, `architect`, `implement`, `review`, `verify`, `fix`, `simplify`; targets `star`, `pi`, `codex`. `--install` is needed once per machine; afterwards the plain command only refreshes the ids. It also soft-deletes the retired `arbor-check-*` and `arbor-research-*` assistants.
- `--install` creates missing assistants with the target's agent, mode and options from `config.yaml`, but never changes those three on an assistant that already exists: pick them in the codeg UI (Settings → Assistants). Re-running only refreshes name, description, avatar and instructions.
- Ids are written to `.arbor/.runtime/codeg-assistants.json`, which is gitignored, so run `codeg-setup` once in every repo and checkout.
- `--target star` limits it to one target.

Check the result:

```bash
python3 ./.arbor/scripts/dispatch.py resolve --role implement --json
# expect "target": "star" and a numeric "assistant_id"; null means codeg-setup has not run
```

## Daily workflow

### Where the main agent runs

| Mode | How roles are dispatched |
| --- | --- |
| Inside codeg: open the repo, start a Claude Code or star conversation (recommended) | `delegate_to_agent`, then `get_delegation_status` (codeg MCP tools) |
| Plain terminal: run `claude` in the repo | `dispatch.py run`, which wraps `codeg-cli run`. Needs the codeg app running, or `--standalone --data-dir <dir>`, or `--url <server>` for a remote codeg-server |

### Start a task

```
/arbor:workflow star add rate limiting to the login endpoint, 10 requests per IP per minute
```

`/arbor:workflow pi` and `/arbor:workflow codex` do the same on pi + DeepSeek or Codex. The command:

1. sets the dispatch target for this checkout (sticky until `/arbor:workflow <other>` or `dispatch.py target clear`);
2. confirms the assistant ids for the seven roles;
3. starts or continues the workflow.

You can also just describe the change; dispatch then uses `dispatch.default_target` (`star`).

### The phases

The main agent drives these; see `.arbor/workflow.md` for every step.

**Phase 1: Plan**

1. The agent classifies the request and asks whether to create a task. Approval to create a task is not approval to implement.
2. It creates `.arbor/tasks/MM-DD-<slug>/`, clarifies requirements with `arbor-brainstorm`, and writes `prd.md`. Complex tasks also get `design.md` and `implement.md`.
3. Explore & design (1.2): it dispatches 2-3 `explore` roles in parallel (findings go to `research/`), reads the essential files they return, and puts the open questions to you as one list. For complex tasks it then dispatches 3 `architect` roles (minimal-change, clean-architecture, pragmatic), presents the trade-offs with a recommendation, and writes `design.md` and `implement.md` after you pick.
4. It curates `implement.jsonl` (feeds `architect` and `implement`) and `check.jsonl` (feeds `review`, `verify`, `fix`, `simplify`) with the spec and research files the assistants need.
5. Complex tasks are put to you for review. After your approval it runs `task.py start` (status `in_progress`).

**Phase 2: Execute**

1. Take a snapshot (`dispatch.py snapshot`), then dispatch `implement`. The hook inlines the jsonl-listed files, `prd.md`, `design.md` and `implement.md`.
2. Review loop on the diff against the snapshot: `review`, then `verify` to filter candidates, then `fix`, then a re-review of the fix delta only. At most 2 rounds, then the agent stops and reports to you. A task without `design.md` is lightweight (one `review` in `Mode: self-check`); with `design.md` it is complex (three parallel `review` runs in `Mode: candidates` once the diff passes 300 changed lines).
3. On a failed dispatch the agent tightens the brief and re-dispatches, optionally with another `Target:`. It never does the role's work itself.

**Phase 2F: Polish**

1. Complex tasks: `simplify` the whole diff and review its delta for unchanged behavior.
2. Final review: five `review` runs in `Mode: candidates`, dedup, `verify`, one `review` in `Mode: sweep`, `verify` again.
3. Only if findings survive, you decide: fix now, fix later, or leave. Chosen findings go to `fix`.
4. Every task, lightweight included: the agent runs each affected package's Quality Check commands itself.

**Phase 3: Finish**

1. `arbor-update-spec` writes what was learned back into the spec (required). Only the main agent edits `.arbor/spec/`; no assistant does.
2. The agent commits in batches; no amend, no push.
3. You run `/arbor:finish-work`: dirty-path check, archive, journal.

Your part: approve task creation, review the PRD and design, read the final commits, run `/arbor:finish-work`.

### Resume

In a new session, `/arbor:continue` finds the active task, works out the current phase from its status and artifacts, and carries on.

## Slash commands and skills

| Command | Purpose |
| --- | --- |
| `/arbor:workflow <target> [request]` | All seven roles on `star`, `pi` or `codex`, then start or continue the task |
| `/arbor:continue` | Resume the current task at the right phase |
| `/arbor:finish-work` | Wrap up: dirty-path check, archive, journal |

There is no `/arbor:start`: both platforms inject the session context through a SessionStart hook.

The main agent loads these skills per phase; you can also ask for one by name.

| Skill | Use |
| --- | --- |
| `arbor-brainstorm` | Clarify requirements, write the PRD |
| `arbor-before-dev` | Read the relevant specs before coding |
| `arbor-check` | Quality check (main-session skill; separate from the dispatched `review` role) |
| `arbor-break-loop` | Root-cause review after repeated failed fixes |
| `arbor-update-spec` | Write lessons back into the spec |
| `arbor-spec-bootstrap` | Write a project spec from scratch |
| `arbor-meta` | Understand or customize Arbor itself |

## Dispatch

### Header protocol

The `task` text of every dispatch starts with:

```
Active task: <absolute path of the task dir in the main checkout>
Role: explore | architect | implement | review | verify | fix | simplify
Mode: self-check | candidates | sweep   (optional, review only; default self-check)
Diff: <absolute path of a .diff file>   (optional, review / verify / fix / simplify)
Target: star | pi              (optional, this call only)
Workspace: <absolute worktree> (optional, parallel variant)

<blank line, then a self-contained brief>
```

The hook inlines the role's manifest (`implement.jsonl` for `architect` and `implement`, `check.jsonl` for `review`, `verify`, `fix`, `simplify`), `prd.md`, `design.md`, `implement.md` and the `Diff:` file only when it sees this header; without it the assistant has to find the context itself. `explore` is the only role that may run without `Active task:`.

Sub-agents never commit, so the review loop slices the uncommitted tree with snapshots:

```bash
python3 ./.arbor/scripts/dispatch.py snapshot                    # prints a tree id
python3 ./.arbor/scripts/dispatch.py diff <A> [<B>] --name r1    # writes .arbor/.runtime/dispatch/diffs/r1.diff, prints its path
```

`B` defaults to the working tree now; add `-C <worktree>` inside a worktree.

### Target selection

Highest wins:

1. `Target:` header line, or `--target`
2. `.arbor/.runtime/dispatch-target` (written by `/arbor:workflow <target>`)
3. env `ARBOR_DISPATCH_TARGET`
4. `dispatch.default_target` in `.arbor/config.yaml` (`star`)

### Terminal dispatch

Usually the main agent runs these; you can too.

```bash
echo "implement the rate limiter from the PRD" | python3 ./.arbor/scripts/dispatch.py run --role implement --wait

python3 ./.arbor/scripts/dispatch.py run --role review --mode candidates --diff <file> -p "..."   # review a diff
python3 ./.arbor/scripts/dispatch.py run --role explore --target pi -p "..."           # pi for this call only
python3 ./.arbor/scripts/dispatch.py run --role implement --detach -p "..."            # background, prints a run id
python3 ./.arbor/scripts/dispatch.py wait <run-id>...                                  # collect detached runs

python3 ./.arbor/scripts/dispatch.py run --role implement --print-prompt -p "..."      # show the assembled prompt
python3 ./.arbor/scripts/dispatch.py run --role implement --dry-run -p "..."           # show the codeg-cli command

python3 ./.arbor/scripts/dispatch.py target get | set <star|pi|codex> | clear                # read / set / clear the override
```

Prompts and replies are kept under `.arbor/.runtime/dispatch/`.

## Parallel variant

For work that splits into disjoint child tasks:

```bash
python3 ./.arbor/scripts/task.py set-meta <parent> execution parallel
python3 ./.arbor/scripts/task.py create "child A" --slug a --parent <parent> -d "..."
```

After `task.py start` the main agent follows Phase 2P in `.arbor/workflow.md`:

1. One git worktree per child, on branch `wip/<parent>/<child>`.
2. Up to `dispatch.max_parallel` (default 3) implement roles at once.
3. The review loop in each worktree (diffs via `dispatch.py diff <task-branch> -C <worktree>`); the main agent commits each green child.
4. Serial `--no-ff` merges into the task branch.
5. Worktree cleanup.
6. Phase 2F (polish) on the merged tree for the parent task.
7. `/arbor:finish-work` archives the parent and its children.

## Task commands

`python3 ./.arbor/scripts/task.py <command>`:

| Command | Purpose |
| --- | --- |
| `create "<title>" -s <slug> -d "<description>" [--parent P] [--no-start]` | New task. The description must be non-empty or archive refuses it |
| `start <dir>` / `current` / `finish` | Set / show / clear the active task |
| `list` / `list-archive` | List tasks / archived tasks |
| `add-context <dir> <implement\|check> <path> [reason]` / `list-context` / `validate` | Manage the jsonl manifests |
| `set-meta <dir> <key> <value>` | Task metadata, e.g. `execution parallel` |
| `add-subtask` / `remove-subtask` | Link / unlink parent and child |
| `set-branch` / `set-base-branch` / `rename` / `archive` | Branch, PR target branch, rename, archive |

Other scripts:

- `get_context.py --mode phase --step 2.1`: detailed guidance for one workflow step
- `spec.py lint`: stale or broken spec docs
- `add_session.py`: write a journal entry (normally called by `/arbor:finish-work`)

## Configuration

The `dispatch:` section of `.arbor/config.yaml`:

```yaml
dispatch:
  default_target: star        # default dispatch target
  max_parallel: 3             # implement roles at once in the parallel variant
  guard_builtin_agent: true   # deny the built-in Agent/Task tool for arbor roles
  hook_decision: allow
  codeg_cli: ""               # empty: find codeg-cli automatically
  permissions: allow          # passed to codeg-cli
  timeout: 90m
  targets:
    star: { agent_type: "custom:star", explore: arbor-explore-star, architect: arbor-architect-star, implement: arbor-implement-star, review: arbor-review-star, verify: arbor-verify-star, fix: arbor-fix-star, simplify: arbor-simplify-star }
    pi:   { agent_type: pi, model: deepseek/DeepSeek-V4.1-Flash, thought_level: max, explore: arbor-explore-pi, ... }
    codex: { agent_type: codex, mode_id: agent-full-access, explore: arbor-explore-codex, ... }
```

`mode_id` is the agent's session mode (codex: `agent-full-access`, `workspace-write`, `read-only`); `model` / `thought_level` are agent options. Both only apply when `codeg-setup --install` creates an assistant; for an existing one change them in the codeg UI. Re-run `codeg-setup` after changing assistant names or editing `.arbor/agents/*.md`.

## Maintenance

```bash
arbor update --dry-run      # preview template updates
arbor update                # asks per locally modified file; -s skip all, -n write .new copies, -f overwrite all
arbor platforms             # configured platforms
arbor uninstall --dry-run   # preview removal
arbor uninstall             # remove .arbor/ and managed files; only the managed block is stripped from CLAUDE.md / AGENTS.md
```

`arbor update -f` also overwrites your own additions to `.arbor/config.yaml`, such as a `packages:` section.

## Rules and known limitations

- Assistants only do their role: no commits, no push, no further dispatch, no `task.py start/current/finish`, no writes under `.arbor/` (`explore` and `architect` write only `<task>/research/*.md`). Only the main agent commits and updates the spec.
- Not yet verified in live codeg sessions: the `delegate_to_agent` hook firing inside codeg, star through `star acp`, and the parallel flow. On first real use, try a small task and check that the dispatched prompt contains `<!-- arbor-hook-injected -->`.
- Assistant ids are per repo and checkout: run `codeg-setup` in each one.

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
