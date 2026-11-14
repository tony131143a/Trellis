# Backend Development Guidelines

> Best practices for backend development in this project.

---

## Overview

This directory holds the code-specs for the CLI in `packages/cli`: the TypeScript commands and configurators, the migration system, the Python scripts it installs, and the `arbor.py` task driver.

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Directory Structure](./directory-structure.md) | Module organization, file layout, design decisions | Done |
| [Script Conventions](./script-conventions.md) | Python script standards for .arbor/scripts/ | Done |
| [Error Handling](./error-handling.md) | Error types, handling strategies | Done |
| [Quality Guidelines](./quality-guidelines.md) | Code standards, forbidden patterns | Done |
| [Logging Guidelines](./logging-guidelines.md) | Structured logging, log levels | Done |
| [Migrations](./migrations.md) | Version migration system for template files | Done |
| [Filesystem Safety](./filesystem-safety.md) | Atomic writes (temp+rename / `os.replace`), path/name chokepoint validation, destructive-op ownership & backup gates, dogfood twin sync | Done |
| [Platform Integration](./platform-integration.md) | The two platforms (Claude Code, Codex), what each installs, bundled skills, how to add a platform | Done |
| [Configurator Shared Helpers](./configurator-shared.md) | `configurators/shared.ts` public surface: placeholder substitution, write helpers, template maps, cross-configurator invariants | Done |
| [`arbor update` Command](./commands-update.md) | Update pipeline: flags, plan composition, migration trigger semantics, apply phase, idempotency, boundaries with `migrations.md` | Done |
| [`arbor platforms` Command](./commands-platforms.md) | Machine-readable report of configured AI platforms: `--json` shape, registry sourcing, failure behavior | Done |
| [`arbor.py` Driver](./driver.md) | Task directory and `task.json` schema 3, node files, the `sync` passes and judge rules, `next:` kinds, integration branches, budgets, `review` / `finish` preconditions, locks, the Orca calls | Done |
| [`arbor uninstall` Command](./commands-uninstall.md) | Uninstall orchestration: plan composition, structured-file dispatch, execute phases, `.arbor/` removal | Done |
| [`spec.py` Freshness Lint](./spec-lint.md) | Spec doc frontmatter (`sources`, `last_verified`), lint rules, `verify` / `init-meta` rewrites | Done |
---

## Pre-Development Checklist

Before writing backend code, read the relevant guidelines based on your task:

- Error handling → [error-handling.md](./error-handling.md)
- Logging → [logging-guidelines.md](./logging-guidelines.md)
- Adding a platform → [platform-integration.md](./platform-integration.md)
- Modifying the `init.ts` flow (new triggers, reinit fast path) → [platform-integration.md](./platform-integration.md) "Common Mistakes"
- Script work → [script-conventions.md](./script-conventions.md)
- Migration system → [migrations.md](./migrations.md)
- Writing/deleting/moving/overwriting files in a user repo (any `writeFileSync`, `rmSync`, `renameSync`, `shutil.move`, or user/agent-supplied path segment) → [filesystem-safety.md](./filesystem-safety.md)
- Adding any native (`.node` / C++ / `node-gyp`) dependency → [quality-guidelines.md "Native dependency policy"](./quality-guidelines.md)
- Editing `configurators/shared.ts` (placeholder substitution, write helpers, template maps) → [configurator-shared.md](./configurator-shared.md)
- Editing `commands/update.ts` (flags, plan, apply phases, idempotency) → [commands-update.md](./commands-update.md) — manifest mechanics still in [migrations.md](./migrations.md)
- Editing the `platforms` subcommand in `cli/index.ts` → [commands-platforms.md](./commands-platforms.md)
- Editing `scripts/arbor.py` or `scripts/common/driver/` → [driver.md](./driver.md)
- Editing `scripts/spec.py`, `scripts/common/spec_*.py`, or the frontmatter format of spec docs → [spec-lint.md](./spec-lint.md)

Also read [unit-test/conventions.md](../unit-test/conventions.md) — specifically the "When to Write Tests" section.

---

## Quality Check

After writing code, verify against these guidelines:

1. Run `git diff --name-only` to see what you changed
2. Read the relevant guidelines above for each changed area
3. Always check [quality-guidelines.md](./quality-guidelines.md)
4. Check if tests need to be added or updated:
   - New pure function → needs unit test
   - Bug fix → needs regression test
   - Changed init/update behavior → needs integration test update
5. Run lint and typecheck:
   ```bash
   pnpm lint && pnpm typecheck
   ```

---

**Language**: All documentation should be written in **English**.
