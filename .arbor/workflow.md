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

# Code-spec context (injected into the dispatched assistants via JSONL).
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

The seven roles below are never performed in the main session and never through the built-in `Agent`/`Task` tool (a guard hook denies it for arbor roles). They run as **codeg assistants** on another model. The main agent plans, curates context, dispatches, dedups findings, verifies, and commits.

**Roles.** Each role has one assistant per target. Default assistant names are `arbor-<role>-<target>` (for example `arbor-review-star`, `arbor-review-pi`); they are configured under `dispatch:` in `.arbor/config.yaml`, and the role instructions live in `.arbor/agents/<role>.md`.

| Role | Writes | Context inlined | Used in | Output |
|---|---|---|---|---|
| `explore` | `<task>/research/<topic>.md` only | spec overview; with a task, `prd.md` + research file list | 1.2 | findings + 5-10 essential files |
| `architect` | `<task>/research/design-<perspective>.md` only | `implement.jsonl` → prd → design → implement.md → `research/*.md` | 1.2 (complex) | one blueprint incl. parallel split |
| `implement` | code (no commits) | `implement.jsonl` → prd → design → implement.md | 2.1, 2P.2 | code + verification report |
| `review` | nothing | `check.jsonl` → prd → design → implement.md → `Diff:` | 2.2, 2P.3, 2F | `PASS`/`FAIL` + JSON findings |
| `verify` | nothing | same as review | 2.2, 2F | CONFIRMED / PLAUSIBLE / REFUTED per candidate |
| `fix` | code (no commits) | same as review | 2.2, 2P.3, 2F | fixed / skipped per finding |
| `simplify` | code (no commits) | same as review | 2F.1 | behavior-preserving cleanup |

