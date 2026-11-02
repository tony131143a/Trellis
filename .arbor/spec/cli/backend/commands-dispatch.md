---
sources:
  - packages/cli/src/templates/arbor/scripts/arbor.py
  - packages/cli/src/templates/arbor/scripts/common/driver/executor.py
  - packages/cli/src/templates/arbor/scripts/common/driver/conductor.py
  - packages/cli/src/templates/arbor/scripts/common/driver/mcp.py
  - packages/cli/src/templates/arbor/scripts/common/dispatch_context.py
last_verified: 2026-11-01
---
# `arbor.py` — Task Driver, Conductor and Executors

The driver owns task state, role preparation, deterministic checks, report
validation and Git observations. The Planner owns scope and approval; a conductor
drives a started task through the driver. The prompt contract is in
[dispatch.md](./dispatch.md).

---

## 1. Scope / Trigger

`packages/cli/src/templates/arbor/scripts/arbor.py` ships as
`.arbor/scripts/arbor.py`. Its helpers live under `common/driver/`; role context
is assembled by `common/dispatch_context.py`. Run it from the repository or a
task worktree. Select role executors under `executors:` in `.arbor/config.yaml`.
Conductor launch, result and cancellation commands use the separate `conductor:`
configuration.

## 2. Signatures

All global options precede the subcommand:

```text
python3 .arbor/scripts/arbor.py [--task DIR] [--executor NAME] [--as-conductor c-NNN] COMMAND

next [--json] [--partition P] [--role explore|architect|review]
run [--dispatch d-NNN] [--partition P] [--autopilot]
run --role explore|architect|review [--mode plan|sweep] [--range BASE..HEAD] [--dispatch d-NNN]
gate
decide impl|tests|contract|fix|skip|accept|retry --reason TEXT
       [--dispatch d-NNN] [--report FILE] [--partition P]
canary [--role explore|review|verify]
override --reason TEXT [--to STATE[/step]] [--role ROLE] [--mode MODE]
status
resume
abandon [--reason TEXT]
prompt --dispatch d-NNN [--print]
bind --request FILE --task-id ID
collect --request FILE --result FILE [--accept-new-control-task NAME] [--reason TEXT]
finish [--pr]
conduct [--brief FILE] [--collect] [--cancel] [--dry-run]
children [--json]
```

| Global option | Contract |
| --- | --- |
| `--task DIR` | Explicit task directory; otherwise the session's active task. |
| `--executor NAME` | Select `executors.<name>`; otherwise `executors.default`. |
| `--as-conductor c-NNN` | Identify the caller as the task's running conductor. |

| Subcommand | Behavior |
| --- | --- |
| `next` | Print the single next step; `--json` includes `task`, `state`, `needs`, `summary` and step-specific fields such as `brief_path`. `--role` prepares an additional CONTRACT research/design angle. |
| `run` | Execute the named brief, validate the report and advance. In GATE, run deterministic checks; at a completed partition wave, merge its branches. `--autopilot` continues until a decision, human gate, STOP, red gate or failed dispatch. Explicit `--role` is for CONTRACT research/design; parent sweep uses review plus an explicit merged range. |
| `gate` | Run level 0 gate commands and contract `auto` checks; report failing AC ids. A parent runs its integration checks in the main checkout. |
| `decide` | Record a reasoned decision: `impl`, `tests`, `contract` for a red gate; `fix`, `skip` for candidates; `accept`, `retry` for report judgment. `--report` supplies a structured interpretation while preserving the raw report. |
| `canary` | Dispatch a small read-only probe to check executor reachability and report format. |
| `override` | Record a justified state jump or one extra role dispatch without advancing the normal table. |
| `status` | Show task state, observations and metrics. |
| `resume` | Leave STOP with another round, or record approval of the revised contract. |
| `abandon` | Record abandonment, optionally with a reason. |
| `prompt` | Rebuild a dispatch prompt; `--print` prints its text. |
| `bind` | Bind a prepared MCP request to the returned codeg task id. |
| `collect` | Validate the complete terminal MCP JSON and advance; optional sibling-task acceptance requires `--reason`. |
| `finish` | In FINISH, write the scorecard and print the merge command, or use `--pr` to push/open a PR with gh. After merge, clean up, archive and journal; repeated calls continue missing steps. |
| `conduct` | Launch the task conductor. `--brief` reads the Planner's brief; `--collect` records its terminal report; `--cancel` cancels it; `--dry-run` writes its prompt and prints the command. |
| `children` | List each child's state, conductor and merge status; `--json` emits structured output. |

