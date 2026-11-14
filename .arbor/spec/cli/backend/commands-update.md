---
sources:
  - packages/cli/src/commands/update.ts
  - packages/cli/src/cli/index.ts
  - packages/cli/src/migrations/index.ts
  - packages/cli/src/utils/managed-paths.ts
  - packages/cli/src/utils/manifest-prune.ts
  - packages/cli/src/utils/retired-platforms.ts
last_verified: 2026-11-13
---
# `arbor update` Command

How `arbor update` upgrades a user project's bundled Arbor assets (Python scripts, `.arbor/.gitignore`, the `AGENTS.md` / `CLAUDE.md` managed blocks, platform files) from the version recorded in `.arbor/.version` to the version of the installed CLI.

This spec covers the command pipeline, flags, interactive surface, and the subsystems update orchestrates. Manifest mechanics — schema fields, migration types, hash gating semantics — live in `migrations.md`. This document references that one rather than restating it.

---

## Overview

User-facing contract:

- Input: a project directory containing `.arbor/`, the CLI binary on `PATH`.
- Output: bundled templates on disk match the CLI version; `.arbor/.version` advanced; modified files preserved or backed up; renamed/deleted files migrated when `--migrate`; legacy deprecated files cleaned up via hash-verified `safe-file-delete`; the `migrationGuide` of every breaking release in the range printed at the end.
- Side effects: snapshot backup at `.arbor/.backup-<timestamp>/`, `.arbor/.template-hashes.json` rewritten.
- `.arbor/config.yaml` is never rewritten, not even under `--force` or `--migrate --force`: `collectTemplateFiles` leaves it out of the template set. New sections reach it only through the sentinel-gated `configSectionsAdded` append (see Apply Phase step 8). Pinned by `test/migrations/migration-1.0.0.test.ts > never rewrites .arbor/config.yaml, not even with --migrate --force`.

Two big invariants:

1. **Idempotent**: re-running `arbor update` immediately after a successful run prints `✓ Already up to date!` and writes no template files. If you ever see auto-update churn on a clean re-run, the cause is almost always a placeholder unresolved in `collectTemplateFiles` (see Common Pitfalls).
2. **User edits are never silently overwritten**. Anything outside Arbor-managed templates is in `PROTECTED_PATHS`; anything inside whose hash differs from the recorded one drops to the conflict prompt or `--force` / `--skip-all` / `--create-new` policy.

---

## Command Entry

Wired in `cli/index.ts` via Commander:

```text
arbor update
  [--dry-run]            preview only
  [-f, --force]          overwrite all changed files; also bypasses final "Proceed?" confirm and forces modified migrations
  [-s, --skip-all]       skip all changed files; also auto-skips modified migrations under --migrate
  [-n, --create-new]     write `.new` copies for changed files
  [--allow-downgrade]    permit CLI < project version
  [--migrate]            apply pending file migrations (renames/deletes)
```

The action handler in `cli/index.ts` constructs `UpdateOptions` and calls `commands/update.ts:update`. There is no env override surface — flags are the only knobs.

`UpdateOptions` is the public interface:

```typescript
interface UpdateOptions {
  dryRun?: boolean;
  force?: boolean;
  skipAll?: boolean;
  createNew?: boolean;
  allowDowngrade?: boolean;
  migrate?: boolean;
}
```

Note that `force` / `skipAll` / `createNew` are mutually exclusive in spirit but the code does not assert mutual exclusivity. They are checked in priority order in `commands/update.ts:promptConflictResolution`. Any of the three also counts as "non-interactive" — it skips the global `Proceed?` confirm in `commands/update.ts:update`.

---

## Update Plan Composition

### 0. Self-heal the manifest

Right after `loadHashes`, `update()` calls `utils/manifest-prune.ts:pruneOrphanManifestKeys` for the configured platforms and continues with the pruned hashes. The prune rules are in `migrations.md` § Self-heal contract.

### 1. Collect bundled templates

`commands/update.ts:collectTemplateFiles` is the single place that produces the "what should be on disk" snapshot. Sources, in order:

