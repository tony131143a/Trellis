---
sources:
  - packages/cli/src/utils/atomic-write.ts
  - packages/cli/src/utils/managed-removal.ts
  - packages/cli/src/utils/managed-paths.ts
  - packages/cli/src/templates/arbor/scripts/common/io.py
last_verified: 2026-11-13
---
# Filesystem Safety — Atomic Writes & Destructive-Op Guards

> Cross-cutting contract for any code that **writes, deletes, moves, or
> overwrites** files in a user's repo. Arbor ships as a CLI that runs inside
> real git repos, so a truncated write or a mistargeted delete is user data
> loss, not a transient bug. These are the guardrails the 2026-07-10 audit's
> two root causes distilled to.

Applies to: `commands/update.ts`, `commands/uninstall.ts`, `utils/*`, and the
shipped Python under `templates/arbor/scripts/`.

---

## 1. Atomic writes — never truncate a state file in place

**Rule**: a file that holds durable state (attribution manifest, `task.json`,
`config.yaml`, journal files) must be written
**temp-in-same-dir + rename**, never `fs.writeFileSync(path, ...)` /
`path.write_text(...)` directly. In-place writes truncate the target as their
first step, so a crash / Ctrl-C / ENOSPC mid-write leaves a half-file. A
truncated `.template-hashes.json` heals to `{}` (every managed file then looks
user-modified); a truncated `task.json` no longer loads.

### Signatures

```ts
// packages/cli/src/utils/atomic-write.ts
export function writeFileAtomic(filePath: string, data: string | Uint8Array): void
// writes `<dir>/.<basename>.<pid>.tmp` then fs.renameSync over filePath;
// removes the tmp and rethrows on failure. Same-dir tmp keeps rename atomic.
```

Callers: `utils/template-hash.ts:saveHashes` and every write in
`utils/file-writer.ts` (`writeFile`, `writeManagedBlockFile`, append mode).

```python
# templates/arbor/scripts/common/io.py
def write_json(path: Path, data: dict) -> bool
def write_text_atomic(path: Path, text: str, newline: str | None = None) -> bool
# tempfile.mkstemp(dir=path.parent) -> os.fdopen write -> os.replace(tmp, path);
# on OSError unlinks tmp and returns False; on any other BaseException
# (Ctrl-C included) unlinks tmp and re-raises.
# write_json serializes and delegates, so both share one implementation.
```

`write_text_atomic` covers the Markdown state files, not just JSON:
`add_session.py` appends to `journal-*.md` and rewrites `index.md` through it.
The append is read-all + write-all rather than `open("a")` for exactly that
reason. The driver writes `task.json` through `write_json`
(`common/driver/repos.py`).

### Wrong vs Correct

```ts
// Wrong — truncates on entry; a crash here corrupts the manifest to {}
fs.writeFileSync(hashesPath, JSON.stringify(payload, null, 2));

// Correct
writeFileAtomic(hashesPath, JSON.stringify(payload, null, 2));
```

> **Note**: atomic write fixes the *crash window*. It does **not** fix
> concurrent last-writer-wins (multiple processes RMW the same file). For
> `task.json` the driver serializes read-modify-write with its per-task lock
> (`common/driver/lock.py`); other files have no locking.

---

## 2. Path & name safety — validate at the chokepoint, before `path.join`

**Rule**: any string that becomes a path segment of a write or delete must be
validated **before** it flows into `path.join` / `shutil.move` / `rmSync`. A
name like `../../x` resolves outside the intended tree and a later recursive
delete escapes it.

