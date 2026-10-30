---
name: arbor-spec-bootstrap
description: "Bootstrap project-specific Arbor coding specs with a single-agent workflow in Claude Code or StarFactory. Use when creating or refreshing .arbor/spec guidelines, analyzing a codebase with GitNexus, ABCoder, or source inspection, decomposing package/layer spec work, and writing real codebase-backed spec docs without placeholder text."
---

# Arbor Spec Bootstrap

Use this skill to create or refresh `.arbor/spec/` guidelines from the real codebase. One capable agent owns the full loop: analyze the repository, choose the spec boundaries, write the docs, and verify the result. The main agent owns the loop; it may dispatch roles through the driver for read-only research, but the work does not depend on them.

## Workflow

1. Confirm Arbor is initialized and inspect the current `.arbor/spec/` tree.
2. Analyze the repository architecture with the best available tools: GitNexus, ABCoder, language tooling, and direct source reads.
3. Decompose the spec work by package and layer only when that reflects the actual codebase.
4. Fill or reshape the spec files with concrete patterns, file paths, examples, and anti-patterns from the project.
5. Verify that the final specs are internally consistent and contain no template placeholders.

## Reference Routing

| Need | Read |
|------|------|
| Repository architecture analysis | [references/repository-analysis.md](references/repository-analysis.md) |
| Spec work decomposition and task planning | [references/spec-task-planning.md](references/spec-task-planning.md) |
| Writing high-signal Arbor spec files | [references/spec-writing.md](references/spec-writing.md) |
| GitNexus and ABCoder MCP setup | [references/mcp-setup.md](references/mcp-setup.md) |

## Operating Rules

- Treat templates as starting points, not contracts. Delete, rename, split, or add spec files when the repository calls for it.
- Prefer source-backed rules over generic advice. Every important recommendation should point at a real file or repeated local pattern.
- Keep execution single-owner by default. Where helpers are used, they run as driver dispatches through the configured executor (`explore` for read-only investigation, `review` / `verify` for verification), started by the main agent; they never write `.arbor/spec/`, the main agent does (see the `arbor-meta` skill, `dispatch.md`); they are optional.
- Do not leave placeholder text, empty headings, or copied boilerplate in `.arbor/spec/`.

## Done Criteria

- `.arbor/spec/` describes the project as it exists now.
- Each relevant package or layer has practical coding guidance with real examples.
- Non-applicable template sections are removed.
- `index.md` files match the final spec file set.
- Any required setup or analysis assumptions are documented in the relevant spec or task notes.
