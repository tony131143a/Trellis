---
sources:
  - packages/cli/src/migrations/index.ts
  - packages/cli/src/types/migration.ts
  - packages/cli/src/commands/update.ts
  - packages/cli/src/utils/template-hash.ts
  - packages/cli/src/utils/file-writer.ts
  - packages/cli/src/utils/manifest-prune.ts
  - packages/cli/src/utils/retired-platforms.ts
  - packages/cli/src/utils/cwd-guard.ts
last_verified: 2026-11-16
---
# Migration System

How `arbor update` moves a project's template files from one Arbor version to the next.

## Update invariants

- Re-running `arbor update` on a clean project writes nothing: `init` and `update` must render
  byte-identical files, and every file update collects must also be created by `init`.
- User edits are never silently overwritten: a file whose content differs from its recorded
  hash goes to the conflict policy instead of being written.
- `.arbor/config.yaml` is never rewritten, not even under `--migrate --force`; a release adds
  a config section only through the sentinel-gated `configSectionsAdded` append
  (`test/migrations/migration-1.0.0.test.ts`).
- Migrations are forward-only; `--allow-downgrade` is an escape hatch, not a supported workflow.
- Backups under `.arbor/.backup-<timestamp>/` are user data; any automatic pruning must be opt-in.

## Adding a migration

- A release's migrations go in `src/migrations/manifests/<version>.json`; no code change is needed.
- A manifest with `breaking: true` and `recommendMigrate: true` must carry `migrationGuide`:
  the guides printed at the end of the update are the only per-release instructions the user
  sees. No check enforces this; review it by hand.
- `rename`, `rename-dir` and `delete` run only under `--migrate`; `safe-file-delete` runs on
  every update and deletes a file only when its hash is in `allowed_hashes`.
- A `rename-dir` is applied only when the manifest records files under its source
  (`update.ts:dirHasManifestEntries`); otherwise the directory may be the user's own and is
  skipped, even under `--force`. See [Filesystem Safety](./filesystem-safety.md).
- A path in the current template set wins over a historical deletion of it.
- When `test/migrations/migration-1.0.0.test.ts` fails after templates change, fix the
  manifest, not the test.

## Protected paths

No migration modifies or deletes these (user data): `.arbor/workspace`, `.arbor/tasks`,
`.arbor/spec`, `.arbor/.developer`, `.arbor/.current-task` (`PROTECTED_PATHS` in
`commands/update.ts`). `rename` / `rename-dir` may move a file into a protected path, never
out of one; other types are refused in both directions.

## Template hashes

- `.arbor/.template-hashes.json` records the bytes Arbor installed, so `update` can tell
  whether the user edited a file. It is a different set from a migration's `allowed_hashes`
  (known-pristine bytes blessed for auto-deletion).
- It is also the scope of `arbor uninstall`: every key listed is removed. So it holds only
  files Arbor actually wrote, never files that merely exist under a managed directory.
  `initializeHashes` takes the set from `trackedPaths` recorded by `utils/file-writer.ts:writeFile`,
  never from a walk of platform directories; every configurator write goes through `writeFile`.
- `.arbor/` is still hashed by a walk: uninstall removes `.arbor/` whole anyway, so over-hashing
  there cannot delete user data.
- `pruneOrphanManifestKeys` (`utils/manifest-prune.ts`) runs at the top of both `update` and
  `uninstall` and drops every key no current owner claims.
- `arbor init` and `arbor uninstall` refuse to run in the home directory
  (`utils/cwd-guard.ts:isCwdHomedir`); only `ARBOR_ALLOW_HOMEDIR=1` bypasses it, `--force` does not.
- Retired platforms are cleanup-only (`utils/retired-platforms.ts:RETIRED_PLATFORM_PATHS`):
  their manifest keys are kept so update and uninstall can clean them up; they are never installed.
