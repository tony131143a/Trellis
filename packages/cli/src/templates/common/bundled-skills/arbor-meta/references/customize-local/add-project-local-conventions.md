# Add Project-Local Conventions

Often the user does not need to change Arbor mechanics; they need local AI to understand their team's conventions. In that case, prefer `.arbor/spec/` or a project-local skill instead of editing `arbor-meta`.

## Where To Put Things

| Content type | Location |
| --- | --- |
| Rules code must follow | `.arbor/spec/<layer>/` |
| Cross-layer thinking methods | `.arbor/spec/guides/` |
| AI capability for a project-specific flow | Project-local skill |
| One-off task material | `.arbor/tasks/<task>/` |
| Session summary | `.arbor/workspace/<developer>/journal-N.md` |

## Create A Project-Local Skill

If the user wants AI to know "how this project customizes Arbor," create a local skill:

```text
.claude/skills/arbor-local/
└── SKILL.md
```

Example:

```md
---
name: arbor-local
description: "Project-local Arbor customizations for this repository. Use when changing this project's Arbor workflow, hooks, local agents, or team-specific conventions."
---

# Arbor Local

## Local Scope

This skill documents this repository's Arbor customizations only.

## Custom Workflow Rules

- ...

## Local Hook Changes

- ...

## Local Agent Changes

- ...
```

If both platforms are in use, place equivalent versions in `.claude/skills/` and `.starFactory/skills/`.

## Write To `.arbor/spec/`

If the content is a coding convention, write it to spec. Examples:

```text
.arbor/spec/backend/error-handling.md
.arbor/spec/frontend/components.md
.arbor/spec/guides/cross-layer-thinking-guide.md
```

After writing it, update the corresponding `index.md` so AI can find the new rule from the entry point.

## Make The Current Task Use New Conventions

After writing a spec, add it to the current task context:

```bash
python3 ./.arbor/scripts/task.py add-context <task> implement ".arbor/spec/backend/error-handling.md" "Error handling conventions"
python3 ./.arbor/scripts/task.py add-context <task> check ".arbor/spec/backend/error-handling.md" "Review error handling"
```

## Do Not Store Project-Private Rules In `arbor-meta`

`arbor-meta` is a public skill for understanding Arbor architecture and local customization entry points. Put project-private content in:

- `.arbor/spec/`
- a project-local skill
- the current task
- workspace journal

This prevents future updates to Arbor's built-in `arbor-meta` from overwriting the team's own conventions.