| Source | Where the bytes come from |
|---|---|
| Python scripts under `.arbor/scripts/` | `templates/arbor/index.ts:getAllScripts` |
| `.arbor/.gitignore` | `templates/arbor/index.ts:gitignoreTemplate` |
| Root `AGENTS.md` | `commands/update.ts:buildAgentsMdTemplate` (managed-block merge) |
| Root `CLAUDE.md` | `commands/update.ts:buildClaudeMdTemplate` (managed-block merge; only when the Claude Code platform is configured; also in `BACKUP_FILES`) |
| Per-platform files | `configurators/index.ts:collectPlatformTemplates` for each detected platform via `configurators/index.ts:getConfiguredPlatforms` |
| `.claude/settings.json` `statusLine` | preserved through `commands/update.ts:preserveExistingClaudeStatusLine` |

`.arbor/config.yaml` is deliberately absent (see Overview).

Platforms are detected from the template hash manifest, not from directory existence: `configurators/index.ts:getConfiguredPlatforms` counts a platform only when `.arbor/.template-hashes.json` records a path under one of that platform's managed paths (`types/ai-tools.ts:getManagedPaths` — `.claude/` for Claude Code; `.codex/` and `.agents/skills/` for Codex, which installs only under `.agents/skills/`) that its current `collectTemplates()` also declares. A native config directory that predates Arbor therefore never activates a platform by itself.

After collection, `collectTemplateFiles` runs two final passes:

1. `update.skip` filtering via `commands/update.ts:loadUpdateSkipPaths` — drops paths matching the `update.skip` list in `.arbor/config.yaml`. **Bypassed** when the update is a breaking release with `recommendMigrate` (`breakingBypass`); see "Migration Trigger Semantics".
2. `configurators/shared.ts:replacePythonCommandLiterals` is applied to every value so init-time and update-time bytes are byte-identical on the same OS. This is the load-bearing step that keeps idempotency working — see Common Pitfalls.

### 2. AGENTS.md / CLAUDE.md managed-block merge

**`AGENTS.md`** (`commands/update.ts:buildAgentsMdTemplate`) and **`CLAUDE.md`** (`commands/update.ts:buildClaudeMdTemplate`) both go through `commands/update.ts:buildManagedBlockTemplate`, which calls `utils/managed-paths.ts:mergeManagedBlockContent`: the `<!-- ARBOR:START -->`…`<!-- ARBOR:END -->` region is replaced in place; if the file has no markers, the template's managed block is appended below the user's text. Text outside the block is never touched. A missing file gets the bundled template as-is. `CLAUDE.md` is collected only when Claude Code is a configured platform.

### 3. Analyze on-disk state

`commands/update.ts:analyzeChanges` walks every entry in the templates map and produces a `ChangeAnalysis`:

| Bucket | Condition |
|---|---|
| `newFiles` | template has it; disk doesn't; no stored hash |
| `userDeletedFiles` | template has it; disk doesn't; **stored hash exists** → respect deletion, do not re-add |
| `unchangedFiles` | disk content === template content |
| `autoUpdateFiles` | disk differs from template; stored hash matches current content → user did not edit; safe to write |
| `changedFiles` | disk differs from template; stored hash absent or stale → user edited; needs decision |

This bucketing is the basis for both the printed plan and the write phase. `commands/update.ts:collectUnchangedFileHashRepairs` additionally collects `unchangedFiles` whose recorded hash is wrong, or missing (unless `shouldExcludeFromHash`), so the hash refresh can repair them — nothing else would, because an unchanged file never leaves that bucket.

---

## Flags Semantics

### `--dry-run`

Runs the full pipeline up to and including the printed plan and breaking-change banner, then returns before the `Proceed?` confirm. No template writes, no backup, no `.gitattributes` backfill, no hash repairs. Two writes still happen: the manifest prune (`pruneOrphanManifestKeys` is called without `persist: false`), and — when there is nothing to do but the version differs — the version stamp in the early-return branch. Combines safely with `--migrate`: `commands/update.ts:update` allows the migration plan to be printed but stops before `executeMigrations` runs. See `update.integration.test.ts > #2 dry run makes no file changes even when changes exist`.

