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
  Roles (explore / architect / test / implement / review / verify / fix / simplify) run only through `arbor.py run`, never in this session.
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


## codeg MCP delegation

With the `codeg-mcp` executor, `arbor.py run` returns `needs=delegation`. Call codeg MCP `delegate_to_agent` with the returned `mcp.arguments` (resolve the named assistant from the MCP roster if no id is configured), then immediately run `arbor.py bind --request <request_path> --task-id <returned task_id>`. Poll `get_delegation_status`, save its complete JSON response at the returned `result_path` outside the task worktree, and run `arbor.py collect --request <request_path> --result <file>` before proceeding. Resume/poll a bound task after interruptions; never start it again. If the configured timeout expires, cancel it through `cancel_delegation` and collect the terminal report. Claude Code and Codex both use this same MCP flow. Do not substitute `codeg-cli run` or native Agent/Task/spawn_agent.
