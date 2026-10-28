# Development Workflow

---

## Core Principles

1. **Plan before code** — figure out what to do before you start
2. **Specs injected, not remembered** — guidelines are injected via hook/skill, not recalled from memory
3. **Persist everything** — research, decisions, and lessons all go to files; conversations get compacted, files don't
4. **Incremental development** — one task at a time
5. **Capture learnings** — after each task, review and write new knowledge back to spec

---

## Arbor System

### Developer Identity

On first use, initialize your identity:

```bash
python3 ./.arbor/scripts/init_developer.py <your-name>
```

Creates `.arbor/.developer` (gitignored) + `.arbor/workspace/<your-name>/`.

### Spec System

`.arbor/spec/` holds coding guidelines organized by package and layer.

- `.arbor/spec/<package>/<layer>/index.md` — entry point with **Pre-Development Checklist** + **Quality Check**. Actual guidelines live in the `.md` files it points to.
- `.arbor/spec/guides/index.md` — cross-package thinking guides.

```bash
python3 ./.arbor/scripts/get_context.py --mode packages   # list packages / layers
```

**When to update spec**: new pattern/convention found · bug-fix prevention to codify · new technical decision.

### Task System

Every task has its own directory under `.arbor/tasks/{MM-DD-name}/` holding `task.json`, `prd.md`, optional `design.md`, optional `implement.md`, optional `research/`, and context manifests (`implement.jsonl`, `check.jsonl`) that the dispatched assistants load.

```bash
# Task lifecycle
python3 ./.arbor/scripts/task.py create "<title>" --description "<one-line summary>" [--slug <name>] [--tier light|standard|full] [--parent <dir>]
python3 ./.arbor/scripts/task.py start <name>          # set active task (session-scoped when available); checks the tier's artifacts
python3 ./.arbor/scripts/task.py current --source      # show active task and source
python3 ./.arbor/scripts/task.py finish                # clear active task (triggers after_finish hooks)
python3 ./.arbor/scripts/task.py archive <name>        # move to archive/{year-month}/
python3 ./.arbor/scripts/task.py list [--mine] [--status <s>]
python3 ./.arbor/scripts/task.py list-archive

# Code-spec context (injected into the dispatched assistants via JSONL).
# `implement.jsonl` / `check.jsonl` are seeded (empty) on `task create`. `seed-context` fills
# both with the package's spec indexes, the shared guides index and the task's research files;
# the AI then adds or drops entries. `validate` fails and `start` refuses while a manifest is
# still empty — assistants would run with zero spec context.
# Pass `start --allow-empty-context` when that is intentional.
python3 ./.arbor/scripts/task.py seed-context <name> [--package <pkg> ...]
python3 ./.arbor/scripts/task.py add-context <name> <action> <file> <reason>
python3 ./.arbor/scripts/task.py list-context <name> [action]
python3 ./.arbor/scripts/task.py validate <name>

# Task metadata
python3 ./.arbor/scripts/task.py set-branch <name> <branch>
python3 ./.arbor/scripts/task.py set-base-branch <name> <branch>    # PR target
python3 ./.arbor/scripts/task.py set-scope <name> <scope>
python3 ./.arbor/scripts/task.py set-meta <name> <key> <value>      # e.g. tier standard, execution parallel

# Hierarchy (parent/child)
python3 ./.arbor/scripts/task.py add-subtask <parent> <child>
python3 ./.arbor/scripts/task.py remove-subtask <parent> <child>

# PR creation
python3 ./.arbor/scripts/task.py create-pr [name] [--dry-run]
```

> Run `python3 ./.arbor/scripts/task.py --help` to see the authoritative, up-to-date list.

**Current-task mechanism**: `task.py create` creates the task directory and (when session identity is available) auto-sets the per-session active-task pointer so the planning breadcrumb fires immediately. `task.py start` writes the same pointer (idempotent if already set) and flips `task.json.status` from `planning` to `in_progress`; while the task is still in planning it refuses when the tier's artifacts (see Tiers) or the context manifests are missing. State is stored under `.arbor/.runtime/sessions/`. If no context key is available from hook input or `ARBOR_CONTEXT_ID`, there is no active task and `task.py start` fails with a session identity hint. `task.py finish` deletes the current session file (status unchanged). `task.py archive <task>` writes `status=completed`, moves the directory to `archive/`, and deletes any runtime session files that still point at the archived task.

### Workspace System

Records every AI session for cross-session tracking under `.arbor/workspace/<developer>/`.

- `journal-N.md` — session log. **Max 2000 lines per file**; a new `journal-(N+1).md` is auto-created when exceeded.
- `index.md` — personal index (total sessions, last active).

```bash
python3 ./.arbor/scripts/add_session.py --title "Title" --commit "hash" --summary "Summary"
```

### Context Script

```bash
python3 ./.arbor/scripts/get_context.py                            # full session runtime
python3 ./.arbor/scripts/get_context.py --mode packages            # available packages + spec layers
python3 ./.arbor/scripts/get_context.py --mode phase --step <X.Y>  # detailed guide for a workflow step
```

### Dispatch

Inside an Arbor task the seven roles below are never performed in the main session (the no-task quick path is the only exception) and never through the built-in `Agent`/`Task` tool (a guard hook denies it for arbor roles). They run as **codeg assistants** on another model. The main agent plans, curates context, dispatches, dedups findings, verifies, and commits.

**Roles.** Each role has one assistant per target. Default assistant names are `arbor-<role>-<target>` (for example `arbor-review-star`, `arbor-review-pi`); they are configured under `dispatch:` in `.arbor/config.yaml`, and the role instructions live in `.arbor/agents/<role>.md`.

| Role | Writes | Context inlined | Used in | Output |
|---|---|---|---|---|
| `explore` | `<task>/research/<topic>.md` only | spec overview; with a task, `prd.md` + research file list | 1.2, any phase, as needed | findings + 5-10 essential files |
| `architect` | `<task>/research/design-<perspective>.md` only | `implement.jsonl` → prd → design → implement.md → `research/*.md` | 1.2 (standard: at most 1; full: 3) | one blueprint incl. parallel split |
| `implement` | code (no commits) | `implement.jsonl` → prd → design → implement.md | 2.1, 2P.2 | code + verification report |
| `review` | nothing | `check.jsonl` → prd → design → implement.md → `Diff:` | 2.2, 2P.3, 2F | `PASS`/`FAIL` + JSON findings |
| `verify` | nothing | same as review | 2F (standard, full) | CONFIRMED / PLAUSIBLE / REFUTED per candidate |
| `fix` | code (no commits) | same as review | 2.2, 2P.3, 2F | fixed / skipped per finding |
| `simplify` | code (no commits) | same as review | 2F.1 | behavior-preserving cleanup |

**Target selection** (highest wins): `Target:` header line or `--target` → this session's `.arbor/.runtime/sessions/<context>.dispatch-target` → checkout-wide `.arbor/.runtime/dispatch-target` → env `ARBOR_DISPATCH_TARGET` → `dispatch.default_target` in config. Switch with `/arbor:workflow <target>` (sets this session's target and continues the task; parallel sessions on one checkout keep their own). The delegation hook swaps an `assistant_id` that belongs to another target for the effective target's assistant, so stale ids cannot cross sessions. Running finders and `verify` on different targets (for example review on `pi`, verify on `star`) makes the verification independent.

**Header protocol.** The `task` text of every dispatch MUST start with this header, followed by a blank line and a self-contained brief:

```
Active task: <absolute path of the task directory in the MAIN checkout>
Role: explore | architect | implement | review | verify | fix | simplify
Mode: self-check | candidates | sweep      (optional; review only; default self-check)
Diff: <absolute path of a .diff file>      (optional; review / verify / fix / simplify)
Target: star | pi                          (optional)
Workspace: <absolute worktree path>        (optional; parallel variant only)
```

