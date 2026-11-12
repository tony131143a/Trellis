# Start Session

Initialize a Arbor-managed development session. This platform has no session-start hook, so manually load the equivalent compact context by following these steps.

---

## Step 1: Current state
Identity, git status, current task, active tasks, journal location.

```bash
{{PYTHON_CMD}} ./.arbor/scripts/get_context.py
```

If this output includes a line beginning `Arbor update available:`, copy the full line verbatim when summarizing session context. Do not shorten operational command hints.

## Step 2: Workflow overview
Compact Phase Index: state machine, tiers, verification ladder, human gates, request triage, and the step-detail command.

```bash
{{PYTHON_CMD}} ./.arbor/scripts/get_context.py --mode phase
```

Full guide in `.arbor/workflow.md` (read on demand).

## Step 3: Guideline indexes
Discover packages + spec layers, then read each relevant index file.

```bash
{{PYTHON_CMD}} ./.arbor/scripts/get_context.py --mode packages
cat .arbor/spec/guides/index.md
cat .arbor/spec/<package>/<layer>/index.md   # for each relevant layer
```

Index files list the specific guideline docs to read when you actually start coding.

## Step 4: Decide next action
From Step 1 you know the current task and status:

- **Active task status `planning`** → Phase 1 (CONTRACT). No `contract.md` or no acceptance criteria yet → load `arbor-brainstorm`. Otherwise continue with the first missing Phase 1 step (design, context, validation, approval); load its detail before `task.py start`. Roles in this phase run as `arbor.py run --role explore|architect|review [--mode plan]` after you write the brief at the `brief_path` from `arbor.py next --json`.
- **Active task status `in_progress`** → Phase 2. Ask the driver for the one next step and do it:
  ```bash
  {{PYTHON_CMD}} ./.arbor/scripts/arbor.py next
  ```
  Roles (explore / architect / implement / review / fix / simplify) run only through `arbor.py run`, never in this session.
- **No active task** → classify first. A simple change (at most 2 files, cause known, no design choice) is done here without Arbor. Otherwise propose a tier (light / standard / full) with a one-line reason and ask for consent to create an Arbor task. If the user says no, skip Arbor for this session.

---

## Skill routing (quick reference)

| User intent | Skill |
|---|---|
| New feature / unclear requirements | `arbor-brainstorm` |
| About to write code | `arbor-before-dev` |
| Done coding / quality check | `arbor-check` |
| Stuck / fixed same bug multiple times | `arbor-break-loop` |
| Learned something worth capturing | `arbor-update-spec` |

Full rules + anti-rationalization table in `.arbor/workflow.md`.


## Orca workers

With the `orca` executor, `arbor.py run` assembles the prompt in `.arbor/.runtime/prompts/<task>/`, writes the worker's task spec (the dispatch header plus `Prompt:` and `Report:` lines) and starts the worker itself with `orca orchestration worker-start`; it prints `needs: "worker"`, `orca_dispatch`, `prompt_path` and `reply_path`. You never call a tool to start a role. The worker reads the `Prompt:` file, writes its complete report to the `Report:` file and sends Orca's `worker_done`. After starting every ready item, end your turn: Orca wakes you when a worker reports, asks a question or stops (if the wake names an `orca orchestration check` command, run it). Then run `arbor.py sync` (`--dispatch d-NNN`, `--wait <duration>` as a fallback when no wake arrives), then `arbor.py next`. `sync` validates settled replies and advances the task, collects failed, timed-out or empty-reply workers (`decide retry` or `decide accept --report <file>`; read the output with `orca orchestration worker-read --dispatch <id>`), prints `waiting for a person (...)` for a permission prompt the user answers in the worker's Orca tab, and `running (orca dispatch <id>)` for a worker still going. If the Orca CLI is missing or Orca is unreachable the request stays prepared (`needs: worker`, "not started"): `arbor.py run --dispatch d-NNN` starts it; never start a dispatch twice. A worker's question arrives as Orca mail: answer with `orca orchestration reply --id <message_id> --body "..."`. Do not substitute native Agent/Task/spawn_agent for a role.
