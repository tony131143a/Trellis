---
sources:
  - packages/cli/src/utils/atomic-write.ts
  - packages/cli/src/utils/managed-removal.ts
  - packages/cli/src/utils/managed-paths.ts
  - packages/cli/src/templates/arbor/scripts/common/io.py
last_verified: 2026-11-18
---
# Filesystem Safety — Atomic Writes & Destructive-Op Guards

> Rules for any code that writes, deletes, moves or overwrites files in a user's repo. Arbor runs inside real git repos, so a truncated write or a mistargeted delete is user data loss, not a transient bug.

Applies to `commands/update.ts`, `commands/uninstall.ts`, `utils/*`, and the shipped Python under `templates/arbor/scripts/`.

## Atomic writes

- A file holding durable state (attribution manifest, `task.json`, `config.yaml`, journal files) is written temp-in-same-dir + rename, never `fs.writeFileSync(path, ...)` or `path.write_text(...)` directly: an in-place write truncates first, so a crash mid-write leaves a half-file.
- TypeScript uses `writeFileAtomic` (`utils/atomic-write.ts`); Python uses `write_text_atomic` / `write_json` (`common/io.py`). Appending to a state file is read-all + atomic write-all, not `open("a")` (`add_session.py` on `journal-*.md`).
- A script that rewrites a user's document reads and writes it without newline translation (`open(..., newline="")`, `write_text_atomic(..., newline="")`), or a CRLF document comes back as a whole-file diff (`common/spec_lint.py:cmd_verify`).
- Atomic write fixes the crash window, not concurrent last-writer-wins: `task.json` read-modify-write is serialized by the driver's per-task lock (`common/driver/lock.py`).

## Path and name safety

- Any string that becomes a path segment of a write or delete is validated before it reaches `path.join`, `shutil.move` or `rmSync`: a name like `../../x` escapes the intended tree.
- Validate at the shared chokepoint rather than each entrypoint: `cleanupEmptyDirs` (`utils/managed-paths.ts`) refuses unsafe or out-of-project targets and never removes a symlink; `validateManagedRelativePath` and `assertSafeManagedPath` (`utils/managed-removal.ts`) check manifest keys used as removal targets.

## Ownership before destruction

Before deleting, moving or overwriting anything that could be user data:

- A mixed-ownership file (`AGENTS.md`, a user-edited hook config) loses only its managed part (`scrubManagedMarkdownBlock`, `scrubHooksJson`), and is deleted only if nothing user-authored remains.
- A directory is moved only when Arbor provably created it (`dirHasManifestEntries` in `commands/update.ts`); otherwise it is skipped, even under `--force`.
- `update` never overwrites the project's `.arbor/config.yaml`.
- A recursive delete of a tree holding user data checks for uncommitted data first (`collectUncommittedArborData` in `commands/uninstall.ts`) and names what it deletes.
- A fail-closed guard on a `--yes` / `--force` path gets an explicit env bypass (`ARBOR_ALLOW_DIRTY_UNINSTALL=1`, mirroring `ARBOR_ALLOW_HOMEDIR`). Warn-and-continue is not enough on `--yes`: nobody reads scrollback in a script.

## Tests required

Every guard leaves a regression test whose assertion fails without the guard: `test/utils/atomic-write.test.ts`, `test/utils/managed-removal.test.ts`, `test/commands/update-internals.test.ts`, `test/commands/uninstall-dirty-guard.integration.test.ts`.

## Related

- [Script Conventions](./script-conventions.md): the Python `io.py` rules and the two script trees
- [Migrations](./migrations.md): rename, rename-dir and delete semantics
