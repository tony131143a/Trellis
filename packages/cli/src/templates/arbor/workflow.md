# Development Workflow

---

## Core Principles

1. **The contract is the spine** — `contract.md` says what "done" looks like and how it is checked; the human approves the contract, and it is frozen once approved
2. **The driver owns control, you own judgment** — `arbor.py` holds the state, the counters, the gates and the validation; you propose the tier, write the contract, classify red gates, dedup findings, curate context and write briefs
3. **Verification is a ladder** — deterministic checks → independent tests → one reader review → candidate reviews + verify → sweep; a red rung never climbs
4. **Many readers, one writer** — read-only roles may run in parallel; each branch has one writer at a time
5. **Git-native** — a task is a worktree plus a branch; writers commit; a diff is a commit range; merges are `--no-ff`
6. **Persist everything** — research, decisions and lessons go to files; conversations get compacted, files don't

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

Every task has its own directory `.arbor/tasks/{MM-DD-name}/` holding `task.json`, `contract.md`, optional `design.md` and `waves.md`, optional `research/`, `briefs/`, `reports/`, and the context manifests `implement.jsonl` / `check.jsonl`.

```bash
# Task lifecycle
python3 ./.arbor/scripts/task.py create "<title>" --description "<one-line summary>" [--slug <name>] [--tier light|standard|full] [--parent <dir>]
python3 ./.arbor/scripts/task.py start <name>          # contract approved: freeze it, create the task worktree + branch, commit
python3 ./.arbor/scripts/task.py current --source      # show active task and source
python3 ./.arbor/scripts/task.py finish                # clear active task (triggers after_finish hooks)
python3 ./.arbor/scripts/task.py archive <name>        # move to archive/{year-month}/
python3 ./.arbor/scripts/task.py list [--mine] [--status <s>]
python3 ./.arbor/scripts/task.py list-archive

# Code-spec context (inlined into every role prompt by the driver).
# `seed-context` fills both manifests with the package's spec indexes, the shared guides
# index and the task's research files; then add or drop entries. `start` refuses while a
# manifest is still empty; pass `start --allow-empty-context` when that is intentional.
python3 ./.arbor/scripts/task.py seed-context <name> [--package <pkg> ...]
python3 ./.arbor/scripts/task.py add-context <name> <action> <file> <reason>
python3 ./.arbor/scripts/task.py list-context <name> [action]
python3 ./.arbor/scripts/task.py validate <name>

# Task metadata
python3 ./.arbor/scripts/task.py set-base-branch <name> <branch>    # branch the PR merges into
python3 ./.arbor/scripts/task.py set-meta <name> <key> <value>      # e.g. tier standard

# Hierarchy (parent/child)
python3 ./.arbor/scripts/task.py add-subtask <parent> <child>
python3 ./.arbor/scripts/task.py remove-subtask <parent> <child>
```

> Run `python3 ./.arbor/scripts/task.py --help` to see the authoritative, up-to-date list.

**Current-task mechanism**: `task.py create` creates the task directory in this checkout and (when session identity is available) points this session at it. `task.py start` records `contract_hash`, creates branch `arbor/<task>` and its worktree `<worktree.root>/<task>` from the current HEAD, moves the task directory into that worktree, commits it as `contract(<task>): approve contract`, sets `state=BUILD`, and points the session at the task directory inside the worktree. State is stored under `.arbor/.runtime/sessions/` in the main checkout. Without a context key (hook input or `ARBOR_CONTEXT_ID`) there is no active task and `task.py start` fails with a session identity hint. `task.py finish` clears this session's pointer. `task.py archive <task>` writes `status=completed` and moves the directory to `archive/`.

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

### Driver

`arbor.py` is the only thing that runs roles. It keeps the task's state in `task.json`, runs the deterministic checks, executes each role through the executor configured under `executors:` in `.arbor/config.yaml`, validates the reply and the git invariants, records metrics in `.arbor/.runtime/results.jsonl`, and advances the state. It never asks you to forward a result: you read what `arbor.py next` says and do that one thing.