### `--force` / `-f`

Three meanings, all in this single flag:

1. **Conflict resolution** (`commands/update.ts:promptConflictResolution`): for every entry in `changedFiles`, choose `overwrite` without asking.
2. **Migration mode** (`commands/update.ts:executeMigrations`): for every `confirm`-bucket migration, treat as `rename`/`delete` (no inline `.backup`). The full snapshot under `.arbor/.backup-<timestamp>/` is the only safety net in this mode.
3. **Final confirm** (`commands/update.ts:update`): skip the global `Proceed?` prompt. This is what makes `arbor update --force --migrate` viable for CI / scripted upgrades. See `update.integration.test.ts > #5b force mode does not prompt for final confirmation`.

### `--skip-all` / `-s`

Mirror of `--force` for the "leave my edits alone" intent: `changedFiles` are skipped; modified `confirm` migrations are skipped (you'll see them flagged on the next update until cleaned up manually). Also skips the final confirm.

### `--create-new` / `-n`

For changed files only — writes `<path>.new` next to the original. Migrations are not affected. Also skips the final confirm. A tip line at the end of `update()` reminds users to merge `.new` files manually.

### `--allow-downgrade`

Permits `cliVersion < projectVersion`. Without it, `update()` prints the two solutions and returns without changing anything. With it, the warning still prints, then the pipeline runs as if upgrading. Migrations between the two versions are not "applied in reverse" — `getMigrationsForVersion` always walks low→high (see `migrations.md`), so a downgrade with file changes is best-effort and the user has to clean up manually. Migration guides, `configSectionsAdded` and the breaking banners are upgrade-only.

### `--migrate`

Opt-in to apply file migrations (renames/deletes/dir renames). Without it: migrations are listed in the plan but not executed; a "Tip: Use --migrate" hint prints. With it:

1. `commands/update.ts:executeMigrations` runs on the classified plan.
2. Hook configs the user modified are scrubbed instead of overwritten or deleted. `commands/update.ts:planHookScrubs` looks at `.claude/settings.json` and `.codex/hooks.json` (`HOOK_CONFIG_PATHS`) when the file exists and `isTemplateModified` says the user edited it; it runs `utils/managed-removal.ts:scrubHooksJson` against the `from` paths of the pending `delete` migrations. A planned file is taken out of the template map AND out of `pendingMigrations`, so neither `--force` nor a confirm-delete can throw the user's own hooks away. `executeHookScrubs` writes the scrubbed JSON (the recorded hash stays the template's, so the file keeps counting as user-modified) or deletes the file when nothing but Arbor hooks was left. Afterwards an empty `.codex/` directory is removed (`cleanupEmptyDirs` stops below managed roots, so this is a separate `rmdirSync`). Tests: `test/migrations/migration-1.0.0.test.ts > scrubs the Arbor hooks from a user-modified settings.json and keeps the user's own` and `> keeps a user-modified .codex/hooks.json with only the user's entries; deletes an unmodified one`.

`safe-file-delete` migrations are independent of `--migrate` — they always run when their hash gate passes (see Apply Phase). A historical deletion is ignored when its path is present in the current template snapshot: current template ownership takes precedence if a later release intentionally restores a retired path. Rationale in `migrations.md`.

### No `--tag` flag

Version selection is implicit: `update()` always uses the version of the installed CLI (`constants/version.ts:VERSION`). There is no remote version check.

---

## Migration Trigger Semantics

### Pending migrations

`commands/update.ts:update` calls `migrations/index.ts:getMigrationsForVersion(projectVersion, cliVersion)` to get the migration set (none when `.arbor/.version` is missing — `projectVersion` is then `"unknown"`), then merges in **orphaned migrations** — `rename` / `rename-dir` items whose source still exists and target doesn't, regardless of version range. Orphans show up when a previous update bumped `.arbor/.version` but a migration was skipped or interrupted; they get added to `pendingMigrations` so the next `--migrate` cleans them up.

Migration state is then run through `commands/update.ts:classifyMigrations` against current hashes and templates:

