# Arbor

Arbor is a spec-driven AI engineering workflow for **Claude Code and Codex**, for work that is too large for one context or splits into parallel parts. The main agent (Claude Code, running inside Orca) writes a contract you approve and splits the work into node files. A Python driver runs every node as an Orca worker in its own git worktree, merges the results into an integration branch, runs the checks and ends every step with the one thing to do next. Small changes do not need it.

## Install and initialize

```bash
pnpm install
pnpm build
node packages/cli/bin/arbor.js init --codex --yes
# Or: init --claude --yes
```

Run init from the project that should receive Arbor.

| Platform | What the main agent gets | Project files |
|---|---|---|
| Claude Code | a short block in `CLAUDE.md`; the skill `arbor` loads on demand | `CLAUDE.md`, `.claude/` |
| Codex | a worker note in `AGENTS.md`; the spec skills | `AGENTS.md`, `.agents/skills/` |

Arbor installs no hooks and no sub-agent definitions. Codex is mainly a worker: `agent: codex` is the default agent of every node. Specs live in `.arbor/spec/`, tasks in `.arbor/tasks/`, journals in `.arbor/workspace/`.

StarFactory is no longer an installable Arbor platform. Update can remove unchanged historical Arbor templates after backing them up; locally modified files remain available for review. Uninstall only processes tracked Arbor files and preserves unrelated user content.

## The loop

The driver is `python3 .arbor/scripts/arbor.py` (`arbor.py` below).

1. **Contract.** `arbor.py new "<title>"`. The main agent explores, asks only what the code cannot answer, and writes `contract.md`: goal, scope, acceptance criteria, and a Verification map with one check command per criterion (`manual` for what only a person can judge). You approve it; `arbor.py start`.
2. **Plan.** The main agent writes one file per node in the task's `nodes/` directory. The plan is that directory: add, edit or delete nodes at any time (a started node's file is frozen).
3. **Run.** `arbor.py sync` starts every ready node in its own Orca worktree, then `arbor.py sync --wait` runs as a background command; the main agent ends its turn and is woken when a node settles.
4. **React.** Each `sync` judges settled nodes (commits, paths, checks), merges good ones with `--no-ff` into the repository's integration branch, runs the full gate once nothing is running, and prints one `next:` line. A failed node: `retry`, `cancel` or change the plan. A red gate: add fix nodes.
5. **Review.** `arbor.py review` writes one read-only reviewer node per repository. Reviewers run code and mark each finding `shown` (with a rerunnable command) or `read`. Findings become fix nodes; then `arbor.py review --pass`.
6. **Finish.** `arbor.py finish` lists the manual checks and prints one `git merge --no-ff` per repository. You merge; run `finish` again to clean up, archive the task and write the journal entry.

A node is one file, `nodes/<id>.md`:

```
---
title: Add the redis channel adapter
repo: server                              # package with its own git repository, or "."
paths: [src/channel/**, tests/channel/**] # no paths = read-only node (research, review)
after: [api-types]                        # nodes that must be merged first
tier: write                               # write (default) | light | explore | review | a name from the config
checks: [AC-2]                            # optional: Verification-map rows it can make green alone
---
The brief: the outcome, the files to read first, interfaces to match, what is out of scope.
```

A writer node gets a worktree and a branch and may only change files inside its `paths`. A read-only node gets no worktree: it runs in the repository's existing checkout, also before `start`, and its result is its report. Nodes with overlapping `paths` run one after the other.

| Command | What it does |
|---|---|
| `new "<title>" [--repo key]` | create the task directory and the contract skeleton |
| `start` | contract approved: validate it, add the repositories Orca does not know yet as Orca projects, activate |
| `sync [--wait] [--json]` | observe, judge, merge, start, gate; print `next:` |
| `review` / `review --pass` | write reviewer nodes / record that the current HEADs were reviewed |
| `finish` | merge commands per repository; then clean up, archive, journal |
| `status [--all]` | state of the task, no side effects |
| `cancel <id>`, `retry <id>`, `resume`, `abandon` | intervene; `resume` grants more nodes or fix rounds after a budget stops the task |

## Prerequisites and configuration

- Orca with its CLI (`orca`). The main agent runs inside Orca. Orca creates worktrees only for its projects: the driver adds the control repository and the `git: true` package repositories a task touches itself (`orca repo add`). In Orca Settings, Agents, set each agent's permission mode so workers do not stop on prompts.
- Python 3 for the scripts under `.arbor/scripts/`.

`.arbor/config.yaml`:

```yaml
executors:
  default: orca
  orca:
    type: orca
    command: orca          # the Orca CLI; an absolute path when not on PATH
    agents:                # the agent of each kind of work: an id, or {agent, model, effort}
      write: codex         # nodes with paths, the default
      explore: omp         # read-only nodes that name no tier
      review:              # reviewer nodes
        agent: claude
        model: opus        # optional; else the agent's own Orca setting
        effort: high       # optional; needs model
      light: omp           # optional: mechanical edits (tier: light)
    main: claude           # optional: the agent that runs the driver (default: detected); its own read-only nodes skip Orca
    timeout: 90m
    max_parallel: 5
    max_nodes: 30          # nodes of one task before sync stops and asks
```

Several independent repositories under one control repository are supported: declare each as a package with `git: true` (optionally `execution.base_ref` and `execution.merge_target`), name it in a node's `repo` and in the Verification map's `repo` column. Each (task, repository) pair gets its own integration branch, gate and merge command.

## Upgrading from 0.x

```bash
# 1. finish or abandon every started task with the old version: 1.0 refuses a pre-1.0 task.json
arbor update --migrate   # 2. removes hooks, role files, workflow.md, slash commands; config.yaml is never overwritten
```

## Maintenance

```bash
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