A hook (codeg path) or `dispatch.py` (terminal path) recognises the header and inlines the role's manifest files, `prd.md`, `design.md`, `implement.md`, and the `Diff:` file, marked `<!-- arbor-hook-injected -->`. Without the header nothing is inlined and the assistant has to pull the context itself. `explore` is the only role that may run without `Active task:`.

**Briefs.** The assistant cannot see your conversation. Put everything it needs in the brief: the goal, the essential files to read, decisions already made, check commands, and for review the `Angles:` line; for verify and fix, the findings JSON.

**Snapshots and diffs.** Sub-agents never commit, so the review loop slices the uncommitted working tree with snapshots:

```bash
python3 ./.arbor/scripts/dispatch.py snapshot                 # prints a tree id (untracked files included; index untouched)
python3 ./.arbor/scripts/dispatch.py diff <A> [<B>] --name <n>   # writes .arbor/.runtime/dispatch/diffs/<n>.diff, prints its path; B defaults to the working tree now
```

The diff excludes `.arbor/` and reports the changed-line count on stderr. Use `-C <worktree>` inside a worktree.

**Path A: inside codeg** (the MCP tools `delegate_to_agent` and `get_delegation_status` are in your tool list):

1. Find the integer `assistant_id` for the role and target in the `<dispatch>` section of the session context, or run `python3 ./.arbor/scripts/dispatch.py resolve --role <role>`.
2. `delegate_to_agent(assistant_id=<id>, working_dir=<repo root, or the worktree>, task=<header + brief>)` returns a `task_id` immediately.
3. `get_delegation_status(task_ids=[...], wait_ms=60000)` repeatedly until every task is terminal. Independent dispatches run concurrently, up to `dispatch.max_parallel` at once.

**Path B: plain terminal** (no codeg MCP tools):

```bash
python3 ./.arbor/scripts/dispatch.py run --role <role> [--mode M] [--diff F] [--target star|pi|codex] [--task <dir>] [--workspace <worktree>] --wait   # brief on stdin, or --prompt / --prompt-file
```

It runs `codeg-cli run -A <assistant>` against the running codeg app (`--url <server>` for a remote `codeg-server`; `--standalone --data-dir <codeg data dir>` while the app is closed) and prints the reply; prompt and reply are kept under `.arbor/.runtime/dispatch/`. `--detach` starts it in the background and prints a run id; `python3 ./.arbor/scripts/dispatch.py wait <run>...` collects results. `--print-prompt` / `--dry-run` show the prompt / the `codeg-cli` command without running.

**Sub-agent self-exemption.** If your own first prompt starts with `Active task:` + `Role:`, you are a dispatched sub-agent: do that role's work directly, do not dispatch anything, do not commit, push, or merge, and do not call `task.py start/current/finish`. You have no `ARBOR_CONTEXT_ID`. Dispatch is for the main agent only.

**Invariants.** Sub-agents never commit, merge, or push; never touch paths outside their working directory; never write under `.arbor/` (explore and architect write only `<task>/research/*.md`). Only the main agent commits (Phase 3.4) and updates `.arbor/spec/` (Phase 3.3).

---

<!--
  WORKFLOW-STATE BREADCRUMB CONTRACT (read this before editing the tag blocks below)

  The [workflow-state:STATUS] blocks embedded in the ## Phase Index section
  below are the SINGLE source of truth for the per-turn `<workflow-state>`
  breadcrumb that the UserPromptSubmit hook reads. inject-workflow-state.py
  only parses them — there is no fallback dict baked into the script.

  STATUS charset: [A-Za-z0-9_-]+. When the hook can't find a tag, it
  degrades to a generic "Refer to workflow.md for current step." line —
  intentionally visible so users notice and fix a broken workflow.md.

  KEY SELECTION (inject-workflow-state.py, resolve_breadcrumb_key):
    tier = task.json.meta.tier when valid, otherwise inferred from the
           artifacts (implement.md → full, design.md → standard, else light)
    1. <status>-parallel   only when the tier is full and meta.execution=parallel
    2. <status>-<tier>
    3. <status>
    The header line shows the tier: `Task: <id> (<status>) · Tier: <tier>`,
    with "(inferred)" when meta.tier is not set.

  INVARIANT (test/templates/arbor.test.ts):
    Every workflow-walkthrough step marked `[required · once]` must have a
    matching enforcement line in every [workflow-state:*] block of its
    phase that is in the step's tier scope. `[required · once]` alone means
    every tier; `[required · once; standard / full]` means the standard,
    full and parallel blocks. The breadcrumb is the only per-turn channel;
    if a mandatory step isn't mentioned there, the AI silently skips it
    (Phase 1 planning gate skip and Phase 3.4 commit skip both manifested
    via this gap).

  PARSER TRAP: a line that ENDS with a `[workflow-state:X]` token opens a
  block for the parser and swallows the real one. Never end a prose or
  comment line with such a token; write "the no_task block" instead.

  TAG ↔ PHASE scoping:
    [workflow-state:no_task]      → no active task; quick path or tier proposal before Phase 1
    [workflow-state:task_error]   → active task record is unreadable; repair it before continuing
    [workflow-state:planning]     → all of Phase 1 (status='planning'), every tier
    [workflow-state:in_progress-light]    → Phase 2 + 2F.5 + Phase 3.2-3.4, tier light
    [workflow-state:in_progress-standard] → Phase 2 + Phase 2F + Phase 3.2-3.4, tier standard
    [workflow-state:in_progress-full]     → Phase 2 + Phase 2F + Phase 3.2-3.4, tier full, serial
    [workflow-state:in_progress-parallel] → Phase 2P + Phase 2F + Phase 3.2-3.4, tier full with
                                    meta.execution=parallel
    [workflow-state:in_progress]  → fallback only, shown when no block exists for the
                                    task's tier (status stays 'in_progress' from
                                    task.py start until task.py archive)
    [workflow-state:completed]    → currently DEAD: cmd_archive flips
                                    status and moves the dir in the same
                                    call, so the resolver loses the
                                    pointer (block kept for a future
                                    explicit in_progress→completed
                                    transition)

  Editing checklist:
    - When you change a [workflow-state:STATUS] block, also check the
      matching phase's `[required · once]` walkthrough steps for sync
    - Run `arbor update` after editing to push the new bodies to
      downstream user projects (block-level managed replacement)
    - Full runtime contract:
      .arbor/spec/cli/backend/workflow-state-contract.md
-->

## Phase Index

```
Phase 1:  Plan    → classify (quick / light / standard / full), consent, explore as needed, one question list, design, planning artifacts
Phase 2:  Execute → implement, then one gate review → fix (serial), or 2P for parallel worktrees (full only)
Phase 2F: Polish  → standard / full: simplify, one final review → verify → fix; every task: quality checks
Phase 3:  Finish  → update spec, commit, and wrap up
```

### Tiers

The tier decides which roles take part and how long the review chain is. Explore is not a tier lever: read a few files yourself when that answers the question, otherwise dispatch `explore` roles, one aspect each, in parallel, as many as the task needs.

| | quick | light | standard | full |
|---|---|---|---|---|
| Fits | at most 2 files, cause known, no design choice | one deliverable, a few files, existing patterns suffice | a feature or refactor across files or layers that needs a written design | several deliverables, contested design, risky migration, or parallel worktrees |
| Task + artifacts | none | `prd.md` | `prd.md` + `design.md` (you write it; one `architect` only if unfamiliar) | `prd.md` + `design.md` + `implement.md` (3 `architect` roles, the user picks) |
| Roles | none (you edit) | implement, review, fix | + simplify, verify | + architect, review `Mode: sweep` |
| Execute (2.2) | edit, run the checks | review self-check (all angles) ⇄ fix, at most 2 rounds | review self-check (`A, B, Acceptance`) ⇄ fix, at most 1 round | same as standard |
| Polish (2F) | none | 2F.5 only | simplify → 3 × review candidates → verify → fix ⇄ review (at most 2) | simplify → 5 × review candidates → verify → sweep → verify → fix ⇄ review (at most 2) |
| Finish | one commit, ask once | 3.3 → 3.4 → `/arbor:finish-work` | same | same |

