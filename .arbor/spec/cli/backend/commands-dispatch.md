---
sources:
  - packages/cli/src/templates/arbor/scripts/arbor.py
  - packages/cli/src/templates/arbor/scripts/common/driver/executor.py
  - packages/cli/src/templates/arbor/scripts/common/driver/orca.py
  - packages/cli/src/templates/arbor/scripts/common/dispatch_context.py
last_verified: 2026-11-02
---
# `arbor.py` — Task Driver and Executors

The driver owns task state, role preparation, deterministic checks, report
validation and Git observations. The main agent (the user's session) owns scope,
approval and judgment and drives a started task through the driver. The prompt
contract is in [dispatch.md](./dispatch.md).

---

## 1. Scope / Trigger

`packages/cli/src/templates/arbor/scripts/arbor.py` ships as
`.arbor/scripts/arbor.py`. Its helpers live under `common/driver/`; role context
is assembled by `common/dispatch_context.py`. Run it from the repository or a
task worktree. Roles run as Orca workers through the executor configured under
`executors:` in `.arbor/config.yaml` (`executors.default: orca`, `type: orca`;
the only executor type).

## 2. Signatures

All global options precede the subcommand:

```text
python3 .arbor/scripts/arbor.py [--task DIR] COMMAND

next [--json] [--partition P] [--role explore|architect|review]
run [--dispatch d-NNN] [--partition P] [--autopilot]
run --role explore|architect|review [--mode plan|sweep] [--range BASE..HEAD] [--dispatch d-NNN]
gate
decide impl|contract|fix|skip|accept|retry --reason TEXT
       [--dispatch d-NNN] [--report FILE]
override --reason TEXT [--to STATE[/step]] [--role ROLE] [--mode MODE]
status
resume
abandon [--reason TEXT]
prompt --dispatch d-NNN [--print]
sync [--dispatch d-NNN] [--wait DURATION] [--accept-new-control-task NAME --reason TEXT]
finish [--pr]
children [--json] [--cleanup]
```

| Global option | Contract |
| --- | --- |
| `--task DIR` | Explicit task directory; otherwise the session's active task. A child task driven from its own Orca agent session passes it on every call. |

| Subcommand | Behavior |
| --- | --- |
| `next` | Print the single next step; `--json` includes `task`, `state`, `needs`, `summary` and step-specific fields such as `brief_path`. `--role` prepares an additional CONTRACT research/design angle. |
| `run` | Execute the named brief, validate the report and advance. In GATE, run deterministic checks; at a completed partition wave, merge its branches. `--autopilot` continues until a decision, human gate, STOP, red gate or failed dispatch. Explicit `--role` is for CONTRACT research/design; parent sweep uses review plus an explicit merged range. |
| `gate` | Run level 0 gate commands and contract `auto` checks; report failing AC ids. A parent runs its integration checks in the main checkout. |
| `decide` | Record a reasoned decision: `impl`, `contract` for a red gate; `fix`, `skip` for PLAUSIBLE findings; `accept`, `retry` for report judgment. `--report` supplies a structured interpretation while preserving the raw report. |
| `override` | Record a justified state jump or one extra role dispatch without advancing the normal table. |
| `status` | Show task state, observations and metrics. |
| `resume` | Leave STOP with another round, or record approval of the revised contract. |
| `abandon` | Record abandonment, optionally with a reason. |
| `prompt` | Rebuild a dispatch prompt; `--print` prints its text. |
| `sync` | Read every pending Orca worker, validate settled replies and advance, collect failed, timed-out or empty-reply workers; `--wait` polls; `--accept-new-control-task` (with `--dispatch` and `--reason`) records a narrowly checked sibling-task acceptance. |
| `finish` | In FINISH, one run writes the scorecard and prints the merge command, opens a PR with `--pr`, or (`merge=auto`, a child of a parent) merges itself. After the merge, one more run cleans up, archives and journals; repeated calls continue missing steps. |
| `children` | List each child's state and merge status and the parent's integration branch; `--json` emits structured output; `--cleanup`, after a human merged the integration branch into the baseline, writes the journal entry and removes its worktree and branch. |

## 3. Contracts

- **Briefs and prompts.** `next --json` names `brief_path`; write only the brief
  body there. `run` adds the role header and curated context. Briefs and reports
  live at `<task>/briefs/d-NNN.md` and `<task>/reports/d-NNN.md`; assembled prompts
  live under `.arbor/.runtime/prompts/<task>/` in the main checkout. Runtime
  dispatch measurements are appended to `.arbor/.runtime/results.jsonl`.
- **Executors.** The `type: orca` executor makes `run` assemble the prompt, write
  the worker's task spec (header plus `Prompt:` and `Report:` lines) and start the
  worker (`orca orchestration worker-start`); it returns `needs: "worker"`. The
  main agent ends its turn, Orca wakes it, then `sync` validates the reply at the
  `Report:` file and advances. `run --dispatch d-NNN` starts a prepared request
  that was not started; never start one twice.
  See [dispatch.md](./dispatch.md).
- **The loop.** After `task.py start` the main agent runs `next`, does the one
  thing it names (`brief` → write it, `run`; `worker` → end the turn, then
  `sync`; `run` → `gate` or wave merge; `decide`; `human`) and runs `next`
  again. `needs` is one of `worker`, `brief`, `run`, `wait`, `decide`,
  `human`, `done`; `human.kind` is one of `approve_contract`, `plausible`, `stop`,
  `merge_conflict`, `merge`. A round cap or two rounds without progress enter
  STOP (`needs=human`, `human.kind=stop`); `resume` grants one more round,
  `override` records a reasoned jump, `abandon` ends the task. `human.mandate`
  (`ask` | `auto`, from `mandate:` in `.arbor/config.yaml` per tier or
  `task.py create --mandate`) says whether the gate asks the user; with `auto`
  the driver records `decide skip` for PLAUSIBLE findings, resumes the first
  STOP of a task and `finish` merges a small, in-scope, reviewed branch itself
  (`common/driver/mandate.py`). Merge into the baseline defaults to `ask` in
  every tier. After start, `next --json` also carries the ready set: `items`
  (every actionable step: the current one, every other partition needing a
  brief, prepared workers not yet started), `running` (in-flight workers and readers, `kind: worker`) and
  `blocked_on` when nothing is actionable. The driver computes it; the caller
  acts on every item, then waits.
- **Merge checks.** Before a wave merge, a partition branch changing files
  outside its paths and the task directory becomes
  `human.kind=merge_conflict` with `reason: scope`. Before any automatic merge
  of a task branch, the same scope check holds and the last review PASS must
  cover every product commit (`common/driver/integration.py`).
- **Planning.** Before start, `run --role explore|architect|review` performs
  CONTRACT research without a diff range or commits. Explore/architect may write
  task research; review is read-only. With no task, only explore accepts a brief
  on stdin. Started-task writers commit in their assigned worktree with the
  dispatch trailer; the driver records observations for caller judgment.
- **Parent integration.** The first started child of an unstarted parent
  creates the integration branch `arbor/<parent>` and its worktree (recorded in
  the parent's `task.json.integration`); children are cut from it, and a
  child's second `finish` merges it back `--no-ff` without a human after a
  catch-up merge, the gate and the merge checks. A failed check records
  `merge_blocked` and prints the merge command (`human.kind=merge`, mandate
  `ask`). An integration child carries `review_deferred` and skips REVIEW
  (BUILD -> GATE -> FINISH); the review-binding merge check does not apply to
  it. A child created with `--base-branch` opts out. After all children merge,
  `task.py integrate <parent>` moves the parent's task dir into the integration
  worktree, adopts its branch and base, and opens REVIEW/candidates over the
  whole integration range; `next` then drives candidates -> fix (on
  the integration branch) -> `gate` (in the integration worktree) -> recheck
  -> FINISH, and `finish` prints the human merge command, then cleans up and
  archives the parent after the merge (its journal entry lists every child).
  Tree position alone does not encode dependencies; write them in child
  contracts.

## 4. Validation & Error Matrix

| Exit | Condition | Behavior |
| --- | --- | --- |
| 0 | Command completed successfully | Read `needs` or the collected verdict; success can still require a decision or escalation. |
| 1 | Refused command, failed dispatch or red gate | Inspect the report and next step; no automatic pass. |
| 2 | Invalid CLI usage | argparse prints usage and the offending argument. |

Missing/invalid executors, an unreachable Orca CLI, duplicate collection and invalid reports are
failures to inspect. A red rung cannot advance to a higher verification rung.
Contract scope changes require approval; observations alone do not justify
resetting or deleting work.

## 5. Good / Base / Bad Cases

- **Good**: `python3 .arbor/scripts/arbor.py --task <task> next --json` names a
  brief; write it, invoke `run` (it starts the worker), end the turn, `sync` when Orca wakes you,
  then `next` again.
- **Base**: `python3 .arbor/scripts/arbor.py --task <task> finish` in FINISH
  writes the scorecard and prints the `--no-ff` merge command in one run; the
  same command after the merge cleans up and archives.
- **Bad**: starting a dispatch a second time, or treating a started worker as a
  completed role report before `sync` validates its `Report:` file.

## 6. Tests Required

- `test/spec/backend-docs.test.ts`: retired surfaces stay absent, all commands
  and protocols are documented, sources exist and scoped spec lint is clean.
- `test/scripts/v2-driver-*.integration.test.ts`: build, CONTRACT, review,
  partitions, executor/Orca protocol, report handling and finish behavior.
- `test/scripts/v2-children.integration.test.ts`: parent child visibility and
  merge status.
- `test/scripts/guard-builtin-agent.integration.test.ts`: native role dispatches
  are denied.

## 7. Wrong vs Correct

#### Wrong

Use a native Agent/Task/spawn_agent call with a hand-written role prompt, bypassing
brief tracking, invariant checks, commit validation and task state.

#### Correct

```bash
python3 .arbor/scripts/arbor.py --task <task> next --json
# Write the body at the returned brief_path; the driver assembles the prompt.
python3 .arbor/scripts/arbor.py --task <task> run --dispatch d-NNN
python3 .arbor/scripts/arbor.py --task <task> prompt --dispatch d-NNN --print
```
