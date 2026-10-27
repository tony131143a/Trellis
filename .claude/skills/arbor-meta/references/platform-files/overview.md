# Platform Files Overview

Arbor supports two AI tool platforms: Claude Code (`.claude/`) and StarFactory (`.starFactory/`, a Claude Code fork). Two root files, `CLAUDE.md` and `AGENTS.md`, carry a managed Arbor block. `.arbor/` stores the shared runtime; the platform directories store adapter files that let the AI tool read Arbor state, call Arbor scripts, and load Arbor skills and commands.

Distinguish two file categories before editing:

- **Shared files**: `.arbor/workflow.md`, `.arbor/tasks/`, `.arbor/spec/`, `.arbor/scripts/`, `.arbor/agents/`, `.arbor/config.yaml`.
- **Platform files**: `.claude/`, `.starFactory/`, `CLAUDE.md`, `AGENTS.md`.

Platform files do not store business state.

## Platform File Categories

| Category | Paths | Purpose |
| --- | --- | --- |
| settings | `.claude/settings.json`, `.starFactory/settings.json` | Register hooks. Hook commands use the project-relative path of the platform directory. |
| hooks | `.claude/hooks/`, `.starFactory/hooks/` | Session-start context, per-turn workflow-state, dispatch context injection, dispatch guard, shell session bridge. |
| skills | `.claude/skills/`, `.starFactory/skills/` | Workflow skills (brainstorm, before-dev, check, update-spec, break-loop) plus bundled skills (`arbor-meta`, `arbor-spec-bootstrap`). |
| commands | `.claude/commands/arbor/`, `.starFactory/commands/arbor/` | Explicit entry points such as `/arbor:continue`, `/arbor:finish-work`, `/arbor:start`, `/arbor:workflow <target>`. |
| root files | `CLAUDE.md`, `AGENTS.md` | Managed block between `<!-- ARBOR:START -->` and `<!-- ARBOR:END -->`; content outside the block is user-owned. |

There are no platform-native sub-agent files. The seven roles (explore, architect, implement, review, verify, fix, simplify) are not Claude Code sub-agents; the main agent dispatches them to codeg assistants (see `../local-architecture/dispatch.md`). Their instruction text lives in `.arbor/agents/*.md`.

## Integration Mode

Both platforms are hook driven:

- SessionStart injects a `.arbor/` overview, including a `<dispatch>` section listing assistant ids.
- UserPromptSubmit emits the `[workflow-state:STATUS]` breadcrumb for the current task.
- PreToolUse on the codeg `delegate_to_agent` tool inlines task context into a role dispatch; a guard hook denies the built-in Agent/Task tool for Arbor roles.

To change "when the AI knows what", inspect settings and hooks first.

## Local Modification Order

1. Read `.arbor/workflow.md` to confirm the shared flow.
2. Read the target platform's `settings.json` to see which hooks are registered.
3. Read the relevant hooks, skills, and commands.
4. Modify the local file closest to the user's need.
5. If the change affects the shared flow, synchronize `.arbor/workflow.md` or `.arbor/spec/`.

Do not modify only platform files and forget the shared workflow. Do not modify only `.arbor/workflow.md` and forget that platform skills and commands may still contain old descriptions. When both `.claude/` and `.starFactory/` exist, keep them semantically in sync.