The tier lives in `task.json.meta.tier` (`task.py create --tier <t>`, later `task.py set-meta <task> tier <t>`). Without it the tier is inferred from the artifacts: `implement.md` → full, `design.md` → standard, otherwise light. `task.py start` refuses a planning task whose tier artifacts are missing, and `meta.execution=parallel` requires tier full.

### Request Triage

- Classify first. **Quick** (at most 2 files, cause known, no design choice): do it in this session without a task: read, edit, run the project's checks, propose one commit message and ask once. Say in one line that no Arbor task was created (`/arbor:workflow` creates one). Quick work skips the spec update and the journal. Unsure whether it is quick: treat it as light.
- Anything larger: in one message propose a tier (light / standard / full) with a one-line reason and ask whether to create a task. The user answers ok / light / standard / full / no. `/arbor:workflow <target> [--tier <t>] <request>` already counts as consent.
- User approval to create a task is not approval to start implementation. Planning still happens first; approval of the final planning summary (1.4) is the only start gate.
- If the user declines a task for non-quick work, do not do broad inline implementation; explain, clarify scope, or suggest a smaller split. Plain questions need no task.

### Planning Artifacts

- `prd.md` — requirements, constraints, and acceptance criteria. Do not put technical design or execution checklists here.
- `design.md` — technical design (standard and full): boundaries, contracts, data flow, tradeoffs, compatibility, rollout / rollback shape.
- `implement.md` — execution plan (full): ordered checklist, validation commands, file ownership and waves, rollback points.
- `implement.jsonl` / `check.jsonl` — spec and research manifests for the dispatched assistants (`implement.jsonl` feeds architect and implement; `check.jsonl` feeds review, verify, fix, and simplify). `task.py seed-context` fills them; they do not replace `implement.md`.
- `research/` — explore findings (`<topic>.md`) and architect blueprints (`design-<perspective>.md`).
- Required before `task.py start`: light = `prd.md`; standard = `prd.md` + `design.md`; full = `prd.md` + `design.md` + `implement.md`.

### Parent / Child Task Trees

Use a parent task when one user request contains several independently verifiable deliverables. The parent task owns the source requirement set, the task map, cross-child acceptance criteria, and final integration review; it normally should not be the implementation target unless it also has direct work.

Use child tasks for deliverables that can be planned, implemented, checked, and archived independently. Parent/child structure is not a dependency system: if one child must wait for another, write that ordering in the child `prd.md` / `implement.md` and keep each child's acceptance criteria testable.

Create new children with `task.py create "<title>" --description "<one-line summary>" --slug <name> --parent <parent-dir>`. Link existing tasks with `task.py add-subtask <parent> <child>`, and unlink mistakes with `task.py remove-subtask <parent> <child>`.

A parent task whose children run concurrently in separate git worktrees uses the parallel execution mode (tier full; step 1.4, Phase 2P).

<!-- Per-turn breadcrumb: shown when there is no active task (before Phase 1) -->

[workflow-state:no_task]
No active task. Classify the request before acting (Phase Index, Tiers).
Quick (at most 2 files, cause known, no design choice): do it here without a task: read, edit, run the project's checks, propose one commit message and ask once. Say in one line that no Arbor task was created (`/arbor:workflow` creates one). Unsure whether it is quick: treat it as light.
Anything larger: in one message propose a tier (light / standard / full) with a one-line reason and ask whether to create a task; the user answers ok / light / standard / full / no. On yes: `task.py create "<title>" --description "<summary>" --slug <name> --tier <tier>` (1.0), then `arbor-brainstorm`. Task-creation consent is not implementation consent; planning comes first.
If the user declines a task for non-quick work, do not implement broadly inline: explain, clarify scope, or suggest a smaller split. Plain questions need no task.
[/workflow-state:no_task]

<!-- Per-turn breadcrumb: shown when the active task record cannot be read. -->

[workflow-state:task_error]
The active task record could not be read. Do not create or activate another task.
Inspect the task directory named above and repair its task.json. It must be a valid JSON object with a non-empty status.
Preserve existing task fields and artifacts. If the correct status cannot be determined safely, ask the user before reconstructing the record.
[/workflow-state:task_error]

### Phase 1: Plan
- 1.0 Create task `[required · once]` (only after task-creation consent; pass `--tier <t>`)
- 1.1 Requirement exploration `[required · repeatable]` (`prd.md`; depth scaled by tier)
- 1.2 Explore & design `[repeatable]` (explore as needed → one question list → standard: write `design.md`; full: 3 architect roles → user picks → `design.md` + `implement.md`)
- 1.3 Configure context `[required · once]` (`task.py seed-context`, then adjust `implement.jsonl` + `check.jsonl`)
- 1.4 Activate task `[required · once]` (final planning summary → user approval → `task.py start`; status → in_progress)
- 1.5 Completion criteria

<!-- Per-turn breadcrumb: shown throughout Phase 1 (status='planning'), every tier -->

[workflow-state:planning]
Load `arbor-brainstorm`; stay in planning. The tier is in the header; pin or change it with `task.py set-meta <task> tier <tier>`.
Artifacts `task.py start` requires: light = `prd.md`; standard = `prd.md` + `design.md`; full = `prd.md` + `design.md` + `implement.md`. Light: goal, scope and testable acceptance criteria; ask only when a product decision is truly open.
Explore & design (1.2): read a few files yourself when that answers it; otherwise dispatch `explore` roles, one aspect each, in parallel (any tier, count by need); from their essential-file lists read only the 2-3 files you need to write the next brief (their `research/*.md` is injected into architect and implement); then ask all open questions as ONE numbered list (recommendation + trade-off each) and wait. Standard: write `design.md` yourself (one `architect` with `Perspective: pragmatic` only if unfamiliar or asked). Full: 3 `architect` roles (minimal-change / clean-architecture / pragmatic), present trade-offs and your recommendation, and after the user picks write `design.md` + `implement.md` (file ownership, waves).
Context (1.3, required): `task.py seed-context <task>` fills `implement.jsonl` + `check.jsonl` (spec indexes, guides, research); then add or drop entries per side.
Multi-deliverable scope: consider a parent task plus independently verifiable child tasks (`task.py create --parent`); dependencies must be written in child artifacts, not implied by tree position. Parallel worktrees (`task.py set-meta <task> execution parallel`) only for full tasks whose `implement.md` has waves.
Activate (1.4): end the final planning summary with the start question; run `task.py start` only after a later user message approves it.
[/workflow-state:planning]

### Phase 2: Execute
- 2.1 Implement `[required · repeatable]` (snapshot S0, then dispatch the implement role)
- 2.2 Gate review `[required · repeatable]` (one review `Mode: self-check` on the diff since S0, then fix; re-review the fix delta only; light at most 2 rounds, standard / full at most 1)
- 2.3 Rollback `[on demand]`
- Phase 2P replaces 2.1–2.2 when `meta.execution=parallel` (tier full): 2P.0 Split · 2P.1 Worktrees · 2P.2 Implement · 2P.3 Gate review + commit · 2P.4 Merge · 2P.5 Cleanup

### Phase 2F: Polish (standard and full; light runs only 2F.5)
- 2F.1 Simplify `[required · once; standard / full]` (simplify the whole diff; no separate review; run the checks)
- 2F.2 Final review `[required · once; standard / full]` (standard: 3 × review candidates → dedup → verify; full: 5 × plus sweep → verify)
- 2F.3 Decide `[on demand]` (CONFIRMED findings are fixed without asking; ask once only about PLAUSIBLE ones)
- 2F.4 Fix `[on demand]` (fix the findings, review the fix delta, at most 2 rounds)
- 2F.5 Quality checks `[required · once]` (run every affected package's Quality Check commands yourself; every tier)

<!-- Per-turn breadcrumb: fallback only. Shown while status='in_progress' when no
     block exists for the task's tier (for example a customised workflow.md that
     predates tiers). The tier blocks below are the normal path. -->

