# Local Customization Overview

This directory is for local AI working in a user project where Arbor was installed through npm and `arbor init` has already been run. The AI should modify generated `.arbor/`, `.claude/`, and `.starFactory/` files inside the project, not Arbor CLI upstream source code.

## First Determine What The User Actually Wants To Change

| User wording | Read first |
| --- | --- |
| "Change the Arbor flow / phases / next prompt" | `change-workflow.md` |
| "Change task creation, status, archive, or hooks" | `change-task-lifecycle.md` |
| "AI did not read context / change injected content" | `change-context-loading.md` |
| "A hook is not behaving as expected" | `change-hooks.md` |
| "Change a role's behavior or how roles run (explore / architect / test / implement / review / verify / fix / simplify)" | `change-agents.md`, `../local-architecture/dispatch.md` |
| "Add a skill or command" | `change-skills-or-commands.md` |
| "Adjust the project spec structure" | `change-spec-structure.md` |
| "Add team conventions and local notes" | `add-project-local-conventions.md` |

## General Operation Order

1. **Confirm platform and directories**: inspect which of `.claude/` and `.starFactory/` exist.
2. **Confirm the current active task**: run `python3 ./.arbor/scripts/task.py current --source`.
3. **Read the local source of truth**: prefer `.arbor/workflow.md`, `.arbor/config.yaml`, and relevant platform files.
4. **Modify narrowly**: edit only files related to the user's request.
5. **Synchronize semantics**: if a shared flow changes, check whether platform entry points also need changes; if a platform entry changes, check whether `.arbor/workflow.md` still agrees.

## Local File Priority

| Layer | Files |
| --- | --- |
| Workflow | `.arbor/workflow.md` |
| Project configuration | `.arbor/config.yaml` |
| Task material | `.arbor/tasks/<task>/` |
| Project specs | `.arbor/spec/` |
| Runtime scripts | `.arbor/scripts/` |
| Assistant instructions | `.arbor/agents/` |
| Platform integration | `.claude/`, `.starFactory/`, `CLAUDE.md`, `AGENTS.md` |

## Things Not To Do By Default

- Do not edit the global npm install directory.
- Do not edit `node_modules/@tony131143a/arbor`.
- Do not assume the user has the Arbor GitHub repository.
- Do not overwrite local files already modified by the user with default templates.
- Do not put team project rules into public `arbor-meta`; project rules belong in `.arbor/spec/` or a local skill.

## When To Inspect Upstream Source

Switch to an upstream source-code perspective only when the user explicitly expresses one of these goals:

- "I want to open a PR to Arbor"
- "I want to change npm package publish contents"
- "I want to fork Arbor"
- "I want to modify the generation logic for `arbor init/update`"

Otherwise, default to modifying local Arbor files inside the user project.
