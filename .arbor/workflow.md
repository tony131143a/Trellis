# Development Workflow

---

## Core Principles

1. **The contract is the spine** — `contract.md` says what "done" looks like and how it is checked; the human approves the scope; the main agent judges later edits in context and seeks approval only for material scope changes
2. **The driver owns control, you own judgment** — `arbor.py` records state, counters, executable checks and observations; you (the main agent, the user's session) propose the tier, write the contract, split work into child tasks, curate context, write the briefs, classify red gates and retry within the contract
3. **Verification is a ladder** — deterministic checks → review (standard / full: parallel candidate readers, each verifies its own findings and reproduces what it confirms) → sweep (full); a red rung never climbs, and a light task that proves bigger than planned climbs to standard by itself. Writers run only the contract's targeted checks; GATE runs the whole suite (`gate.commands`) and, after a fix, every repro
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

`task.py create` creates the task directory in this checkout and points this session at it. `task.py start` records `contract_hash`, creates branch `arbor/<task>` and its worktree (an Orca workspace `<task>` under the main checkout's; Orca chooses the path, recorded as `worktree_path` in `task.json`) from the current HEAD, moves the task directory into that worktree, commits it as `contract(<task>): approve contract`, sets `state=BUILD` and points the session at the task directory inside the worktree. Session state lives under `.arbor/.runtime/sessions/` in the main checkout; without a context key (hook input or `ARBOR_CONTEXT_ID`) there is no active task and `start` fails with a session identity hint. Central polyrepo tasks (`packages.<name>.git: true`) are described in the appendix.

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

- **Main agent** — the user's session, normally one Orca agent session per task (Claude Code or Codex, running inside Orca): Phase 1, task creation and start, the Phase 2 loop, the questions it puts to the user, the merge gate.
- **Roles** — dispatched by `arbor.py run` and started by the driver as an Orca worker (an agent tab of its own in the task's Orca workspace); the driver prepares the prompt, starts the worker and validates the reply. Never perform a role yourself and never use native Agent/Task/spawn_agent for one.

```bash
python3 ./.arbor/scripts/arbor.py next [--json] [--partition P] [--role explore|architect|review]   # the single next step; the ready set
python3 ./.arbor/scripts/arbor.py run [--dispatch d-NNN] [--partition P]                             # dispatch the brief you just wrote
python3 ./.arbor/scripts/arbor.py run --role explore|architect|review [--mode plan] [--dispatch d-NNN]   # CONTRACT phase, before task.py start
python3 ./.arbor/scripts/arbor.py gate                        # GATE: gate.commands + the contract's auto checks (a parent: in the integration worktree)
python3 ./.arbor/scripts/arbor.py decide <choice> --reason "…"   # impl | contract (red gate) · fix | skip (PLAUSIBLE) · accept --report <file> | retry (ambiguous report)
python3 ./.arbor/scripts/arbor.py finish [--pr]               # FINISH: scorecard + PR / merge command; after the merge: cleanup
python3 ./.arbor/scripts/arbor.py children [--json] [--cleanup]   # a parent task: every child's state and merge status; cleanup after the integration merge
python3 ./.arbor/scripts/arbor.py override --reason "…" (--to STATE[/step] | --role <role> [--mode M])   # one step off the state table; recorded in the scorecard
python3 ./.arbor/scripts/arbor.py status | resume | abandon [--reason "…"]
python3 ./.arbor/scripts/arbor.py prompt --dispatch d-NNN --print   # rebuild the assembled prompt of a dispatch
```

Every command takes `--task <dir>` before the command name (default: this session's active task; pass it for a child task driven from an Orca agent session of its own). Exit codes: 0 ok, 1 refused / failed dispatch / red gate, 2 usage error.

### `next --json`

Always carries `task`, `state`, `needs` and `summary`; depending on `needs` also `role`, `mode`, `range`, `dispatch`, `brief_path`, `batch`, `decision`, `human` and `touched_files` (what the task changed so far: read it instead of re-exploring). `batch` lists the readers of the current step that run concurrently (REVIEW candidates: standard 2, full 3): write every brief, then start each with `arbor.py run --dispatch <id>`. After start it also carries the **ready set**: `items` (every step you can act on now: the current step, every other reader of its batch, every other partition that needs a brief, every prepared worker not yet started), `running` (workers and readers in flight, each with `kind: "worker"` and `orca_dispatch`) and, when `items` is empty, `blocked_on`. Act on every item in one turn, then wait once for what is running; never add items yourself. An escalated task also carries `tier_history` and `escalated` (the last escalation: `signal`, `detail`); at REVIEW/fix, `repros` maps each CONFIRMED finding id to its reproduction. Before `task.py start` it answers `state: CONTRACT`, `needs: human` (`approve_contract`) plus the next `dispatch` id and its `brief_path`.

| `needs` | Meaning | Do |
|---|---|---|
| `brief` | a role must run | write the brief for `role` at `brief_path`, then `arbor.py run` |
| `worker` | a worker of the current step is in flight, or prepared but not started | in flight: end your turn, Orca wakes you; then `arbor.py sync`. Not started (a failed start): fix the cause, then `arbor.py run --dispatch <id>` |
| `run` | deterministic driver work | `arbor.py gate` for GATE; `arbor.py run` for a wave start or wave merge |
| `wait` | every ready partition or reader is running | end your turn until a worker reports, then `arbor.py sync` and `next` again |
| `decide` | a judgment the driver cannot make | `arbor.py decide <choice> --reason "…"`; `contract` → fix the contract with the user, then `arbor.py resume` |
| `human` | `human.kind`: `approve_contract` · `plausible` · `stop` · `merge_conflict` · `merge` | see Human Gates; `human.mandate` says `ask` or `auto` |
| `done` | nothing left | stop |

### Dispatch protocol (Orca workers)

`arbor.py run` assembles the prompt at `.arbor/.runtime/prompts/<task>/d-NNN.md`, writes the worker's task spec `d-NNN.spec.md` beside it (the dispatch header plus `Prompt:` and `Report:` lines) and **starts the worker itself** (`orca orchestration worker-start --spec-file <spec> --task-title "<task> d-NNN <role>" --run <run> --worktree path:<worktree> --agent <agent> [--keep-open] --retry-request <request id> --json`) in the dispatch's worktree and the task's Orca Run (the first dispatch of the task creates it with `orca orchestration run-create` and stores it as `orca_run` in `task.json`); you never call a tool to start a role. It prints JSON with `needs: "worker"`, `dispatch`, `role`, `request_path`, `orca_dispatch`, `prompt_path`, `reply_path`, `timeout_s`, `started` and `instructions`. The worker reads the `Prompt:` file, does the role, writes its complete final report to the `Report:` file (`.arbor/.runtime/replies/<task>/d-NNN.md` in the main checkout; the only reply the driver reads) and sends Orca's `worker_done` once (`--report-path <that file>`; the driver takes the verdict from the report file, not from `--outcome`). After starting every ready item, **end your turn**: Orca wakes you when a worker reports, asks a question or stops. If the wake names an `orca orchestration check` command, run it. Then run `python3 ./.arbor/scripts/arbor.py sync`, then `arbor.py next`.

`arbor.py sync [--dispatch d-NNN] [--wait <duration, e.g. 10m>]` reads each pending worker (`orca orchestration worker-show --dispatch <id> --full --json`): a settled worker's reply is validated (reply format, writer's commit, boundaries) and the task advances (`d-NNN <role>: ok|fail|judgment; report: ...`); the report file is the reply, whatever the worker told Orca: a worker that settled as failed in Orca (e.g. `worker_done --outcome failed`), exited, timed out or ended its turn without `worker_done`, but wrote its report, is collected through the same validation (`d-NNN <role>: its report is written and is validated as the reply`); only a worker with an empty report file is a failed dispatch. A worker that sent `worker_done` with an empty report file is collected for your judgment (`decide retry` or `decide accept --report <interpreted report>`; read its output with `orca orchestration worker-read --dispatch <id>`). `running (orca dispatch <id>)` means keep waiting. `waiting for a person (...)` means a permission prompt only a person can answer: the user answers it in the worker's Orca tab. `its turn ended without a report or worker_done` means the worker stopped silently (Orca also wakes you with "Worker stopped without reporting"): answer its question if it asked one (`orca orchestration reply --id <message_id> --body "..."`), otherwise `orca orchestration send --to dispatch:<orca dispatch> --subject "finish" --body "Write the report to <reply file>, then send worker_done."`; a fresh worker is not judged this way during its first 60 seconds. Past the executor `timeout` the driver stops the worker (`orca orchestration worker-stop`) and collects it as failed only when Orca confirms the stop; otherwise it prints `timeout after …, and Orca could not prove the worker stopped; not collected`: inspect `orca orchestration worker-show --dispatch <id>`, then `sync` again (a worker is never collected while it may still be writing). `--wait` polls until a worker settles or needs attention (the fallback when no wake arrives). Exit code 1 when a collected dispatch failed. A worker's question (`orca orchestration ask`) arrives as Orca mail: answer with `orca orchestration reply --id <message_id> --body "..."`.

`arbor.py run --dispatch d-NNN` is safe to repeat: the request id makes a start idempotent, so starting the same prepared request again (after a killed `arbor.py run`) replays Orca's answer instead of starting a second worker. A failed start is not a failed dispatch: `arbor.py run` exits 1 and prints why on stderr, and the request stays prepared (`next` shows `needs: worker`, not started, with the reason). The cause is usually environmental (agent CLI missing, a trust prompt, Orca unreachable): fix it, then run `arbor.py run --dispatch d-NNN` again; the driver releases what the failed start left (`orca orchestration worker-release`) and retries on the same Orca Task. The third failed start in a row fails the dispatch. Never retry with a new dispatch to get around it. A missing Orca CLI is an error (`Orca CLI not found … set executors.<name>.command`). When another agent session drives the task later, the driver takes the Run over (`orca orchestration run-use`) on the first start; there is no command for it. Request records live in `.arbor/.runtime/workers/<task>/<dispatch>.json`; a collected request is not collected twice.

**Orca workspaces.** One task = one Orca workspace (its worktree on `arbor/<task>`); every role of the task is a worker inside it. Orca creates and removes every worktree (`orca worktree create` / `orca worktree rm`, never forced except to roll back a worktree the same command just made) and chooses its path; arbor records it (`worktree_path` in `task.json`) and finds a task worktree again by its branch. CONTRACT-phase roles run as workers in the main checkout's workspace; a partition (`arbor/<task>--<p>`, workspace `<task>-<p>`) is a child workspace of the task's, and a child task a child workspace of the parent's integration workspace (named `<parent task>`). If Orca already has a workspace or branch of that name, `task.py start` is refused ("Orca already has a workspace or branch named …"). The main agent must itself run inside Orca (an agent tab in the repository's workspace): the coordinator identity and the wake-ups come from the Orca terminal.

**Dispatch header.** The driver writes it; you never type it:

```
Active task: <absolute path of .arbor/tasks/<task> inside the task worktree>
Role: explore | architect | implement | review | fix | simplify
Mode: self-check | candidates | sweep | plan        (review only)
Range: <base>..<head>                               (roles that read or write a diff)
Dispatch: d-NNN
Prompt: <absolute path of .arbor/.runtime/prompts/<task>/d-NNN.md>
Report: <absolute path of .arbor/.runtime/replies/<task>/d-NNN.md>
```

Then the injected context (`implement.jsonl` for architect / implement, `check.jsonl` for review / fix / simplify; `contract.md`, `design.md`, `waves.md`, `git diff <Range>`), then your brief. The brief is committed as `briefs/d-NNN.md`, the reply plus the driver's verdict as `reports/d-NNN.md`.

**Briefs.** The role cannot see your conversation. A brief carries what the artifacts do not: the essential files to read first, decisions already made, known pitfalls, files to stay out of; for review the `Angles:` line; for fix the findings JSON. Do not paste the contract or the diff; the driver injects them. Never ask a role to dispatch another role.

**Judgment, not automation.** File / role / commit observations never automatically STOP a task or reset work: the main agent inspects the diff, the raw report and concurrent activity. An ambiguous report (or an empty reply file) is collected with status `judgment` and `next` returns `needs=decide`: `arbor.py decide retry --reason "…"`, or interpret it yourself and `arbor.py decide accept --report <file> --reason "…"` (the interpretation uses the role's structured format; no implicit PASS). Contract drift is an observation; scope and acceptance changes still need the user. Round caps are escalation gates: `NO_PROGRESS` (two rounds without progress) or `BUDGET` (4 consecutive red gates, 2 review fix rounds) enter STOP.

**CONTRACT-phase dispatch.** Before `task.py start` you can dispatch `explore`, `architect` and `review` (`Mode: plan`): `arbor.py next --role <role> --json` names the next `dispatch` id and its `brief_path`; write the brief; `arbor.py run --role <role> [--mode plan] --dispatch <id>`. It runs in the main checkout with no `Range:` and commits nothing; `explore` / `architect` may write only `<task>/research/`, `review` nothing. Independent angles run concurrently with no quota (prepare and run each one; `next --json` lists `pending_workers`); dependent questions wait for their prerequisites; the plan review and `task.py start` wait until every reader is collected. Each reader owns `research/<dispatch>-*.md`; you consolidate the evidence into `design.md`, `contract.md`, `waves.md` and the manifests. Dispatch ids continue after start.

**Multi-partition waves.** When the contract's current wave names more than one partition, `arbor.py run` gives each partition its own branch `arbor/<task>--<p>` and worktree (Orca workspace `<task>-<p>`); `next --json` carries `partition` and `partitions_pending`. Write each brief at its `brief_path`, then `arbor.py run --partition <p>` for each (they run at the same time; keep to `executors.orca.max_parallel`). A partition's writer must stay within its paths; a change outside them (the task directory aside) stops the merge as `human` / `merge_conflict` with `reason: scope`: ask the user whether to revert it on the partition branch (then `resume` merges) or to merge by hand. When every partition is done, `arbor.py run` merges the branches `--no-ff` in wave order; a conflict becomes `human` / `merge_conflict`: merge by hand in the task worktree, commit, `arbor.py resume`.

**Sub-agent self-exemption.** If your prompt carries `Active task:` + `Role:` (after Orca's dispatch preamble; the Arbor header follows under `=== TASK ===`), you are a dispatched worker: read the `Prompt:` file first, do that role's work directly, write the complete report to the `Report:` file (the one file you may write outside your role's write boundary), then send `worker_done` with `--report-path`; never run `arbor.py` or `task.py start/current/finish`, never dispatch anything, never push, merge or rebase.

### Roles

Role instructions live in `.arbor/agents/<role>.md` of the main checkout; the driver reads them at every dispatch, so an edit applies to every open task from its next dispatch on.

| Role | Writes | Commits | Output |
|---|---|---|---|
| `explore` | `.arbor/tasks/<task>/research/**` | no | findings + 5–10 essential files |
| `architect` | `.arbor/tasks/<task>/research/**` | no | one blueprint + partition / wave suggestion |
| `implement` | anything (code and tests) | yes, own branch | Complete / Partial / Blocked + verification (every auto check green) |
| `fix` | as implement; never weakens a test or edits a repro to pass | yes, own branch | fixed / skipped per finding; each repro before / after (may promote it into the suite) |
| `simplify` | as implement, tests untouched | yes, own branch | behavior-preserving cleanup, or "no change"; not a step of the loop, run it with `arbor.py override --role simplify` |
| `review` | candidates / sweep: `.arbor/tasks/<task>/research/repro/**`, runs tests and builds; otherwise nothing | no | first line `PASS` / `FAIL` + findings JSON, CONFIRMED (candidates / sweep: with a `repro`) / PLAUSIBLE / REFUTED per finding |

Every role: no push, no merge, no rebase, no checkout of other branches, no writes under `.arbor/` except `tasks/<task>/`. Commit format: `<role>(<task-dir-name>): <summary>` with trailer `Arbor-Dispatch: d-NNN`.

### Parent / Child Task Trees

Use a parent task when one user request contains several independently verifiable deliverables. The parent owns the requirement set, the task map, the cross-child acceptance criteria and a `## Children` list (deliverable, paths it owns, depends-on); it normally has no implementation work of its own. Children are created with `task.py create … --parent <parent-dir>` (or linked with `task.py add-subtask <parent> <child>`). Parent/child structure is not a dependency system: ordering between children is written in the child contracts, not implied by the tree; start the child that owns the next independently verifiable deliverable. Do not start the parent.

**Children run in parallel on the parent's integration branch; the parent reviews them all at once.** Starting the first child of an unstarted parent creates `arbor/<parent>` (cut from the checked-out branch, in an Orca workspace `<parent>` under the main checkout's, recorded in the parent's `task.json.integration`); every child is cut from it and merges back into it. Each started child is driven from a session of its own (every `arbor.py` call with `--task <child>`); `arbor.py --task <parent> children` shows every child's state, merge status and whether it is behind the integration branch. **A child skips REVIEW** (`task.json.review_deferred`): BUILD → GATE → FINISH. Its FINISH needs no human: `arbor.py finish` merges the integration branch into the child when it is behind, runs the gate, checks the scope (partition paths), then merges the child `--no-ff` into the integration branch and archives it there; a failed check prints why and leaves a human merge (`human.kind: merge`). When every child is merged (`next --json` of the parent says so), `python3 ./.arbor/scripts/task.py integrate <parent> [--tier standard|full]` starts the **integration review**: the parent takes the integration worktree and branch as its own (its task directory moves there, as `start` does), enters REVIEW/candidates over the whole integration range, and from there `arbor.py --task <parent> next` drives the ordinary loop: candidates → `fix` on the integration branch (the only writer left) → GATE (`gate.commands` + the parent contract's `auto` checks, in the integration worktree) → recheck of the delta → FINISH. `arbor.py --task <parent> finish` writes the scorecard and prints the `--no-ff` merge command for the integration branch into the baseline (always the user's); after the merge, `finish` again removes the integration worktree and branch, archives the parent and writes one journal entry listing every child. Seed the parent's `check.jsonl` (`task.py seed-context <parent>`) before `integrate` so the readers get spec context. A child created with `--base-branch <b>` opts out: it reviews itself and merges into `<b>` by a human like any task.

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
Phase 2: Drive   → the `arbor.py next` loop: BUILD (implement: code + tests) → GATE → REVIEW (light: self-check → fix; standard / full: candidates → fix; full: + sweep; after every fix: GATE → one self-check over the delta, or a new candidate cycle when the delta is large) → FINISH; an integration child: BUILD → GATE → FINISH
Phase 3: Finish  → spec update → `arbor.py finish` (scorecard + PR / merge command) → human `--no-ff` merge → `/arbor:finish-work` (cleanup, archive, journal); child: automatic merge into the parent's integration branch; parent: `task.py integrate` → the REVIEW loop on the integration branch → `arbor.py finish` → human merge → `finish` again (cleanup)
```

### State Machine

| State | Entered when | Who | What happens | Leaves to |
|---|---|---|---|---|
| INTAKE | `/arbor:workflow <request>` | you → human | propose a tier with a one-line reason; the human answers ok / light / standard / full | consent → `task.py create` → CONTRACT |
| CONTRACT | task directory exists | you + explore / architect + human | explore → one question list → `contract.md` (+ `design.md`; full: architecture perspectives → `waves.md`) → `seed-context` → structural validation → full: review `Mode: plan` → human approves | `task.py start` → BUILD |
| BUILD | a wave is pending | you + driver + implement | `implement` delivers code and tests and runs the contract's `auto` checks, lint and typecheck green before committing (GATE runs the full suite); a wave of several partitions runs one implement per partition in parallel | GATE |
| GATE | the task branch has new commits | driver → you | `gate.commands` + every `auto` row of the Verification map. Green → next wave or REVIEW (an integration child: FINISH). Red → you classify: `impl` (`fix`) / `contract` (edit the contract; the human re-approves) | 4 consecutive reds → STOP |
| REVIEW | GATE green, all waves done | review, fix, human | light: one `review` `Mode: self-check` over `last_reviewed..HEAD` → findings → `fix`. standard / full: N `review` `Mode: candidates` (2 / 3, in parallel; each verifies its own ≤ 8 findings, and a CONFIRMED verdict without a `repro` is read as PLAUSIBLE) → dedup + mechanical prefilter → CONFIRMED → `fix`, PLAUSIBLE per mandate; full: one `sweep` over the whole range once the cycle is clean, self-verified the same way. After every `fix`: GATE (plus every `exec` repro as `REPRO-n`) → **recheck**: a delta of at most `mandate.auto_merge_max_lines` lines gets one `review` `Mode: self-check` over `last_reviewed..HEAD` (none when the passing repros cover every fixed finding), a larger one a new candidate cycle over it | PASS / clean → FINISH; 2 fix rounds or no progress → STOP |
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
| REVIEW | 1 self-check reviewer → fix | 2 candidate readers → fix | 3 candidate readers → fix → sweep |
| Human gates | tier · merge | + contract | + contract · PLAUSIBLE |
| Sessions | one | one | one per child task, concurrently; the parent's for the integration review |
| Escalation | → standard on the first signal: 2 consecutive red gates, an implement report Partial / Blocked, a large diff (`ESCALATE_MAX_LINES` in `common/driver/state.py`) or changes in two configured packages at a BUILD gate | — | — |

The tier lives in `task.json.meta.tier` (`task.py create --tier <t>`, later `task.py set-meta <task> tier <t>`); without it the tier is inferred from the artifacts (`waves.md` → full, `design.md` → standard, else light). The driver escalates a light task to standard by itself (one way, recorded in `task.json.tier_history`): the green gate then enters candidates, and the standard mandate applies from then on. `task.py set-meta <task> tier_lock true` keeps a light task light; a child whose review is deferred to its parent never escalates. Light has no candidate readers, so the repro rule and the repro-covered recheck skip apply only once a task is standard or full.

### Human Gates

1. **Tier** (INTAKE): the human agrees to the proposed tier.
2. **Contract** (end of CONTRACT): the human approves `contract.md`; material changes to scope or acceptance need approval; editorial changes do not.
3. **PLAUSIBLE** (REVIEW, only when PLAUSIBLE findings survive the readers): fix or skip, asked once, most severe first with your recommendation.
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
Roles here: write the brief at the `brief_path` from `arbor.py next --role <role> --json`, then `arbor.py run --role explore|architect|review [--mode plan] --dispatch <id>`; it runs as a worker in the main checkout and commits nothing; independent angles run concurrently.
Multi-deliverable scope: a parent task plus independently verifiable child tasks (`task.py create --parent`); dependencies are written in child contracts, not implied by tree position.
Approve (1.7): end the planning summary with the approval question; run `task.py start <task>` only after a later user message approves the contract.
[/workflow-state:planning]

### Phase 2: Drive
- 2.1 The loop `[required · repeatable]` (`arbor.py next` → do the one thing it names)
- 2.2 Write a brief `[required · repeatable]`
- 2.3 BUILD (implement: code + tests, auto checks green)
- 2.4 GATE and decide `[on demand]`
- 2.5 REVIEW (light: self-check; standard / full: candidates (self-verified, with repros) → fix; full: + sweep; after a fix: GATE with the repros, recheck of the delta)
- 2.6 STOP, resume, override `[on demand]`

<!-- Per-turn breadcrumb: fallback only. Normally the hook shows the driver's
     own one-line next step instead of this block. -->

[workflow-state:in_progress]
The driver did not answer. Run `python3 ./.arbor/scripts/arbor.py next` and do the one thing it names: `brief` → write it at its path, then `arbor.py run`; `worker` → end your turn (Orca wakes you), then `arbor.py sync`, or `arbor.py run --dispatch <id>` when not started; `run` → `arbor.py gate` / `arbor.py run`; `decide` → `arbor.py decide <choice> --reason "…"`; `human` → `approve_contract` / `plausible` / `stop` / `merge_conflict`: ask the user, then `decide` or `resume`; `merge` → Phase 3. If `arbor.py` is missing, run `arbor update`.
Roles run only as Orca workers started by `arbor.py run` from the main session only; never use the built-in Agent/Task tool or perform a role in this session. Sub-agent self-exemption: if you are a dispatched sub-agent (your prompt carries `Active task:` / `Role:` after Orca's dispatch preamble), perform that role directly, write the report to the `Report:` file, send `worker_done` and do not run arbor.py.
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
5. Inside an Arbor task, never perform a role in this session and never use the built-in Agent/Task tool for one; every role goes through `arbor.py run` as an Orca worker

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

`python3 ./.arbor/scripts/task.py seed-context <task> [--package <pkg> ...]` writes the packages' spec `index.md` files, `.arbor/spec/guides/index.md` and every `research/*.md` into **both** manifests; when the package has a `lessons.jsonl` it first renders `research/lessons.md`, a digest of the newest 50 lessons not yet backed by a test or a lint. Then add specific guideline files with `task.py add-context <task> implement|check "<path>" "<reason>"` and drop lines that do not apply to a side (`implement.jsonl` → architect, implement; `check.jsonl` → review, fix, simplify). Never add code files. Ready gate: both `implement.jsonl` and `check.jsonl` must contain at least one real `{"file": "...", "reason": "..."}` entry before `task.py start`. The seed `_example` row alone is not ready; `start` refuses it (`--allow-empty-context` when intentional).

#### 1.6 Validate & plan review `[required · once]`

Structural validation runs on the contract (see Task Artifacts); fix every error it reports. Full: run one `review` with `Mode: plan` (goal-backward: what must be true for the goal, which criterion covers it, is it wired, does it fit the context budget) and revise the contract with its findings. Standard may run one when the design is contested.

#### 1.7 Approve & start `[required · once]`

End the planning summary (goal, scope, criteria with their checks, key decisions, risks, tier) with the question whether to approve the contract. Only a later user message that approves it authorizes `python3 ./.arbor/scripts/task.py start <task-dir>`: it checks the tier's artifacts (light `contract.md`; standard + `design.md`; full + `waves.md`) and the manifests, records `contract_hash`, creates the task worktree and branch, commits the task directory (with the CONTRACT-phase briefs, reports and research) and sets `state=BUILD`. From here on the driver leads (2.1). If `start` reports a session-identity problem, follow its hint and retry.

---

## Phase 2: Drive

Goal: the driver walks BUILD → GATE → REVIEW; you supply judgment and briefs from this session and ask the user only at the human gates whose mandate is `ask`.

#### 2.1 The loop `[required · repeatable]`

`python3 ./.arbor/scripts/arbor.py next`: do exactly what it names (the `needs` table in Driver), then `next` again. Do not edit `task.json`, do not run roles yourself, do not commit on behalf of a role. A child task driven from its own Orca agent session passes `--task <child>` on every call. Each `run` starts a worker: end your turn, and when Orca wakes you run `arbor.py sync`, then `next` again. A pending request survives an interrupted session: `arbor.py sync` it; `arbor.py run --dispatch d-NNN` is safe to repeat.

#### 2.2 Write a brief `[required · repeatable]`

Write the brief at `brief_path` for the role `next` names, then `arbor.py run`. Short and specific:

- **implement**: the essential files, the part of the design this run covers, the criteria and their test files, pitfalls, files to stay out of. Name only targeted tests: writers run the contract's `auto` checks, lint and typecheck; the full suite is GATE's (`gate.commands`).
- **fix** (and `simplify` via override): the essential files, pitfalls; for fix the findings JSON, the CONFIRMED entries verbatim with their `repro` (also in `next --json` as `repros`).
- **review**: `Angles:` — self-check (light entry, and the recheck of a fix delta in every tier): `A, B, C, D, E, Conventions, Acceptance, Cleanup-lite`; candidates, one angle group per reader (standard: `A, D, Acceptance` / `B, C, E, Conventions, Cleanup-lite`; full: `A, D` / `B, Conventions, Cleanup-lite` / `C, E, Acceptance`); sweep: the verified list.

#### 2.3 BUILD

`implement` reads the contract and design, writes the tests the Verification map names and the code that satisfies the criteria, runs every `auto` check plus lint and typecheck green and commits (the full suite runs at GATE). Writing a test first is the role's habit, not a gate: the driver checks the result at GATE. A Partial or Blocked report comes back through `next`; add the missing information to the next brief or return to the contract. A multi-partition wave runs one `implement` per partition in its own worktree, then merges them `--no-ff` (see Driver).

#### 2.4 GATE and decide `[on demand]`

The driver runs `gate.commands` and every `auto` check. Red → `next` asks you to classify the failure with `arbor.py decide impl|contract --reason "<one line of evidence>"`: `impl` — the code or its tests are wrong; `fix` runs. `contract` — the contract is wrong; edit `contract.md`, get the user's approval, then `arbor.py resume`.

On a light task the gate also feeds the escalation to standard: the second consecutive red gate, or at a green BUILD gate more than 300 changed lines in `base..HEAD` (`.arbor/tasks/` excluded) or files in more than one configured package; an implement report Partial / Blocked escalates as soon as it is collected. The gate output and `next --json` (`escalated`) say which signal fired.

#### 2.5 REVIEW

**Light**: one `review` `Mode: self-check` over `last_reviewed..HEAD` (including "does the Verification map cover every criterion"); findings go to `fix`. **Standard / full**: N `review` `Mode: candidates` in parallel from the `batch` of `next --json`; each reader verifies its own findings (at most 8), may run tests and builds and writes its repros under `<task>/research/repro/` → the driver dedups and prefilters mechanically (file exists, line within ±5 of a change, cited spec exists) → CONFIRMED findings are fixed without asking. A CONFIRMED verdict needs a `repro`: `exec` (a script that fails on the current HEAD and passes once fixed, plus the command that runs it) or `trace` (two or more existing `file:line` steps); the driver reads one without as PLAUSIBLE and says so in the report's observations; PLAUSIBLE ones follow the mandate (`plausible=auto`: the driver records `decide skip` and lists them in the scorecard; `ask`: put them to the user once, then `arbor.py decide fix|skip --reason "…"`) → `fix`. Full: once a cycle is clean, one `review` `Mode: sweep` over the whole range with the verified list; it verifies its new findings the same way. **After every fix** (every tier): GATE, which also runs the `exec` repro of every fixed finding as `REPRO-n` (a failing one is a red gate like any other), then the driver measures the fix delta `last_reviewed..HEAD`: at most `mandate.auto_merge_max_lines` lines → one `review` `Mode: self-check` over it (PASS → FINISH, or the sweep in full), except when every fixed finding's `exec` repro passed in that gate: then the cycle closes without the self-check (`task.json.recheck_skips`, listed in the scorecard); larger → a new candidate cycle over the delta. Two fix rounds, or a cycle without progress, enter STOP. Invalid findings may stay unfixed; list them in the final summary. Cleanup is an angle of the readers (`Cleanup-lite`), not a stage: run `simplify` only on demand with `arbor.py override --role simplify`.

#### 2.6 STOP, resume, override `[on demand]`

STOP comes from a round cap (`BUDGET`), two rounds without progress (`NO_PROGRESS`) or an explicit `abandon` (`HUMAN`); all work is preserved. `next` answers `needs=human` with `human.kind: stop`, the reason and the evidence: inspect the result, tighten the brief or change the plan, tell the user what happened, then `arbor.py resume` (BUDGET: grants one more round), `arbor.py override --reason "…" --to STATE[/step]` (a recorded state decision) or `--role <role> [--mode M]` (an extra role inside the contract), or `arbor.py abandon --reason "…"`.

---

## Phase 3: Finish

Goal: a merged branch with its evidence, the lessons captured, the session recorded.

#### 3.1 Spec update `[required · once]`

Load `arbor-update-spec` and decide what this task taught: recurring CONFIRMED categories from the review reports belong in `.arbor/spec/` (or a lint rule). Edit spec files in the task worktree and commit them on the task branch before `arbor.py finish`; afterwards `python3 ./.arbor/scripts/spec.py verify <doc>` (`spec.py lint` lists stale or unlisted docs, advisory).

`arbor.py finish` appends one row per CONFIRMED finding (every review reader) to `.arbor/spec/<package>/lessons.jsonl` (single repo: `.arbor/spec/lessons.jsonl`; `.arbor/spec/.gitattributes` merges it with `union`) and commits it with the scorecard. Before the merge, fill each new row's `root_cause`, `prevention`, `check` (`none` | `spec` | `test` | `lint`) and `check_ref`, and commit on the task branch. When the scorecard's **Recurring across tasks** names a category (rows of two or more tasks, none backed by a test or a lint), add a lint rule or a test and mark the row `check: lint|test` rather than another spec sentence; the reminder is advisory and does not block the merge.

#### 3.2 Debug retrospective `[on demand]`

If the same issue was fixed more than once, load `arbor-break-loop`: classify the root cause, explain why earlier fixes failed, propose prevention.

#### 3.3 Scorecard, PR and merge `[required · once]`

`python3 ./.arbor/scripts/arbor.py finish [--pr]` writes and commits `scorecard.md` (read its "Recurring CONFIRMED categories" against 3.1), then opens the PR (`--pr` with `gh`; body = contract + scorecard) or prints the local `--no-ff` merge command. The human merges; never merge or push yourself. With `merge=auto` (the user opted in) the same run merges a branch that changes fewer than `auto_merge_max_lines` product lines, stays within the partition paths, has no product commit after the last review PASS, with a clean main checkout on the base branch and no conflict, and goes straight on to the cleanup. A child of a parent merges into the parent's integration branch instead (see Parent / Child Task Trees).

#### 3.4 Cleanup, archive, journal `[required · once]`

Once the branch is merged, `/arbor:finish-work` runs `arbor.py finish` again: it removes the task worktree and branch, archives the task, clears the session pointer and writes the journal entry (DONE), then records anything else the session did. An integrated parent is cleaned up the same way: its journal entry lists every child the integration branch carried.

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

A product task owns two worktrees (Orca creates both; the product worktree is a child workspace of the control task's). Its task directory, contract, manifests, specs, briefs, reports and scorecard live in the **control** worktree. Writer commits, Range diffs, GATE commands, partition worktrees and merges operate in the **product** worktree. Product code and verification paths in the contract are relative to the product root. Context manifests continue to reference control-repo specs; roles read product sources from the explicit execution directory in their prompt. The product repo does not need an Arbor installation. Package-specific `execution.worktree` and `execution.gate` settings under the package configuration replace the control project's setup/GATE settings for product execution; a product GATE with neither commands nor contract `auto` checks is rejected with `GATE-EMPTY`. Execution repository identity, source commit, merge target and package policy are frozen in `task.json.execution_binding`; changing that binding or the package policy after start is refused.

Product execution dispatches are serialized, including within a multi-partition wave (`next` lists one ready item at a time); CONTRACT readers can run concurrently in the control worktree. Control and main-checkout snapshots record drift as observations for the main agent, not proof that the child wrote those files (`arbor.py sync --dispatch d-NNN --accept-new-control-task <name> --reason "..."` records a narrowly checked sibling-task acceptance). A failed/interrupted product setup retains a start journal under `.arbor/.runtime/starts/` and owned worktrees; inspect those before retrying.

Finish uses two explicit local merge boundaries: `arbor.py finish` first prints the product merge command; after that `--no-ff` merge, run it again to record product merge evidence and obtain the control merge command; after the control `--no-ff` merge, run it again for cleanup/archive. Cleanup checks both repos and refuses dirty or changed product worktrees. Automatic product PR creation is not supported. A control merge alone never completes a product task.