[workflow-state:in_progress]
No block for this task's tier was found. Set the tier (`task.py set-meta <task> tier light|standard|full`) and follow that tier's Phase 2 / 2F steps in `.arbor/workflow.md`; every tier runs the 2F.5 quality checks, `arbor-update-spec` (3.3, required) and a batched commit (3.4, required; no amend, no push) before `/arbor:finish-work`.
Sub-agent self-exemption: if you are already a dispatched sub-agent (your prompt starts with `Active task:` / `Role:`), perform that role directly; do not dispatch, commit, or call task.py start/current/finish. Dispatch is main session only.
[/workflow-state:in_progress]

<!-- Per-turn breadcrumb: shown while status='in_progress' for tier light.
     Scope: Phase 2 + 2F.5 + Phase 3.2-3.4 (status stays 'in_progress' from
     task.py start until task.py archive; only archive flips it). The body
     must cover every required step from implementation through commit. -->

[workflow-state:in_progress-light]
Tier light. Roles run as codeg assistants only: `delegate_to_agent(assistant_id=<from the <dispatch> context or dispatch.py resolve>, working_dir=<repo root>, task=<header + brief>)` + `get_delegation_status`, or `python3 ./.arbor/scripts/dispatch.py run --role <role> --wait`; the task text starts with `Active task: <absolute task dir>` then `Role: <role>` (review adds `Mode:`; review/verify/fix/simplify add `Diff:`); never the built-in Agent/Task tool.
Flow: `dispatch.py snapshot` -> S0, implement (2.1) -> gate review (2.2): `dispatch.py diff $S0 --name gate`, 1 review `Mode: self-check` with `Angles: A, B, C, D, E, Conventions, Acceptance, Cleanup-lite` (the only review for light) -> fix -> review self-check of the fix delta; at most 2 rounds, then stop and report to the user.
No simplify and no final review: run each affected package's Quality Check commands yourself (2F.5).
Then `arbor-update-spec` (3.3, required) -> batched commit (3.4, required; no amend, no push) -> `/arbor:finish-work`.
Sub-agent self-exemption: if you are already a dispatched sub-agent (your prompt starts with `Active task:` / `Role:`), perform that role directly; do not dispatch, commit, or call task.py start/current/finish. Dispatch is main session only.
[/workflow-state:in_progress-light]

<!-- Per-turn breadcrumb: shown while status='in_progress' for tier standard.
     Scope: Phase 2 + Phase 2F + Phase 3.2-3.4. -->

[workflow-state:in_progress-standard]
Tier standard. Roles run as codeg assistants only: `delegate_to_agent(assistant_id=<from the <dispatch> context or dispatch.py resolve>, working_dir=<repo root>, task=<header + brief>)` + `get_delegation_status`, or `python3 ./.arbor/scripts/dispatch.py run --role <role> --wait`; the task text starts with `Active task: <absolute task dir>` then `Role: <role>` (review adds `Mode:`; review/verify/fix/simplify add `Diff:`); never the built-in Agent/Task tool.
Flow: `dispatch.py snapshot` -> S0, implement (2.1) -> gate review (2.2): `dispatch.py diff $S0 --name gate`, 1 review `Mode: self-check` with `Angles: A, B, Acceptance` -> fix -> re-review the fix delta; at most 1 round.
Polish (2F): simplify on `dispatch.py diff $S0 --name whole`, no separate review; run the project checks, red -> fix (2F.1) -> final review on `dispatch.py diff $S0 --name final`: 3 reviews `Mode: candidates` (A+D / B+Conventions / C+E+Acceptance) -> dedup -> verify, at most 8 candidates per run, in parallel (2F.2) -> CONFIRMED findings are fixed without asking; ask the user once only about PLAUSIBLE ones (2F.3) -> fix + review self-check of the fix delta, at most 2 rounds (2F.4) -> run each affected package's Quality Check commands yourself (2F.5).
Then `arbor-update-spec` (3.3, required) -> batched commit (3.4, required; no amend, no push) -> `/arbor:finish-work`.
Sub-agent self-exemption: if you are already a dispatched sub-agent (your prompt starts with `Active task:` / `Role:`), perform that role directly; do not dispatch, commit, or call task.py start/current/finish. Dispatch is main session only.
[/workflow-state:in_progress-standard]

<!-- Per-turn breadcrumb: shown while status='in_progress' for tier full, serial
     execution. Scope: Phase 2 + Phase 2F + Phase 3.2-3.4. -->

[workflow-state:in_progress-full]
Tier full. Roles run as codeg assistants only: `delegate_to_agent(assistant_id=<from the <dispatch> context or dispatch.py resolve>, working_dir=<repo root>, task=<header + brief>)` + `get_delegation_status`, or `python3 ./.arbor/scripts/dispatch.py run --role <role> --wait`; the task text starts with `Active task: <absolute task dir>` then `Role: <role>` (review adds `Mode:`; review/verify/fix/simplify add `Diff:`); never the built-in Agent/Task tool.
Flow: as standard for 2.1 and 2.2: `dispatch.py snapshot` -> S0, implement, gate review `Mode: self-check` with `Angles: A, B, Acceptance` on `dispatch.py diff $S0 --name gate`, at most 1 fix round.
Polish (2F): simplify the whole diff, no separate review; project checks, red -> fix (2F.1) -> final review on `dispatch.py diff $S0 --name final`: 5 reviews `Mode: candidates` (A / B / C / D+E / Conventions+Acceptance) -> dedup -> verify (at most 8 per run, in parallel) -> 1 review `Mode: sweep` with the verified list -> verify its new candidates (2F.2) -> CONFIRMED: fix without asking; ask once only about PLAUSIBLE (2F.3) -> fix + review self-check of the fix delta, at most 2 rounds (2F.4) -> run each affected package's Quality Check commands yourself (2F.5).
Then `arbor-update-spec` (3.3, required) -> batched commit (3.4, required; no amend, no push) -> `/arbor:finish-work`.
Sub-agent self-exemption: if you are already a dispatched sub-agent (your prompt starts with `Active task:` / `Role:`), perform that role directly; do not dispatch, commit, or call task.py start/current/finish. Dispatch is main session only.
[/workflow-state:in_progress-full]

<!-- Per-turn breadcrumb: shown while status='in_progress', tier full, and the
     task has meta.execution=parallel. Same scope as in_progress-full but for
     Phase 2P. -->

