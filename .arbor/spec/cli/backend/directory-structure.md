---
sources:
  - packages/cli/src/configurators/index.ts
  - packages/cli/src/configurators/workflow.ts
  - packages/cli/src/templates/markdown/index.ts
  - packages/cli/src/templates/arbor/gitattributes.txt
  - packages/cli/scripts/copy-templates.js
last_verified: 2026-11-18
---
# Directory Structure

> How backend/CLI code is organized in this project.

## Overview

This is a TypeScript monorepo using ES modules that publishes one package, the CLI (`@tony131143a/arbor`, `packages/cli/`). What ships is the generic templates under `packages/cli/src/templates/`. The repository also installs Arbor on itself, so its own `.arbor/scripts/`, `.claude/` and root `CLAUDE.md` / `AGENTS.md` are installed copies, not the source of what ships.

## Layout

```
packages/cli/
├── src/
│   ├── cli/            # entry point and argument parsing (Commander.js)
│   ├── commands/       # command implementations
│   ├── configurators/  # per-platform template sets and the platform registry
│   ├── constants/      # paths and names
│   ├── migrations/     # migration logic + manifests/
│   ├── templates/      # shipped templates: arbor/, claude/, common/, markdown/
│   ├── types/          # type definitions, including the platform registry
│   └── utils/
└── scripts/            # build-time helpers (copy-templates.js)

.arbor/                 # installed copy, plus this repo's own spec/, tasks/, workspace/
.claude/                # installed copy
```

| Layer | Directory | Responsibility |
|-------|-----------|----------------|
| CLI | `src/cli/` | Parse arguments, display help, call commands |
| Commands | `src/commands/` | Implement CLI commands, orchestrate actions |
| Configurators | `src/configurators/` | Copy or generate configuration for each tool |
| Templates | `src/templates/` | Template content and the utilities that read it |
| Types | `src/types/` | TypeScript type definitions |
| Utils | `src/utils/` | Utility functions |
| Constants | `src/constants/` | Paths and names |

## What ships

- `pnpm build` runs `tsc`, then `scripts/copy-templates.js`, which copies only `src/templates/` and `src/migrations/manifests/` into `dist/`. It never copies the repo-root `.arbor/` or `.claude/`, because those carry this project's own customizations.
- Generic templates under `src/templates/` are the single source of what ships; they hold no project-specific content, and this repo's own `.arbor/spec/` is never shipped (users fill in theirs).
- Template changes are mirrored into this repo's installed copies (`.claude/`, `.arbor/scripts/`) and never left to drift; the script trees are held byte-identical (see [Script Conventions](./script-conventions.md)).
- Copy whole template directories; do not hardcode file lists.
- A platform's file set is described once, in its `collect<Platform>Templates()` returning a `Map<relPath, content>`; the registry in `configurators/index.ts` derives `configure` from it (see [Configurator Shared Helpers](./configurator-shared.md)).
- `DetectedPackage` in `utils/project-detector.ts` and the `packages:` schema read by `common/config.py` are one contract: change one, change the other.

## Naming

- `kebab-case` for TypeScript files and directories.
- Spec template sources under `templates/markdown/spec/` use `.md.txt`, so IDEs and readers do not take them for real docs.

## Don't: Leak dogfood spec into templates/markdown/spec/

`packages/cli/src/templates/markdown/spec/` contains only `.md.txt` placeholder templates for users. This repository's own spec lives in `.arbor/spec/<pkg>/<layer>/*.md`; a bare `.md` written to the template directory ships to npm but is never read by `templates/markdown/index.ts`, and nothing else fails. Guard: `packages/cli/test/regression.test.ts` → "regression: templates/markdown/spec contains only .md.txt files".

## Workspace Journal Merge Behavior

Parallel sessions and worktrees touch `.arbor/workspace/<developer>/` at the same time, and its two files merge differently on purpose:

- `journal-*.md` auto-resolves: `.gitattributes` carries `journal-*.md merge=union` (template `packages/cli/src/templates/arbor/gitattributes.txt`), because each session only appends a block. `ensureGitattributes()` in `configurators/workflow.ts` adds the rule on init and update without overwriting an existing file.
- `index.md` has no merge attribute, because every session rewrites it and a union merge would interleave two rewrites. Its conflicts are expected and safe: resolve by picking either side, since it is a derived summary and task state lives in each task's `task.json`.
