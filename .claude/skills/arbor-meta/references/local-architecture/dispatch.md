# The Driver: arbor.py

In Arbor the six roles (`explore`, `architect`, `implement`, `review`, `fix`, `simplify`) are not platform sub-agents. One script, `.arbor/scripts/arbor.py`, runs them. It owns three things: the task's state table, its counters, and validation (of replies, commits and git invariants). Judgment belongs to the **main agent** (the user's session, normally one Orca agent session per task): the tier proposal, the contract, child-task splitting, briefs, red-gate classification, finding dedup, retries inside the contract, the questions put to the user and the merge gate. Role instruction text lives in `.arbor/agents/<role>.md` (plain markdown, no frontmatter).

## Commands

```bash
python3 ./.arbor/scripts/arbor.py --task <parent> children [--json]   # child tasks: state and merge status
python3 ./.arbor/scripts/arbor.py next [--json]               # the single next step
python3 ./.arbor/scripts/arbor.py run [--dispatch d-NNN]      # execute the pending dispatch (in GATE: the gate)
python3 ./.arbor/scripts/arbor.py run --role explore|architect|review [--mode plan] [--dispatch d-NNN]   # CONTRACT phase, before task.py start
python3 ./.arbor/scripts/arbor.py gate                        # GATE level 0; prints the failing AC ids
python3 ./.arbor/scripts/arbor.py decide <choice> --reason "…"   # impl | tests | contract · fix | skip
python3 ./.arbor/scripts/arbor.py override --reason "…" (--to STATE[/step] | --role <role> [--mode M])   # one step off the state table; recorded in the scorecard
python3 ./.arbor/scripts/arbor.py status | resume | abandon [--reason "…"]
python3 ./.arbor/scripts/arbor.py prompt --dispatch d-NNN --print   # the assembled prompt, rebuilt
python3 ./.arbor/scripts/arbor.py sync [--dispatch d-NNN] [--wait 10m]   # read every pending Orca worker; validate and collect the settled ones
```