## 3. Contracts

- **Briefs and prompts.** `next --json` names `brief_path`; write only the brief
  body there. `run` adds the role header and curated context. Briefs and reports
  live at `<task>/briefs/d-NNN.md` and `<task>/reports/d-NNN.md`; assembled prompts
  live under `.arbor/.runtime/prompts/<task>/` in the main checkout. Runtime
  dispatch measurements are appended to `.arbor/.runtime/results.jsonl`.
- **Executors.** Command executors substitute shell-quoted placeholders, run in
  the task worktree and return stdout as the report. A `type: codeg-mcp` executor
  returns `needs=delegation`: delegate once using `mcp.arguments`, immediately
  `bind`, poll the bound task, save the complete terminal response at the returned
  `result_path` outside the task worktree, then `collect`. Resume bound requests
  after interruptions; never launch them twice. See [dispatch.md](./dispatch.md).
- **Conductor.** Launch one per started task with `conduct`. It calls the driver
  with `--task`, `--executor` and `--as-conductor` on every call. While
  `task.json.conductor.status` is `running`, mutations (`run`, `gate`, `decide`,
  `override`, `resume`, `abandon`, `finish`) require that run's identity; Planner
  `next` returns `needs=conductor`. Collection writes `reports/c-NNN.md` and
  records `DONE`, `ESCALATE` or `FAILED` in `task.json.conductor`. A later launch
  archives the previous record into `conductor_runs`. Escalations return
  `needs=human`, `human.kind=conductor`; resolve the stated reason before relaunch.
- **Planning.** Before start, `run --role explore|architect|review` performs
  CONTRACT research without a diff range or commits. Explore/architect may write
  task research; review is read-only. With no task, only explore accepts a brief
  on stdin. Started-task writers commit in their assigned worktree with the
  dispatch trailer; the driver records observations for caller judgment.
- **Parent integration.** Inspect `children`, launch each ready child's conductor,
  and merge children in dependency order. If a later child predates an earlier
  merge, integrate the base into that child and rerun its `gate` before the user
  merges it with `--no-ff`. After all children merge, use the parent's
  `next --role review --json` brief, then
  `run --role review --mode sweep --range <before-first-merge>..<base>`.
  Resolve findings, run the parent's `gate`, then archive the parent. Tree
  position alone does not encode dependencies; write them in child contracts.

## 4. Validation & Error Matrix

| Exit | Condition | Behavior |
| --- | --- | --- |
| 0 | Command completed successfully | Read `needs` or the collected verdict; success can still require a decision or escalation. |
| 1 | Refused command, failed dispatch or red gate | Inspect the report and next step; no automatic pass. |
| 2 | Invalid CLI usage | argparse prints usage and the offending argument. |

Missing/invalid executors, conductor ownership conflicts and invalid reports are
failures to inspect. A red rung cannot advance to a higher verification rung.
Contract scope changes require approval; observations alone do not justify
resetting or deleting work.

## 5. Good / Base / Bad Cases

- **Good**: `python3 .arbor/scripts/arbor.py --task <task> conduct --brief <file>`;
  after the run ends, `conduct --collect`, then inspect `next --json`.
- **Base**: `python3 .arbor/scripts/arbor.py --task <task> next --json` names a
  brief; write it and invoke `run` if no conductor can be launched.
- **Bad**: invoking `run` without the running conductor's `--as-conductor`, or
  treating an MCP delegation request as a completed role report.

## 6. Tests Required

- `test/spec/backend-docs.test.ts`: retired surfaces stay absent, all commands
  and protocols are documented, sources exist and scoped spec lint is clean.
- `test/scripts/v2-driver-*.integration.test.ts`: build, CONTRACT, review,
  partitions, executor/MCP protocol, report handling and finish behavior.
- `test/scripts/v2-conductor.integration.test.ts`: launch, ownership, collection,
  escalation, cancellation and parent child visibility.
- `test/scripts/guard-builtin-agent.integration.test.ts`: native role and
  conductor dispatches are denied.

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
