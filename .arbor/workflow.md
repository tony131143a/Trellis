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
python3 ./.arbor/scripts/task.py create "<title>" [--slug <name>] [--parent <dir>]
python3 ./.arbor/scripts/task.py start <name>          # set active task (session-scoped when available)
python3 ./.arbor/scripts/task.py current --source      # show active task and source
python3 ./.arbor/scripts/task.py finish                # clear active task (triggers after_finish hooks)
python3 ./.arbor/scripts/task.py archive <name>        # move to archive/{year-month}/
python3 ./.arbor/scripts/task.py list [--mine] [--status <s>]
python3 ./.arbor/scripts/task.py list-archive

# Code-spec context (injected into implement/check assistants via JSONL).
# `implement.jsonl` / `check.jsonl` are seeded (empty) on `task create`; the AI curates
# real spec + research entries during planning. `validate` fails and `start` refuses while
# a seeded manifest is still empty — assistants would run with zero spec context.
# Pass `start --allow-empty-context` when that is intentional.
python3 ./.arbor/scripts/task.py add-context <name> <action> <file> <reason>
python3 ./.arbor/scripts/task.py list-context <name> [action]
python3 ./.arbor/scripts/task.py validate <name>

# Task metadata
python3 ./.arbor/scripts/task.py set-branch <name> <branch>
python3 ./.arbor/scripts/task.py set-base-branch <name> <branch>    # PR target
python3 ./.arbor/scripts/task.py set-scope <name> <scope>
python3 ./.arbor/scripts/task.py set-meta <name> <key> <value>      # e.g. execution parallel

# Hierarchy (parent/child)
python3 ./.arbor/scripts/task.py add-subtask <parent> <child>
python3 ./.arbor/scripts/task.py remove-subtask <parent> <child>