| Class | Trigger |
|---|---|
| `auto` | source unmodified, target free or matches template |
| `confirm` | source modified by user (hash mismatch) |
| `conflict` | both source and target exist with user content |
| `skip` | source missing, path is `PROTECTED_PATHS`, or (see below) an unowned `rename-dir` source |

`rename-dir` has an extra ownership gate when the target is absent: `commands/update.ts:dirHasManifestEntries(item.from, hashes)` must find at least one manifest-tracked file under that source directory before it lands in `auto`. If the manifest has no record of the directory — e.g. a user's own editor config directory that merely shares a path with a retired Arbor platform dir — the item goes to `skip` instead, even under `--force` (skip never executes). See [Filesystem Safety § 2–3](./filesystem-safety.md) for the rationale and the other ownership/backup gates it's modeled after.

Sorting before execution is by `commands/update.ts:sortMigrationsForExecution`: deeper `rename-dir` first, then other `rename-dir`, then `rename` / `delete`. Critical for nested directory renames — without depth ordering, a parent move would leave child entries pointing at a dead source.

### The breaking-change gate

This is the safety mechanism that prevents accidental half-migration across a major version. In `commands/update.ts:update`, after `classifyMigrations`:

```text
if (pendingMigrationCount > 0
    && !options.migrate
    && !options.dryRun
    && cliVsProject > 0
    && projectVersion !== "unknown"
    && metadata.breaking
    && metadata.recommendMigrate)
  → process.exit(1)
```

Why hard-fail: the alternative path silently bumps `.arbor/.version` on success, leaving deprecated files orphaned next to the new architecture forever. The user has no signal that something went wrong until much later, when `update` re-flags the same orphan list every release.

Hard-fail conditions, all of which must be true:

- there is real migration work pending (`auto` + `confirm` + `conflict`; `safe-file-delete` is not counted)
- `--migrate` was not passed
- `--dry-run` was not passed (preview is always allowed)
- the upgrade is a real upgrade (not same-version, not downgrade)
- the version range crosses at least one manifest with `breaking: true` and at least one with `recommendMigrate: true` (`getMigrationMetadata` ORs each flag across the range)

### `breakingBypass` for `update.skip`

When `--migrate` is set on a real upgrade whose range is `breaking` + `recommendMigrate`, `commands/update.ts:update` computes `breakingBypass = true` and threads it into `collectTemplateFiles` and `collectSafeFileDeletes`. The bypass causes `update.skip` to be ignored for both new template writes AND `safe-file-delete` cleanup.

Rationale: honoring `update.skip` during a breaking upgrade leaves the project permanently half-migrated — old deprecated files persist under skip-protected paths while new templates never land. The hash check in `safe-file-delete.allowed_hashes` is still the safety net (user-customized files still skip with a "skip-modified" reason). User customizations to non-deprecated files are still guarded at write time by the per-file conflict prompt.

---

## Apply Phase

Before the "nothing to do" early return (and therefore on every non-dry run), `configurators/workflow.ts:ensureGitattributes` backfills the project-root `.gitattributes` journal `merge=union` rule. The early return itself still writes `collectUnchangedFileHashRepairs` and, on a version change, the version stamp.

Order of operations in `commands/update.ts:update` (after the `Proceed?` confirm, when not dry-run):

1. **Backup** — `commands/update.ts:createFullBackup` snapshots every `BACKUP_DIRS` entry plus `BACKUP_FILES` (= `AGENTS.md`, `CLAUDE.md`) into `.arbor/.backup-<ISO-timestamp>/`. `BACKUP_DIRS` is `configurators/index.ts:ALL_MANAGED_DIRS` plus the top-level directories of `utils/retired-platforms.ts:RETIRED_PLATFORM_PATHS` (`.starFactory`), so files of a retired platform are in the snapshot before `safe-file-delete` removes them (`test/commands/retired-platform.integration.test.ts`). `commands/update.ts:shouldExcludeFromBackup` filters out previous backups, `node_modules/`, user-data dirs (`workspace/`, `tasks/`, `spec/`, `backlog/`, `agent-traces/`), and platform-native worktree dirs (`/worktrees/`, `/worktree/`). Symlinks (and Windows directory junctions) are never followed in `commands/update.ts:collectAllFiles` — a junction to an ancestor would loop forever.

