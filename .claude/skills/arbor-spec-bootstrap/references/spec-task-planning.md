# Spec Task Planning

Use a single agent as the default execution model. The agent may create Arbor tasks for traceability, but the skill does not require a parallel worker model.

## Decomposition

Create spec work units around real ownership boundaries:

- One package when a package has its own conventions.
- One layer when the same package has distinct frontend, backend, CLI, worker, or shared-library rules.
- One cross-cutting guide when a pattern spans packages and is not owned by one layer.

Avoid artificial decomposition. A small library usually needs one focused spec pass, not several tasks.

## Task Shape

When a Arbor task is useful, write a concise PRD with these sections:

```markdown
# Fill <package-or-layer> Arbor Specs

## Goal
Write project-specific `.arbor/spec/` guidance for <scope>.

## Scope
- Spec directory:
- Source directories to inspect:
- Tests to inspect:
- Out of scope:

## Architecture Context
Summarize the concrete findings from repository analysis.

## Files To Create Or Update
- `.arbor/spec/.../index.md`
- `.arbor/spec/.../<topic>.md`

## Rules
- Adapt the spec file set to the real codebase.
- Use real source examples with file paths.
- Remove template-only sections that do not apply.
- Do not modify product source code unless the task explicitly asks for it.

## Acceptance Criteria
- [ ] Specs contain concrete examples and anti-patterns from the repository.
- [ ] No placeholder text remains.
- [ ] Index files match the final spec files.
- [ ] Claims are backed by source files, tests, or project docs.
```

## Optional Helper Agents

Helpers can inspect independent packages or run verification. In Arbor they run as driver dispatches through the configured executor (explore for read-only investigation, review/verify for verification), started by the main agent, not as platform sub-agents. They never write `.arbor/spec/`; the main agent does. They are optional. The main agent still owns integration and final quality.

Helper tasks must have clear ownership:

- Read-only research tasks may inspect any source needed for the assigned scope.
- Write tasks (done by the main agent; dispatched roles do not write `.arbor/spec/`) should own disjoint spec directories.
- Verification tasks should check placeholder removal, broken links, and consistency.

Do not encode assistant ids or dispatch commands in the spec task. Put only the required work and acceptance criteria in the task.