# PR creation
python3 ./.arbor/scripts/task.py create-pr [name] [--dry-run]
```

> Run `python3 ./.arbor/scripts/task.py --help` to see the authoritative, up-to-date list.

**Current-task mechanism**: `task.py create` creates the task directory and (when session identity is available) auto-sets the per-session active-task pointer so the planning breadcrumb fires immediately. `task.py start` writes the same pointer (idempotent if already set) and flips `task.json.status` from `planning` to `in_progress`. State is stored under `.arbor/.runtime/sessions/`. If no context key is available from hook input or `ARBOR_CONTEXT_ID`, there is no active task and `task.py start` fails with a session identity hint. `task.py finish` deletes the current session file (status unchanged). `task.py archive <task>` writes `status=completed`, moves the directory to `archive/`, and deletes any runtime session files that still point at the archived task.

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

The **implement**, **check**, and **research** roles are never performed in the main session and never through the built-in `Agent`/`Task` tool (a guard hook denies it for arbor roles). They run as **codeg assistants** on another model. The main agent plans, curates context, dispatches, verifies, and commits.

**Role × target matrix.** Each role has one assistant per target. Default assistant names are `arbor-<role>-<target>`; they are configured under `dispatch:` in `.arbor/config.yaml`.

| Role | Header `Role:` | Context inlined | `star` (Claude Code fork) | `pi` (pi + DeepSeek) |
|---|---|---|---|---|
| implement | `implement` | `implement.jsonl` → prd → design → implement.md | `arbor-implement-star` | `arbor-implement-pi` |
| check | `check` / `check [finish]` | `check.jsonl` → prd → design → implement.md | `arbor-check-star` | `arbor-check-pi` |
| research | `research` | spec directory overview + search tips (no task files) | `arbor-research-star` | `arbor-research-pi` |

**Target selection** (highest wins): `Target:` header line or `--target` → `.arbor/.runtime/dispatch-target` → env `ARBOR_DISPATCH_TARGET` → `dispatch.default_target` in config. Switch with `/arbor:workflow-star` or `/arbor:workflow-pi` (sets the target and continues the task), or `/arbor:dispatch-target star|pi|clear`.

**Header protocol.** The `task` text of every dispatch MUST start with this header, followed by a blank line and a self-contained brief:

```
Active task: <absolute path of the task directory in the MAIN checkout>
Role: implement | check | check [finish] | research
Target: star | pi            (optional)
Workspace: <absolute worktree path>   (optional; parallel variant only)
```

A hook (codeg path) or `dispatch.py` (terminal path) recognises the header and inlines the jsonl-listed spec/research files plus `prd.md`, `design.md`, `implement.md`, marked `<!-- arbor-hook-injected -->`. Without the header nothing is inlined and the assistant has to pull the context itself.

**Path A: inside codeg** (the MCP tools `delegate_to_agent` and `get_delegation_status` are in your tool list):

1. Find the integer `assistant_id` for the role and target in the `<dispatch>` section of the session context, or run `python3 ./.arbor/scripts/dispatch.py resolve --role <role>`.
2. `delegate_to_agent(assistant_id=<id>, working_dir=<repo root, or the worktree>, task=<header + brief>)` returns a `task_id` immediately.
3. `get_delegation_status(task_ids=[...], wait_ms=60000)` repeatedly until every task is terminal. Independent dispatches can run concurrently.

**Path B: plain terminal** (no codeg MCP tools):

```bash
python3 ./.arbor/scripts/dispatch.py run --role <role> [--finish] [--target star|pi] [--task <dir>] [--workspace <worktree>] --wait   # brief on stdin, or --prompt / --prompt-file
```

It runs `codeg-cli run -A <assistant>` against the running codeg app (`--url <server>` for a remote `codeg-server`; `--standalone --data-dir <codeg data dir>` while the app is closed) and prints the reply; prompt and reply are kept under `.arbor/.runtime/dispatch/`. `--finish` makes it `Role: check [finish]`. `--detach` starts it in the background and prints a run id; `python3 ./.arbor/scripts/dispatch.py wait <run>...` collects results. `--print-prompt` / `--dry-run` show the prompt / the `codeg-cli` command without running.

**Sub-agent self-exemption.** If your own first prompt starts with `Active task:` + `Role:`, you are a dispatched sub-agent: do that role's work directly, do not dispatch anything, do not commit, push, or merge, and do not call `task.py start/current/finish`. You have no `ARBOR_CONTEXT_ID`. Dispatch is for the main agent only.

**Invariants.** Sub-agents never commit, merge, or push; never touch paths outside their working directory; never write under `.arbor/` (a `check [finish]` pass may edit `.arbor/spec/`; research writes only `<task>/research/*.md`). Only the main agent commits (Phase 3.4).

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

  INVARIANT (test/regression.test.ts):
    Every workflow-walkthrough step marked `[required · once]` must have a
    matching enforcement line in its phase's [workflow-state:*] block. The
    breadcrumb is the only per-turn channel; if a mandatory step isn't
    mentioned there, the AI silently skips it (Phase 1 planning gate
    skip and Phase 3.4 commit skip both manifested via this gap).

  TAG ↔ PHASE scoping:
    [workflow-state:no_task]      → no active task; before Phase 1
    [workflow-state:task_error]   → active task record is unreadable; repair it before continuing
    [workflow-state:planning]     → all of Phase 1 (status='planning')
    [workflow-state:in_progress]  → Phase 2 + Phase 3.2-3.4, serial execution
                                    (status stays 'in_progress' from
                                    task.py start until task.py archive)
    [workflow-state:in_progress-parallel] → Phase 2P + Phase 3.2-3.4 when the
                                    task has meta.execution=parallel (the hook
                                    picks this key; if the block is missing it
                                    falls back to in_progress)
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
Phase 1: Plan    → classify, get task-creation consent, then write planning artifacts
Phase 2: Execute → dispatch implement/check to codeg assistants (serial), or 2P for parallel worktrees
Phase 3: Finish  → verify, update spec, commit, and wrap up
```

### Request Triage

- Simple conversation or small task: ask only whether this turn should create an Arbor task. If the user says no, skip Arbor for this session.
- Complex task: ask whether you may create an Arbor task and enter planning. If the user says no, do not do broad inline implementation; explain, clarify scope, or suggest a smaller split.
- User approval to create a task is not approval to start implementation. Planning still happens first.

### Planning Artifacts

- `prd.md` — requirements, constraints, and acceptance criteria. Do not put technical design or execution checklists here.
- `design.md` — technical design for complex tasks: boundaries, contracts, data flow, tradeoffs, compatibility, rollout / rollback shape.
- `implement.md` — execution plan for complex tasks: ordered checklist, validation commands, review gates, and rollback points.
- `implement.jsonl` / `check.jsonl` — spec and research manifests for the dispatched assistants. They do not replace `implement.md`.
- Lightweight tasks may be PRD-only. Complex tasks must have `prd.md`, `design.md`, and `implement.md` before `task.py start`.

### Parent / Child Task Trees

Use a parent task when one user request contains several independently verifiable deliverables. The parent task owns the source requirement set, the task map, cross-child acceptance criteria, and final integration review; it normally should not be the implementation target unless it also has direct work.

Use child tasks for deliverables that can be planned, implemented, checked, and archived independently. Parent/child structure is not a dependency system: if one child must wait for another, write that ordering in the child `prd.md` / `implement.md` and keep each child's acceptance criteria testable.

Create new children with `task.py create "<title>" --slug <name> --parent <parent-dir>`. Link existing tasks with `task.py add-subtask <parent> <child>`, and unlink mistakes with `task.py remove-subtask <parent> <child>`.

A parent task whose children run concurrently in separate git worktrees uses the parallel execution mode (step 1.4, Phase 2P).

<!-- Per-turn breadcrumb: shown when there is no active task (before Phase 1) -->

[workflow-state:no_task]
No active task. First classify the current turn and ask for task-creation consent before creating any Arbor task.
Simple conversation / small task: ask only whether this turn should create an Arbor task. If the user says no, skip Arbor for this session.
Complex task: ask the user if you can create an Arbor task and enter the planning phase. If the user says no, explain, clarify scope, or suggest a smaller split.
[/workflow-state:no_task]

<!-- Per-turn breadcrumb: shown when the active task record cannot be read. -->

[workflow-state:task_error]
The active task record could not be read. Do not create or activate another task.
Inspect the task directory named above and repair its task.json. It must be a valid JSON object with a non-empty status.
Preserve existing task fields and artifacts. If the correct status cannot be determined safely, ask the user before reconstructing the record.
[/workflow-state:task_error]

### Phase 1: Plan
- 1.0 Create task `[required · once]` (only after task-creation consent)
- 1.1 Requirement exploration `[required · repeatable]` (`prd.md`; complex tasks also need `design.md` + `implement.md`)
- 1.2 Research `[optional · repeatable]` (dispatch the research role)
- 1.3 Configure context `[required · once]` (curate `implement.jsonl` + `check.jsonl`)
- 1.4 Activate task `[required · once]` (choose serial or parallel execution mode, review gate, then `task.py start`; status → in_progress)
- 1.5 Completion criteria

<!-- Per-turn breadcrumb: shown throughout Phase 1 (status='planning') -->

[workflow-state:planning]
Load `arbor-brainstorm`; stay in planning.
Lightweight: `prd.md` can be enough. Complex: finish `prd.md`, `design.md`, and `implement.md`; ask for review before `task.py start` (1.4).
Curate `implement.jsonl` and `check.jsonl` (1.3, required): the dispatch hook inlines exactly those files into the codeg assistants.
Multi-deliverable scope: consider a parent task plus independently verifiable child tasks (`task.py create --parent`); dependencies must be written in child artifacts, not implied by tree position.
Decide the execution mode in 1.4: serial (default) or parallel (`task.py set-meta <task> execution parallel` plus child tasks), before `task.py start`.
[/workflow-state:planning]

### Phase 2: Execute
- 2.1 Implement `[required · repeatable]` (dispatch the implement role)
- 2.2 Quality check `[required · repeatable]` (dispatch the check role)
- 2.3 Rollback `[on demand]`
- Phase 2P replaces 2.1–2.2 when `meta.execution=parallel`: 2P.0 Split · 2P.1 Worktrees · 2P.2 Implement · 2P.3 Check · 2P.4 Merge · 2P.5 Final check · 2P.6 Cleanup

<!-- Per-turn breadcrumb: shown while status='in_progress' (serial execution).
     Scope: all of Phase 2 + Phase 3.2-3.4 (status stays 'in_progress' from
     task.py start until task.py archive; only archive flips it). The body
     therefore must cover every required step from implementation through
     commit, including Phase 3.3 spec update and Phase 3.4 commit. -->

[workflow-state:in_progress]
Roles implement / check / research run as codeg assistants, never via the built-in Agent/Task tool. Dispatch with `delegate_to_agent(assistant_id=<from the <dispatch> context or dispatch.py resolve>, working_dir=<repo root>, task=<header + brief>)` and wait with `get_delegation_status`; without those tools run `python3 ./.arbor/scripts/dispatch.py run --role <role> --wait`.
The task text starts with `Active task: <absolute task dir>` then `Role: <role>`; the hook inlines the jsonl entries -> prd.md -> design.md -> implement.md.
Flow: implement (2.1) -> check (2.2; the last one full-scope, `Role: check [finish]`) -> `arbor-update-spec` (3.3, required) -> batched commit (3.4, required; no amend, no push) -> `/arbor:finish-work`.
Sub-agent self-exemption: if you are already a dispatched sub-agent (your prompt starts with `Active task:` / `Role:`), perform that role directly; do not dispatch, commit, or call task.py start/current/finish. Dispatch is main session only.
[/workflow-state:in_progress]

<!-- Per-turn breadcrumb: shown while status='in_progress' and the task has
     meta.execution=parallel. Same scope as [workflow-state:in_progress] but
     for Phase 2P. -->

[workflow-state:in_progress-parallel]
Parallel execution is enabled for this task (meta.execution=parallel). Same dispatch rules as serial (codeg assistants only, header `Active task:` + `Role:`, never the built-in Agent/Task tool), plus Phase 2P:
Each child task gets its own worktree (`git worktree add <WT_ROOT>/<parent>-<child> -b wip/<parent>/<child> <task-branch>`, 2P.1). Dispatch up to dispatch.max_parallel implement roles at once (2P.2) with `working_dir=<worktree>` and header `Active task: <absolute child dir in the MAIN checkout>`, `Role: implement`, `Workspace: <worktree>`.
Then check each child in its worktree and commit it yourself (2P.3), merge serially with `git merge --no-ff` into the task branch (2P.4), run one full-scope `Role: check [finish]` on the merged tree for the parent task (2P.5), and remove the worktrees (2P.6).
Finish on the parent task: `arbor-update-spec` (3.3, required) -> batched commit (3.4, required; no amend, no push) -> `/arbor:finish-work` (archives parent and children).
Sub-agent self-exemption: if you are already a dispatched sub-agent, perform your role in your worktree only; never merge, commit, or dispatch.
[/workflow-state:in_progress-parallel]

### Phase 3: Finish
- 3.2 Debug retrospective `[on demand]`
- 3.3 Spec update `[required · once]`
- 3.4 Commit changes `[required · once]`
- 3.5 Wrap-up reminder

> Note: step 3.1 was folded into 2.2 (last-iteration full-scope check) and 3.4 (commit preamble). Numbering kept stable to avoid breaking external references.

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
5. Artifact presence informs the next step; missing `design.md` / `implement.md` is valid for lightweight tasks and incomplete planning for complex tasks.

### Active Task Routing

When a user request matches one of these intents inside an active task, route first, then load the detailed phase step if needed.

- Planning or unclear requirements -> `arbor-brainstorm`.
- `in_progress` implementation/check -> dispatch the implement / check role (codeg `delegate_to_agent`, or `dispatch.py run`); with `meta.execution=parallel` follow Phase 2P.
- Repeated debugging -> `arbor-break-loop`; spec updates -> `arbor-update-spec`.

### Guardrails

- Task creation approval is not implementation approval; implementation waits for `task.py start` after artifact review.
- PRD-only is valid for lightweight tasks; complex tasks need `design.md` + `implement.md`.
- Planning must be persisted to task artifacts; checks must run before reporting completion.
- Never perform the implement / check / research roles in the main session or through the built-in Agent/Task tool; dispatch them (see Dispatch).

### Loading Step Detail

At each step, run this to fetch detailed guidance:

```bash
python3 ./.arbor/scripts/get_context.py --mode phase --step <step>
# e.g. python3 ./.arbor/scripts/get_context.py --mode phase --step 1.1
```

---

## Phase 1: Plan

Goal: classify the request, get task-creation consent when a task is needed, and produce the planning artifacts required before implementation.

#### 1.0 Create task `[required · once]`

Create the task directory only after task-creation consent. The command sets status to `planning`, writes `task.json`, creates a default `prd.md`, and auto-targets the new task when session identity is available:

```bash
python3 ./.arbor/scripts/task.py create "<task title>" --slug <name>
```

`--slug` is the human-readable name only. Do **not** include the `MM-DD-` date prefix; `task.py create` adds that prefix automatically.

For task trees, create the parent task first and then create each child with `--parent <parent-dir>`. Do not start the parent just because children exist; start the child that owns the next independently verifiable deliverable.

After this command succeeds, the per-turn breadcrumb auto-switches to `[workflow-state:planning]`, telling the AI to stay in planning.

Run only `create` here — do not also run `start`. `start` flips status to `in_progress`, which switches the breadcrumb to the implementation phase before planning artifacts are reviewed. Save `start` for step 1.4.

Skip when `python3 ./.arbor/scripts/task.py current --source` already points to a task.

#### 1.1 Requirement exploration `[required · repeatable]`

Load the `arbor-brainstorm` skill and explore requirements interactively with the user per the skill's guidance.

The brainstorm skill will guide you to:
- Ask one question at a time
- Prefer researching over asking the user
- Prefer offering options over open-ended questions
- Update `prd.md` immediately after each user answer
- Split large scopes into a parent task plus child tasks when the deliverables can be verified independently
- Keep `prd.md` focused on requirements and acceptance criteria
- For complex tasks, produce `design.md` and `implement.md` before implementation starts

When considering a parent/child split:
- Use a parent task when one request contains several independently verifiable deliverables.
- Parent tasks own source requirements, child-task mapping, cross-child acceptance criteria, and final integration review.
- Child tasks own actual deliverables that can be planned, implemented, checked, and archived independently.
- Parent/child structure is not a dependency system. If child B depends on child A, write that ordering in child B's `prd.md` / `implement.md`.
- Start the child task that owns the next deliverable. Do not start the parent unless the parent itself has direct implementation work.

Return to this step whenever requirements change and revise the relevant artifact.

#### 1.2 Research `[optional · repeatable]`

Research can happen at any time during requirement exploration. It isn't limited to local code — you can use any available tool (MCP servers, skills, web search, etc.) to look up external information, including third-party library docs, industry practices, API references, etc.

For larger questions, dispatch the **research** role (see Dispatch in the Arbor System section):

- **Header**: `Active task: <absolute task dir>` then `Role: research`
- **Brief**: the specific question to research
- **Key requirement**: research output MUST be persisted to `{TASK_DIR}/research/` (one file per topic)

Small questions you can answer by reading a few files directly; just write the finding into `{TASK_DIR}/research/` yourself.

**Research artifact conventions**:
- One file per research topic (e.g. `research/auth-library-comparison.md`)
- Record third-party library usage examples, API references, version constraints in files
- Note relevant spec file paths you discovered for later reference

Brainstorm and research can interleave freely — pause to research a technical question, then return to talk with the user.

**Key principle**: Research output must be written to files, not left only in the chat. Conversations get compacted; files don't.

#### 1.3 Configure context `[required · once]`

Curate `implement.jsonl` and `check.jsonl` so the dispatched implement/check assistants get the right spec/research context. The hook inlines exactly the files listed here; an empty manifest means the assistant runs with no spec. These files were seeded on `task create` with a single self-describing `_example` line; your job here is to fill in real entries.

**Location**: `{TASK_DIR}/implement.jsonl` and `{TASK_DIR}/check.jsonl` (already exist).

**Format**: one JSON object per line — `{"file": "<path>", "reason": "<why>"}`. Paths are repo-root relative.

**What to put in**:
- **Spec files** — `.arbor/spec/<package>/<layer>/index.md` and any specific guideline files (`error-handling.md`, `conventions.md`, etc.) relevant to this task
- **Research files** — `{TASK_DIR}/research/*.md` that the assistant will need to consult

**What NOT to put in**:
- Code files (`src/**`, `packages/**/*.ts`, etc.) — those are read by the assistant during implementation, not pre-registered here
- Files you're about to modify — same reason

**Split between the two files**:
- `implement.jsonl` → specs + research the implement role needs to write code correctly
- `check.jsonl` → specs for the check role (quality guidelines, check conventions, same research if needed)

These manifests do not replace `implement.md`. `implement.md` is the human-readable execution plan for a complex task; jsonl files only list context files to inject.

**How to discover relevant specs**:

```bash
python3 ./.arbor/scripts/get_context.py --mode packages
```

Lists every package + its spec layers with paths. Pick the entries that match this task's domain.

**How to append entries**:

Either edit the jsonl file directly in your editor, or use:

```bash
python3 ./.arbor/scripts/task.py add-context "$TASK_DIR" implement "<path>" "<reason>"
python3 ./.arbor/scripts/task.py add-context "$TASK_DIR" check "<path>" "<reason>"
```

Delete the seed `_example` line once real entries exist (optional — it's skipped automatically by consumers).

Ready gate: both `implement.jsonl` and `check.jsonl` must contain at least one real `{"file": "...", "reason": "..."}` entry before `task.py start`. The seed `_example` row alone is not ready. For a parallel parent task, curate the manifests of every child task too (children may start from a copy of the parent's).

Skip this step only when both files already have real curated entries.

#### 1.4 Activate task `[required · once]`

**Decide the execution mode first.**

- **serial** (default): one implement → check loop in the main checkout (Phase 2.1–2.2).
- **parallel**: choose it only when the work splits into child tasks that touch disjoint files and can be verified independently. Mark the parent, then follow Phase 2P:

  ```bash
  python3 ./.arbor/scripts/task.py set-meta <parent-dir> execution parallel
  ```

  This stores `meta.execution = "parallel"` in the parent's `task.json`; the breadcrumb key becomes `in_progress-parallel` after `task.py start`. Child tasks are created in 2P.0 (or earlier, in planning, with `task.py create --parent`).

After artifact review, flip the task status to `in_progress`:

```bash
python3 ./.arbor/scripts/task.py start <task-dir>
```

For lightweight tasks, `prd.md` can be enough. For complex tasks, `prd.md`, `design.md`, and `implement.md` must exist and be reviewed before start. `implement.jsonl` and `check.jsonl` must both have real curated entries before start. Runtime consumers tolerate missing or seed-only manifests for compatibility, but that tolerance is not a planning-ready state.

After this command succeeds, the breadcrumb auto-switches to `[workflow-state:in_progress]` (or `in_progress-parallel`), and the rest of Phase 2 / 3 follows.

If `task.py start` errors with a session-identity message (no context key from hook input or `ARBOR_CONTEXT_ID`), follow the hint in the error to set up session identity, then retry.

#### 1.5 Completion criteria

| Condition | Required |
|------|:---:|
| `prd.md` exists | ✅ |
| User confirms task should enter implementation | ✅ |
| `task.py start` has been run (status = in_progress) | ✅ |
| `research/` has artifacts (complex tasks) | recommended |
| `design.md` exists (complex tasks) | ✅ |
| `implement.md` exists (complex tasks) | ✅ |
| `implement.jsonl` and `check.jsonl` each contain at least one real curated entry (seed row does not count) | ✅ |
| Execution mode chosen; `meta.execution=parallel` set when parallel | ✅ |

---

## Phase 2: Execute

Goal: turn reviewed planning artifacts into code that passes quality checks, by dispatching the implement and check roles to codeg assistants. Dispatch mechanics (header protocol, the two paths, target selection) are in the Dispatch subsection of the Arbor System section. Serial mode uses 2.1–2.3 below; parallel mode (`meta.execution=parallel`) uses Phase 2P instead.

#### 2.1 Implement `[required · repeatable]`

Dispatch the **implement** role. With codeg: `delegate_to_agent(assistant_id=<id from <dispatch> or dispatch.py resolve>, working_dir=<repo root>, task=<header + brief>)`, then `get_delegation_status(task_ids, wait_ms=60000)` until terminal. Without codeg: `python3 ./.arbor/scripts/dispatch.py run --role implement --wait`. The hook (or `dispatch.py`) inlines the jsonl entries, `prd.md`, `design.md` if present, and `implement.md` if present. The task text MUST begin with the header block:

```
Active task: <absolute task dir>
Role: implement
```

- **Brief** (after the header): implement the reviewed task artifacts, consulting materials under `{TASK_DIR}/research/`; finish by running project lint and type-check. Add anything the artifacts do not say (known pitfalls, files to avoid).
- **Dispatch prompt guard**: the assistant's own instructions already say it is the `implement` role and must not dispatch; keep the brief free of instructions to delegate or to spawn another implement/check run.
- On completion, read the assistant's report (files modified, verification, open questions) and skim `git diff --stat` before moving on. The assistant does not commit.

#### 2.2 Quality check `[required · repeatable]`

Dispatch the **check** role the same way (`Role: check`; `dispatch.py run --role check --wait` in a terminal):

- **Brief**: review all code changes against specs and task artifacts; fix any findings directly; ensure lint and type-check pass.
- The check assistant reviews the diff against specs, `prd.md`, `design.md` if present, and `implement.md` if present; auto-fixes what it finds; runs lint and type-check; and reports PASS or FAIL with a fix list.
- On FAIL or open issues, decide whether to re-dispatch implement (design-level problem) or check again.

**Final pass (before Phase 3.4 commit)**: the last 2.2 of a task must run full-scope, not just on the latest implement chunk. Use `Role: check [finish]`; list all affected packages with `python3 ./.arbor/scripts/get_context.py --mode packages` and tell the assistant to load each package's spec index Quality Check section. This catches cross-layer / multi-package issues a mid-iteration local 2.2 cannot.

#### 2.3 Rollback `[on demand]`

- `check` reveals a prd defect → return to Phase 1, fix `prd.md`, then redo 2.1
- Implementation went wrong → revert code, redo 2.1
- Need more research → dispatch the research role (same as Phase 1.2), write findings into `research/`
- A dispatch failed, timed out, or returned nothing useful → read its result, tighten the brief, and re-dispatch (optionally with a different `Target:`). Do not silently do the role's work in the main session.

---

## Phase 2P: Execute (parallel variant)

Applies only when the parent task has `meta.execution=parallel`. Goal: implement independent child tasks concurrently, each in its own git worktree, then merge serially. Use it instead of 2.1–2.2; Phase 3 runs on the parent task afterwards.

Invariants: sub-agents never commit, merge, or touch paths outside their worktree, and never write under `.arbor/`. The `Active task:` header line is **always** the absolute path of the task directory in the MAIN checkout, even when `working_dir` is a worktree (the `.arbor/tasks` copy inside a worktree is read-only noise). Runtime state (`.arbor/.runtime`, `.arbor/.developer`) is resolved from the main checkout only.

#### 2P.0 Split `[required · repeatable]`

Write the waves and file ownership into the parent `implement.md`: which child owns which files, and which children must wait for others. Children in the same wave must not modify the same file. Create each child:

```bash
python3 ./.arbor/scripts/task.py create "<title>" --slug <name> --parent <parent-dir>
```

Give each child its own `prd.md` and curated `implement.jsonl` / `check.jsonl` (copying the parent's is fine).

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

with `working_dir=<worktree path>`. Collect all `task_id`s and wait with `get_delegation_status(task_ids, wait_ms=60000)`; in a terminal use `dispatch.py run --role implement --task <child-dir> --workspace <worktree> --detach` then `dispatch.py wait`. Handle failures as in 2.3, per child.

#### 2P.3 Check `[required · repeatable]`

Dispatch a `Role: check` in each worktree (`Active task` = that child, `Workspace` = its worktree, `working_dir` = the worktree). When a child is green, commit it yourself inside its worktree: `git -C <worktree> add -A && git -C <worktree> commit -m "<msg>"`.

#### 2P.4 Merge `[required · repeatable]`

In the main checkout, on the task branch, merge children serially: `git merge --no-ff wip/<parent>/<child>`. Resolve conflicts yourself. Run the project checks after each merge.

#### 2P.5 Final check `[required · repeatable]`

On the merged tree, dispatch one full-scope check: `Active task:` = the **parent** task, `Role: check [finish]`, `working_dir` = the main checkout.

#### 2P.6 Cleanup `[required · repeatable]`

```bash
git worktree remove "$WT_ROOT/<parent>-<child>"
git branch -d "wip/<parent>/<child>"
```

for every merged child. Then continue with Phase 3 on the parent task (3.3 spec update, 3.4 commit of any remaining changes). `/arbor:finish-work` archives the parent and its children.

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

Edit the corresponding step's walkthrough body in the Phase 1 / 2 / 3 sections above. Critical invariants:
- No active task must triage first and ask for task-creation consent before creating an Arbor task.
- Planning must distinguish lightweight PRD-only tasks from complex tasks that require `prd.md`, `design.md`, and `implement.md` before start.
- Every required execution path must keep the Phase 3.4 commit reminder reachable before `/arbor:finish-work`.

All tag blocks live in the `## Phase Index` section above, immediately after each phase summary:

| Scope | Corresponding tag |
|---|---|
| No active task (before Phase 1) | `[workflow-state:no_task]` (after the Phase Index ASCII art) |
| Active task record unreadable | `[workflow-state:task_error]` (repair the existing task before continuing) |
| All of Phase 1 (task created → ready for implementation) | `[workflow-state:planning]` (after Phase 1 summary) |
| Phase 2 + Phase 3.2–3.4, serial (implementation + check + wrap-up) | `[workflow-state:in_progress]` (after Phase 2 summary) |
| Phase 2P + Phase 3.2–3.4, parallel (task has `meta.execution=parallel`) | `[workflow-state:in_progress-parallel]` (right after `in_progress`) |
| After Phase 3.5 (archived) | `[workflow-state:completed]` (after Phase 3 summary; **currently DEAD**) |

### Breadcrumb key selection

`inject-workflow-state.py` normally uses `task.json.status` as the block name. For a task whose status is `in_progress` and whose `meta.execution` is `parallel`, it uses `in_progress-parallel` instead, and falls back to `in_progress` when that block is missing.

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