2. **Migrations** (only if `--migrate`) — `commands/update.ts:executeMigrations` runs `auto` items first (sorted by depth), then `confirm` items via `commands/update.ts:promptMigrationAction` (or `--force` / `--skip-all` short-circuits). Default action for prompts is `backup-rename`: leaves `<new-path>.backup` (rename) or `<path>.backup` (delete) of the user's modified content, so users can diff inline without digging through the snapshot. Hash tracking is updated via `utils/template-hash.ts:renameHash` / `removeHash`. Empty source dirs are pruned by `utils/managed-paths.ts:cleanupEmptyDirs` (gated by `configurators/index.ts:isManagedPath` + `isManagedRootDir` — never deletes managed roots themselves, never crosses into unmanaged paths). A `rename-dir` whose target already byte-matches the current templates (`dirMatchesCurrentTemplates`) drops the source instead of moving it over the target.

3. **Hook scrubs** — `executeHookScrubs` (planned only under `--migrate`, see `--migrate`), then the empty-`.codex/` removal.

4. **`safe-file-delete`** — `commands/update.ts:executeSafeFileDeletes` deletes files in the `delete` action bucket (hash matched, not protected, not in `update.skip` unless bypassed), removes their hash entries, and prunes empty parent directories (through `cleanupEmptyDirs`, so only inside `ALL_MANAGED_DIRS`; empty directories under a retired platform root such as `.starFactory/` stay). `commands/update.ts:collectSafeFileDeletes` first excludes paths owned by the current template snapshot so historical cleanup cannot conflict with a reintroduced template. `migrations.md` covers the full classification matrix.

5. **New file writes** — straight `mkdir -p` + `writeFileSync`. `.sh` and `.py` get `chmod 755`.

6. **Auto-update writes** — same as new files, but the file already exists.

7. **Conflict resolution** — for every `changedFiles` entry, call `commands/update.ts:promptConflictResolution`. The `applyToAll` carrier object captures `[a]` / `[s]` / `[n]` "Apply to all" choices so the user only has to decide once for a batch of similar prompts. Result is `overwrite` (write + chmod), `skip` (no-op), or `create-new` (write `<path>.new`).

8. **`configSectionsAdded`** — only on real upgrades (`cliVsProject > 0`, `projectVersion !== "unknown"`). `commands/update.ts:applyConfigSectionsAdded` walks entries from `migrations/index.ts:getConfigSectionsAddedBetween`, dedupes by `file::sentinel`, skips any whose sentinel is already present in the user's file (idempotent), and appends the named section extracted via `commands/update.ts:extractConfigSection` from the bundled `config.yaml` template. This is the only path by which `update` writes `.arbor/config.yaml`: it never overwrites the user's text, only appends a missing section. See `migrations.md` § `configSectionsAdded` for the schema.

9. **Version stamp** — `commands/update.ts:updateVersionFile` writes `cliVersion` to `.arbor/.version`.

10. **Hash refresh** — every newly-written file (`newFiles`, `autoUpdateFiles`, overwritten `changedFiles`) plus the `collectUnchangedFileHashRepairs` entries gets its hash recomputed and saved via `utils/template-hash.ts:updateHashes`. `.new` copies and skipped files do NOT get their hash updated — the original file's recorded hash continues to drive the next-update conflict decision.

11. **Migration guides** — when the range is `breaking`, `update()` prints every `migrationGuide` collected by `migrations/index.ts:getMigrationMetadata` (one `📋 v<version> migration guide:` block each), after the summary.

12. **End-of-run banners** — breaking-change banner, changelog, and `--migrate` recommendation are intentionally printed last so they don't scroll off screen on long updates.

---

## Hashing & Idempotency

`.arbor/.template-hashes.json` is the contract that makes `analyzeChanges` work. Schema and helpers live in `utils/template-hash.ts`. Update interacts with it via:

- `loadHashes(cwd)` at the top of `update()`
- `computeHash(content)` for inline checks (`safe-file-delete` matching, `analyzeChanges`)
- `isTemplateModified(cwd, path, hashes)` in `classifyMigrations` and `planHookScrubs`
- `renameHash` / `removeHash` / `saveHashes` during migrations
- `updateHashes(cwd, files)` at the end

`saveHashes` (called by `updateHashes`/`renameHash`/`removeHash`) writes `.arbor/.template-hashes.json` via `writeFileAtomic` (temp file in the same dir + rename), not a direct `writeFileSync`. A crash mid-write can no longer truncate the manifest to `{}`, which would otherwise make every managed file look user-modified on the next run. See [Filesystem Safety § 1](./filesystem-safety.md).

`migrations.md` documents the relationship to `allowed_hashes` in `safe-file-delete` migrations: the hash file tracks "Arbor-installed bytes" (so update can detect user edits); `allowed_hashes` is a bounded set of "known-pristine bytes" the manifest blesses for auto-deletion. They are different sets — a user file might have a recorded hash but not be `allowed_hashes`-eligible.

The idempotency invariant ("re-running update on a clean repo writes nothing") rests on three pieces of hygiene:

1. **`collectTemplateFiles` resolves all placeholders the same way init does.** The most common bug is forgetting to pipe a new placeholder through `configurators/shared.ts:replacePythonCommandLiterals` (or the per-platform `resolvePlaceholders`) inside a configurator's `collectTemplates` lambda. Init writes resolved bytes; update collects unresolved templates; hashes mismatch every run. See `platform-integration.md > Common Mistakes > "Template placeholder not resolved in collectTemplates"`.
2. **Init and update agree on what files exist.** Anything `collectTemplateFiles` lists must also be created by `init`, otherwise update auto-adds it on every run. See `platform-integration.md > Common Mistakes > "Template listed in update but not created by init"`.
3. **The runtime templates are byte-stable.** `buildAgentsMdTemplate` and `buildClaudeMdTemplate` should return the same content when given the same inputs across runs. The CLI tests this via `update.integration.test.ts > #1 same version update is a true no-op` (full snapshot before/after).

---

## Boundaries with `init`

Update and init share the same template producers:

| Helper | Producer |
|---|---|
| Collect platform files | `configurators/index.ts:collectPlatformTemplates` (init does it via `configurePlatform` writing them out; update gathers them via the parallel `collectTemplates` lambda in `PLATFORM_FUNCTIONS`) |
| Detect platforms | `configurators/index.ts:getConfiguredPlatforms` |
| Backup roots | `configurators/index.ts:ALL_MANAGED_DIRS` (plus retired-platform roots, the source of `BACKUP_DIRS` in update) |
| Empty-dir cleanup gate | `configurators/index.ts:isManagedPath` / `isManagedRootDir` |
| Python script bundle | `templates/arbor/index.ts:getAllScripts` |
| Init hash seeding | `utils/template-hash.ts:initializeHashes` (init); update keeps it fresh via `updateHashes` |

What's unique to update:

- Managed-block merge for `AGENTS.md` (init writes the bundled template directly through `utils/file-writer.ts:writeFile`; `CLAUDE.md` is merged by both).
- Snapshot backup at `.arbor/.backup-<timestamp>/`.
- Manifest self-heal (`pruneOrphanManifestKeys`) and receipt repair (`collectUnchangedFileHashRepairs`).
- Migration plan + execution, including the hook-config scrub.
- `configSectionsAdded` append path.
- Migration guide printing.

Init has no notion of "what was here before" — it always assumes a fresh slate and is gated by `--force` / `--skip-existing`. Update is the only command that reasons about prior state via hashes.

---

## Boundaries with `migrations.md`

`migrations.md` is the canonical reference for: manifest schema (all fields including `breaking` / `recommendMigrate` / `migrationGuide` / `aiInstructions` / `configSectionsAdded`), migration types (`rename` / `rename-dir` / `delete` / `safe-file-delete`), classification rules per type, hash relationships (`allowed_hashes` vs `.template-hashes.json`), `update.skip` config, protected paths, and walk-table helpers (`getMigrationsForVersion` / `getAllMigrations` / `getMigrationMetadata` / `getConfigSectionsAddedBetween`).