```bash
python3 ./.arbor/scripts/arbor.py next [--json]               # the single next step
python3 ./.arbor/scripts/arbor.py run [--dispatch d-NNN]      # execute the dispatch whose brief you just wrote
python3 ./.arbor/scripts/arbor.py run --role explore|architect|review [--mode plan] [--dispatch d-NNN]   # CONTRACT phase only, before task.py start
python3 ./.arbor/scripts/arbor.py gate                        # run GATE level 0; prints the failing AC ids
python3 ./.arbor/scripts/arbor.py decide <choice> --reason "…"   # impl | tests | contract (red gate) · fix | skip (PLAUSIBLE)
python3 ./.arbor/scripts/arbor.py canary [--role <role>]      # small read-only dispatch: is the executor reachable, is the reply well-formed
python3 ./.arbor/scripts/arbor.py override --reason "…" (--to STATE[/step] | --role <role> [--mode M])   # one step off the state table; recorded in the scorecard
python3 ./.arbor/scripts/arbor.py status | resume | abandon [--reason "…"]
python3 ./.arbor/scripts/arbor.py prompt --dispatch d-NNN --print   # the assembled prompt of a dispatch
```

Every command takes `--task <dir>` before the command name (default: this session's active task). Exit codes: 0 ok, 1 refused / failed dispatch / red gate, 2 usage error.

`arbor.py next --json` always carries `task`, `state`, `needs` and `summary`; depending on `needs` it adds `role`, `mode`, `range`, `dispatch`, `brief_path`, `decision`, `human` and `touched_files`. Before `task.py start` it answers `state: CONTRACT`, `needs: human` with `human.kind: approve_contract`, plus the next `dispatch` id, its `brief_path` and `contract_roles` (explore, architect, review).

| `needs` | Meaning | You do |
|---|---|---|
| `brief` | a role must run | write the brief for that `role` at `brief_path`, then `arbor.py run` |
| `run` | the driver has deterministic work: GATE, or merging a finished wave back into the task branch | `arbor.py gate` for GATE (`arbor.py run` does the same there); `arbor.py run` for the wave merge |
| `wait` | multi-partition wave: every ready partition is running or finished and the wave cannot merge yet | wait for the running `arbor.py run --partition <p>` calls, then `arbor.py next` again |
| `decide` | a judgment the driver cannot make | `arbor.py decide <choice> --reason "…"` with one of the listed options |
| `human` | `human.kind` says which: `approve_contract`, `plausible`, `stop`, `merge_conflict` or `merge` | `approve_contract`: before start, finish the contract (research with `arbor.py run --role`, see CONTRACT-phase dispatch), ask for approval, then `task.py start`; after start, the user re-approves the edited `contract.md` and you run `arbor.py resume`. `plausible`: `decide fix\|skip --reason "…"`. `stop`: report, then `resume`, `override` or `abandon` as the user says. `merge_conflict`: merge the named partition branch into the task branch by hand in the task worktree, commit, then `arbor.py resume`. `merge`: Phase 3 |
| `done` | nothing left | stop |

**Multi-partition waves.** When the contract's current wave names more than one partition, the driver gives each partition its own branch `arbor/<task>--<p>` and worktree `<worktree.root>/<task>-<p>`, and `next --json` carries `partition` plus `partitions_pending` (the other partitions that also need a brief right now). Write each brief at its `brief_path`, then start one `arbor.py run --partition <p>` per partition — they may run at the same time (the driver serialises task.json under `<task>/.lock`; keep to `executors.<name>.max_parallel`). A partition's writer may only touch that partition's paths; the driver prepends the scope line to the brief and rejects anything outside. When every partition is done, `next` says `run` and `arbor.py run` merges the branches back `--no-ff` in wave order; a conflict becomes `human` / `merge_conflict`.

**Dispatch header.** The driver writes it; you never type it. Every role prompt starts with:

```
Active task: <absolute path of .arbor/tasks/<task> inside the task worktree; the main checkout before start>
Role: explore | architect | test | implement | review | verify | fix | simplify
Mode: self-check | candidates | sweep | plan        (review only)
Range: <base>..<head>                               (roles that read or write a diff)
Dispatch: d-NNN
```

Then the injected context (the role's manifest — `implement.jsonl` for architect / test / implement, `check.jsonl` for review / verify / fix / simplify — then `contract.md`, `design.md`, `waves.md`, and `git diff <Range>`), then your brief. Your brief is committed as `briefs/d-NNN.md` on the task branch, and the reply plus the driver's verdict as `reports/d-NNN.md`; the assembled prompt is kept at `.arbor/.runtime/prompts/<task>/d-NNN.md` in the main checkout (`arbor.py prompt --dispatch d-NNN --print` rebuilds it).

**CONTRACT-phase dispatch.** Before `task.py start` the state table does not run yet, but you can still dispatch `explore`, `architect` and `review` (`Mode: plan`, the default for review):

1. `arbor.py next --json` names the next `dispatch` id and its `brief_path` (`<task>/briefs/d-NNN.md`).
2. Write the brief there (body only; the driver adds the header and context).
3. `arbor.py run --role explore|architect|review [--mode plan] [--dispatch d-NNN]`.

It runs in the main checkout with no `Range:` and commits nothing. `explore` and `architect` may write only `<task>/research/`; `review` writes nothing. Anything else they touch is a violation: the driver restores the stray paths (never resets the branch) and reports a moved HEAD for you to undo by hand. Each run is recorded in `task.json` (`dispatches`, `phase: CONTRACT`), in `reports/d-NNN.md` and in `results.jsonl`; `task.py start` later commits the task directory with the briefs, reports and research. Dispatch ids continue after start: with d-001 and d-002 used here, the first BUILD dispatch is d-003. After start, `run --role` is refused; an extra role then goes through `override --role`. With no task at all only `run --role explore` works: pipe the brief on stdin; the reply comes back on stdout and nothing is recorded in a task.

**Briefs.** The role cannot see your conversation. A brief carries what the artifacts do not: the essential files to read first, decisions already made, known pitfalls, files to stay out of, and for review the `Angles:` line; for verify and fix, the findings JSON. Do not paste the contract or the diff; the driver injects them.

**Sub-agent self-exemption.** If your own first prompt starts with `Active task:` + `Role:`, you are a dispatched role: do that role's work directly, never run `arbor.py` or `task.py start/current/finish`, never dispatch anything, never push, merge or rebase. You have no `ARBOR_CONTEXT_ID`.

### Roles

Role instructions live in `.arbor/agents/<role>.md`. The driver checks each role's write boundary after every dispatch; a violation fails the dispatch and resets the branch to where it was.

| Role | Writes | Commits | Output |
|---|---|---|---|
| `explore` | `.arbor/tasks/<task>/research/**` | no (the driver commits research) | findings + 5–10 essential files |
| `architect` | `.arbor/tasks/<task>/research/**` | no | one blueprint + partition / wave suggestion |
| `test` | the contract's test paths only | yes, own branch | criterion → test map; the red run |
| `implement` | anything except test paths and `.arbor/` outside the task dir | yes, own branch | Complete / Partial / Blocked + verification |
| `fix` | as implement; regression tests only when listed in its report | yes, own branch | fixed / skipped per finding |
| `simplify` | as implement | yes, own branch | behavior-preserving cleanup, or "no change" |
| `review` | nothing | no | first line `PASS` / `FAIL` + findings JSON |
| `verify` | nothing | no | CONFIRMED / PLAUSIBLE / REFUTED per candidate |

Every role: no push, no merge, no rebase, no checkout of other branches, no writes under `.arbor/` except `tasks/<task>/`. Test paths are the contract's `## Test paths`, else `test_paths:` in `.arbor/config.yaml`.

**Commit format** (writers; the driver rejects anything else as a failed dispatch):

```
<role>(<task-dir-name>): <summary>

<optional body>

Arbor-Dispatch: d-NNN
```

---

<!--
  WORKFLOW-STATE BREADCRUMB CONTRACT (read this before editing the tag blocks below)

  The per-turn `<workflow-state>` breadcrumb (UserPromptSubmit hook,
  inject-workflow-state.py) has two sources:

  1. Active task: the hook runs `.arbor/scripts/arbor.py next --json` and
     injects its one-line `summary` plus `needs`. The driver owns the state,
     so nothing here can drift from it.
  2. No active task, an unreadable task record, or a driver that is missing
     or fails: the [workflow-state:STATUS] blocks below. They are the single
     source of that text; the hook has no fallback dict.

  STATUS charset: [A-Za-z0-9_-]+. When the hook can't find a tag, it
  degrades to a generic "Refer to workflow.md for current step." line —
  intentionally visible so users notice and fix a broken workflow.md.

  KEY SELECTION (inject-workflow-state.py, resolve_breadcrumb_key): the
  first block that exists of <status>-<tier>, then <status>. No tier
  variants ship; the driver summary replaces them.

  PARSER TRAP: a line that ENDS with a `[workflow-state:X]` token opens a
  block for the parser and swallows the real one. Never end a prose or
  comment line with such a token; write "the no_task block" instead.

  TAG ↔ PHASE scoping:
    no_task      → no active task; triage before Phase 1
    task_error   → active task record is unreadable; repair it before continuing
    planning     → Phase 1 (status='planning')
    in_progress  → Phase 2 / 3 when the driver summary is unavailable
    completed    → archived task (normally unreachable: archive moves the dir)

  Editing checklist:
    - Keep each block short; it is injected on every turn
    - Run `arbor update` after editing to push the new bodies to
      downstream projects (block-level managed replacement)
-->

## Phase Index

```
Phase 1: Plan    → INTAKE (tier, consent) → CONTRACT (explore, one question list, contract.md, design, seed-context, validation, plan review, approval, task.py start)
Phase 2: Drive   → `arbor.py next` loop: BUILD (test red → implement green) → GATE → REVIEW → POLISH (standard / full)
Phase 3: Finish  → scorecard, spec update, PR, human `--no-ff` merge, cleanup
```

### State Machine

| State | Entered when | Who | What happens | Leaves to |
|---|---|---|---|---|
| INTAKE | `/arbor:workflow <request>` | you → human | propose a tier with a one-line reason; the human answers ok / light / standard / full | consent → `task.py create` → CONTRACT |
| CONTRACT | task directory exists | you + explore / architect + human | explore → one question list → `contract.md` (+ `design.md`; full: 3 architect perspectives → chosen → `waves.md`) → `seed-context` → structural validation → standard / full: review `Mode: plan` → human approves | `task.py start` → BUILD |
| BUILD | a wave is pending | driver + writers | `test` commits failing tests (the driver checks they fail for the right reason) → `implement` makes them pass | GATE |
| GATE | the task branch has new commits | driver → you | level 0: `gate.commands` + every `auto` row of the Verification map. Green → next wave or REVIEW. Red → you classify: impl (`fix`, tests frozen) / tests (`test` again) / contract (edit it, the human re-approves) | `counters.gate++`; two rounds without progress → STOP |
| REVIEW | GATE green, all waves done | review + fix | one review `Mode: self-check` over `base..HEAD`; findings → `fix` → GATE → re-review only `last_reviewed..HEAD`; caps: light 2 rounds, standard / full 1 | PASS → light: FINISH; standard / full: POLISH |
| POLISH | standard / full, REVIEW passed | simplify, review, verify, fix, human | `simplify` → GATE → N reviews `Mode: candidates` → mechanical prefilter → `verify` (≤ 8 per run) → full: `sweep` → verify → CONFIRMED fixed; PLAUSIBLE asked once → `fix` → GATE → re-review the delta (≤ 2 rounds) | FINISH |
| FINISH | REVIEW / POLISH done | you + driver + human | `scorecard.md`, spec update, PR (body = contract + scorecard), human `--no-ff` merge | merged → worktree removed, archive, journal → DONE |
| STOP | a cap, no progress, or an invariant violation | human | the driver prints state, reason, last evidence | `arbor.py resume` (optionally after `override --reason`) or `abandon` |

Progress (only the driver changes counters): a GATE round progresses when the set of failing AC ids shrinks or a previously failing check passes; a REVIEW / POLISH round when its set of finding ids changes. Two rounds in a row without progress → STOP(NO_PROGRESS); a round cap → STOP(BUDGET).

### Tiers

The tier decides how much contract work happens and how high the verification ladder climbs. Simple changes (at most 2 files, cause known, no design choice) do not use Arbor at all.

| | light | standard | full |
|---|---|---|---|
| Fits | one deliverable, a few files, existing patterns suffice | a feature or refactor across files or layers that needs a written design | several deliverables, contested design, risky migration |
| Contract artifacts | `contract.md` | + `design.md` + review `Mode: plan` | + 3 architect perspectives + `waves.md` |
| Explore (soft cap; say why when exceeded) | 1 | 3 | 5 |
| BUILD | one partition, serial | partitions per the contract | partitions + waves |
| Ladder climbs to | rung 2 | rung 3 (2 candidate readers) | rung 4 (3 candidate readers + sweep) |
| Human gates | tier · contract · merge | + PLAUSIBLE | + PLAUSIBLE |

The tier lives in `task.json.meta.tier` (`task.py create --tier <t>`, later `task.py set-meta <task> tier <t>`); without it the tier is inferred from the artifacts (`waves.md` → full, `design.md` → standard, else light). Reader counts are starting values, tuned from the scorecards.

### Verification Ladder

| Rung | What | Who runs it | Cost |
|---|---|---|---|
| 0 | `gate.commands` + the contract's `auto` checks | driver | no tokens |
| 1 | independent tests: `test` commits them red, `implement` turns them green | one dispatch each | low |
| 2 | one clean-context review + Verification-map coverage | one dispatch | medium |
| 3 | N candidate reviews → prefilter → verify | standard / full | high |
| 4 | sweep | full | high |

### Human Gates

1. **Tier** (INTAKE): the human agrees to the proposed tier.
2. **Contract** (end of CONTRACT): the human approves `contract.md`; changing it later needs a new approval.
3. **PLAUSIBLE** (POLISH, only when PLAUSIBLE findings survive): fix or skip, asked once.
4. **Merge** (FINISH): the human merges the PR with `--no-ff`.

Nothing else waits for the human unless the driver STOPs.

### Request Triage

- Classify first. A simple change (at most 2 files, cause known, no design choice) is done in this session without Arbor: read, edit, run the project's checks, propose one commit message and ask once. Unsure whether it is simple: treat it as light.
- Anything larger: in one message propose a tier (light / standard / full) with a one-line reason and ask whether to create a task. The user answers ok / light / standard / full / no. `/arbor:workflow <request>` already counts as consent to the task, not to the tier.
- Consent to create a task is not approval of the contract. Contract approval (1.7) is the only start gate.
- If the user declines a task for non-simple work, do not implement broadly inline: explain, clarify scope, or suggest a smaller split. Plain questions need no task.

### Task Artifacts

`contract.md` sections (the driver parses them; keep the headings):

| Section | Content |
|---|---|
| `## Goal` | one paragraph |
| `## Scope` | in / out |
| `## Acceptance criteria` | `AC-n: Given <precondition> When <action> Then <observable result>` |
| `## Verification map` | table `id \| kind \| check \| file`; `kind` is `auto` (a command that fails before and passes after) or `manual` |
| `## Interface pins` | signatures, paths, CLI / HTTP shapes the tests will call; light may say "existing interfaces" |
| `## Test paths` | globs the `test` role owns (optional; defaults to `test_paths:` in config) |
| `## Partitions` | `name: globs`, non-overlapping (optional; absent = one `default` partition) |
| `## Waves` | `n: [partitions]` (optional; absent = one wave) |

Structural validation (before approval): every AC has a map row; every `auto` row has a command and a file that exists or sits inside the test paths; Interface pins are not empty; partitions do not overlap; waves name existing partitions.

Other artifacts:

- `design.md` — standard / full: boundaries, contracts, data flow, trade-offs, rollback.
- `waves.md` — full: the chosen architect's partitions and wave order with the reasoning.
- `research/` — explore findings (`<topic>.md`) and architect blueprints (`design-<perspective>.md`).
- `implement.jsonl` / `check.jsonl` — spec and research manifests the driver inlines into role prompts.
- `briefs/d-NNN.md` — the brief you wrote for every dispatch; `reports/d-NNN.md` — the reply plus the driver's verdict. Both are committed by the driver, or by `task.py start` for CONTRACT-phase dispatches. The assembled prompt is not committed: it stays at `.arbor/.runtime/prompts/<task>/d-NNN.md` in the main checkout.
- `scorecard.md` — written at FINISH: dispatches per role, GATE / REVIEW / POLISH rounds, findings per rung, AC automation rate, overrides, violations.

### Parent / Child Task Trees

Use a parent task when one user request contains several independently verifiable deliverables. The parent task owns the source requirement set, the task map, cross-child acceptance criteria, and final integration review; it normally has no implementation work of its own.

Use child tasks for deliverables that can be contracted, built, checked, and archived independently. Parent/child structure is not a dependency system: if one child must wait for another, write that ordering in the child's `contract.md` and keep each child's acceptance criteria testable.

Create new children with `task.py create "<title>" --description "<one-line summary>" --slug <name> --parent <parent-dir>`. Link existing tasks with `task.py add-subtask <parent> <child>`, and unlink mistakes with `task.py remove-subtask <parent> <child>`. Do not start the parent just because children exist; start the child that owns the next independently verifiable deliverable.

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
- 1.1 Explore `[repeatable]` (soft cap light 1 / standard 3 / full 5)
- 1.2 Questions `[required · once]` (one numbered list, then wait)
- 1.3 Write the contract `[required · repeatable]` (`contract.md`)
- 1.4 Design `[required · once; standard / full]` (standard: `design.md`; full: 3 architect perspectives → chosen → `design.md` + `waves.md`)
- 1.5 Configure context `[required · once]` (`task.py seed-context`, then adjust the manifests)
- 1.6 Validate & plan review `[required · once]` (structural validation; standard / full: review `Mode: plan`)
- 1.7 Approve & start `[required · once]` (planning summary → human approves the contract → `task.py start`)

<!-- Per-turn breadcrumb: shown throughout Phase 1 (status='planning'), every tier -->

[workflow-state:planning]
Phase 1, CONTRACT. The tier is in the header; change it with `task.py set-meta <task> tier <tier>`.
Explore (1.1, soft cap light 1 / standard 3 / full 5) → ask every open question as ONE numbered list and wait (1.2) → write `contract.md`: Goal, Scope, Acceptance criteria (Given/When/Then), Verification map, Interface pins, Test paths (1.3) → standard: `design.md`; full: 3 architect perspectives → user picks → `design.md` + `waves.md` (1.4) → `task.py seed-context <task>` (1.5) → structural validation; standard / full: one review `Mode: plan` (1.6).
Roles here: write the brief at the `brief_path` from `arbor.py next --json`, then `arbor.py run --role explore|architect|review [--mode plan]`; it runs in the main checkout and commits nothing.
Multi-deliverable scope: consider a parent task plus independently verifiable child tasks (`task.py create --parent`); dependencies must be written in child contracts, not implied by tree position.
Approve (1.7): end the planning summary with the approval question; run `task.py start <task>` only after a later user message approves the contract.
[/workflow-state:planning]

### Phase 2: Drive
- 2.1 The loop `[required · repeatable]` (`arbor.py next` → do the one thing it names)
- 2.2 Write a brief `[required · repeatable]`
- 2.3 BUILD (test red → implement green)
- 2.4 GATE and decide `[on demand]`
- 2.5 REVIEW
- 2.6 POLISH (standard / full; PLAUSIBLE asked once)
- 2.7 STOP, resume, override `[on demand]`

<!-- Per-turn breadcrumb: fallback only. Normally the hook shows the driver's
     own one-line next step instead of this block. -->

[workflow-state:in_progress]
The driver did not answer. Run `python3 ./.arbor/scripts/arbor.py next` and do the one step it names: `brief` → write the brief at its path, then `arbor.py run`; `decide` → `arbor.py decide <choice> --reason "…"`; `human` → ask the user; `done` → Phase 3. If `arbor.py` is missing, run `arbor update`.
Roles run only through `arbor.py run`; never the built-in Agent/Task tool, never in this session.
Sub-agent self-exemption: if you are already a dispatched sub-agent (your prompt starts with `Active task:` / `Role:`), perform that role directly; do not run arbor.py or task.py start/current/finish. Dispatch is main session only.
[/workflow-state:in_progress]

### Phase 3: Finish
- 3.1 Scorecard & spec update `[required · once]`
- 3.2 Debug retrospective `[on demand]`
- 3.3 PR and merge `[required · once]` (human merges with `--no-ff`)
- 3.4 Cleanup, archive, journal `[required · once]`

<!-- Per-turn breadcrumb: shown while status='completed'. Normally unreachable:
     `task.py archive` writes the status and moves the directory in one call,
     so the session pointer is gone before the next prompt. -->

[workflow-state:completed]
Task archived. Run `/arbor:finish-work` to record the session.
[/workflow-state:completed]

### Rules

1. `arbor.py next` is the source of truth for where a started task is; do the one step it names
2. Only the driver changes `task.json` state and counters, runs roles, and runs the gate
3. Contract changes after approval go through `decide contract` and a new human approval
4. Steps tagged `[once]` are skipped when their output already exists
5. Inside an Arbor task, never perform a role in this session and never use the built-in Agent/Task tool for one

### Loading Step Detail

```bash
python3 ./.arbor/scripts/get_context.py --mode phase --step <step>
# e.g. python3 ./.arbor/scripts/get_context.py --mode phase --step 1.3
```

---

## Phase 1: Plan

Goal: an approved, frozen contract that says what done looks like and how each criterion is checked.

#### 1.0 Intake & create task `[required · once]`

Propose a tier with a one-line reason (see Tiers) and wait for the user's answer. `/arbor:workflow <request>` counts as consent to create a task. Then:

```bash
python3 ./.arbor/scripts/task.py create "<task title>" --description "<one-line summary>" --slug <name> --tier <light|standard|full>
```

`create` sets status `planning`, writes `task.json` and a `contract.md` skeleton, and points this session at the task. Title and `--description` must be non-empty; `--slug` has no `MM-DD-` prefix (added automatically). For task trees, create the parent first, then each child with `--parent <parent-dir>`.

Run only `create` here. Skip when `task.py current --source` already points to a task.

#### 1.1 Explore `[repeatable]`

Facts first. Answer small questions by reading a few files yourself. Otherwise run `explore` roles, one aspect each, as CONTRACT-phase dispatches (write the brief at the `brief_path` from `arbor.py next --json`, then `arbor.py run --role explore`) (soft cap: light 1, standard 3, full 5; say why when you exceed it). Each writes `research/<topic>.md` and returns 5–10 essential files. Read only the 2–3 files you need for the next step; the research files are injected into later roles.

#### 1.2 Questions `[required · once]`

Compare the findings with the request and list what is still open: product intent, scope edges, error handling, compatibility, interfaces. Put every open question to the user **as one numbered list**, each with the decision, why it matters, your recommendation and the trade-off, and wait for one round of answers. Follow up only on new decisions the answers raise. "Your call" → state your choice and get it confirmed.

#### 1.3 Write the contract `[required · repeatable]`

Fill `contract.md` (sections in Task Artifacts). Rules of thumb:

- Every acceptance criterion is observable: Given / When / Then, no "works correctly".
- Every criterion has a Verification map row; prefer `auto` rows whose command fails before the change and passes after (`-t AC-n` filters work well).
- Interface pins name what the tests will call, so `test` and `implement` cannot drift apart.
- Test paths are the only paths the `test` role may write and the paths `implement` may not.

Return here whenever an answer, a design choice or a red gate changes what done means.

#### 1.4 Design `[required · once; standard / full]`

- **Standard**: write `design.md` yourself (boundaries, contracts, data flow, trade-offs, rollback). Run one `architect` (`arbor.py run --role architect`, brief with `Perspective: pragmatic`) only when the area is unfamiliar or the user asks.
- **Full**: run 3 `architect` roles (`arbor.py run --role architect`, one brief each with `Perspective: minimal-change` / `clean-architecture` / `pragmatic`). Present each design, the trade-offs, your recommendation and the proposed partitions / waves. After the user picks, write `design.md`, add `## Partitions` / `## Waves` to the contract, and record the reasoning in `waves.md`.

#### 1.5 Configure context `[required · once]`

```bash
python3 ./.arbor/scripts/task.py seed-context "$TASK_DIR" [--package <pkg> ...]
```

`seed-context` writes the packages' spec `index.md` files, `.arbor/spec/guides/index.md` and every `research/*.md` into **both** manifests. Then add specific guideline files with `task.py add-context "$TASK_DIR" implement|check "<path>" "<reason>"` and drop lines that do not apply to a side (`implement.jsonl` → architect, test, implement; `check.jsonl` → review, verify, fix, simplify). Never add code files; roles read those themselves.

Ready gate: both `implement.jsonl` and `check.jsonl` must contain at least one real `{"file": "...", "reason": "..."}` entry before `task.py start`. The seed `_example` row alone is not ready; `start` refuses it.

#### 1.6 Validate & plan review `[required · once]`

Structural validation runs on the contract (see Task Artifacts); fix every error it reports. Standard / full: run one `review` with `Mode: plan` (`arbor.py run --role review --mode plan`; goal-backward: what must be true for the goal, which criterion covers it, is it wired, does it fit the context budget) and revise the contract with its findings.

#### 1.7 Approve & start `[required · once]`

End the planning summary (goal, scope, criteria with their checks, key decisions, risks, tier) with the question whether to approve the contract. Only a later user message that approves it authorizes:

```bash
python3 ./.arbor/scripts/task.py start <task-dir>
```

`start` checks the tier's artifacts (light `contract.md`; standard + `design.md`; full + `waves.md`) and the manifests, freezes `contract_hash`, creates the task worktree and branch, commits the task directory (with the CONTRACT-phase briefs, reports and research), and sets `state=BUILD`. From here on `arbor.py next` leads. Before BUILD, consider continuing in a fresh session: all state is on disk.

If `start` reports a session-identity problem, follow its hint and retry.

---

## Phase 2: Drive

Goal: the driver walks BUILD → GATE → REVIEW → POLISH; you supply judgment and briefs.

#### 2.1 The loop `[required · repeatable]`

```bash
python3 ./.arbor/scripts/arbor.py next
```

Do exactly what it names (see the `needs` table in Driver), then run `next` again. Do not edit `task.json`, do not run roles yourself, do not commit on behalf of a role. `touched_files` in `next --json` lists what the task changed so far; read from it instead of re-exploring.

#### 2.2 Write a brief `[required · repeatable]`

Write the brief at `brief_path` for the role `next` names, then `arbor.py run`. The driver adds the header and the injected context. A good brief is short and specific:

- **test**: which criteria to cover, the Interface pins to call, fixtures or helpers to reuse.
- **implement / fix / simplify**: the essential files, the part of the design this run covers, pitfalls, files to stay out of; for fix, the findings JSON.
- **review**: `Angles:` — REVIEW self-check: `A, B, Acceptance` (light: `A, B, C, D, E, Conventions, Acceptance, Cleanup-lite`); POLISH candidates: one angle group per reader (`A, D` / `B, Conventions` / `C, E, Acceptance`).
- **verify**: the deduplicated candidates JSON, at most 8.

Never ask a role to dispatch another role.

#### 2.3 BUILD

`test` commits failing tests for the criteria. The driver checks the red run: the map commands must fail on an assertion; a collection or import error is not red. Then `implement` makes them pass without touching the test paths. A Partial or Blocked report comes back to you through `next`; add the missing information to the next brief or return to the contract.

#### 2.4 GATE and decide `[on demand]`

The driver runs `gate.commands` and every `auto` check. Red → `next` asks you to classify the failure:

- `impl` — the code is wrong; `fix` runs with the tests frozen.
- `tests` — the tests are wrong; `test` runs again.
- `contract` — the contract is wrong; edit `contract.md`, get the user's approval, then `arbor.py resume`.

```bash
python3 ./.arbor/scripts/arbor.py decide impl|tests|contract --reason "<one line of evidence>"
```

#### 2.5 REVIEW

One `review` `Mode: self-check` over `base..HEAD`, including "does the Verification map cover every criterion". Findings go to `fix`, back through GATE, and only `last_reviewed..HEAD` is reviewed again. Round caps: light 2, standard / full 1. Invalid findings may stay unfixed; list them in the final summary.

#### 2.6 POLISH

Standard / full only. `simplify` → GATE → N reviews `Mode: candidates` (standard 2, full 3) → you dedup → the driver prefilters mechanically (file exists, quoted code within ±5 lines, line inside the range, cited rule exists) → `verify` → full: one review `Mode: sweep` with the verified list, its new candidates verified too. CONFIRMED findings are fixed without asking. When PLAUSIBLE findings survive, present them once, most severe first, with your recommendation, and record the answer with `arbor.py decide fix|skip --reason "…"`. Fix rounds are re-reviewed on the delta, at most 2.

#### 2.7 STOP, resume, override `[on demand]`

The driver STOPs on a round cap (BUDGET), two rounds without progress (NO_PROGRESS), or an invariant violation. Report the state, the reason and the last evidence to the user. `arbor.py resume` continues; `arbor.py override --reason "…" --to STATE[/step]` jumps to a state, `override --reason "…" --role <role> [--mode M]` runs one extra role without advancing; both are recorded in the scorecard. `arbor.py abandon [--reason "…"]` ends the task. A dispatch that failed or broke an invariant has already been reset; tighten the brief rather than doing the role's work here.

---

## Phase 3: Finish

Goal: a merged branch with its evidence, the lessons captured, the session recorded.

#### 3.1 Scorecard & spec update `[required · once]`

The driver writes `scorecard.md`. Load `arbor-update-spec` and decide what this task taught: recurring CONFIRMED categories belong in `.arbor/spec/` (or a lint rule). Edit spec files in the task worktree and commit them on the task branch. After editing a spec doc, `python3 ./.arbor/scripts/spec.py verify <doc>`; `spec.py lint` lists stale or unlisted docs (advisory).

#### 3.2 Debug retrospective `[on demand]`

If the same issue was fixed more than once, load `arbor-break-loop`: classify the root cause, explain why earlier fixes failed, propose prevention.

#### 3.3 PR and merge `[required · once]`

The driver opens the PR (`gh pr create`; body = contract + scorecard) or prints the local merge command when `gh` is unavailable. The human merges with `--no-ff`; never merge or push yourself.

#### 3.4 Cleanup, archive, journal `[required · once]`

Once the merge is detected, the driver removes the task worktree, archives the task and writes the journal entry in the main checkout. Then run `/arbor:finish-work` to record the session.

---

## Customizing Arbor (for forks)

This section is for developers who want to modify the Arbor workflow itself.

### Changing what a step means

Edit the step's body in the Phase 1 / 2 / 3 sections above. The state machine, counters and caps live in the driver (`.arbor/scripts/arbor.py`); change them there, not here, and keep this document's tables in sync.

| Scope | Tag |
|---|---|
| No active task (before Phase 1) | `[workflow-state:no_task]` |
| Active task record unreadable | `[workflow-state:task_error]` |
| Phase 1, every tier | `[workflow-state:planning]` |
| Phase 2 / 3 when the driver gives no summary | `[workflow-state:in_progress]` |
| Archived (normally unreachable) | `[workflow-state:completed]` |

### Changing the per-turn prompt text

Edit the body of the corresponding `[workflow-state:STATUS]` block, then run `arbor update` (template maintainers) or restart the AI session (your own project). For a started task the text comes from the driver's `summary`.

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