[workflow-state:in_progress-parallel]
Tier full, parallel execution (meta.execution=parallel). Same dispatch rules as serial (codeg assistants only, header `Active task:` + `Role:`, never the built-in Agent/Task tool), plus Phase 2P:
Each child task gets its own worktree (`git worktree add <WT_ROOT>/<parent>-<child> -b wip/<parent>/<child> <task-branch>`, 2P.1). Dispatch up to dispatch.max_parallel implement roles at once (2P.2) with `working_dir=<worktree>` and header `Active task: <absolute child dir in the MAIN checkout>`, `Role: implement`, `Workspace: <worktree>`.
Run the 2.2 gate review in every worktree, all children in the same batch (1 review `Mode: self-check`, `Angles: A, B, Acceptance`, diffs via `dispatch.py diff <task-branch> -C <worktree>`, at most 1 fix round), and commit each green child yourself in its worktree (2P.3); merge serially with `git merge --no-ff` into the task branch and run the checks after each merge (2P.4); remove the worktrees (2P.5).
Then the full-tier Phase 2F on the merged tree for the parent task (diff base = the task branch's starting commit): simplify (2F.1) -> 5 candidates + sweep -> verify (2F.2) -> ask only about PLAUSIBLE (2F.3) -> fix (2F.4) -> Quality Check commands (2F.5). Then `arbor-update-spec` (3.3, required) -> batched commit (3.4, required; no amend, no push) -> `/arbor:finish-work` (archives parent and children).
Sub-agent self-exemption: if you are already a dispatched sub-agent, perform your role in your worktree only; never merge, commit, or dispatch.
[/workflow-state:in_progress-parallel]

### Phase 3: Finish
- 3.2 Debug retrospective `[on demand]`
- 3.3 Spec update `[required · once]`
- 3.4 Commit changes `[required · once]`
- 3.5 Wrap-up reminder

> Note: step 3.1 was folded into Phase 2F (final review + quality checks) and 3.4 (commit preamble). Numbering kept stable to avoid breaking external references.

<!-- Per-turn breadcrumb: shown while status='completed'.
     Currently DEAD in normal flow: cmd_archive writes status='completed' in
     the same call that moves the task dir to archive/, so the active-task
     resolver loses the pointer and the hook never fires on archived tasks.
     Block preserved for a future status-transition redesign (e.g. an
     explicit in_progress→completed command). Edit through the same spec
     channel as the live blocks. -->

[workflow-state:completed]
Code committed. Run `/arbor:finish-work`; if dirty, return to Phase 3.4 first.
[/workflow-state:completed]

### Rules

1. Identify which Phase you're in, then continue from the next step there
2. Run steps in order inside each Phase; `[required]` steps can't be skipped
3. Phases can roll back (e.g., Execute reveals a prd defect → return to Plan to fix, then re-enter Execute)
4. Steps tagged `[once]` are skipped if the output already exists; don't re-run
5. The tier decides which artifacts and steps are required; a missing `design.md` / `implement.md` is valid for light and incomplete planning for standard / full.

### Active Task Routing

When a user request matches one of these intents inside an active task, route first, then load the detailed phase step if needed.

- Planning or unclear requirements -> `arbor-brainstorm`.
- Questions about existing code or external libraries -> read the files yourself, or dispatch `explore` (1.2), any phase.
- `in_progress` implementation / review -> dispatch implement, then the 2.2 gate review (codeg `delegate_to_agent`, or `dispatch.py run`); standard / full continue with Phase 2F; with `meta.execution=parallel` (tier full) follow Phase 2P.
- Repeated debugging -> `arbor-break-loop`; spec updates -> `arbor-update-spec`.

### Guardrails

- Task creation approval is not implementation approval; implementation waits for `task.py start` after the final planning summary is approved.
- Required artifacts follow the tier: light = `prd.md`; standard adds `design.md`; full adds `implement.md`. `task.py start` checks them.
- Planning must be persisted to task artifacts; checks must run before reporting completion.
- Inside an Arbor task, never perform the explore / architect / implement / review / verify / fix / simplify roles in the main session or through the built-in Agent/Task tool; dispatch them (see Dispatch). The no-task quick path is the only exception.
- Review ⇄ fix loops stop at their round limit (2.2: light 2, standard / full 1; 2F.4: 2); report what remains instead of re-dispatching indefinitely.

### Loading Step Detail

At each step, run this to fetch detailed guidance:

```bash
python3 ./.arbor/scripts/get_context.py --mode phase --step <step>
# e.g. python3 ./.arbor/scripts/get_context.py --mode phase --step 1.1
```

---

## Phase 1: Plan

Goal: classify the request, pick the tier, get task-creation consent when a task is needed, and produce the planning artifacts the tier requires before implementation.

#### 1.0 Create task `[required · once]`

Create the task directory only after task-creation consent (a `/arbor:workflow <target> <request>` call counts). The command sets status to `planning`, writes `task.json`, creates a default `prd.md`, and auto-targets the new task when session identity is available:

```bash
python3 ./.arbor/scripts/task.py create "<task title>" --description "<one-line summary>" --slug <name> --tier <light|standard|full>
```

Both the title and `--description` must be non-empty — `create` rejects blanks, and a record with either one empty is refused at archive. `--slug` is the human-readable name only. Do **not** include the `MM-DD-` date prefix; `task.py create` adds that prefix automatically.

`--tier` pins the tier the user agreed to (`--meta tier=<t>` is the same thing). Without it the tier is inferred from the artifacts as planning progresses (`design.md` → standard, `implement.md` → full); change it any time with `python3 ./.arbor/scripts/task.py set-meta <task-dir> tier <t>`. The per-turn breadcrumb header shows the current tier.

For task trees, create the parent task first and then create each child with `--parent <parent-dir>`. Do not start the parent just because children exist; start the child that owns the next independently verifiable deliverable.

After this command succeeds, the per-turn breadcrumb auto-switches to the planning block, telling the AI to stay in planning.

Run only `create` here — do not also run `start`. `start` flips status to `in_progress`, which switches the breadcrumb to the implementation phase before planning artifacts are reviewed. Save `start` for step 1.4.

Skip when `python3 ./.arbor/scripts/task.py current --source` already points to a task.

#### 1.1 Requirement exploration `[required · repeatable]`

Load the `arbor-brainstorm` skill and explore requirements with the user per the skill's guidance. The depth scales with the tier:

- **Light**: write the goal, the scope boundary and testable acceptance criteria into `prd.md`. Ask only when a product decision is truly open; skip the first-principles analysis and the PRD convergence pass.
- **Standard / full**: the full skill: evidence first, the requirement convergence gate, the PRD convergence pass, and `design.md` (+ `implement.md` for full) before implementation starts.

The brainstorm skill will guide you to:
- Inspect the repository before asking; ask open questions as one numbered list, each with your recommendation
- Prefer offering options over open-ended questions
- Update `prd.md` immediately after each user answer
- Split large scopes into a parent task plus child tasks when the deliverables can be verified independently
- Keep `prd.md` focused on requirements and acceptance criteria
- For standard and full tasks, produce `design.md` (and for full, `implement.md`) before implementation starts

When considering a parent/child split:
- Use a parent task when one request contains several independently verifiable deliverables.
- Parent tasks own source requirements, child-task mapping, cross-child acceptance criteria, and final integration review.
- Child tasks own actual deliverables that can be planned, implemented, checked, and archived independently.
- Parent/child structure is not a dependency system. If child B depends on child A, write that ordering in child B's `prd.md` / `implement.md`.
- Start the child task that owns the next deliverable. Do not start the parent unless the parent itself has direct implementation work.

Return to this step whenever requirements change and revise the relevant artifact.

#### 1.2 Explore & design `[repeatable]`

Facts first, then questions, then design. Follows Claude Code's feature-dev flow (discover → explore → clarify → architect), scaled by tier.

**a. Explore** (as needed, any tier). Small questions you can answer by reading a few files yourself: do that, write the finding into `{TASK_DIR}/research/` if it matters later, and move on. Otherwise dispatch **explore** roles, one aspect each, in parallel; the task decides how many, not the tier:

- Header: `Active task: <absolute task dir>` then `Role: explore`
- Brief examples: "find features similar to <feature> and trace their implementation end to end"; "map the architecture and abstractions of <area>"; "find the test setup, UI patterns, or extension points relevant to <feature>"; "fetch <library>@<version> and document the APIs we need" (external)
- Each writes `research/<topic>.md` and returns 5-10 **essential files**.

When they return, read only the 2-3 files you need to write the next brief or the design. Do not re-read every essential file: `research/*.md` is injected into architect and implement by the dispatch hook, and those roles read the code themselves.

**b. Clarify** (do not skip). Compare the findings with the requirements and list what is still open: product intent, scope boundaries, edge cases, error handling, integration points, backward compatibility, performance, design preferences. Put every open question to the user **as one numbered list**, each with the decision needed, why it matters, your recommendation and the trade-off, and wait for the answers in one round; fold them into `prd.md`. Follow up only on new decisions the answers raise. If the user says "your call", give your recommendation and get explicit confirmation.

**c. Design**.

- **Light**: nothing to write; the existing patterns are the design.
- **Standard**: write `design.md` yourself from what you read (boundaries, contracts, data flow, trade-offs, compatibility). Dispatch one **architect** (`Perspective: pragmatic`) only when the area is unfamiliar or the user asks for a second opinion; it writes `research/design-pragmatic.md` and you fold it into `design.md`.
- **Full**: dispatch 3 **architect** roles in parallel, one perspective each:
  - Header: `Active task: <absolute task dir>` then `Role: architect`
  - Brief: `Perspective: minimal-change` / `clean-architecture` / `pragmatic`, plus the clarified decisions and the essential files.
  - Each writes `research/design-<perspective>.md` with a parallel-split suggestion.

  Then present to the user: a short summary of each design, the trade-offs, concrete differences, **your recommendation and why**, and the proposed split (children, owned files, interface contracts, waves). **Do not start implementation without the user's explicit choice.** Write the chosen design into `design.md` and the execution plan (ordered checklist, validation commands, file ownership, waves) into `implement.md`.

**Research artifact conventions**:
- One file per topic (e.g. `research/auth-library-comparison.md`); architect blueprints are `research/design-<perspective>.md`
- Record third-party usage examples, API references, and version constraints in files
- Note relevant spec file paths you discovered for later reference

Brainstorm (1.1) and 1.2 interleave freely. **Key principle**: research and design output must be written to files, not left only in the chat. Conversations get compacted; files don't.

#### 1.3 Configure context `[required · once]`

`implement.jsonl` and `check.jsonl` tell the dispatch hook which spec and research files to inline into the assistants (`implement.jsonl` → architect, implement; `check.jsonl` → review, verify, fix, simplify). The hook inlines exactly the files listed here; an empty manifest means the assistant runs with no spec. Seed them, then adjust:

```bash
python3 ./.arbor/scripts/task.py seed-context "$TASK_DIR" [--package <pkg> ...]
```

`seed-context` writes the chosen packages' spec layer `index.md` files, `.arbor/spec/guides/index.md`, and every `{TASK_DIR}/research/*.md` into **both** manifests (idempotent; the package defaults to the task's `package`). Then:

