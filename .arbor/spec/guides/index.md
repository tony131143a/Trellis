---
sources: []
last_verified: 2026-11-13
---
# Thinking Guides

> **Purpose**: Ask the right questions before coding. Most bugs and tech debt come from "didn't think of that", not from lack of skill.

## Available Guides

| Guide | Purpose | When to Use |
|-------|---------|-------------|
| [Code Reuse Thinking Guide](./code-reuse-thinking-guide.md) | Identify patterns and reduce duplication | When you notice repeated patterns |
| [Cross-Layer Thinking Guide](./cross-layer-thinking-guide.md) | Think through data flow across layers | Features spanning multiple layers |
| [Cross-Platform Thinking Guide](./cross-platform-thinking-guide.md) | Catch OS, shell, Python, path, and persistence assumptions | When commands, templates, scripts, or persisted JSON must work across platforms |

## Thinking Triggers

Read the [Cross-Layer Thinking Guide](./cross-layer-thinking-guide.md) when:

- [ ] A feature touches 3+ layers, data format changes between layers, or multiple consumers need the same data
- [ ] You are not sure where some logic belongs
- [ ] You are adding a persisted JSON or config field, or UI / command code starts casting raw payload fields

Read the [Code Reuse Thinking Guide](./code-reuse-thinking-guide.md) when:

- [ ] You are writing code similar to something that exists, or see a pattern repeated 3+ times
- [ ] You are adding a field to multiple places, or modifying any constant or config
- [ ] You are creating a new utility/helper function (search first)
- [ ] Two files read the same untyped payload field with local casts
- [ ] Multiple branches update the same derived state from `kind` / `action`

Read the [Cross-Platform Thinking Guide](./cross-platform-thinking-guide.md) when:

- [ ] You are editing Python scripts, shell commands, or generated config, or documenting a command users copy into terminals
- [ ] Code or docs assume `python3`, shebang execution, `/` separators, or POSIX-only shell behavior
- [ ] You are changing persisted JSON or migrations that must work across macOS, Linux, and Windows

## Verifying AI Review Findings

Verify every CRITICAL/WARNING finding against the actual code before prioritizing it:

- [ ] "User input can be malicious": is the data actually external, or a trusted internal source such as a bundled manifest?
- [ ] "Behavior change": do the code comments document it as intentional?
- [ ] A variable misread: trace it to its definition (a Map keyed by path, not name)
- [ ] A "bug" in a test: mentally delete the feature; if the test still passes, the test is tautological

## Pre-Modification Rule

Before changing any value, search for every place it appears (`grep -r "value_to_change" .`). This prevents most "forgot to update X" bugs.