This document does NOT restate any of that. When extending update behavior, decide which side of the line your change lives on:

- New manifest field → `migrations.md`, plus the consumer wiring in `update.ts`.
- New CLI flag, new interactive prompt, new write phase, new banner → here.
- New migration *type* → both: define the type and classification in `migrations.md`, define the executor in `update.ts:executeMigrations`.

---

## Common Pitfalls

### Multi-version hop chain

`getMigrationsForVersion(from, to)` walks every manifest where `manifest.version` falls strictly above `from` and ≤ `to`, in version order (manifests ship for 0.1.0 through 1.0.0 under `src/migrations/manifests/`). If the hop's aggregated metadata is `breaking` + `recommendMigrate`, the breaking gate fires once for the whole hop. Consequence: a user who deferred upgrades for several releases sees a single hard-fail without `--migrate`, but the migration list can be very long. Test with `--dry-run` before running `--migrate` on big hops.

### Breaking + recommendMigrate must ship `migrationGuide`

`migrations.md` documents this: a manifest with `breaking: true` AND `recommendMigrate: true` MUST also define `migrationGuide`. The reason update.ts cares: the guides printed at the end of the run are the only per-release instructions the user sees. `getMigrationMetadata` collects `migrationGuide` from every manifest in the hop; if the breaking manifest is missing one, the user gets either older guides with no mention of the actual breaking release, or nothing at all. No check enforces this — reviewers must check it by hand.

### Orphan migrations

If `.arbor/.version` says you're already on the latest CLI but a stale `from` path still exists on disk and the new `to` doesn't, that's an orphan. `update()` always scans `getAllMigrations()` for orphans regardless of version range and adds them to `pendingMigrations`. They show up under "⚠️ Detected incomplete migrations from previous updates" in the printed plan. Causes: a previous run was interrupted between `migrations` execution and `updateVersionFile`; a previous run skipped the migration via `[s]` and the user expected it to apply later; manifest authoring error (an entry referencing a path that was already moved before that version shipped). All three resolve the same way: `arbor update --migrate`.

### Backup bloat

Every non-trivial run creates `.arbor/.backup-<timestamp>/`. `BACKUP_EXCLUDE_PATTERNS` keeps user-data trees and platform worktrees out, but the snapshot still includes every managed config file in every platform directory. Backups can accumulate over a few months. There is no automatic pruning today — Arbor treats backups as user data ("cleanup is your call"). If you add automatic pruning, it must be opt-in and must not delete backups newer than the last successful version transition (otherwise a debug rollback path disappears).

### `node_modules/` under managed dirs

`/node_modules` is in `BACKUP_EXCLUDE_PATTERNS` so a platform directory that happens to hold installed npm dependencies is not snapshotted into every backup (`update.integration.test.ts > #27 backup skips managed node_modules dependency trees` regression-tests this). Neither Claude Code nor Codex ships dependencies today. When adding a platform that does, verify the pattern still catches them; if the platform uses a non-standard path, extend `BACKUP_EXCLUDE_PATTERNS`.

### Idempotency churn after adding a placeholder

Symptom: every `arbor update` shows the same settings or skill file as auto-updated. Root cause: a configurator's `configure()` resolves a placeholder before writing, but `collectTemplates` returns the unresolved template. Fix: every placeholder must be resolved in BOTH places. The cleanest pattern is to share a `resolvePlaceholders(...)` call in both code paths inside `configurators/<platform>.ts`. See `platform-integration.md > Common Mistakes > "Template placeholder not resolved in collectTemplates"`.

### "Modified by you" on a file the user never touched

Two failure modes here:

1. The file was written before hash tracking existed for that path (legacy install). No untracked-hash whitelist exists; if one is ever needed, prefer backfilling hashes over an escape hatch. (A completely empty manifest prints the "First update with hash tracking enabled" hint.)
2. Two writers produced byte-different content for the same path. This cannot happen between Claude Code and Codex, which write under different directories (`.claude/` vs `.agents/skills/`), but it applies to any future shared destination: both writers must render through the same code path, and their output must be byte-identical.