- **Add** specific guideline files the task touches (`error-handling.md`, `conventions.md`, ...) with `python3 ./.arbor/scripts/task.py add-context "$TASK_DIR" implement|check "<path>" "<reason>"`.
- **Drop** lines that do not apply to a side: `implement.jsonl` carries what the implement role needs to write code correctly; `check.jsonl` carries the review side (quality guidelines, conventions the Conventions angle checks).
- **Never add** code files (`src/**`, `packages/**/*.ts`, ...) or files you are about to modify; the assistants read those themselves.

**Format**: one JSON object per line — `{"file": "<path>", "reason": "<why>"}`. Paths are repo-root relative. `python3 ./.arbor/scripts/get_context.py --mode packages` lists every package and its spec layers. These manifests do not replace `implement.md`.

Ready gate: both `implement.jsonl` and `check.jsonl` must contain at least one real `{"file": "...", "reason": "..."}` entry before `task.py start`. The seed `_example` row alone is not ready. For a parallel parent task, curate the manifests of every child task too (children may start from a copy of the parent's).

Skip this step only when both files already have real curated entries.

#### 1.4 Activate task `[required · once]`

One gate. End the final planning summary (Goal, In Scope, Out of Scope, Acceptance Criteria, Key Decisions, Risks or Deferred Items, artifact status, tier) with the question whether to start. Only a later user message that explicitly approves that summary authorizes `task.py start`; task-creation consent and the original request do not.

**Full tier only — decide the execution mode** before start:

- **serial** (default): implement → gate review in the main checkout (Phase 2.1–2.2).
- **parallel**: choose it only when `implement.md` splits the work into child tasks that touch disjoint files and can be verified independently (the chosen architect's parallel split is the starting point). Mark the parent, then follow Phase 2P:

  ```bash
  python3 ./.arbor/scripts/task.py set-meta <parent-dir> execution parallel
  ```

  This stores `meta.execution = "parallel"` in the parent's `task.json`; the breadcrumb key becomes `in_progress-parallel` after `task.py start`. `start` refuses `execution=parallel` on a task whose tier is not full. Child tasks are created in 2P.0 (or earlier, in planning, with `task.py create --parent`).

After approval, flip the task status to `in_progress`:

```bash
python3 ./.arbor/scripts/task.py start <task-dir>
```

`start` checks the tier's artifacts: light needs `prd.md`; standard needs `prd.md` + `design.md`; full needs `prd.md` + `design.md` + `implement.md`. A missing file stops the start and names it; write it or change the tier with `set-meta`. `implement.jsonl` and `check.jsonl` must both have real curated entries before start. Runtime consumers tolerate missing or seed-only manifests for compatibility, but that tolerance is not a planning-ready state.

After this command succeeds, the breadcrumb auto-switches to the tier's `in_progress-<tier>` block (or `in_progress-parallel`), and the rest of Phase 2 / 2F / 3 follows.

If `task.py start` errors with a session-identity message (no context key from hook input or `ARBOR_CONTEXT_ID`), follow the hint in the error to set up session identity, then retry.

#### 1.5 Completion criteria

| Condition | light | standard | full |
|------|:---:|:---:|:---:|
| `prd.md` exists with testable acceptance criteria | ✅ | ✅ | ✅ |
| Open questions were put to the user as one list and answered | ✅ | ✅ | ✅ |
| User approved the final planning summary in a later message | ✅ | ✅ | ✅ |
| `design.md` exists | — | ✅ | ✅ |
| User chose one architect design; `implement.md` exists (ownership, waves) | — | — | ✅ |
| `implement.jsonl` and `check.jsonl` each contain at least one real curated entry (seed row does not count) | ✅ | ✅ | ✅ |
| Execution mode chosen; `meta.execution=parallel` set when parallel | — | — | ✅ |
| `task.py start` has been run (status = in_progress) | ✅ | ✅ | ✅ |

---

## Phase 2: Execute

Goal: turn reviewed planning artifacts into code that passes one gate review. Dispatch mechanics (header protocol, the two paths, snapshots, target selection) are in the Dispatch subsection of the Arbor System section. Serial mode uses 2.1–2.3 below; parallel mode (`meta.execution=parallel`, full tier) uses Phase 2P instead. Standard and full tasks continue with Phase 2F afterwards; light tasks go straight to 2F.5.

#### 2.1 Implement `[required · repeatable]`

First record the starting point: `S0=$(python3 ./.arbor/scripts/dispatch.py snapshot)`. Every later diff of this task is taken against S0.

Dispatch the **implement** role. With codeg: `delegate_to_agent(assistant_id=<id from <dispatch> or dispatch.py resolve>, working_dir=<repo root>, task=<header + brief>)`, then `get_delegation_status(task_ids, wait_ms=60000)` until terminal. Without codeg: `python3 ./.arbor/scripts/dispatch.py run --role implement --wait`. The hook (or `dispatch.py`) inlines the jsonl entries, `prd.md`, `design.md` if present, and `implement.md` if present. The task text MUST begin with the header block:

```
Active task: <absolute task dir>
Role: implement
```

- **Brief** (after the header): the essential files to read first, the part of the chosen design this run covers, anything the artifacts do not say (known pitfalls, files to avoid), and the lint / typecheck / test commands.
- **Dispatch prompt guard**: the assistant's own instructions already say it is the `implement` role and must not dispatch; keep the brief free of instructions to delegate or to spawn another role.
- On completion, read the report (status, files modified, verification, deviations) and skim `git diff --stat`. The assistant does not commit. Partial or Blocked: add the missing information and re-dispatch, or return to Phase 1.

#### 2.2 Gate review `[required · repeatable]`

One self-checking review of the implementation, then a short fix loop. For light tasks this is the only review; for standard and full it is a gate (is the direction right, is anything obviously broken, are the acceptance criteria met) before the final review in Phase 2F.

1. **Scope**: `python3 ./.arbor/scripts/dispatch.py diff $S0 --name gate` writes the diff and prints its path; stderr shows the changed-line count.
2. **Review**: one **review** with `Mode: self-check` and `Diff: <path>`; the brief carries the task goal and the acceptance criteria plus the angles:
   - **Light**: `Angles: A, B, C, D, E, Conventions, Acceptance, Cleanup-lite`
   - **Standard / full**: `Angles: A, B, Acceptance`
3. **Fix**: when CONFIRMED or PLAUSIBLE findings remain, snapshot first (`F0=$(dispatch.py snapshot)`) and dispatch **fix** with `Diff:` and the findings JSON.
4. **Re-review**: `dispatch.py diff $F0 --name gate-fix` and one **review** `Mode: self-check` on that fix delta only. Round limit: **light 2**, **standard / full 1**; still FAIL after that: stop and report to the user (standard / full may also carry the leftovers into 2F.2).

Findings you judge invalid may stay unfixed; record them and list them in the final summary. Light tasks continue with 2F.5; standard and full with 2F.1.

#### 2.3 Rollback `[on demand]`

- Review reveals a prd defect → return to Phase 1, fix `prd.md`, then redo 2.1
- Implementation went wrong → revert code, redo 2.1
- Need more facts → dispatch the explore role (same as Phase 1.2), write findings into `research/`
- A dispatch failed, timed out, or returned nothing useful → read its result, tighten the brief, and re-dispatch (optionally with a different `Target:`). Network or rate-limit errors: lower the parallelism and retry. Do not silently do the role's work in the main session.
- Any step stuck after 2 retries: stop and report; do not retry indefinitely.

---

## Phase 2P: Execute (parallel variant)

Applies only when the parent task has `meta.execution=parallel` (full tier; `task.py start` enforces it). Goal: implement independent child tasks concurrently, each in its own git worktree, then merge serially. Use it instead of 2.1–2.2; Phase 2F and Phase 3 run on the parent task afterwards.

Invariants: sub-agents never commit, merge, or touch paths outside their worktree, and never write under `.arbor/`. The `Active task:` header line is **always** the absolute path of the task directory in the MAIN checkout, even when `working_dir` is a worktree (the `.arbor/tasks` copy inside a worktree is read-only noise). Runtime state (`.arbor/.runtime`, `.arbor/.developer`) is resolved from the main checkout only.

#### 2P.0 Split `[required · repeatable]`

Start from the chosen architect's parallel split. Write the waves and file ownership into the parent `implement.md`: which child owns which files, the interface contracts between children, and which children must wait for others. Children in the same wave must not modify the same file. Create each child:

```bash
python3 ./.arbor/scripts/task.py create "<title>" --description "<one-line summary>" --slug <name> --parent <parent-dir>
```

Give each child its own `prd.md` and run `task.py seed-context <child-dir>` for its `implement.jsonl` / `check.jsonl` (copying the parent's is also fine).

#### 2P.1 Worktrees `[required · repeatable]`

One worktree and branch per child. Keep worktrees outside the repo:

```bash
REPO=$(git rev-parse --show-toplevel)
WT_ROOT="$(dirname "$REPO")/$(basename "$REPO")-wt"
git worktree add "$WT_ROOT/<parent>-<child>" -b "wip/<parent>/<child>" <task-branch>
```

#### 2P.2 Implement `[required · repeatable]`

Dispatch up to `dispatch.max_parallel` implement roles at once (more children → next wave). Each header:

```
Active task: <absolute child task dir in the MAIN checkout>
Role: implement
Workspace: <absolute worktree path>
```

with `working_dir=<worktree path>`; the brief carries the child's part of the design, its owned files, and the interface contracts. Collect all `task_id`s and wait with `get_delegation_status(task_ids, wait_ms=60000)`; in a terminal use `dispatch.py run --role implement --task <child-dir> --workspace <worktree> --detach` then `dispatch.py wait`. Handle failures as in 2.3, per child.

#### 2P.3 Gate review + commit `[required · repeatable]`

Run the 2.2 gate review in every worktree, all children in the same batch (one review `Mode: self-check`, `Angles: A, B, Acceptance`, at most 1 fix round): scope with `dispatch.py diff <task-branch> -C <worktree> --name <child>-gate`, `working_dir` = the worktree, `Active task` = that child, `Workspace` = its worktree. Also check that the child touched only its owned files. When a child is green, commit it yourself inside its worktree: `git -C <worktree> add -A && git -C <worktree> commit -m "<msg>"`.

#### 2P.4 Merge `[required · repeatable]`

In the main checkout, on the task branch, merge children serially: `git merge --no-ff wip/<parent>/<child>`. Resolve conflicts yourself after understanding both sides. Run the project checks after each merge; small breakage you fix yourself, larger breakage goes to a fix dispatch. More waves: return to 2P.1 with worktrees based on the merged task branch.

#### 2P.5 Cleanup `[required · repeatable]`

```bash
git worktree remove "$WT_ROOT/<parent>-<child>"
git branch -d "wip/<parent>/<child>"
```

for every merged child. Then continue with the full-tier Phase 2F on the parent task (diff base = the task branch's starting commit), and Phase 3. `/arbor:finish-work` archives the parent and its children.

---

## Phase 2F: Polish

Goal: code that is simple, free of duplication, correct, and meets every acceptance criterion. Runs for standard and full tasks after Phase 2 or 2P; light tasks run only 2F.5. Follows Claude Code's `/simplify` and `/code-review` (find → verify → fix; full adds the sweep). `S0` is the snapshot from 2.1, or the task branch's starting commit after 2P.

#### 2F.1 Simplify `[required · once; standard / full]`

Snapshot first (`P0=$(dispatch.py snapshot)`), then `dispatch.py diff $S0 --name whole` and dispatch **simplify** with `Diff:` set to it. No separate review of its delta: the final review in 2F.2 covers the simplified diff. Run the project's lint / typecheck / tests yourself afterwards; if they go red, dispatch **fix** with `dispatch.py diff $P0 --name simplify-fix`.

#### 2F.2 Final review `[required · once; standard / full]`

On the whole diff (`dispatch.py diff $S0 --name final`):

1. **Find**, `Mode: candidates`, in parallel:
   - **Standard**: three **review** roles, angles `A, D` / `B, Conventions` / `C, E, Acceptance`.
   - **Full**: five **review** roles, angles `A` / `B` / `C` / `D, E` / `Conventions, Acceptance`.
2. **Dedup**: merge all JSON findings; one entry per line or mechanism, keeping the most concrete failure scenario.
3. **Verify**: dispatch **verify** with the same `Diff:` and the deduplicated candidates as JSON in the brief, at most 8 candidates per run, runs in parallel. Keep CONFIRMED and PLAUSIBLE.
4. **Sweep** (full only): one **review** `Mode: sweep` with the verified list in the brief; send its new candidates through **verify** too.

#### 2F.3 Decide `[on demand]`

CONFIRMED findings are fixed without asking. Only when PLAUSIBLE findings survive, present them once, most severe first, each with your recommendation and reasoning, and ask: fix now, fix later, or leave as is. The CONFIRMED list is shown alongside for information. No surviving findings: go straight to 2F.5.

#### 2F.4 Fix `[on demand]`

Snapshot (`F0`), dispatch **fix** with `Diff:` and the findings JSON (CONFIRMED plus the PLAUSIBLE ones the user chose), then `dispatch.py diff $F0 --name final-fix` and one **review** `Mode: self-check` on the fix delta. At most **2 rounds**; still FAIL after that: stop and report to the user.

#### 2F.5 Quality checks `[required · once]`

Every tier. Run every affected package's spec Quality Check commands yourself (`python3 ./.arbor/scripts/get_context.py --mode packages` lists the packages and their spec indexes). Light tasks run this right after 2.2. Failures go back to a fix dispatch.

---

## Phase 3: Finish

Goal: ensure code quality, capture lessons, record the work.

#### 3.2 Debug retrospective `[on demand]`

If this task involved repeated debugging (the same issue was fixed multiple times), load the `arbor-break-loop` skill to:
- Classify the root cause
- Explain why earlier fixes failed
- Propose prevention

The goal is to capture debugging lessons so the same class of issue doesn't recur.

#### 3.3 Spec update `[required · once]`

Load the `arbor-update-spec` skill and review whether this task produced new knowledge worth recording:
- Newly discovered patterns or conventions
- Pitfalls you hit
- New technical decisions

Update the docs under `.arbor/spec/` accordingly. Even if the conclusion is "nothing to update", walk through the judgment.

After editing a spec doc, stamp it as re-checked: `python3 ./.arbor/scripts/spec.py verify <doc>`. Run `python3 ./.arbor/scripts/spec.py lint` to see stale, broken, or unlisted spec docs — advisory, it never blocks.

#### 3.4 Commit changes `[required · once]`

**Spec-sync preamble**: before drafting commits, ask: did this task fix a bug or surface non-obvious knowledge that should land in `.arbor/spec/` so future-you (or future-AI) doesn't repeat the mistake? If yes, return to Phase 3.3 first — spec writes belong in the same task's commit batch, not as a forgotten follow-up.

The AI drives a batched commit of this task's code changes so `/finish-work` can run cleanly afterwards. Goal: produce work commits FIRST, then bookkeeping (archive + journal) commits land after — never interleaved.

**Step-by-step**:

1. **Inspect dirty state** (parallel tasks: the children were already committed in their worktrees and merged; only parent-level changes such as spec updates remain):
   ```bash
   git status --porcelain
   ```
   Snapshot every dirty path. If the working tree is clean, skip to 3.5.

2. **Learn commit style** from recent history (so drafted messages blend in):
   ```bash
   git log --oneline -5
   ```
   Note the prefix convention (`feat:` / `fix:` / `chore:` / `docs:` ...), language (中文/English), and length style.

3. **Classify dirty files into two groups**:
   - **AI-edited this session** — files you wrote/edited via Edit/Write/Bash tool calls in this session. You know what changed and why.
   - **Unrecognized** — dirty files you did NOT touch this session (could be the user's manual edits, leftover WIP from a previous session, or unrelated work). Do NOT silently include these.

4. **Draft a commit plan**. Group AI-edited files into logical commits (1 commit per coherent change unit, not 1 commit per file). Each entry: `<commit message>` + file list. List unrecognized files separately at the bottom.

5. **Present the plan once, ask for one-shot confirmation**. Format:
   ```
   Proposed commits (in order):
     1. <message>
        - <file>
        - <file>
     2. <message>
        - <file>

   Unrecognized dirty files (NOT in any commit — confirm include/exclude):
     - <file>
     - <file>

   Reply 'ok' / '行' to execute. Reply with edits, or '我自己来' / 'manual' to abort.
   ```

6. **On confirmation**: run `git add <files>` + `git commit -m "<msg>"` for each batch in order. Do not amend. Do not push.

7. **On rejection** (user replies "不行" / "我自己来" / "manual" / any pushback on the plan): stop. Do not attempt a second plan. The user will commit by hand; you skip ahead to 3.5 once they confirm.

**Rules**:
- No `git commit --amend` anywhere — three-stage three-commit flow (work commits → archive commit → journal commit).
- Never push to remote in this step.
- If the user wants different message wording but accepts the file grouping, edit the message and re-confirm once — but if they reject the grouping, exit to manual mode.
- The batched plan is one prompt; do not prompt per commit.

#### 3.5 Wrap-up reminder

After the above, remind the user they can run `/finish-work` to wrap up (archive the task, record the session).

---

## Customizing Arbor (for forks)

This section is for developers who want to modify the Arbor workflow itself. All customization is done by editing this file; the scripts are parsers only.

### Changing what a step means

Edit the corresponding step's walkthrough body in the Phase 1 / 2 / 2F / 3 sections above. Critical invariants:
- No active task must classify first: quick work is done without a task; anything larger proposes a tier and asks for task-creation consent before creating an Arbor task.
- Planning must require the tier's artifacts before start: light = `prd.md`; standard adds `design.md`; full adds `implement.md`.
- Every required execution path must keep the Phase 3.4 commit reminder reachable before `/arbor:finish-work`.

All tag blocks live in the `## Phase Index` section above, immediately after each phase summary:

| Scope | Corresponding tag |
|---|---|
| No active task (before Phase 1) | `[workflow-state:no_task]` (after the Parent / Child section) |
| Active task record unreadable | `[workflow-state:task_error]` (repair the existing task before continuing) |
| All of Phase 1 (task created → ready for implementation), every tier | `[workflow-state:planning]` (after Phase 1 summary) |
| Phase 2 + 2F.5 + Phase 3.2–3.4, tier light | `[workflow-state:in_progress-light]` (after Phase 2F summary) |
| Phase 2 + 2F + Phase 3.2–3.4, tier standard | `[workflow-state:in_progress-standard]` |
| Phase 2 + 2F + Phase 3.2–3.4, tier full, serial | `[workflow-state:in_progress-full]` |
| Phase 2P + 2F + Phase 3.2–3.4, tier full with `meta.execution=parallel` | `[workflow-state:in_progress-parallel]` |
| Fallback when no block exists for the task's tier | `[workflow-state:in_progress]` (right after the Phase 2F summary) |
| After Phase 3.5 (archived) | `[workflow-state:completed]` (after Phase 3 summary; **currently DEAD**) |

### Breadcrumb key selection

`inject-workflow-state.py` resolves the task's tier first: `task.json.meta.tier` when it is one of `light` / `standard` / `full`, otherwise inferred from the artifacts (`implement.md` → full, `design.md` → standard, else light; the header then says "(inferred)"). It then uses the first block that exists: `<status>-parallel` (only when the tier is full and `meta.execution` is `parallel`), then `<status>-<tier>`, then `<status>`. No `planning-<tier>` blocks ship, so planning always lands on `planning`.

### Changing the per-turn prompt text

Directly edit the body of the corresponding `[workflow-state:STATUS]` block. After editing, run `arbor update` (if you're a template maintainer) or restart your AI session (if you're customizing your own project) — no script changes required.

### Adding a custom status

Add a new block:

```
[workflow-state:my-status]
your per-turn prompt text
[/workflow-state:my-status]
```

Constraints:
- STATUS charset: `[A-Za-z0-9_-]+` (underscores and hyphens allowed, e.g. `in-review`, `blocked-by-team`)
- A lifecycle hook must write `task.json.status` to your custom value, otherwise the tag is never read
- Lifecycle hooks live in `task.json.hooks.after_*` and bind to one of `after_create / after_start / after_finish / after_archive`

### Adding a lifecycle hook

Add a `hooks` field to your `task.json`:

```json
{
  "hooks": {
    "after_finish": [
      "your-script-or-command-here"
    ]
  }
}
```

Supported events: `after_create / after_start / after_finish / after_archive`. Note that `after_finish` ≠ a status change (it only clears the active-task pointer); use `after_archive` for "task is done" notifications.

### Full contract

For the workflow state machine's runtime contract, the locations of all status writers, pseudo-statuses (`no_task` / `stale_<source_type>`), the hook reachability matrix, and other deep details, see:

- `.arbor/spec/cli/backend/workflow-state-contract.md` — runtime contract + writer table + test invariants
- `.arbor/scripts/inject-workflow-state.py` — actual parser (reads workflow.md only, no embedded text)