| Concern | Guard | Location |
|---|---|---|
| empty-dir pruning after a delete | `cleanupEmptyDirs(cwd, dir)` returns without touching anything for absolute paths, empty / `.` / `..` segments, paths outside `ALL_MANAGED_DIRS`, managed roots themselves, or a target whose realpath leaves the project; never removes a symlink | `utils/managed-paths.ts` |
| manifest key as a removal target (strict mode) | `validateManagedRelativePath` (rejects empty, NUL, `\`, absolute, drive-letter, empty / `.` / `..` segments) + `assertSafeManagedPath` (parent symlinks must resolve inside the project) — used by `buildManagedRemovalPlan` only with `strictPaths: true`, which no CLI command passes | `utils/managed-removal.ts` |
| rename-dir migration source | `dirHasManifestEntries(fromDir, hashes)` — only auto-move a dir Arbor provably created | `commands/update.ts` |

> **Why the chokepoint, not the entrypoint**: `cleanupEmptyDirs` is the shared
> pruner called after file deletes (update migrations and `safe-file-delete`,
> uninstall Phase 4), so validating inside it covers all of those callers.
> Uninstall Phase 5, the empty-`.codex/` removal in update and rename-dir's
> `removeDirectoryRecursive` do not go through it.

---

## 3. Destructive-op ownership / backup gate

Before deleting, moving, or overwriting anything that **could be user data**,
one of these must hold. Pick by operation:

| Operation | Required guard |
|---|---|
| Delete a mixed-ownership file (e.g. `AGENTS.md`) | Strip only the managed block (`scrubManagedMarkdownBlock`); delete only if nothing user-authored remains. Never `unlinkSync` the whole file. |
| Remove Arbor hooks from a user-edited hook config (`.claude/settings.json`, `.codex/hooks.json`) during `update --migrate` | `planHookScrubs`: take the file out of both the template overwrite and the migration delete, strip only entries whose command runs a deleted file (`scrubHooksJson`), delete only if nothing else is left. |
| Move a dir that may be user-owned (rename-dir) | Ownership check (`dirHasManifestEntries`); unowned + target-absent → **skip** (safe even under `--force`, since skip never executes). |
| Update the project's own config (`.arbor/config.yaml`) | Never in `update`'s template set, so no overwrite even under `--force`; only sentinel-gated `configSectionsAdded` appends. |
| `rm -rf` a tree with user data (`uninstall`) | `collectUncommittedArborData(cwd)` (git status over `spec/tasks/workspace`); scripted `--yes` fails closed unless `ARBOR_ALLOW_DIRTY_UNINSTALL=1`. Disclosure must name what user data is deleted. |

**Env override precedent**: a fail-closed guard on a `--yes`/`--force` path gets
an explicit env bypass, mirroring `ARBOR_ALLOW_HOMEDIR`
(`ARBOR_ALLOW_DIRTY_UNINSTALL=1`). Warn-and-continue is not enough on
`--yes` — nobody reads scrollback in a script.

---

## 4. Dogfood twin sync

Shipped Python (`packages/cli/src/templates/arbor/scripts/**`) has a dogfood
twin at repo `.arbor/scripts/**`. **Every `.py` under the two trees must be
byte-identical, and the build fails if it is not** — there is no such thing as
acceptable local drift. Edit both copies, never one.

The full contract, including what the test does and does not cover, is in
`script-conventions.md` → "Two script trees, one content". `packages/cli/dist/**`
and `.arbor/.backup-*/**` are generated/history — never hand-edit.

---

## 5. Tests required

Every guard here leaves a runnable regression test whose assertion **fails
without the guard**:

- Atomic write: write-succeeds + no tmp leftover + original survives a failed write (`test/utils/atomic-write.test.ts`); Python `write_json` fd ownership and tmp cleanup (`regression.test.ts` → "regression: write_json fd ownership and cleanup (issue #429)").
- Path traversal: `cleanupEmptyDirs` rejects traversal / dot segments and does not follow a managed parent symlink outside the project (`test/commands/update-internals.test.ts`); `validateManagedRelativePath` / `assertSafeManagedPath` (`test/utils/managed-removal.test.ts`).
- Ownership/backup gates: unowned source skipped (`update-internals` rename-dir gate), hook scrub keeps the user's own entries and config.yaml is never rewritten (`test/migrations/migration-1.0.0.test.ts`), uninstall refuses dirty `--yes` (`uninstall-dirty-guard`, real git).
- Dogfood twin sync: identical `.py` path sets in both trees, plus one byte-compare case per file (`regression.test.ts` → "regression: .arbor/scripts stays byte-identical to templates/arbor/scripts"). The file list is derived from the filesystem, so a new script is covered the moment it is added.

---

## Related

- [`arbor update` Command](./commands-update.md) — migration classification/apply
- [`arbor uninstall` Command](./commands-uninstall.md) — plan/execute phases
- [Script Conventions](./script-conventions.md) — Python `io.py` contract
- [Migrations](./migrations.md) — rename/rename-dir/delete semantics
