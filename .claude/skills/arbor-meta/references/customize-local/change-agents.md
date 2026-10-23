# Change Local Agents (Assistant Instructions)

When the user wants to change `research`, `implement`, or `check` role behavior, edit the assistant instruction sources in `.arbor/agents/`. These roles run as codeg assistants, not as platform sub-agents, so there are no `.claude/agents/` or `.starFactory/agents/` files to edit.

## Read These Files First

1. `.arbor/agents/{implement,check,research}.md` (plain markdown, no frontmatter)
2. `.arbor/workflow.md` Phase 2 and research routing
3. `.arbor/config.yaml` `dispatch:` section
4. Current task `prd.md`, `implement.jsonl` / `check.jsonl`
5. `../local-architecture/dispatch.md`

## Edit And Re-Install

1. Edit the relevant `.arbor/agents/<role>.md`.
2. Run `python3 ./.arbor/scripts/dispatch.py codeg-setup` to re-render `.arbor/.runtime/codeg-assistants/<target>-<role>.md` for every target (`star`, `pi`).
3. Paste the rendered text into the matching codeg assistants following the printed UI steps, or run `codeg-setup --install` (macOS only) to upsert the codeg database rows.

An installed assistant keeps its old text until step 3 is done. Editing `.arbor/agents/` alone changes nothing at runtime.

## Common Needs

| Need | Which file to edit |
| --- | --- |
| Research must write files, not only reply in chat | `research.md` |
| Certain local specs must be read before implementation | `implement.jsonl` of the task, or spec rules; `implement.md` only for the read-order rule |
| Specific commands must run during checking | `check.md` |
| Role must not modify certain directories | The write-boundary section of that role file |
| Role output format must be fixed | The report section of that role file |
| Change which assistant a role uses | `dispatch:` in `.arbor/config.yaml`, then `codeg-setup` |

## Modification Principles

1. Preserve role boundaries: research investigates and persists; implement writes implementation; check reviews and fixes.
2. Do not hard-code project specs into role files; long-term rules belong in `.arbor/spec/`.
3. Keep the read order explicit: injected payload (or active task JSONL) then `prd.md`, `design.md`, `implement.md`.
4. Keep the hard limits: no commit, merge, or stash; stay inside the working directory; never write under `.arbor/`; never dispatch.
5. Keep the pull-based context steps; the hook only injects when the dispatch header is present.
