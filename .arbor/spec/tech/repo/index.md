---
sources:
  - .arbor/config.yaml
  - packages/cli/package.json
  - pnpm-workspace.yaml
last_verified: 2026-11-13
---
# Repository Package Map

These guidelines describe the current Arbor repository shape and how package
keys in `.arbor/config.yaml` map to source code and specs.

## Purpose

Keep Arbor package/spec routing aligned with the actual repository so spec
lint, `add_session.py` and future AI sessions load the right guidance.

## Guidelines Index

| Guide | Description | Status |
| --- | --- | --- |
| [Provenance](./provenance.md) | How Arbor was derived from Trellis: rename table, what was removed, what still says "Trellis" | Done |

## Package Map

| Package key | Path | Package name | Spec path | Purpose |
| --- | --- | --- | --- | --- |
| `cli` | `packages/cli` | `@tony131143a/arbor` | `.arbor/spec/cli/**` | User-facing CLI (`init`, `update`, `uninstall`, `platforms`), templates, migrations, the Python scripts installed to `.arbor/scripts/` (including the driver `arbor.py`) and the two platform configurators (Claude Code, Codex). |

Arbor is a derivative of Trellis; see [provenance.md](./provenance.md) for the
rename table and the list of upstream packages and features that were removed.

## Workspace

- `pnpm-workspace.yaml` declares `packages/*`; the only workspace package is
  `packages/cli`. There are no git submodules.
- Run from a checkout: `pnpm install && pnpm build`, then
  `node packages/cli/bin/arbor.js init ...` in the target project (README,
  "Install and initialize").

## Contracts

- `.arbor/config.yaml` uses the stable Arbor package key `cli` rather than the
  npm package name. The key is part of spec paths (`.arbor/spec/cli/<layer>/`)
  and of `spec.py lint --package cli`.
- `default_package` is `cli`. `add_session.py` falls back to it when
  `--package` is omitted (`common/config.py` `resolve_package`).
  `arbor.py new` uses it as the task's default repository only when it names a
  `git: true` package (`common/driver/repos.py` `repo_keys`); `cli` has no
  `git: true`, so new tasks default to `.`.

## Pre-Development Checklist

- Changing `packages:` or `default_package` in `.arbor/config.yaml`: re-check
  the Package Map and Contracts above, and the spec layout rules in
  [spec-lint.md](../../cli/backend/spec-lint.md).
- Touching upstream names, license files or the rename history: read
  [provenance.md](./provenance.md).

## Quality Check

```bash
python3 ./.arbor/scripts/spec.py lint
git diff --check -- .arbor/config.yaml .arbor/spec
```

- The Package Map row matches `.arbor/config.yaml` (`packages.cli.path`) and
  the `name` in `packages/cli/package.json`.
