# Backend Development Guidelines

> Best practices for backend development in this project.

## Overview

This directory holds the rules for the CLI in `packages/cli`: the TypeScript commands and configurators, the migration system, the Python scripts it installs, and the `arbor.py` task driver.

## Guidelines Index

| Guide | Description |
|-------|-------------|
| [Directory Structure](./directory-structure.md) | Module organization, file layout, naming |
| [Script Conventions](./script-conventions.md) | Python script standards for .arbor/scripts/ |
| [Error Handling](./error-handling.md) | Error types, handling strategies |
| [Quality Guidelines](./quality-guidelines.md) | Code standards, forbidden patterns |
| [Logging Guidelines](./logging-guidelines.md) | Console output: colours and message rules |
| [Migrations](./migrations.md) | Update invariants, adding a migration, protected paths, template hashes |
| [Filesystem Safety](./filesystem-safety.md) | Atomic writes, path/name chokepoint validation, destructive-op ownership & backup gates |
| [Platform Integration](./platform-integration.md) | The two platforms, what each installs, rules for adding a platform |
| [Configurator Shared Helpers](./configurator-shared.md) | What belongs in `configurators/shared.ts`, cross-configurator invariants |
| [`arbor.py` Driver](./driver.md) | Task files and who writes them, locks, repos, branches and worktrees, Orca access |

## Pre-Development Checklist

Before writing backend code, read the relevant guidelines based on your task:

- Error handling → [error-handling.md](./error-handling.md)
- Logging → [logging-guidelines.md](./logging-guidelines.md)
- Adding a platform, or changing the `init.ts` flow → [platform-integration.md](./platform-integration.md)
- Script work → [script-conventions.md](./script-conventions.md)
- `commands/update.ts`, `commands/uninstall.ts` or the migration system → [migrations.md](./migrations.md)
- Writing/deleting/moving/overwriting files in a user repo (any `writeFileSync`, `rmSync`, `renameSync`, `shutil.move`, or user/agent-supplied path segment) → [filesystem-safety.md](./filesystem-safety.md)
- Adding any native (`.node` / C++ / `node-gyp`) dependency → [quality-guidelines.md](./quality-guidelines.md)
- Editing `configurators/shared.ts` → [configurator-shared.md](./configurator-shared.md)
- Editing `scripts/arbor.py` or `scripts/common/driver/` → [driver.md](./driver.md)

Also read [unit-test/conventions.md](../unit-test/conventions.md), section "When to Write Tests".

## Quality Check

After writing code:

1. Run `git diff --name-only` and read the guidelines above for each changed area.
2. Always check [quality-guidelines.md](./quality-guidelines.md).
3. Add or update tests: a new pure function needs a unit test, a bug fix a regression test, changed init/update behavior an integration test.
4. Run lint and typecheck:
   ```bash
   pnpm lint && pnpm typecheck
   ```

**Language**: All documentation should be written in **English**.