Every command takes `--task <dir>` before the command name (`--task` defaults to the session's active task; a child task driven from its own Orca agent session passes it on every call). Exit codes: 0 ok, 1 refused / failed dispatch / red gate, 2 usage error.

`next --json` always has `task`, `state`, `needs` (`worker | brief | run | wait | decide | human | done`) and `summary`; it adds `tier`, `wave`, `partition`, `role`, `mode`, `range`, `dispatch`, `brief_path`, `batch` (readers of the step that may run concurrently, each `dispatch` + `brief_path`), `readers_running`, `decision` (`kind`, `options`, `failing`), `human` (`kind`: `approve_contract | plausible | stop | merge_conflict | merge`; `mandate`: `ask | auto`, the task's mandate for that gate) and `touched_files` when they apply; an escalated task adds `tier_history` and `escalated`, and REVIEW/fix adds `repros` (CONFIRMED finding id → reproduction). On a task that is not started yet it returns `state: CONTRACT`, `needs: human` with `human.kind: approve_contract`, plus `dispatch` (the next id), `brief_path` and `contract_roles` (`explore`, `architect`, `review`). The SessionStart and per-turn hooks show only `summary` and `needs`.

## State Machine

`CONTRACT → BUILD → GATE → REVIEW → FINISH → DONE`, with `STOP` reachable from any state. `task.py start` enters BUILD after the human approves the contract. BUILD runs `implement` (code and tests together; the role runs the contract's `auto` checks green before committing); GATE runs `gate.commands` plus every `auto` Verification-map command; REVIEW for light runs one `review` `Mode: self-check` over `base..HEAD`, `fix`, and re-reviews over `last_reviewed..HEAD`; for standard / full it runs N `review` `Mode: candidates` (2 / 3, each verifying its own at most 8 findings; a CONFIRMED verdict needs a `repro`, else the driver reads it as PLAUSIBLE), a dedup and mechanical prefilter, `fix` for CONFIRMED findings, and for full a `sweep` once a cycle is clean (`task.json.cycle`, `cycle_ids`, `cycle.repros`). After a fix the GATE also runs every `exec` repro as `REPRO-n`; when those cover every fixed finding and the delta is small the recheck self-check is skipped (`task.json.recheck_skips`). A light task escalates to standard by itself on two consecutive red gates, an implement report Partial / Blocked, or a BUILD diff over 300 lines or two packages (`state.maybe_escalate`, `common/driver/escalate.py`, `task.json.tier_history`; `meta.tier_lock: true` opts out). Caps: 2 review fix rounds in every tier; 4 consecutive red gates; 2 rounds without progress. A cap enters STOP (`BUDGET` / `NO_PROGRESS`); `next` answers `needs=human` with `human.kind: stop` and the main agent continues with `resume` (grants one more round), `override` or `abandon`. The task's mandate (`mandate:` in `.arbor/config.yaml` per tier, `task.py create --mandate`, resolved by `common/driver/mandate.py`; gates `contract`, `plausible`, `merge`) decides which human gates ask: with `auto` the driver records `decide skip` for PLAUSIBLE findings and `arbor.py finish` merges a branch under `auto_merge_max_lines` product lines itself (`task.json.auto_merge`, committed on the task branch before the merge). Reader batches: REVIEW candidates gets every reader's dispatch id when the step opens (`task.json.batch.ids`, assigned in `save()` under the task lock); `run --dispatch <id>` starts any of them, concurrently, and `batch.running` tracks them. Boundary observations stay advisory. Only the driver changes `task.json` `state`, `counters`, `dispatches`, `last_reviewed` and `stop`.

## CONTRACT-Phase Dispatch

Before `task.py start` there is no state table, worktree or Range, but the contract still needs research and a plan review. `arbor.py run --role explore|architect|review [--mode plan] [--dispatch d-NNN]` covers that:

- The main agent writes the brief body at `<task>/briefs/<id>.md`, where `<id>` and the path come from `next --json` (`dispatch`, `brief_path`). Use an explicit new `--dispatch` id for concurrent research; retrying a pending id returns its original request. A missing or empty brief is refused.
- `--mode plan` goes with `review` only and is its default.
- The role runs in the main checkout, with header `Active task`, `Role`, `Mode` (review) and `Dispatch`, and no `Range:`. Nothing is committed.
- Write boundary: `explore` and `architect` may write only `<task>/research/`; `review` only `<task>/research/repro/` in `candidates` / `sweep` mode (its repro scripts, committed by the driver with the report), nothing otherwise. Unexpected changes are observations for the main agent. The driver preserves the files and HEAD, without reset, checkout or clean.
- Each run is recorded in `task.json` `dispatches` (`phase: "CONTRACT"`; review adds `verdict` and `findings`), in `<task>/reports/<id>.md`, and as a `results.jsonl` row with state `CONTRACT`.
- `task.py start` keeps those records and commits the task directory, briefs, reports and research included. Dispatch ids continue: after pre-start d-001 and d-002, the first BUILD dispatch is d-003.
- On a started task in CONTRACT, `run --role` also supports concurrent replanning; outside CONTRACT an extra role goes through `override --role`.
- With no task at all (INTAKE) only `--role explore` works: the brief comes on stdin, the reply goes to stdout, and no task directory is touched; the prompt is kept as `.arbor/.runtime/prompts/intake-<timestamp>.md`.

## Header Protocol

The driver starts every role prompt with:

```text
Active task: <absolute path of .arbor/tasks/<task> inside the task worktree; the main checkout before start>
Role: explore | architect | implement | review | fix | simplify
Mode: self-check | candidates | sweep | plan   (review only)
Range: <base>..<head>                          (roles that read or write a diff)
Dispatch: d-NNN
Prompt: <absolute path of .arbor/.runtime/prompts/<task>/d-NNN.md>
Report: <absolute path of .arbor/.runtime/replies/<task>/d-NNN.md>
```

In the worker's task spec (after Orca's dispatch preamble, under `=== TASK ===`) this header is all there is: the `Prompt:` line names the assembled prompt file and the role reads it first; the `Report:` line names the file the role writes its complete final report to. The older `Diff:`, `Target:` and `Workspace:` lines are gone. After the header comes the injected context, assembled by `common/dispatch_context.py`: the files listed in `implement.jsonl` (`architect`, `implement`) or `check.jsonl` (`review`, `fix`, `simplify`), then `contract.md` (legacy `prd.md`), `design.md`, `waves.md` (legacy `implement.md`), then `git diff <Range>` run in the task worktree, marked `<!-- arbor-hook-injected -->`; `explore` gets the spec overview plus the contract and the research file list. Size caps come from `context_injection:` in `.arbor/config.yaml`. Last comes the main agent's brief, which is `tasks/<task>/briefs/d-NNN.md`. The assembled prompt is not committed: it is written to `.arbor/.runtime/prompts/<task>/d-NNN.md` in the main checkout, and `arbor.py prompt --dispatch d-NNN --print` rebuilds it. The reply (the `Report:` file) plus the driver's verdict goes to `tasks/<task>/reports/d-NNN.md`; the driver commits the brief and the report on the task branch.

## Executors

`executors:` in `.arbor/config.yaml` decides how a role runs:

```yaml
executors:
  default: orca
  orca:
    type: orca
    command: orca          # the Orca CLI; an absolute path when not on PATH
    agent: codex           # Orca agent id every role starts as (codex, claude, omp, ...)
    timeout: 90m
    max_parallel: 5
    keep_open: false       # true: a finished worker stays open in Orca
    roles:                 # per-role agent override
      explore:
        agent: omp
```

`type: orca` is the only executor: `arbor.py run` assembles the prompt, writes the worker's task spec `<dispatch>.spec.md` beside it (the dispatch header plus `Prompt:` and `Report:` lines) and starts the worker itself with `orca orchestration worker-start --spec-file <spec> --task-title "<task> d-NNN <role>" --worktree path:<the dispatch's worktree> --agent <agent> [--keep-open] --json`. It prints `needs: "worker"`, `dispatch`, `role`, `request_path`, `orca_dispatch`, `prompt_path`, `reply_path`, `timeout_s`, `started` and `instructions`. The worker reads the `Prompt:` file, writes its complete final report to the `Report:` file (`.arbor/.runtime/replies/<task>/d-NNN.md` in the main checkout; the only reply the driver reads) and sends Orca's `worker_done` (`--report-path <file> --outcome succeeded`). The main agent ends its turn after starting every ready item; Orca wakes it when a worker reports, asks a question or stops (run the `orca orchestration check` command a wake names), then `arbor.py sync`, then `arbor.py next`.

`arbor.py sync [--dispatch d-NNN] [--wait <duration>]` reads each pending worker with `orca orchestration worker-show --dispatch <id> --json`: a settled worker's reply is validated (reply format, writer's commit, boundaries) and the task advances; a failed or `worker_done`-less exit is collected as a failed dispatch; past `timeout` it is stopped (`orca orchestration worker-stop`) and collected as failed; `waiting for a person (...)` is a permission prompt the user answers in the worker's Orca tab; `running (orca dispatch <id>)` keeps waiting; an empty reply file is collected for judgment (`decide retry` or `decide accept --report <file>`; the output is readable with `orca orchestration worker-read --dispatch <id>`). `--wait` polls until a worker settles or needs a person. Exit code 1 when a collected dispatch failed. `sync --dispatch d-NNN --accept-new-control-task <name> --reason "..."` records a narrowly checked sibling-task acceptance.

A failed `worker-start` is recorded at once as a failed dispatch. If the Orca CLI is missing or Orca is unreachable the request stays prepared (`needs: worker`, "not started"); `arbor.py run --dispatch d-NNN` starts it. Never start a dispatch twice. Request records live in `.arbor/.runtime/workers/<task>/<dispatch>.json` (`task.json` key `workers`). A worker's question (`orca orchestration ask`) arrives as Orca mail: answer with `orca orchestration reply --id <message_id> --body "..."`. Do not substitute native Agent/Task/spawn_agent for a role.

One task = one Orca workspace (its worktree and branch `arbor/<task>`); every role is a worker inside it. CONTRACT-phase roles run as workers in the main checkout's workspace; a partition and a child task are child workspaces (`task.py start`, wave start and the parent integration branch register them with `orca worktree set --parent-worktree`, display only). The main agent must run inside Orca (an agent tab in the repository's workspace). One-time setup per repository: `orca repo add --path <repo>`, `orca repo set --repo path:<repo> --external-worktree-visibility show`; in Orca Settings, Agents, set each agent's permission mode so workers do not stop on prompts (codex and claude have a Yolo preset; omp needs `--approval-mode yolo` as launch arguments).

The agent comes from the `executors.orca` entry and its per-role overrides; model and reasoning effort are the agent's own settings in Orca. `run --autopilot` stops at worker handoffs; the host ends its turn and resumes the driver after Orca wakes it.

## Invariants And Commit Format

After every dispatch the driver checks, with git:

| Who | Check |
| --- | --- |
| readers (`explore`, `architect`, `review`) | worktree clean except the task's `research/` (`review`: `research/repro/`); HEAD unmoved |
| writers (`implement`, `fix`, `simplify`) | only their own branch moved, at least one new commit, no merge commits, every commit well-formed |
| partition writers | changed files within the partition's paths (the task directory aside); a change outside is a scope observation that stops the merge |
| everyone | remote refs and other local branches unmoved; `.arbor/` changes only under `tasks/<task>/` |
| contract | hash drift is recorded for contextual judgment, not an execution/collection gate |

Boundary and commit-format observations are retained for main-agent judgment without automatic failure, STOP or rollback. Role instructions recommend commits like:

```text
<role>(<task-dir-name>): <summary>

<optional body>

Arbor-Dispatch: d-NNN
```

Ambiguous reports are retained with status `judgment`, never silently counted as PASS. In a started task, `next` asks the main agent to `decide retry --reason ...` or `decide accept --report <interpretation> --reason ...`. The original report remains intact and the interpretation is recorded separately. Missing commits are advisory. Actual executor failures remain failures.

## Git Model

`task.py start` creates branch `arbor/<task>` and worktree `<worktree.root>/<task>` (default root `../<repo>-wt`), runs `worktree.setup` once, moves the task directory there and commits it. Partition branches for multi-partition waves are `arbor/<task>--<partition>` in worktrees `<root>/<task>-<partition>`, merged back with `--no-ff`. The task branch reaches the main branch through a PR the human merges with `--no-ff`. `.arbor/.runtime/` (sessions, `prompts/`, `results.jsonl`) stays in the main checkout.

## Guard Hook And Sub-Agent Exemption

`guard-builtin-agent.py` (PreToolUse, matcher `^(Agent|Task)$`, timeout 10) denies the built-in Agent/Task tool when the prompt carries an Arbor header or the `subagent_type` starts with `arbor-`, so roles cannot silently run outside the driver. A session whose prompt carries `Active task:` plus `Role:` (after Orca's dispatch preamble) is a dispatched worker: it does its role, writes its report to the `Report:` file, sends `worker_done`, never runs `arbor.py` or `task.py start/current/finish`, never pushes, merges or rebases, and has no `ARBOR_CONTEXT_ID`.

## Measurement

Every dispatch appends one line to `.arbor/.runtime/results.jsonl` (`task`, `dispatch`, `role`, `mode`, `state`, `wave`, `partition`, `executor`, timings, `exit_code`, `status`, `commit`, `violations`). FINISH writes `scorecard.md` into the task directory: dispatches per role, GATE / REVIEW rounds, findings per rung, AC automation rate, overrides and violations.

## Debugging

- `arbor.py status`: state, counters, last dispatches, STOP reason.
- `arbor.py prompt --dispatch d-NNN --print`: exactly what a role received.
- `.arbor/.runtime/results.jsonl`: per-dispatch exit code, status and violations.
- Observed boundary changes: inspect the retained files and raw report in context; no branch reset has occurred. Use the ordinary next step or a reasoned override. Legacy STOP records require explicit resume/override after inspecting evidence.

Independent CONTRACT explore/architect roles may run concurrently without a total role quota. Use `next --role explore|architect --json` to prepare another angle, then `run --role <role> --dispatch <id>`. Research/design readers have no simultaneous cap and do not consult `max_parallel`; the main agent chooses the fan-out. Results can be synced out of order; each owns `research/<dispatch>-*.md`. Plan review/start/resume wait for all readers, and the main agent consolidates the evidence.