### `--allow-downgrade` is a foot-gun

Migrations are forward-only. A user who downgrades while staying on the same major usually gets away with it (templates revert, user files preserved), but anything that depends on a migration applied since the target version (e.g., a renamed directory, a deleted legacy file restored under its new name) will be broken. `--allow-downgrade` is genuinely an escape hatch, not a supported workflow.

### Platform detection needs two filters

Platform detection uses template hashes with an ownership intersection: a platform counts only when the manifest contains a path declared by that platform's current `collectTemplates()` output and the path is under one of its managed paths. Keep both filters; dropping either one can create bogus platform detections and unsafe update/uninstall plans.

### Things that look like bugs but aren't

- The `Proceed?` prompt asks for confirmation even when the only "change" is a version bump. Some of those cases short-circuit before the prompt (no file changes, no migrations, no safe-deletes, no hook scrubs — see the early return after `analyzeChanges`); others legitimately have changes worth confirming.

---

## Test Conventions

Integration tests live in `test/commands/update.integration.test.ts` (numbered cases plus named cases such as the "receipt repair for files already identical to their template" group). The 1.0 migration path (delete list, hook scrubs, config.yaml never rewritten) is in `test/migrations/migration-1.0.0.test.ts`; retired-platform cleanup is in `test/commands/retired-platform.integration.test.ts`. The fixture pattern:

```typescript
beforeEach: mkdtemp + cwd-spy + console-mute + fetch-stub
setupProject(): await init({ yes: true, force: true })
test body:
  1. mutate the temp project to simulate the scenario (delete a file, edit a file, swap hashes, edit config.yaml, ...)
  2. call await update({ ...flags })
  3. assert on filesystem state and (optionally) on inquirer mock state
afterEach: restoreAllMocks + rm -rf tmp
```

External mocks: `figlet` (banner), `inquirer` (prompts; usually default `{ proceed: true }` and per-test overrides for migration-action and conflict-resolution prompts), `node:child_process.execSync` (Python detection), `globalThis.fetch`. No filesystem or VERSION mocks — tests rely on the real CLI version and real bundled templates.

Hash file helpers `readHashesV2` / `writeHashesV2` (defined in the test file) bypass `utils/template-hash.ts` to inject precise hash states. Use them when the test's behavior depends on a specific tracked-vs-modified condition that's awkward to construct via `init` + edit.

Internal helpers exported with `@internal Exported for testing only` JSDoc tags:

- `loadUpdateSkipPaths`
- `extractConfigSection`
- `applyConfigSectionsAdded`
- `shouldExcludeFromBackup`
- `sortMigrationsForExecution`

`test/commands/update-internals.test.ts` unit-tests `cleanupEmptyDirs` (re-exported from `utils/managed-paths.ts`), `loadUpdateSkipPaths`, `sortMigrationsForExecution`, `shouldExcludeFromBackup`, `dirHasManifestEntries` and the `classifyMigrations` rename-dir ownership gate. Don't widen the public surface of `commands/update.ts` for testing — keep additions to those `@internal` exports.

What you should test when extending update:

| Change | Required test |
|---|---|
| New `UpdateOptions` flag | A new `#NN` integration case exercising the flag |
| New write phase | A snapshot-style test (full repo before/after) and a hash-tracking assertion |
| New idempotency-affecting helper | A "re-run produces no changes" test (model: `#1 same version update is a true no-op`) |
| New protected-path or backup-exclude pattern | A `shouldExcludeFromBackup` unit test in `update-internals.test.ts` |
| New migration type | Add classification + execution unit tests, then a multi-step scenario in the integration suite |
| Block-merge change to `AGENTS.md` / `CLAUDE.md` | At least one test asserting both "user prose preserved" and "managed block updated" |

When a test reaches into `getAllMigrations()` or `getMigrationsForVersion`, it's exercising the boundary with `migrations/index.ts` — keep those assertions narrow (e.g., "this manifest's safe-file-delete fires") so they don't break every time the manifest list grows.
