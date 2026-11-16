---
sources:
  - .arbor/config.yaml
  - packages/cli/package.json
  - pnpm-workspace.yaml
last_verified: 2026-11-16
---
# Repository Package Map

How package keys in `.arbor/config.yaml` map to source code and specs, so spec lint, `add_session.py` and agent sessions load the right guidance.

## Package Map

| Package key | Path | Package name | Spec path | Purpose |
| --- | --- | --- | --- | --- |
| `cli` | `packages/cli` | `@tony131143a/arbor` | `.arbor/spec/cli/**` | User-facing CLI (`init`, `update`, `uninstall`, `platforms`), templates, migrations, the Python scripts installed to `.arbor/scripts/` (including the driver `arbor.py`) and the platform configurators (Claude Code, Codex). |

## Workspace

- `pnpm-workspace.yaml` declares `packages/*`; the only workspace package is `packages/cli`. There are no git submodules.
- Run from a checkout: `pnpm install && pnpm build`, then `node packages/cli/bin/arbor.js init ...` in the target project (README, "Install and initialize").

## Contracts

- `.arbor/config.yaml` uses the stable package key `cli`, not the npm package name. The key is part of spec paths (`.arbor/spec/cli/<layer>/`) and of `spec.py lint --package cli`.
- `default_package` is `cli`. `add_session.py` falls back to it when `--package` is omitted (`common/config.py` `resolve_package`); `arbor.py new` uses it as the task's default repository only when it names a `git: true` package (`common/driver/repos.py` `repo_keys`).

## Pre-Development Checklist

- Changing `packages:` or `default_package` in `.arbor/config.yaml`: re-check the Package Map and Contracts above.

## Quality Check

```bash
python3 ./.arbor/scripts/spec.py lint
git diff --check -- .arbor/config.yaml .arbor/spec
```

- The Package Map row matches `.arbor/config.yaml` (`packages.cli.path`) and the `name` in `packages/cli/package.json`.
