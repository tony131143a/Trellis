# Change Local Agents (Role Instructions)

When the user wants to change the behavior of one of the eight roles (`explore`, `architect`, `test`, `implement`, `review`, `verify`, `fix`, `simplify`), edit the role instruction sources in `.arbor/agents/`. These roles run through the driver and its executor, not as platform sub-agents, so there are no `.claude/agents/` or `.starFactory/agents/` files to edit.

## Read These Files First

1. `.arbor/agents/<role>.md` for the role in question (plain markdown, no frontmatter)
2. `.arbor/workflow.md` Driver and Roles sections, Phase 1 (contract), and Phase 2 (BUILD, GATE, REVIEW, POLISH)
3. `.arbor/config.yaml` `executors:` section
4. Current task `contract.md`, `implement.jsonl` (feeds architect, test and implement) / `check.jsonl` (feeds review, verify, fix, simplify)
5. `../local-architecture/dispatch.md`

## Edit And Refresh

1. Edit the relevant `.arbor/agents/<role>.md`.
2. If the executor keeps its own copy of the instructions (the default codeg executor uses one `arbor-<role>` assistant per role), update that copy.
3. Run `python3 ./.arbor/scripts/arbor.py canary --role <role>` to check that the executor still answers in the expected format.

## Common Needs

| Need | Which file to edit |
| --- | --- |
| Explore or architect must write files, not only reply in chat | `explore.md` / `architect.md` |
| Certain local specs must be read before implementation | `implement.jsonl` of the task, or spec rules |
| Tests must use a fixture style or naming | `test.md`, or `.arbor/spec/` |
| Review must apply extra angles or severity rules | `review.md` |
| Verify or fix must follow stricter rules | `verify.md` / `fix.md` |
| Specific commands must run at the gate | `gate.commands` in `.arbor/config.yaml`, or the contract's Verification map; roles do not own them |
| Role must not modify certain directories | The write-boundary section of that role file (the driver enforces test paths and `.arbor/` itself) |
| Role output format must be fixed | The report section of that role file |
| Run roles on a different tool or model | `executors:` in `.arbor/config.yaml`, or the executor's own per-role configuration |

## Modification Principles

1. Preserve role boundaries: explore investigates and persists; architect designs; test writes failing tests; implement makes them pass; review finds, verify filters, fix applies, simplify cleans up. Only `explore` and `architect` write under `<task>/research/`; only writers commit.
2. Do not hard-code project specs into role files; long-term rules belong in `.arbor/spec/`.
3. Keep the read order explicit: injected payload (or task JSONL) then `contract.md`, `design.md`, `waves.md`, `git diff <Range>`.
4. Keep the hard limits: no push, merge, rebase or branch switch; never write under `.arbor/` outside the task directory; never dispatch.
5. Keep the pull-based context steps for prompts without the injected marker.
