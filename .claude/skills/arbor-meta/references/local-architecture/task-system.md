# Local Task System

The Arbor task system is stored entirely under `.arbor/tasks/` in the user project. Each task is a directory containing requirements, context, research, state, and relationship information.

## Task Directory Structure

```text
.arbor/tasks/
├── 04-28-example-task/
│   ├── task.json
│   ├── contract.md
│   ├── design.md
│   ├── waves.md
│   ├── implement.jsonl
│   ├── check.jsonl
│   ├── research/
│   ├── briefs/
│   ├── reports/
│   └── scorecard.md
└── archive/
    └── 2026-04/
```

| File | Purpose |
| --- | --- |
| `task.json` | Task metadata: status, assignee, priority, branch, parent/child tasks; after `task.py start` also the driver's `state`, `base`, `contract_hash`, `worktree_path`, `wave`, `last_reviewed`, `counters`, `dispatches`. |
| `contract.md` | Goal, scope, acceptance criteria (Given / When / Then), Verification map, Interface pins, Test paths, optional Partitions / Waves. Every tier; light tasks have only this. Approved by the human; `contract_hash` records the baseline but does not block edits or collection. Older tasks may have `prd.md` instead. |
| `design.md` | Technical design for standard and full tasks: boundaries, contracts, data flow, compatibility, tradeoffs. |
| `waves.md` | Full tasks: the chosen architect design's partitions and wave order with the reasoning (legacy name `implement.md`). |
| `implement.jsonl` | List of spec/research files the `architect`, `test` and `implement` roles must read first. |
| `check.jsonl` | List of spec/research files the `review`, `verify`, `fix`, and `simplify` roles must read first. |
| `research/` | Research artifacts (`explore` findings, `architect` blueprints `design-<perspective>.md`, or the main agent's notes). Larger findings should not live only in chat. |
| `briefs/` | `d-NNN.md`: the brief the main agent wrote for each dispatch (body only; the driver adds header and context). |
| `reports/` | `d-NNN.md`: the role's reply plus the driver's verdict; `gate-N.md`: output of the N-th gate round; `candidates-rN.json`: POLISH round N after the prefilter. Committed by the driver; CONTRACT-phase files are committed by `task.py start`. The assembled prompts stay uncommitted in `.arbor/.runtime/prompts/<task>/` of the main checkout. |
| `scorecard.md` | Written at FINISH: dispatches per role, rounds, findings per rung, AC automation rate, overrides, violations. |

`task.py start` moves the whole directory into the task worktree (`<worktree.root>/<task>`, branch `arbor/<task>`) and commits it there; from then on the task's artifacts travel with its code into the PR.

## `task.json`

`task.json` records task status and metadata. Common fields:

| Field | Meaning |
| --- | --- |
| `id` / `name` / `title` | Task identity and title. |
| `status` | Status such as `planning`, `in_progress`, `review`, or `completed`. |
| `priority` | `P0`, `P1`, `P2`, `P3`. |
| `creator` / `assignee` | Creator and assignee. |
| `package` | Target package in a monorepo; may be empty. |
| `branch` / `base_branch` | Working branch and PR target branch. |
| `children` / `parent` | Parent/child task relationships. |
| `commit` / `pr_url` | Commit and PR information after completion. |
| `meta` | Extension fields. `meta.tier` (`light` / `standard` / `full`; inferred from the artifacts when absent) and `meta.execution` (`parallel` requires tier full). |

## Parent / Child Task Trees

Parent/child task relationships are for work structure. A parent task groups related deliverables under one source requirement set; it is not a dependency scheduler and does not replace the child task's own planning artifacts.

Use a parent task when a request has multiple independently verifiable deliverables. The parent owns:

- Source requirements and user-facing scope.
- The map of child tasks and their responsibility boundaries.
- Cross-child acceptance criteria and final integration review.

Use child tasks for deliverables that can move through planning, implementation, review, and archive independently. If one child depends on another, write that dependency in the child's `contract.md`; do not rely on tree position to imply ordering.

Create new children with:

```bash
python3 ./.arbor/scripts/task.py create "<child title>" --description "<one-line summary>" --slug <child-slug> --parent <parent-dir>
```

Link or unlink existing tasks with:

```bash
python3 ./.arbor/scripts/task.py add-subtask <parent-dir> <child-dir>
python3 ./.arbor/scripts/task.py remove-subtask <parent-dir> <child-dir>
```

`children` on the parent is a historical list. When a child is archived, Arbor keeps that child name in the parent so progress like `[2/3 done]` remains meaningful after completed children move to `archive/`.

The AI should not treat phase numbers as task status. Before `task.py start`, progress is determined by `status`, artifact presence (`meta.tier`, else the artifacts: `contract.md`, `design.md` for standard, `waves.md` for full), and whether JSONL context is configured. After it, `arbor.py next` is the source of truth.

## Active Task

The user sees a "current task," but Arbor stores active task state per session.

```text
.arbor/.runtime/sessions/<context-key>.json
```

`task.py start` writes the task path (the absolute path inside the task worktree) into the runtime session file for the current session; runtime state stays in the main checkout. `task.py current --source` shows the current task and where it came from. Different AI windows can point to different tasks without overwriting each other.

If the platform or shell environment has no stable session identity, `task.py start` may be unable to set the active task. The AI should read the error, inspect the platform hook/session environment, and not fall back to a shared global pointer.

## JSONL Context

`implement.jsonl` and `check.jsonl` are context manifests the driver inlines into role prompts. They hold spec and research files only, never code.

`task.py seed-context <task> [--package <pkg> ...]` fills both manifests with the package's spec layer index files, the guides index, and the task's research files (idempotent); the main agent then adds or drops entries per side. `task.py create --tier <light|standard|full>` sets the tier at creation, and `task.py start` refuses a planning task whose tier artifacts are missing.

Format:

```jsonl
{"file": ".arbor/spec/cli/backend/index.md", "reason": "Backend conventions"}
{"file": ".arbor/tasks/04-28-example/research/api.md", "reason": "API research"}
```

Rules:

- Include spec and research files.
- Do not include code files that are about to be modified.
- Do not treat temporary conclusions in chat as the only context.
- Rows without a `file` field are skipped by readers. Legacy `{"_example": ...}` placeholder rows are rejected by `task.py validate` — delete them.

## Common Commands

```bash
python3 ./.arbor/scripts/task.py create "<title>" --description "<one-line summary>" --slug <slug>
python3 ./.arbor/scripts/task.py start <task>
python3 ./.arbor/scripts/task.py current --source
python3 ./.arbor/scripts/task.py add-context <task> implement <file> <reason>
python3 ./.arbor/scripts/task.py validate <task>
python3 ./.arbor/scripts/task.py finish
python3 ./.arbor/scripts/task.py archive <task>
```

When modifying the task system, the AI should prefer script commands to maintain structure. Edit JSON/Markdown directly only when scripts do not cover the need.

## Local Customization Points

| Need | Edit location |
| --- | --- |
| Change the default task template | `.arbor/scripts/common/task_store.py` and task creation instructions. |
| Change status semantics | `.arbor/workflow.md`, workflow-state hook logic, and task usage conventions. |
| Add task lifecycle actions | `hooks.after_*` in `.arbor/config.yaml`. |
| Change context rules | Planning artifact guidance in `.arbor/workflow.md` and related hook and `.arbor/agents/*.md` instructions. |
| Change archive policy | `.arbor/scripts/common/task_store.py` / `task_utils.py`. |

These are local files in the user project. Do not default to editing Arbor CLI source code unless the user wants to contribute upstream.
