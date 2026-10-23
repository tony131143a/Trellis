# Change Local Agents

When the user wants to change `arbor-research`, `arbor-implement`, or `arbor-check` behavior, edit platform agent files in the user project.

## Read These Files First

1. Target platform agent directory
2. `.arbor/workflow.md` Phase 2 / research routing
3. Current task `prd.md`
4. Current task `implement.jsonl` / `check.jsonl`
5. Relevant hook or agent prelude

## Common Paths

| Platform | Path |
| --- | --- |
| Claude Code | `.claude/agents/arbor-*.md` |
| Cursor | `.cursor/agents/arbor-*.md` |
| OpenCode | `.opencode/agents/arbor-*.md` |
| Codex | `.codex/agents/arbor-*.toml` |
| Kiro | `.kiro/agents/arbor-*.json` |
| Gemini CLI | `.gemini/agents/arbor-*.md` |
| Qoder | `.qoder/agents/arbor-*.md` |
| CodeBuddy | `.codebuddy/agents/arbor-*.md` |
| Factory Droid | `.factory/droids/arbor-*.md` |
| Pi Agent | `.pi/agents/arbor-*.md` |
| Reasonix | `.reasonix/skills/arbor-*/SKILL.md` (subagent frontmatter) |
| ZCode | `.zcode/agents/arbor-*.md` |

Use the actual paths in the user project as authoritative.

## Common Needs

| Need | Which agent to edit |
| --- | --- |
| Research must write files, not only reply in chat | `arbor-research` |
| Certain local specs must be read before implementation | `arbor-implement` + `implement.jsonl` configuration rules |
| Specific commands must run during checking | `arbor-check` |
| Agent must not modify certain directories | The corresponding agent's write boundary instructions |
| Agent output format must be fixed | The corresponding agent's final/reporting instructions |

## Modification Principles

1. **Preserve role boundaries**: research investigates and persists; implement writes implementation; check reviews and fixes.
2. **Do not hard-code project specs into agents**: long-term specs belong in `.arbor/spec/`; agents are responsible for reading them.
3. **Make read order explicit**: active task -> PRD -> info -> JSONL -> spec/research.
4. **Make write boundaries explicit**: which directories may be written and which may not.
5. **Synchronize across platforms**: when the user configured multiple platforms, decide whether to change only the current platform or all platform agents.

## Agent Pull Platforms

If an agent file contains a prelude for "read task/context after startup," do not remove those steps when editing. Otherwise the agent will work only from chat context and bypass Arbor's core mechanism.

## Hook Push Platforms

If context is injected by a hook, the agent file should still retain responsibility boundaries. Do not remove PRD/spec requirements from the agent just because a hook injects context.
