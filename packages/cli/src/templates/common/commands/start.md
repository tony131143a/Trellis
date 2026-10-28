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
Compact Phase Index, request triage rules, planning artifact contract, and the step-detail command.

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
From Step 1 you know the current task and status. Check the task directory:

- **Active task status `planning` + no `prd.md`** → Phase 1.1. Load the `arbor-brainstorm` skill.
- **Active task status `planning` + `prd.md` exists** → stay in Phase 1. The tier decides the artifacts: light = `prd.md`; standard = + `design.md`; full = + `implement.md`. Load the relevant Phase 1 step detail before `task.py start`.
- **Active task status `in_progress`** → Phase 2 step 2.1 (Phase 2P when tier full and `meta.execution=parallel`). The seven roles (explore / architect / implement / review / verify / fix / simplify) are dispatched to codeg assistants, not done here. Load the step detail:
  ```bash
  {{PYTHON_CMD}} ./.arbor/scripts/get_context.py --mode phase --step 2.1 --platform {{CLI_FLAG}}
  ```
- **No active task** → classify first. Quick work (at most 2 files, cause known, no design choice) is done here without a task. Otherwise propose a tier (light / standard / full) with a one-line reason and ask for consent to create a Arbor task. If the user says no, skip Arbor for this session.

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