**Target selection** (highest wins): `Target:` header line or `--target` → `.arbor/.runtime/dispatch-target` → env `ARBOR_DISPATCH_TARGET` → `dispatch.default_target` in config. Switch with `/arbor:workflow-star` or `/arbor:workflow-pi` (sets the target and continues the task). Running finders and `verify` on different targets (for example review on `pi`, verify on `star`) makes the verification independent.

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
    [workflow-state:in_progress]  → Phase 2 + Phase 2F + Phase 3.2-3.4, serial execution
                                    (status stays 'in_progress' from
                                    task.py start until task.py archive)
    [workflow-state:in_progress-parallel] → Phase 2P + Phase 2F + Phase 3.2-3.4 when the
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
Phase 1:  Plan    → classify, consent, explore + clarify, (complex) architect, write planning artifacts
Phase 2:  Execute → implement, then the review → [verify] → fix loop (serial), or 2P for parallel worktrees
Phase 2F: Polish  → (complex) simplify, final review → verify → sweep, user decides, fix, quality checks
Phase 3:  Finish  → update spec, commit, and wrap up
```

### Request Triage

- Simple conversation or small task: ask only whether this turn should create an Arbor task. If the user says no, skip Arbor for this session.
- Complex task: ask whether you may create an Arbor task and enter planning. If the user says no, do not do broad inline implementation; explain, clarify scope, or suggest a smaller split.
- User approval to create a task is not approval to start implementation. Planning still happens first.

### Planning Artifacts

- `prd.md` — requirements, constraints, and acceptance criteria. Do not put technical design or execution checklists here.
- `design.md` — technical design for complex tasks: boundaries, contracts, data flow, tradeoffs, compatibility, rollout / rollback shape.
- `implement.md` — execution plan for complex tasks: ordered checklist, validation commands, review gates, and rollback points.
- `implement.jsonl` / `check.jsonl` — spec and research manifests for the dispatched assistants (`implement.jsonl` feeds architect and implement; `check.jsonl` feeds review, verify, fix, and simplify). They do not replace `implement.md`.
- `research/` — explore findings (`<topic>.md`) and architect blueprints (`design-<perspective>.md`).
- Lightweight tasks may be PRD-only. Complex tasks must have `prd.md`, `design.md`, and `implement.md` before `task.py start`.
- **Tier = artifacts.** A task without `design.md` is **lightweight**; a task with `design.md` is **complex**. The tier decides how much of the explore / architect / review machinery runs (see 1.2, 2.2, Phase 2F).

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
- 1.2 Explore & design `[repeatable]` (explore roles in parallel → read essential files → clarify with the user; complex: architect roles in parallel → user picks → `design.md` + `implement.md`)
- 1.3 Configure context `[required · once]` (curate `implement.jsonl` + `check.jsonl`)
- 1.4 Activate task `[required · once]` (choose serial or parallel execution mode, review gate, then `task.py start`; status → in_progress)
- 1.5 Completion criteria

<!-- Per-turn breadcrumb: shown throughout Phase 1 (status='planning') -->

[workflow-state:planning]
Load `arbor-brainstorm`; stay in planning.
Lightweight: `prd.md` can be enough. Complex: finish `prd.md`, `design.md`, and `implement.md`; ask for review before `task.py start` (1.4).
Explore & design (1.2): dispatch 2-3 `explore` roles in parallel, one aspect each (required for complex tasks), read every essential file they return yourself, then put the open technical questions to the user as one list and wait. Complex: dispatch 3 `architect` roles in parallel (minimal-change / clean-architecture / pragmatic), present the trade-offs and your recommendation, and after the user picks, write `design.md` + `implement.md` (file ownership, waves).
Curate `implement.jsonl` and `check.jsonl` (1.3, required): the dispatch hook inlines exactly those files into the codeg assistants.
Multi-deliverable scope: consider a parent task plus independently verifiable child tasks (`task.py create --parent`); dependencies must be written in child artifacts, not implied by tree position.
Decide the execution mode in 1.4: serial (default) or parallel (`task.py set-meta <task> execution parallel` plus child tasks), before `task.py start`.
[/workflow-state:planning]

### Phase 2: Execute
- 2.1 Implement `[required · repeatable]` (snapshot S0, then dispatch the implement role)
- 2.2 Review loop `[required · repeatable]` (review → [verify] → fix, re-review of the fix delta only, at most 2 rounds)
- 2.3 Rollback `[on demand]`
- Phase 2P replaces 2.1–2.2 when `meta.execution=parallel`: 2P.0 Split · 2P.1 Worktrees · 2P.2 Implement · 2P.3 Review loop + commit · 2P.4 Merge · 2P.5 Cleanup

### Phase 2F: Polish (complex tasks; serial and parallel)
- 2F.1 Simplify `[required · once]` (simplify the whole diff, review its delta for unchanged behavior)
- 2F.2 Final review `[required · once]` (5 × review candidates → dedup → verify → sweep → verify)
- 2F.3 User decision `[on demand]` (only when findings survive)
- 2F.4 Fix `[on demand]` (fix the chosen findings, review the fix delta)
- 2F.5 Quality checks `[required · once]` (run every affected package's Quality Check commands yourself; lightweight tasks run this step too)

<!-- Per-turn breadcrumb: shown while status='in_progress' (serial execution).
     Scope: all of Phase 2 + Phase 2F + Phase 3.2-3.4 (status stays
     'in_progress' from task.py start until task.py archive; only archive
     flips it). The body therefore must cover every required step from
     implementation through commit, including Phase 3.3 spec update and
     Phase 3.4 commit. -->

[workflow-state:in_progress]
Roles run as codeg assistants, never via the built-in Agent/Task tool: `delegate_to_agent(assistant_id=<from the <dispatch> context or dispatch.py resolve>, working_dir=<repo root>, task=<header + brief>)` and `get_delegation_status`; without those tools `python3 ./.arbor/scripts/dispatch.py run --role <role> --wait`. The task text starts with `Active task: <absolute task dir>` then `Role: <role>` (review adds `Mode:`; review/verify/fix/simplify add `Diff:`).
Tier: no `design.md` = lightweight; `design.md` present = complex.
Flow: `dispatch.py snapshot` -> S0, implement (2.1) -> review loop (2.2): `dispatch.py diff S0` -> lightweight, or diff under 300 changed lines: 1 review `Mode: self-check`; complex with 300+: 3 reviews `Mode: candidates` (A+D / B+Conventions / C+E) -> dedup -> verify -> fix -> review self-check of the fix delta only; at most 2 rounds, then stop and report to the user.
Complex: polish (2F): simplify the whole diff and review its delta (2F.1) -> final review: 5 reviews `Mode: candidates` (A / B / C / D+E / Conventions+Acceptance) -> dedup -> verify -> 1 review `Mode: sweep` -> verify (2F.2) -> only if findings survive, ask the user once (2F.3) -> fix + review the fix delta (2F.4). Every task: run each affected package's Quality Check commands yourself (2F.5).
Then `arbor-update-spec` (3.3, required) -> batched commit (3.4, required; no amend, no push) -> `/arbor:finish-work`.
Sub-agent self-exemption: if you are already a dispatched sub-agent (your prompt starts with `Active task:` / `Role:`), perform that role directly; do not dispatch, commit, or call task.py start/current/finish. Dispatch is main session only.
[/workflow-state:in_progress]

<!-- Per-turn breadcrumb: shown while status='in_progress' and the task has
     meta.execution=parallel. Same scope as [workflow-state:in_progress] but
     for Phase 2P. -->

[workflow-state:in_progress-parallel]
Parallel execution is enabled for this task (meta.execution=parallel). Same dispatch rules as serial (codeg assistants only, header `Active task:` + `Role:`, never the built-in Agent/Task tool), plus Phase 2P:
Each child task gets its own worktree (`git worktree add <WT_ROOT>/<parent>-<child> -b wip/<parent>/<child> <task-branch>`, 2P.1). Dispatch up to dispatch.max_parallel implement roles at once (2P.2) with `working_dir=<worktree>` and header `Active task: <absolute child dir in the MAIN checkout>`, `Role: implement`, `Workspace: <worktree>`.
Run the 2.2 review loop in every worktree, all children in the same batch (diffs via `dispatch.py diff <task-branch> -C <worktree>`), and commit each green child yourself in its worktree (2P.3); merge serially with `git merge --no-ff` into the task branch and run the checks after each merge (2P.4); remove the worktrees (2P.5).
Then Phase 2F on the merged tree for the parent task (diff base = the task branch's starting commit), then `arbor-update-spec` (3.3, required) -> batched commit (3.4, required; no amend, no push) -> `/arbor:finish-work` (archives parent and children).
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
5. Artifact presence informs the next step; missing `design.md` / `implement.md` is valid for lightweight tasks and incomplete planning for complex tasks.

### Active Task Routing

When a user request matches one of these intents inside an active task, route first, then load the detailed phase step if needed.

- Planning or unclear requirements -> `arbor-brainstorm`.
- Questions about existing code or external libraries -> dispatch `explore` (1.2), any phase.
- `in_progress` implementation / review -> dispatch implement, then the 2.2 review loop (codeg `delegate_to_agent`, or `dispatch.py run`); with `meta.execution=parallel` follow Phase 2P; complex tasks then run Phase 2F.
- Repeated debugging -> `arbor-break-loop`; spec updates -> `arbor-update-spec`.

### Guardrails

- Task creation approval is not implementation approval; implementation waits for `task.py start` after artifact review.
- PRD-only is valid for lightweight tasks; complex tasks need `design.md` + `implement.md`.
- Planning must be persisted to task artifacts; checks must run before reporting completion.
- Never perform the explore / architect / implement / review / verify / fix / simplify roles in the main session or through the built-in Agent/Task tool; dispatch them (see Dispatch).
- The review loop stops after 2 rounds; report what remains instead of re-dispatching indefinitely.

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

#### 1.2 Explore & design `[repeatable]`

Facts first, then questions, then design. Follows Claude Code's feature-dev flow (discover → explore → clarify → architect). Small questions you can answer by reading a few files yourself; write the finding into `{TASK_DIR}/research/` and move on.

**a. Explore** (required for complex tasks, optional for lightweight ones). Dispatch 2-3 **explore** roles in parallel, each on a different aspect, with thoroughness `very thorough`:

- Header: `Active task: <absolute task dir>` then `Role: explore`
- Brief examples: "find features similar to <feature> and trace their implementation end to end"; "map the architecture and abstractions of <area>"; "find the test setup, UI patterns, or extension points relevant to <feature>"; "fetch <library>@<version> and document the APIs we need" (external)
- Each writes `research/<topic>.md` and returns 5-10 **essential files**.

When they return, **read every essential file yourself** before going on: the main agent needs first-hand context to write good briefs.

**b. Clarify** (do not skip). Compare the findings with the requirements and list what is still unclear: edge cases, error handling, integration points, scope boundaries, design preferences, backward compatibility, performance. Put the questions to the user **as one list** and wait for the answers; fold them into `prd.md`. If the user says "your call", give your recommendation and get explicit confirmation.

**c. Architect** (complex tasks). Dispatch 3 **architect** roles in parallel, one perspective each:

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

Curate `implement.jsonl` and `check.jsonl` so the dispatched assistants get the right spec/research context (`implement.jsonl` → architect, implement; `check.jsonl` → review, verify, fix, simplify). The hook inlines exactly the files listed here; an empty manifest means the assistant runs with no spec. These files were seeded on `task create` with a single self-describing `_example` line; your job here is to fill in real entries.

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
- `check.jsonl` → specs for the review side (quality guidelines, conventions the Conventions angle checks, same research if needed)

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

- **serial** (default): implement → review loop in the main checkout (Phase 2.1–2.2).
- **parallel**: choose it only when the work splits into child tasks that touch disjoint files and can be verified independently (the chosen architect's parallel split is the starting point). Mark the parent, then follow Phase 2P:

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
| `research/` has explore findings (complex tasks) | ✅ |
| User chose one architect design (complex tasks) | ✅ |
| `design.md` exists (complex tasks) | ✅ |
| `implement.md` exists (complex tasks) | ✅ |
| `implement.jsonl` and `check.jsonl` each contain at least one real curated entry (seed row does not count) | ✅ |
| Execution mode chosen; `meta.execution=parallel` set when parallel | ✅ |

---

## Phase 2: Execute

Goal: turn reviewed planning artifacts into code whose review loop comes back clean. Dispatch mechanics (header protocol, the two paths, snapshots, target selection) are in the Dispatch subsection of the Arbor System section. Serial mode uses 2.1–2.3 below; parallel mode (`meta.execution=parallel`) uses Phase 2P instead. Complex tasks continue with Phase 2F afterwards.

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

#### 2.2 Review loop `[required · repeatable]`

Follows Claude Code's `/code-review`: finders surface candidates, an independent verifier filters them when finders do not self-filter, a fixer applies them.

1. **Scope**: `python3 ./.arbor/scripts/dispatch.py diff $S0 --name r1` writes the diff and prints its path; stderr shows the changed-line count.
2. **Find**:
   - Lightweight task, or complex task with under 300 changed lines: one **review** with `Mode: self-check` and `Diff: <path>`. Lightweight briefs add `Angles: A, B, C, D, E, Conventions, Acceptance, Cleanup-lite`.
   - Complex task with 300+ changed lines: three **review** roles in parallel with `Mode: candidates`, angles `A, D` / `B, Conventions` / `C, E`.
   - Every brief carries the task goal and the acceptance criteria.
3. **Dedup** (candidates mode): merge all JSON findings; one entry per line or mechanism, keeping the most concrete failure scenario.
4. **Verify** (candidates mode): dispatch **verify** with the same `Diff:` and the deduplicated candidates as JSON in the brief, at most 8 candidates per verify run, runs in parallel. Keep CONFIRMED and PLAUSIBLE.
5. **Fix**: when findings remain, dispatch **fix** with `Diff:` and the findings JSON. Snapshot first: `F0=$(dispatch.py snapshot)`.
6. **Re-review**: `dispatch.py diff $F0 --name r2` and one **review** `Mode: self-check` on that fix delta only. Loop fix → re-review at most **2 rounds**; still FAIL after that: stop and report to the user.

Findings you judge invalid may stay unfixed; record them and list them in the final summary.

#### 2.3 Rollback `[on demand]`

- Review reveals a prd defect → return to Phase 1, fix `prd.md`, then redo 2.1
- Implementation went wrong → revert code, redo 2.1
- Need more facts → dispatch the explore role (same as Phase 1.2), write findings into `research/`
- A dispatch failed, timed out, or returned nothing useful → read its result, tighten the brief, and re-dispatch (optionally with a different `Target:`). Network or rate-limit errors: lower the parallelism and retry. Do not silently do the role's work in the main session.
- Any step stuck after 2 retries: stop and report; do not retry indefinitely.

---

## Phase 2P: Execute (parallel variant)

Applies only when the parent task has `meta.execution=parallel`. Goal: implement independent child tasks concurrently, each in its own git worktree, then merge serially. Use it instead of 2.1–2.2; Phase 2F and Phase 3 run on the parent task afterwards.

Invariants: sub-agents never commit, merge, or touch paths outside their worktree, and never write under `.arbor/`. The `Active task:` header line is **always** the absolute path of the task directory in the MAIN checkout, even when `working_dir` is a worktree (the `.arbor/tasks` copy inside a worktree is read-only noise). Runtime state (`.arbor/.runtime`, `.arbor/.developer`) is resolved from the main checkout only.

#### 2P.0 Split `[required · repeatable]`

Start from the chosen architect's parallel split. Write the waves and file ownership into the parent `implement.md`: which child owns which files, the interface contracts between children, and which children must wait for others. Children in the same wave must not modify the same file. Create each child:

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

with `working_dir=<worktree path>`; the brief carries the child's part of the design, its owned files, and the interface contracts. Collect all `task_id`s and wait with `get_delegation_status(task_ids, wait_ms=60000)`; in a terminal use `dispatch.py run --role implement --task <child-dir> --workspace <worktree> --detach` then `dispatch.py wait`. Handle failures as in 2.3, per child.

#### 2P.3 Review loop + commit `[required · repeatable]`

Run the 2.2 loop in every worktree, all children in the same batch: scope with `dispatch.py diff <task-branch> -C <worktree> --name <child>-r1`, `working_dir` = the worktree, `Active task` = that child, `Workspace` = its worktree. Also check that the child touched only its owned files. When a child is green, commit it yourself inside its worktree: `git -C <worktree> add -A && git -C <worktree> commit -m "<msg>"`.

#### 2P.4 Merge `[required · repeatable]`

In the main checkout, on the task branch, merge children serially: `git merge --no-ff wip/<parent>/<child>`. Resolve conflicts yourself after understanding both sides. Run the project checks after each merge; small breakage you fix yourself, larger breakage goes to a fix dispatch. More waves: return to 2P.1 with worktrees based on the merged task branch.

#### 2P.5 Cleanup `[required · repeatable]`

```bash
git worktree remove "$WT_ROOT/<parent>-<child>"
git branch -d "wip/<parent>/<child>"
```

for every merged child. Then continue with Phase 2F on the parent task (diff base = the task branch's starting commit), and Phase 3. `/arbor:finish-work` archives the parent and its children.

---

## Phase 2F: Polish

Goal: code that is simple, free of duplication, correct, and meets every acceptance criterion. Runs for complex tasks after Phase 2 or 2P; lightweight tasks run only 2F.5. Follows Claude Code's `/simplify` and high-effort `/code-review` (find → verify → sweep). `S0` is the snapshot from 2.1, or the task branch's starting commit after 2P.

#### 2F.1 Simplify `[required · once]`

`dispatch.py diff $S0 --name whole` and dispatch **simplify** with `Diff:` set to it. Snapshot before (`P0`). If it changed anything, `dispatch.py diff $P0 --name simplify` and dispatch one **review** `Mode: self-check` on that delta with the brief "confirm behavior is unchanged". Problems go back through **fix**.

#### 2F.2 Final review `[required · once]`

On the whole diff (`dispatch.py diff $S0 --name final`):

1. Five **review** roles in parallel, `Mode: candidates`, angles `A` / `B` / `C` / `D, E` / `Conventions, Acceptance`.
2. Dedup, then **verify** (at most 8 candidates per run, in parallel). Keep CONFIRMED and PLAUSIBLE.
3. One **review** `Mode: sweep` with the verified list in the brief; send its new candidates through **verify** too.

#### 2F.3 User decision `[on demand]`

Only when findings survive: present them once, most severe first, each with your recommendation (CONFIRMED: fix now; PLAUSIBLE: your call with reasoning), and ask: fix now, fix later, or leave as is. No surviving findings: go straight to 2F.5.

#### 2F.4 Fix `[on demand]`

Dispatch **fix** with the chosen findings, then one **review** `Mode: self-check` on the fix delta (same 2-round limit as 2.2).

#### 2F.5 Quality checks `[required · once]`

Run every affected package's spec Quality Check commands yourself (`python3 ./.arbor/scripts/get_context.py --mode packages` lists the packages and their spec indexes). Lightweight tasks run this right after 2.2. Failures go back to a fix dispatch.

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
| Phase 2 + 2F + Phase 3.2–3.4, serial (implementation + review + polish + wrap-up) | `[workflow-state:in_progress]` (after Phase 2 summary) |
| Phase 2P + 2F + Phase 3.2–3.4, parallel (task has `meta.execution=parallel`) | `[workflow-state:in_progress-parallel]` (right after `in_progress`) |
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
