# Development Workflow

---

## Core Principles

1. **The contract is the spine** — `contract.md` says what "done" looks like and how it is checked; the human approves the scope; the main agent judges later edits in context and seeks approval only for material scope changes
2. **The driver owns control, you own judgment** — `arbor.py` records state, counters, executable checks and observations; you (the main agent, the user's session) propose the tier, write the contract, split work into child tasks, curate context, write the briefs, classify red gates and retry within the contract
3. **Verification is a ladder** — deterministic checks → review (candidates + independent verify in standard / full) → sweep (full); a red rung never climbs
4. **Many readers, one writer** — read-only roles run in parallel; each branch has one writer at a time
5. **Git-native** — a task is a worktree plus a branch; writers commit; a diff is a commit range; merges are `--no-ff`
6. **Persist everything** — research, decisions and lessons go to files; conversations get compacted, files don't

---

## Arbor System

### Developer Identity

```bash
python3 ./.arbor/scripts/init_developer.py <your-name>   # once; creates .arbor/.developer + .arbor/workspace/<name>/
```

### Spec System

`.arbor/spec/<package>/<layer>/index.md` holds the coding guidelines per package and layer (Pre-Development Checklist + Quality Check); `.arbor/spec/guides/index.md` the cross-package thinking guides. `python3 ./.arbor/scripts/get_context.py --mode packages` lists them. Update the spec when a new pattern, a bug-fix prevention or a technical decision deserves to outlive the task.

### Task System

Every task has its own directory `.arbor/tasks/{MM-DD-name}/` holding `task.json`, `contract.md`, optional `design.md` and `waves.md`, optional `research/`, `briefs/`, `reports/`, and the context manifests `implement.jsonl` / `check.jsonl`.

```bash
python3 ./.arbor/scripts/task.py create "<title>" --description "<one-line summary>" [--slug <name>] [--tier light|standard|full] [--parent <dir>] [--mandate "contract=auto,merge=ask"]
python3 ./.arbor/scripts/task.py start <name>          # contract approved: record its hash, create the task worktree + branch, commit
python3 ./.arbor/scripts/task.py current --source      # show active task and source
python3 ./.arbor/scripts/task.py archive <name>        # move to archive/{year-month}/ (arbor.py finish does this for a merged task)
python3 ./.arbor/scripts/task.py list [--mine] [--status <s>] | list-archive
python3 ./.arbor/scripts/task.py seed-context <name> [--package <pkg> ...]   # fill both manifests: spec indexes, guides index, research/
python3 ./.arbor/scripts/task.py add-context <name> <implement|check> <file> <reason>
python3 ./.arbor/scripts/task.py list-context <name> [action] | validate <name>
python3 ./.arbor/scripts/task.py set-base-branch <name> <branch> | set-meta <name> <key> <value>   # e.g. tier standard
python3 ./.arbor/scripts/task.py add-subtask <parent> <child> | remove-subtask <parent> <child>
python3 ./.arbor/scripts/task.py finish                # only to clear a stale session pointer
```

`task.py create` creates the task directory in this checkout and points this session at it. `task.py start` records `contract_hash`, creates branch `arbor/<task>` and its worktree `<worktree.root>/<task>` from the current HEAD, moves the task directory into that worktree, commits it as `contract(<task>): approve contract`, sets `state=BUILD` and points the session at the task directory inside the worktree. Session state lives under `.arbor/.runtime/sessions/` in the main checkout; without a context key (hook input or `ARBOR_CONTEXT_ID`) there is no active task and `start` fails with a session identity hint. Central polyrepo tasks (`packages.<name>.git: true`) are described in the appendix.

### Workspace System

`.arbor/workspace/<developer>/journal-N.md` records every session (2000 lines per file, then `journal-(N+1).md`); `index.md` is the personal index. `arbor.py finish` writes the entry of a merged task; `python3 ./.arbor/scripts/add_session.py --title "…" --commit "<hash>" --summary "…"` records anything else.

### Context Script

```bash
python3 ./.arbor/scripts/get_context.py                            # full session runtime
python3 ./.arbor/scripts/get_context.py --mode packages            # available packages + spec layers
python3 ./.arbor/scripts/get_context.py --mode phase --step <X.Y>  # detailed guide for a workflow step
```

---

## Driver

`arbor.py` owns role preparation, task state, deterministic checks, report parsing, Git observations, metrics and state transitions. Two kinds of agent talk to it:

- **Main agent** — the user's session, normally one codeg conversation per task (Claude Code or Codex): Phase 1, task creation and start, the Phase 2 loop, the questions it puts to the user, the merge gate.
- **Roles** — dispatched by `arbor.py run` and executed through codeg MCP as a sub-agent session of its own; the driver prepares the prompt and validates the reply. Never perform a role yourself and never use native Agent/Task/spawn_agent for one.

```bash
python3 ./.arbor/scripts/arbor.py next [--json] [--partition P] [--role explore|architect|review]   # the single next step; the ready set
python3 ./.arbor/scripts/arbor.py run [--dispatch d-NNN] [--partition P]                             # dispatch the brief you just wrote
python3 ./.arbor/scripts/arbor.py run --role explore|architect|review [--mode plan] [--dispatch d-NNN]   # CONTRACT phase, before task.py start
python3 ./.arbor/scripts/arbor.py run --role review --mode sweep --range <before>..<base>             # a parent task reviewing its merged children
python3 ./.arbor/scripts/arbor.py gate                        # GATE: gate.commands + the contract's auto checks (a parent: in the integration worktree)
python3 ./.arbor/scripts/arbor.py decide <choice> --reason "…"   # impl | contract (red gate) · fix | skip (PLAUSIBLE) · accept --report <file> | retry (ambiguous report)
python3 ./.arbor/scripts/arbor.py finish [--pr]               # FINISH: scorecard + PR / merge command; after the merge: cleanup
python3 ./.arbor/scripts/arbor.py children [--json] [--cleanup]   # a parent task: every child's state and merge status; cleanup after the integration merge
python3 ./.arbor/scripts/arbor.py override --reason "…" (--to STATE[/step] | --role <role> [--mode M])   # one step off the state table; recorded in the scorecard
python3 ./.arbor/scripts/arbor.py status | resume | abandon [--reason "…"]
python3 ./.arbor/scripts/arbor.py prompt --dispatch d-NNN --print   # rebuild the assembled prompt of a dispatch
```

Every command takes `--task <dir>` before the command name (default: this session's active task; pass it for a child task driven from a conversation of its own). Exit codes: 0 ok, 1 refused / failed dispatch / red gate, 2 usage error.

### `next --json`

Always carries `task`, `state`, `needs` and `summary`; depending on `needs` also `role`, `mode`, `range`, `dispatch`, `brief_path`, `batch`, `decision`, `human` and `touched_files` (what the task changed so far: read it instead of re-exploring). `batch` lists the readers of the current step that run concurrently (REVIEW candidates: standard 2, full 3; the verify batches of 8 candidates): write every brief, then start each with `arbor.py run --dispatch <id>`. After start it also carries the **ready set**: `items` (every step you can act on now: the current step, every other reader of its batch, every other partition that needs a brief, every prepared delegation not yet sent), `running` (delegations and readers in flight) and, when `items` is empty, `blocked_on`. Act on every item in one turn, then wait once for what is running; never add items yourself. Before `task.py start` it answers `state: CONTRACT`, `needs: human` (`approve_contract`) plus the next `dispatch` id and its `brief_path`.

| `needs` | Meaning | Do |
|---|---|---|
| `brief` | a role must run | write the brief for `role` at `brief_path`, then `arbor.py run` |
| `delegation` | a prepared codeg MCP request is pending | delegate once and bind, or poll/resume `task_id`; collect its terminal JSON (the sync hook does both) |
| `run` | deterministic driver work | `arbor.py gate` for GATE; `arbor.py run` for a wave start or wave merge |
| `wait` | every ready partition or reader is running | wait for the running delegations, then `next` again |
| `decide` | a judgment the driver cannot make | `arbor.py decide <choice> --reason "…"`; `contract` → fix the contract with the user, then `arbor.py resume` |
| `human` | `human.kind`: `approve_contract` · `plausible` · `stop` · `merge_conflict` · `merge` | see Human Gates; `human.mandate` says `ask` or `auto` |
| `done` | nothing left | stop |

### Dispatch protocol (codeg MCP)

`arbor.py run` assembles the prompt at `.arbor/.runtime/prompts/<task>/d-NNN.md` and returns `needs=delegation` with `mcp.arguments`: call codeg MCP `delegate_to_agent` once with them (the `task` text is the dispatch header plus a `Prompt:` line; the role reads that file first; resolve the named assistant from the MCP roster when no id is configured). The Arbor PostToolUse hook (`.claude/hooks/sync-delegation.py` / `.codex/hooks/sync-delegation.py`) then runs `arbor.py bind --request <request_path> --task-id <id>` and, after each terminal `get_delegation_status` reply, saves the complete JSON and runs `arbor.py collect --request <request_path> --result <file>`; its note tells you what it did. Run them by hand only when the note says so or no hook is installed. Claude Code and Codex both use this same MCP flow. Resume/poll a bound task after interruptions; never delegate it again. If `timeout_s` expires, `cancel_delegation` and collect the terminal report. Request records live in `.arbor/.runtime/delegations/<task>/<dispatch>.json`; a collected request cannot be collected twice.

**Dispatch header.** The driver writes it; you never type it:

```
Active task: <absolute path of .arbor/tasks/<task> inside the task worktree>
Role: explore | architect | implement | review | verify | fix | simplify
Mode: self-check | candidates | sweep | plan        (review only)
Range: <base>..<head>                               (roles that read or write a diff)
Dispatch: d-NNN
Prompt: <absolute path of .arbor/.runtime/prompts/<task>/d-NNN.md>
```

Then the injected context (`implement.jsonl` for architect / implement, `check.jsonl` for review / verify / fix / simplify; `contract.md`, `design.md`, `waves.md`, `git diff <Range>`), then your brief. The brief is committed as `briefs/d-NNN.md`, the reply plus the driver's verdict as `reports/d-NNN.md`.

**Briefs.** The role cannot see your conversation. A brief carries what the artifacts do not: the essential files to read first, decisions already made, known pitfalls, files to stay out of; for review the `Angles:` line; for verify and fix the findings JSON. Do not paste the contract or the diff; the driver injects them. Never ask a role to dispatch another role.

**Judgment, not automation.** File / role / commit observations never automatically STOP a task or reset work: the main agent inspects the diff, the raw report and concurrent activity. An ambiguous report is collected with status `judgment` and `next` returns `needs=decide`: `arbor.py decide retry --reason "…"`, or interpret it yourself and `arbor.py decide accept --report <file> --reason "…"` (the interpretation uses the role's structured format; no implicit PASS). Contract drift is an observation; scope and acceptance changes still need the user. Round caps are escalation gates: `NO_PROGRESS` (two rounds without progress) or `BUDGET` (4 consecutive red gates, 2 review fix rounds) enter STOP.

**CONTRACT-phase dispatch.** Before `task.py start` you can dispatch `explore`, `architect` and `review` (`Mode: plan`): `arbor.py next --role <role> --json` names the next `dispatch` id and its `brief_path`; write the brief; `arbor.py run --role <role> [--mode plan] --dispatch <id>`. It runs in the main checkout with no `Range:` and commits nothing; `explore` / `architect` may write only `<task>/research/`, `review` nothing. Independent angles run concurrently with no quota (prepare and delegate each one; `next --json` lists `pending_delegations`); dependent questions wait for their prerequisites; the plan review and `task.py start` wait until every reader is collected. Each reader owns `research/<dispatch>-*.md`; you consolidate the evidence into `design.md`, `contract.md`, `waves.md` and the manifests. Dispatch ids continue after start.

**Multi-partition waves.** When the contract's current wave names more than one partition, `arbor.py run` gives each partition its own branch `arbor/<task>--<p>` and worktree `<worktree.root>/<task>-<p>`; `next --json` carries `partition` and `partitions_pending`. Write each brief at its `brief_path`, then `arbor.py run --partition <p>` for each (they run at the same time; keep to `executors.codeg.max_parallel`). A partition's writer must stay within its paths; a change outside them (the task directory aside) stops the merge as `human` / `merge_conflict` with `reason: scope`: ask the user whether to revert it on the partition branch (then `resume` merges) or to merge by hand. When every partition is done, `arbor.py run` merges the branches `--no-ff` in wave order; a conflict becomes `human` / `merge_conflict`: merge by hand in the task worktree, commit, `arbor.py resume`.

**Sub-agent self-exemption.** If your own first prompt starts with `Active task:` + `Role:`, you are a dispatched role: do that role's work directly, never run `arbor.py` or `task.py start/current/finish`, never dispatch anything, never push, merge or rebase.

### Roles

Role instructions live in `.arbor/agents/<role>.md`.

| Role | Writes | Commits | Output |
|---|---|---|---|
| `explore` | `.arbor/tasks/<task>/research/**` | no | findings + 5–10 essential files |
| `architect` | `.arbor/tasks/<task>/research/**` | no | one blueprint + partition / wave suggestion |
| `implement` | anything (code and tests) | yes, own branch | Complete / Partial / Blocked + verification (every auto check green) |
| `fix` | as implement; never weakens a test to pass | yes, own branch | fixed / skipped per finding |
| `simplify` | as implement, tests untouched | yes, own branch | behavior-preserving cleanup, or "no change" |
| `review` | nothing | no | first line `PASS` / `FAIL` + findings JSON |
| `verify` | nothing | no | CONFIRMED / PLAUSIBLE / REFUTED per candidate |

Every role: no push, no merge, no rebase, no checkout of other branches, no writes under `.arbor/` except `tasks/<task>/`. Commit format: `<role>(<task-dir-name>): <summary>` with trailer `Arbor-Dispatch: d-NNN`.

### Parent / Child Task Trees

Use a parent task when one user request contains several independently verifiable deliverables. The parent owns the requirement set, the task map, the cross-child acceptance criteria and a `## Children` list (deliverable, paths it owns, depends-on); it normally has no implementation work of its own. Children are created with `task.py create … --parent <parent-dir>` (or linked with `task.py add-subtask <parent> <child>`). Parent/child structure is not a dependency system: ordering between children is written in the child contracts, not implied by the tree; start the child that owns the next independently verifiable deliverable. Do not start the parent.

**Children run in parallel on the parent's integration branch.** Starting the first child of an unstarted parent creates `arbor/<parent>` (cut from the checked-out branch, worktree `<worktree.root>/<parent>`, recorded in the parent's `task.json.integration`); every child is cut from it and merges back into it. Each started child is driven from a session of its own (every `arbor.py` call with `--task <child>`); `arbor.py --task <parent> children` shows every child's state, merge status and whether it is behind the integration branch. A child's FINISH needs no human: `arbor.py finish` merges the integration branch into the child when it is behind, runs the gate, checks the scope (partition paths) and that no product commit came after the last review PASS, then merges the child `--no-ff` into the integration branch and archives it there; a failed check prints why and leaves a human merge (`human.kind: merge`). When every child is merged, the parent's session runs the integration review (`arbor.py --task <parent> run --role review --mode sweep --range <sweep_range>` from `children --json`, brief at the `brief_path` from `next --role review --json`), dedups the findings, fixes them as a light child (or directly when ≤ 2 files), runs `arbor.py --task <parent> gate`, then asks the user to merge the integration branch into the baseline with the printed `--no-ff` command (always the user's). Afterwards `arbor.py --task <parent> children --cleanup` writes the journal entry and removes the integration worktree and branch, then `task.py archive <parent>`. A child created with `--base-branch <b>` opts out and merges into `<b>` by a human like any task.

---

<!--
  WORKFLOW-STATE BREADCRUMB CONTRACT (read this before editing the tag blocks below)

  The per-turn `<workflow-state>` breadcrumb (UserPromptSubmit hook,
  inject-workflow-state.py) has two sources:

  1. Active task: the hook runs `.arbor/scripts/arbor.py next --json` and
     injects its one-line `summary` plus `needs`.
  2. No active task, an unreadable task record, or a driver that is missing
     or fails: the [workflow-state:STATUS] blocks below. They are the single
     source of that text; the hook has no fallback dict.

  STATUS charset: [A-Za-z0-9_-]+. KEY SELECTION: the first block that exists
  of <status>-<tier>, then <status>.

  PARSER TRAP: a line that ENDS with a `[workflow-state:X]` token opens a
  block for the parser and swallows the real one. Never end a prose or
  comment line with such a token; write "the no_task block" instead.

  TAG ↔ PHASE scoping:
    no_task      → no active task; triage before Phase 1
    task_error   → active task record is unreadable; repair it before continuing
    planning     → Phase 1 (status='planning')
    in_progress  → Phase 2 / 3 when the driver summary is unavailable
    completed    → archived task (normally unreachable: archive moves the dir)

  SessionStart injects `## Phase Index` up to `## Phase 1: Plan` (tag blocks
  stripped): keep that region short; it is loaded into every session.
-->

## Phase Index

```
Phase 1: Plan    → INTAKE (tier, consent) → CONTRACT (explore, one question list, contract.md, design, seed-context, validation, full: plan review, approval, task.py start)
Phase 2: Drive   → the `arbor.py next` loop: BUILD (implement: code + tests) → GATE → REVIEW (light: self-check → fix; standard / full: simplify → candidates → verify → fix → re-review the delta; full: + sweep) → FINISH
Phase 3: Finish  → spec update → `arbor.py finish` (scorecard + PR / merge command) → human `--no-ff` merge → `/arbor:finish-work` (cleanup, archive, journal); child: automatic merge into the parent's integration branch; parent: sweep review, gate, human merge, children --cleanup
```

### State Machine

| State | Entered when | Who | What happens | Leaves to |
|---|---|---|---|---|
| INTAKE | `/arbor:workflow <request>` | you → human | propose a tier with a one-line reason; the human answers ok / light / standard / full | consent → `task.py create` → CONTRACT |
| CONTRACT | task directory exists | you + explore / architect + human | explore → one question list → `contract.md` (+ `design.md`; full: architecture perspectives → `waves.md`) → `seed-context` → structural validation → full: review `Mode: plan` → human approves | `task.py start` → BUILD |
| BUILD | a wave is pending | you + driver + implement | `implement` delivers code and tests and runs every `auto` check green before committing; a wave of several partitions runs one implement per partition in parallel | GATE |
| GATE | the task branch has new commits | driver → you | `gate.commands` + every `auto` row of the Verification map. Green → next wave or REVIEW. Red → you classify: `impl` (`fix`) / `contract` (edit the contract; the human re-approves) | 4 consecutive reds → STOP |
| REVIEW | GATE green, all waves done | simplify, review, verify, fix, human | light: one `review` `Mode: self-check` over `last_reviewed..HEAD` → findings → `fix` → GATE → re-review the delta. standard / full: `simplify` → GATE → N `review` `Mode: candidates` (2 / 3, in parallel) → mechanical prefilter → `verify` (≤ 8 per reader, in parallel) → CONFIRMED → `fix`, PLAUSIBLE per mandate → GATE → next cycle over the delta; full: one `sweep` over the whole range once the cycle is clean, its candidates verified too | PASS / clean → FINISH; 2 fix rounds or no progress → STOP |
| FINISH | REVIEW done | you (`arbor.py finish`) + human | one `arbor.py finish`: `scorecard.md`, then the PR (`--pr`) or the printed `--no-ff` merge command (`merge=auto`: merges a small clean branch itself; a child: merges into the integration branch itself); after the human merge `arbor.py finish` again cleans up: worktree, archive, journal | DONE |
| STOP | a round cap (`BUDGET`), no progress (`NO_PROGRESS`), explicit abandon (`HUMAN`) | you + human | inspect the reason and evidence; no automatic recovery | `arbor.py resume` (BUDGET: one more round), `override --reason`, a re-plan, or `abandon` |

Progress (only the driver changes counters): a GATE round progresses when the set of failing AC ids shrinks; a REVIEW round when its set of finding ids changes.

### Tiers

Simple changes (at most 2 files, cause known, no design choice) do not use Arbor at all.

| | light | standard | full |
|---|---|---|---|
| Fits | one deliverable, a few files, existing patterns suffice | a feature or refactor across files or layers that needs a written design | several deliverables, contested design, risky migration |
| Contract artifacts | `contract.md` | + `design.md` | + architecture perspectives → `waves.md`; review `Mode: plan` |
| BUILD | one implement | partitions per the contract | partitions + waves |
| REVIEW | 1 self-check reviewer → fix | simplify → 2 candidate readers → verify → fix | simplify → 3 candidate readers → verify → fix → sweep |
| Human gates | tier · merge | + contract | + contract · PLAUSIBLE |
| Sessions | one | one | one per child task, concurrently |

The tier lives in `task.json.meta.tier` (`task.py create --tier <t>`, later `task.py set-meta <task> tier <t>`); without it the tier is inferred from the artifacts (`waves.md` → full, `design.md` → standard, else light).

### Human Gates

1. **Tier** (INTAKE): the human agrees to the proposed tier.
2. **Contract** (end of CONTRACT): the human approves `contract.md`; material changes to scope or acceptance need approval; editorial changes do not.
3. **PLAUSIBLE** (REVIEW, only when PLAUSIBLE findings survive verify): fix or skip, asked once, most severe first with your recommendation.
4. **Merge** (FINISH): the human merges with `--no-ff`.

`next --json` names each gate's mandate (`human.mandate`: `ask` or `auto`, from `mandate:` in `.arbor/config.yaml` per tier — light: contract auto; standard: plausible auto; full: everything ask; merge is `ask` in every tier unless the user opts in — or per task with `task.py create --mandate "contract=auto,merge=ask"`). With `auto` you proceed without asking; the driver itself skips PLAUSIBLE findings and, with `merge=auto`, merges a small clean, in-scope, reviewed branch. STOP, `merge_conflict` and scope changes are always put to the user. Everything else (red-gate classification, finding dedup, report interpretation, retries within the contract) is yours.

### Task Artifacts

`contract.md` sections (the driver parses them; keep the headings):

| Section | Content |
|---|---|
| `## Goal` | one paragraph |
| `## Scope` | in / out |
| `## Acceptance criteria` | `AC-n: Given <precondition> When <action> Then <observable result>` |
| `## Verification map` | table `id \| kind \| check \| file`; `kind` is `auto` (a command that passes once the criterion holds; implement creates the test file) or `manual` |
| `## Interface pins` | optional: signatures, paths, CLI / HTTP shapes the design fixes up front (needed when partitions build against each other) |
| `## Partitions` | `name: globs`, non-overlapping (optional; absent = one `default` partition) |
| `## Waves` | `n: [partitions]` (optional; absent = one wave) |

Structural validation (before approval): every AC has a map row; every `auto` row has a command; partitions do not overlap; waves name existing partitions.

Other artifacts: `design.md` (standard / full: boundaries, contracts, data flow, trade-offs, rollback) · `waves.md` (full: the chosen partitions and wave order with the reasoning) · `research/` (explore findings `<dispatch>-<topic>.md`, architect blueprints `<dispatch>-design-<perspective>.md`) · `implement.jsonl` / `check.jsonl` (spec and research manifests the driver inlines; never code files) · `briefs/`, `reports/` · `scorecard.md` (FINISH: dispatches per role, GATE / REVIEW rounds, findings per rung, AC automation rate, overrides, violations, recurring CONFIRMED categories).

### Request Triage

- Classify first. A simple change (at most 2 files, cause known, no design choice) is done in this session without Arbor: read, edit, run the project's checks, propose one commit message and ask once. Unsure: treat it as light.
- Anything larger: in one message propose a tier (light / standard / full) with a one-line reason and ask whether to create a task. The user answers ok / light / standard / full / no. `/arbor:workflow <request>` already counts as consent to the task, not to the tier. Task consent is not contract approval.
- If the user declines a task for non-simple work, do not implement broadly inline: explain, clarify scope, or suggest a smaller split. Plain questions need no task.

### Active Task Routing

Inside an active task, route first, then load the phase step if needed.

- Planning or unclear requirements → `arbor-brainstorm`.
- Questions about code → read the files yourself, or an `explore` brief through `arbor.py run --role explore`.
- A started task → `arbor.py next`: do the one thing it names; never perform a role in this session.
- Repeated debugging → `arbor-break-loop`; spec updates → `arbor-update-spec`.

<!-- Per-turn breadcrumb: shown when there is no active task (before Phase 1) -->

[workflow-state:no_task]
No active task. Classify the request before acting (Request Triage).
Simple (at most 2 files, cause known, no design choice): do it here without Arbor: read, edit, run the project's checks, propose one commit message and ask once. Unsure: treat it as light.
Anything larger: in one message propose a tier (light / standard / full) with a one-line reason and ask whether to create a task; the user answers ok / light / standard / full / no. On yes: `task.py create "<title>" --description "<summary>" --slug <name> --tier <tier>` (1.0), then write the contract. Task consent is not contract approval.
If the user declines a task for non-simple work, do not implement broadly inline: explain, clarify scope, or suggest a smaller split. Plain questions need no task.
[/workflow-state:no_task]

<!-- Per-turn breadcrumb: shown when the active task record cannot be read. -->

[workflow-state:task_error]
The active task record could not be read. Do not create or activate another task.
Inspect the task directory named above and repair its task.json. It must be a valid JSON object with a non-empty status.
Preserve existing task fields and artifacts. If the correct status cannot be determined safely, ask the user before reconstructing the record.
[/workflow-state:task_error]

### Phase 1: Plan
- 1.0 Intake & create task `[required · once]` (tier proposal → consent → `task.py create --tier`)
- 1.1 Explore `[repeatable]`
- 1.2 Questions `[required · once]` (one numbered list, then wait)
- 1.3 Write the contract `[required · repeatable]` (`contract.md`)
- 1.4 Design `[required · once; standard / full]` (standard: `design.md`; full: architecture perspectives → `design.md` + `waves.md`)
- 1.5 Configure context `[required · once]` (`task.py seed-context`, then adjust the manifests)
- 1.6 Validate & plan review `[required · once]` (structural validation; full: review `Mode: plan`)
- 1.7 Approve & start `[required · once]` (planning summary → human approves the contract → `task.py start`)

<!-- Per-turn breadcrumb: shown throughout Phase 1 (status='planning'), every tier -->

[workflow-state:planning]
Phase 1, CONTRACT. The tier is in the header; change it with `task.py set-meta <task> tier <tier>`.
Explore (1.1) → ask every open question as ONE numbered list and wait (1.2) → write `contract.md`: Goal, Scope, Acceptance criteria (Given/When/Then), Verification map, optional Interface pins / Partitions / Waves (1.3) → standard: `design.md`; full: architecture perspectives → `design.md` + `waves.md` (1.4) → `task.py seed-context <task>` (1.5) → structural validation; full: one review `Mode: plan` (1.6).
Roles here: write the brief at the `brief_path` from `arbor.py next --role <role> --json`, then `arbor.py run --role explore|architect|review [--mode plan] --dispatch <id>`; it runs in the main checkout through codeg MCP and commits nothing; independent angles run concurrently.
Multi-deliverable scope: a parent task plus independently verifiable child tasks (`task.py create --parent`); dependencies are written in child contracts, not implied by tree position.
Approve (1.7): end the planning summary with the approval question; run `task.py start <task>` only after a later user message approves the contract.
[/workflow-state:planning]

### Phase 2: Drive
- 2.1 The loop `[required · repeatable]` (`arbor.py next` → do the one thing it names)
- 2.2 Write a brief `[required · repeatable]`
- 2.3 BUILD (implement: code + tests, auto checks green)
- 2.4 GATE and decide `[on demand]`
- 2.5 REVIEW (light: self-check; standard / full: simplify → candidates → verify → fix; full: + sweep)
- 2.6 STOP, resume, override `[on demand]`

<!-- Per-turn breadcrumb: fallback only. Normally the hook shows the driver's
     own one-line next step instead of this block. -->

[workflow-state:in_progress]
The driver did not answer. Run `python3 ./.arbor/scripts/arbor.py next` and do the one thing it names: `brief` → write it at its path, then `arbor.py run`; `delegation` → `delegate_to_agent` with the returned `mcp.arguments` (the sync hook binds and collects); `run` → `arbor.py gate` / `arbor.py run`; `decide` → `arbor.py decide <choice> --reason "…"`; `human` → `approve_contract` / `plausible` / `stop` / `merge_conflict`: ask the user, then `decide` or `resume`; `merge` → Phase 3. If `arbor.py` is missing, run `arbor update`.
Roles run only through `arbor.py run` and codeg MCP from the main session only; never use the built-in Agent/Task tool or perform a role in this session. Sub-agent self-exemption: if you are a dispatched sub-agent (your prompt starts with `Active task:` / `Role:`), perform that role directly and do not run arbor.py.
[/workflow-state:in_progress]

### Phase 3: Finish
- 3.1 Spec update `[required · once]`
- 3.2 Debug retrospective `[on demand]`
- 3.3 Scorecard, PR and merge `[required · once]` (`arbor.py finish`; the human merges with `--no-ff`)
- 3.4 Cleanup, archive, journal `[required · once]` (`/arbor:finish-work`)

<!-- Per-turn breadcrumb: shown while status='completed'. Normally unreachable:
     `task.py archive` writes the status and moves the directory in one call,
     so the session pointer is gone before the next prompt. -->

[workflow-state:completed]
Task archived. Run `/arbor:finish-work` to record the session.
[/workflow-state:completed]

### Rules

1. `arbor.py next` is the source of truth for where a started task is; do the one step it names
2. Only the driver changes `task.json` state and counters, prepares and validates roles, and runs the gate
3. You review contract changes against the user's authorization; substantive replanning goes back to the user for re-approval before `arbor.py resume`
4. Steps tagged `[once]` are skipped when their output already exists
5. Inside an Arbor task, never perform a role in this session and never use the built-in Agent/Task tool for one; every role goes through `arbor.py run` and codeg MCP

### Loading Step Detail

`python3 ./.arbor/scripts/get_context.py --mode phase --step <X.Y>` (e.g. `--step 1.3`) prints one step's full instructions from Phase 1 / 2 / 3 below.

---

## Phase 1: Plan

Goal: an approved contract that says what done looks like and how each criterion is checked.

#### 1.0 Intake & create task `[required · once]`

Propose a tier with a one-line reason (see Tiers) and wait for the user's answer. `/arbor:workflow <request>` counts as consent to create a task. Then `python3 ./.arbor/scripts/task.py create "<task title>" --description "<one-line summary>" --slug <name> --tier <light|standard|full>` (status `planning`, `task.json`, a `contract.md` skeleton, the session pointer; `--slug` has no `MM-DD-` prefix). For task trees, create the parent first, then each child with `--parent <parent-dir>`. Skip when `task.py current --source` already points to a task.

#### 1.1 Explore `[repeatable]`

Facts first. Answer small questions by reading a few files yourself. Otherwise run `explore` roles, one aspect each, as CONTRACT-phase dispatches (`arbor.py next --role explore --json` → brief → `arbor.py run --role explore --dispatch <id>`; independent angles run concurrently, no total quota); each writes `research/<dispatch>-<topic>.md` and returns 5–10 essential files. Read only the 2–3 files you need for the next step; the research files are injected into later roles.

#### 1.2 Questions `[required · once]`

Compare the findings with the request and list what is still open: product intent, scope edges, error handling, compatibility, interfaces. Put every open question to the user **as one numbered list**, each with the decision, why it matters, your recommendation and the trade-off, and wait for one round of answers. "Your call" → state your choice and get it confirmed.

#### 1.3 Write the contract `[required · repeatable]`

Fill `contract.md` (sections in Task Artifacts). Every acceptance criterion is observable (Given / When / Then, no "works correctly"); every criterion has a Verification map row, preferably `auto` with a command that selects its tests (`-t AC-n` filters work well) and names the test file implement will create; Interface pins only when partitions or a design need them fixed up front. Return here whenever an answer, a design choice or a red gate changes what done means.

#### 1.4 Design `[required · once; standard / full]`

- **Standard**: write `design.md` yourself (boundaries, contracts, data flow, trade-offs, rollback); run `architect` angles when uncertainty warrants it.
- **Full**: choose independent `architect` angles as needed (no fixed count); run independent questions concurrently, sequence dependent ones. Consolidate the designs, conflicts, trade-offs and proposed partitions / waves; after the necessary user decisions write `design.md`, add `## Partitions` / `## Waves` to the contract, and record the reasoning in `waves.md`.

#### 1.5 Configure context `[required · once]`

`python3 ./.arbor/scripts/task.py seed-context <task> [--package <pkg> ...]` writes the packages' spec `index.md` files, `.arbor/spec/guides/index.md` and every `research/*.md` into **both** manifests. Then add specific guideline files with `task.py add-context <task> implement|check "<path>" "<reason>"` and drop lines that do not apply to a side (`implement.jsonl` → architect, implement; `check.jsonl` → review, verify, fix, simplify). Never add code files. Ready gate: both `implement.jsonl` and `check.jsonl` must contain at least one real `{"file": "...", "reason": "..."}` entry before `task.py start`. The seed `_example` row alone is not ready; `start` refuses it (`--allow-empty-context` when intentional).

#### 1.6 Validate & plan review `[required · once]`

Structural validation runs on the contract (see Task Artifacts); fix every error it reports. Full: run one `review` with `Mode: plan` (goal-backward: what must be true for the goal, which criterion covers it, is it wired, does it fit the context budget) and revise the contract with its findings. Standard may run one when the design is contested.

#### 1.7 Approve & start `[required · once]`

End the planning summary (goal, scope, criteria with their checks, key decisions, risks, tier) with the question whether to approve the contract. Only a later user message that approves it authorizes `python3 ./.arbor/scripts/task.py start <task-dir>`: it checks the tier's artifacts (light `contract.md`; standard + `design.md`; full + `waves.md`) and the manifests, records `contract_hash`, creates the task worktree and branch, commits the task directory (with the CONTRACT-phase briefs, reports and research) and sets `state=BUILD`. From here on the driver leads (2.1). If `start` reports a session-identity problem, follow its hint and retry.

---

## Phase 2: Drive

Goal: the driver walks BUILD → GATE → REVIEW; you supply judgment and briefs from this session and ask the user only at the human gates whose mandate is `ask`.

#### 2.1 The loop `[required · repeatable]`

`python3 ./.arbor/scripts/arbor.py next`: do exactly what it names (the `needs` table in Driver), then `next` again. Do not edit `task.json`, do not run roles yourself, do not commit on behalf of a role. A child task driven from its own conversation passes `--task <child>` on every call. Each `run` ends in `needs=delegation`: the sync hook binds and collects; then `next` again. A pending request survives an interrupted session: resume or poll it instead of delegating twice.

#### 2.2 Write a brief `[required · repeatable]`

Write the brief at `brief_path` for the role `next` names, then `arbor.py run`. Short and specific:

- **implement**: the essential files, the part of the design this run covers, the criteria and their test files, pitfalls, files to stay out of.
- **fix / simplify**: the essential files, pitfalls; for fix the findings JSON.
- **review**: `Angles:` — light self-check: `A, B, C, D, E, Conventions, Acceptance, Cleanup-lite`; candidates, one angle group per reader (standard: `A, D, Acceptance` / `B, C, E, Conventions`; full: `A, D` / `B, Conventions` / `C, E, Acceptance`); sweep: the verified list.
- **verify**: the deduplicated candidates JSON, at most 8.

#### 2.3 BUILD

`implement` reads the contract and design, writes the tests the Verification map names and the code that satisfies the criteria, runs every `auto` check green and commits. Writing a test first is the role's habit, not a gate: the driver checks the result at GATE. A Partial or Blocked report comes back through `next`; add the missing information to the next brief or return to the contract. A multi-partition wave runs one `implement` per partition in its own worktree, then merges them `--no-ff` (see Driver).

#### 2.4 GATE and decide `[on demand]`

The driver runs `gate.commands` and every `auto` check. Red → `next` asks you to classify the failure with `arbor.py decide impl|contract --reason "<one line of evidence>"`: `impl` — the code or its tests are wrong; `fix` runs. `contract` — the contract is wrong; edit `contract.md`, get the user's approval, then `arbor.py resume`.

#### 2.5 REVIEW

**Light**: one `review` `Mode: self-check` over `last_reviewed..HEAD` (including "does the Verification map cover every criterion"); findings go to `fix`, back through GATE, and only the delta is reviewed again. **Standard / full**: `simplify` first (behavior-preserving cleanup; GATE after a commit), then N `review` `Mode: candidates` in parallel from the `batch` of `next --json` → you dedup → the driver prefilters mechanically (file exists, line within ±5 of a change, cited rule exists) → `verify` (one reader per batch of 8, in parallel) → CONFIRMED findings are fixed without asking; PLAUSIBLE ones follow the mandate (`plausible=auto`: the driver records `decide skip` and lists them in the scorecard; `ask`: put them to the user once, then `arbor.py decide fix|skip --reason "…"`) → `fix` → GATE → the next cycle reviews only the delta. Full: once a cycle is clean, one `review` `Mode: sweep` over the whole range with the verified list; its new candidates are verified too. Two fix rounds, or a cycle without progress, enter STOP. Invalid findings may stay unfixed; list them in the final summary.

#### 2.6 STOP, resume, override `[on demand]`

STOP comes from a round cap (`BUDGET`), two rounds without progress (`NO_PROGRESS`) or an explicit `abandon` (`HUMAN`); all work is preserved. `next` answers `needs=human` with `human.kind: stop`, the reason and the evidence: inspect the result, tighten the brief or change the plan, tell the user what happened, then `arbor.py resume` (BUDGET: grants one more round), `arbor.py override --reason "…" --to STATE[/step]` (a recorded state decision) or `--role <role> [--mode M]` (an extra role inside the contract), or `arbor.py abandon --reason "…"`.

---

## Phase 3: Finish

Goal: a merged branch with its evidence, the lessons captured, the session recorded.

#### 3.1 Spec update `[required · once]`

Load `arbor-update-spec` and decide what this task taught: recurring CONFIRMED categories from the review reports belong in `.arbor/spec/` (or a lint rule). Edit spec files in the task worktree and commit them on the task branch before `arbor.py finish`; afterwards `python3 ./.arbor/scripts/spec.py verify <doc>` (`spec.py lint` lists stale or unlisted docs, advisory).

#### 3.2 Debug retrospective `[on demand]`

If the same issue was fixed more than once, load `arbor-break-loop`: classify the root cause, explain why earlier fixes failed, propose prevention.

#### 3.3 Scorecard, PR and merge `[required · once]`

`python3 ./.arbor/scripts/arbor.py finish [--pr]` writes and commits `scorecard.md` (read its "Recurring CONFIRMED categories" against 3.1), then opens the PR (`--pr` with `gh`; body = contract + scorecard) or prints the local `--no-ff` merge command. The human merges; never merge or push yourself. With `merge=auto` (the user opted in) the same run merges a branch that changes fewer than `auto_merge_max_lines` product lines, stays within the partition paths, has no product commit after the last review PASS, with a clean main checkout on the base branch and no conflict, and goes straight on to the cleanup. A child of a parent merges into the parent's integration branch instead (see Parent / Child Task Trees).

#### 3.4 Cleanup, archive, journal `[required · once]`

Once the branch is merged, `/arbor:finish-work` runs `arbor.py finish` again: it removes the task worktree and branch, archives the task, clears the session pointer and writes the journal entry (DONE), then records anything else the session did.

---

## Customizing Arbor (for forks)

Edit a step's body in the Phase 1 / 2 / 3 sections above; the state machine, counters and caps live in the driver (`.arbor/scripts/common/driver/state.py`): change them there and keep this document's tables in sync. The per-turn prompt text is the body of the corresponding `[workflow-state:STATUS]` block (`no_task`, `task_error`, `planning`, `in_progress`, `completed`); after editing run `arbor update` (template maintainers) or restart the AI session. A custom status needs a new `[workflow-state:my-status]` block (charset `[A-Za-z0-9_-]+`) and a lifecycle hook that writes `task.json.status` to that value: add `"hooks": {"after_finish": ["<command>"]}` to `task.json` (events `after_create / after_start / after_finish / after_archive`; `after_finish` only clears the session pointer, use `after_archive` for "task is done").

---

## Appendix: Central polyrepo tasks

When this repository stores tasks/specs for independent `packages.<name>.git: true` repositories, the package decides the execution repository. Fetch the desired product ref before starting; start resolves the base ref to a full commit and never silently follows later remote changes.

```bash
# Naming a git: true package means working in it (execution package).
python3 .arbor/scripts/task.py create "Product task" --description "..." --package app
# base ref / merge target: flags, else packages.app.execution.base_ref / merge_target.
python3 .arbor/scripts/task.py start <task> --base-ref origin/dev --merge-target dev
# No --package: the task belongs to the control repo (execution control); a git: true
# default_package is never inherited.
python3 .arbor/scripts/task.py create "Control task" --description "..."
# Edit only the control repo while still selecting app's specs:
python3 .arbor/scripts/task.py create "Spec task" --description "..." --package app --execution control
```

`execution_mode` is saved at create; `start` inherits it and an explicit `start --execution` overrides it. A control task without a package seeds shared guides/research only. `--execution package` requires a configured independent Git package.

A product task owns two worktrees. Its task directory, contract, manifests, specs, briefs, reports and scorecard live in the **control** worktree. Writer commits, Range diffs, GATE commands, partition worktrees and merges operate in the **product** worktree. Product code and verification paths in the contract are relative to the product root. Context manifests continue to reference control-repo specs; roles read product sources from the explicit execution directory in their prompt. The product repo does not need an Arbor installation. Package-specific `execution.worktree` and `execution.gate` settings under the package configuration replace the control project's setup/GATE settings for product execution; a product GATE with neither commands nor contract `auto` checks is rejected with `GATE-EMPTY`. Execution repository identity, source commit, merge target and package policy are frozen in `task.json.execution_binding`; changing that binding or the package policy after start is refused.

Product execution dispatches are serialized, including within a multi-partition wave; CONTRACT readers can run concurrently in the control worktree. Control and main-checkout snapshots record drift as observations for the main agent, not proof that the child wrote those files (`arbor.py collect --accept-new-control-task <name> --reason "..."` records a narrowly checked sibling-task acceptance). A failed/interrupted product setup retains a start journal under `.arbor/.runtime/starts/` and owned worktrees; inspect those before retrying.

Finish uses two explicit local merge boundaries: `arbor.py finish` first prints the product merge command; after that `--no-ff` merge, run it again to record product merge evidence and obtain the control merge command; after the control `--no-ff` merge, run it again for cleanup/archive. Cleanup checks both repos and refuses dirty or changed product worktrees. Automatic product PR creation is not supported. A control merge alone never completes a product task.
