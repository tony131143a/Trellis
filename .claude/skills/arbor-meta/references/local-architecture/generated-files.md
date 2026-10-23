# Local Files Generated After Init

`arbor init` writes the Arbor runtime into the user project. Later, `arbor update` tries to update Arbor-managed template files, but it uses `.arbor/.template-hashes.json` to determine which files have already been modified by the user.

This page only describes files that are visible and editable inside the user project.

## `.arbor/`

```text
.arbor/
├── workflow.md
├── config.yaml
├── .developer
├── .version
├── .template-hashes.json
├── .runtime/
├── scripts/
├── spec/
├── tasks/
└── workspace/
```

| Path | Usually editable? | Notes |
| --- | --- | --- |
| `.arbor/workflow.md` | Yes | Local workflow documentation and AI routing rules. |
| `.arbor/config.yaml` | Yes | Project configuration, hooks, packages, journal line limits, and related settings. |
| `.arbor/spec/` | Yes | Project specs, intended to be updated regularly by users and AI. |
| `.arbor/tasks/` | Yes | Task material and research artifacts, maintained by the task workflow. |
| `.arbor/workspace/` | Yes | Session records, usually written by `add_session.py`. |
| `.arbor/scripts/` | Carefully | Local runtime. It can be customized, but only after understanding the call chain. |
| `.arbor/.runtime/` | No | Runtime state, usually written automatically by hooks/scripts. |
| `.arbor/.developer` | Carefully | Current developer identity. |
| `.arbor/.version` | No | Arbor version record used by update/migration logic. |
| `.arbor/.template-hashes.json` | No | Template hash record. Do not hand-write business rules here. |

## Platform Directories

Different platforms generate different directories. Common categories:

| Category | Example paths | Purpose |
| --- | --- | --- |
| hooks | `.claude/hooks/`, `.codex/hooks/`, `.cursor/hooks/` | Inject session context, workflow-state, and sub-agent context. |
| settings | `.claude/settings.json`, `.codex/hooks.json`, `.qoder/settings.json`, `.trae/hooks.json` | Tell the platform when to run hooks or plugins. |
| agents | `.claude/agents/`, `.codex/agents/`, `.kiro/agents/`, `.zcode/agents/` | Define agents such as `arbor-research`, `arbor-implement`, and `arbor-check`. |
| skills | `.claude/skills/`, `.agents/skills/`, `.qoder/skills/`, `.zcode/skills/` | Skills that auto-trigger or can be read by AI. |
| commands/prompts/workflows | `.cursor/commands/`, `.github/prompts/`, `.devin/workflows/`, `.zcode/commands/` | Explicit user-invoked command or workflow entry points. |

When modifying a platform directory, also confirm whether `.arbor/workflow.md` still describes the same flow.

## Meaning Of Template Hashes

`.arbor/.template-hashes.json` records the content hash from the last time Arbor wrote a template file. `arbor update` uses it to distinguish three cases:

| Case | Update behavior |
| --- | --- |
| File was not modified by the user | It can be updated automatically. |
| File was modified by the user | Prompt the user to overwrite, keep, or generate `.new`. |
| File is no longer a current template | It may be deleted, renamed, or preserved according to migration rules. |

When an AI customizes local Arbor files, it does not need to maintain hashes manually. It is normal for Arbor update to recognize the result as "modified by the user."

## Local Customization Boundaries

Editable by default:

- `.arbor/workflow.md`
- `.arbor/config.yaml`
- `.arbor/spec/**`
- `.arbor/scripts/**`
- Platform hooks, settings, agents, skills, commands, prompts, and workflows

Do not edit by default:

- Global npm install directory
- `node_modules/@tony131143a/arbor`
- Arbor GitHub repository source code
- Concrete state files under `.arbor/.runtime/**`
- Hash contents inside `.arbor/.template-hashes.json`

Switch to the Arbor CLI source-code perspective only when the user explicitly wants to contribute upstream.
