# Design: Spec freshness lint and change traceability

## 1. Boundaries

**New (Python, stdlib only, Python 3.9+), mirrored in `.trellis/scripts/` and
`packages/cli/src/templates/trellis/scripts/`:**

| File | Role |
|------|------|
| `spec.py` | Entry shim (argparse) → `common.spec_lint.main` |
| `common/spec_meta.py` | Frontmatter parse / line-level rewrite (restricted YAML subset) |
| `common/spec_lint.py` | Doc discovery, rules L1–L7, reporters (text / JSON), `verify`, `init-meta` |
| `common/spec_trace.py` | `derive_spec_changes()` + provenance lookup over archived `task.json` |

**Changed:**

- `common/task_store.py`: `cmd_archive` writes `spec_changes` / `spec_changes_source`
  before the task.json write; new `cmd_add_spec_change`.
- `task.py`: `add-spec-change <dir> <path>` subparser; docstring usage line.
- `common/types.py`: `TaskData` gains `spec_changes: list[str]`,
  `spec_changes_source: str`.
- `templates/trellis/index.ts`: register the four new scripts in `getAllScripts()`.
- `templates/markdown/spec/{backend,frontend}/index.md.txt`: add
  "Pre-Development Checklist" and "Quality Check" sections.
- `templates/markdown/spec/{backend,frontend}/*.md.txt` leaf templates: seed
  frontmatter (`sources: []`, `last_verified:` left for `init-meta`).
- `templates/common/commands/finish-work.md` Step 1: add the lint command.
- `templates/trellis/workflow.md` step 3.3 and dogfood `.trellis/workflow.md` (same
  hunk): mention `spec.py lint` / `spec.py verify`.
- `templates/common/skills/update-spec.md`: describe the frontmatter fields and
  when to run `verify`.

**Not changed:** hooks, SessionStart / sub-agent injection, `safe_commit` staging
scope, TypeScript CLI commands (no `trellis spec` TS subcommand in phase 1),
`packages_context.py` (still directory-scan only).

## 2. Frontmatter contract

```markdown
---
sources:
  - packages/cli/src/commands/ablate.ts
  - packages/cli/src/utils/ablation-store.ts
last_verified: 2026-10-21
---
# `trellis ablate` and `trellis restore`
```

- Block = line 1 is `---`, terminated by the next line that is exactly `---`.
- Supported syntax (hand-written parser, no PyYAML): `key: scalar`, `key:` followed by
  `  - item` lines, `key: [a, b]`, blank lines, `#` comments. Anything else →
  `invalid-metadata` error naming the line. Unknown keys are preserved verbatim.
- `sources`: repo-relative POSIX paths, `./` prefix stripped. Glob characters
  `* ? [` and `**` allowed; resolved with `Path(repo_root).glob`. Absolute paths and
  `..` segments → `invalid-source` error.
- `last_verified`: `YYYY-MM-DD`. Any other shape → `invalid-metadata` error.
- Applicability: **required** (rule L1) for layer leaf docs
  (`spec/<pkg>/<layer>/*.md` in monorepo, `spec/<layer>/*.md` in single-repo)
  excluding `index.md`. **Optional** for `spec/guides/*.md` and every `index.md`;
  when present it is validated and L2 / L4 still apply.
- Rewrites are line-level, never a re-serialization:
  - `verify` replaces the existing `last_verified:` line; if absent, inserts it after
    the `sources` block (or after the opening `---`). On a doc with no block at all it
    prepends `sources: []` + `last_verified` (L1 then asks for `sources`). All other
    bytes unchanged, including the doc's own line endings (CRLF stays CRLF).
  - `init-meta` prepends a block to docs that lack one. A directory scan seeds only
    required leaf docs (applicability above); a file named explicitly is seeded
    whatever its kind. If the first 30 lines contain a
    markdown `Sources:` bullet list (today only `cli/backend/commands-ablate.md`), its
    entries are copied into `sources` with code spans stripped; the prose list is left
    in place. `last_verified` seeds from `git log -1 --format=%ci -- <doc>` (first 10
    chars), falling back to today when git is unavailable.

## 3. Lint rules

| Id | Severity | Applies to | Detection | Remediation in message |
|----|----------|-----------|-----------|------------------------|
| L1 `missing-metadata` | warn | required docs (§2) | no frontmatter, empty `sources`, or no `last_verified` | `run spec.py init-meta <path>` |
| L2 `dead-source` | error | any doc with `sources` | a source entry matches zero files | fix or remove the entry |
| L3 `broken-link` | error | all docs | relative `](x.md)` / `](x.md#a)` link whose target does not exist relative to the doc dir; skips `http(s):`, `mailto:`, pure `#anchor`, fenced code blocks and inline code spans | fix the link |
| L4 `stale` | warn | docs with `sources` + `last_verified` | newest commit date over all matched source files (`git log -1 --format=%ci -- <files>`, one call per doc) is later than `last_verified`; fallback: newest mtime when git fails | re-check doc, then `spec.py verify <path>` |
| L5 `placeholder` | info | all docs | index table rows whose Status cell is `To fill`; body lines containing a `PLACEHOLDER_MARKERS` phrase: `(To be filled by the team)` (shipped leaf templates line 20) or `To fill` outside a table; fenced code blocks and inline code spans are skipped | fill or delete |
| L6 `missing-section` | warn | layer `index.md` (not `guides/index.md`) | no `## Pre-Development Checklist` or no `## Quality Check` heading | add the section |
| L7 `unlisted-doc` | warn | layer leaf docs | sibling `index.md` contains no link to the doc filename | add an index row |

Severity order error > warn > info. Findings carry `path:line` (line 0 when the
whole file is the subject).

## 4. CLI contract

```text
spec.py lint   [PATH...] [--package NAME] [--json] [--strict] [--provenance]
spec.py verify PATH...   [--date YYYY-MM-DD]
spec.py init-meta [PATH...] [--dry-run]
```

- `PATH` filters to docs under the given files/dirs (repo-relative or absolute,
  must resolve under `.trellis/spec`). `--package` filters to `spec/<pkg>/`.
- Text output, one line per finding, then one summary line:

```text
ERROR dead-source   .trellis/spec/cli/backend/x.md:3   packages/cli/src/gone.ts matches no file
WARN  stale         .trellis/spec/cli/backend/y.md:4   sources changed 2026-10-18 after last_verified 2026-09-01 (packages/cli/src/commands/mem.ts)
spec lint: 37 docs, 1 error, 1 warning, 0 info
```

  Clean run prints only `spec lint: 37 docs, 0 findings` (silent success).
- `--json` shape:

```json
{
  "docs": 37,
  "findings": [
    {"rule": "dead-source", "severity": "error", "path": ".trellis/spec/cli/backend/x.md",
     "line": 3, "message": "...", "detail": {"source": "packages/cli/src/gone.ts"}}
  ],
  "summary": {"errors": 1, "warnings": 1, "info": 0},
  "provenance": {".trellis/spec/cli/backend/x.md": [
    {"task": "10-21-spec-freshness", "completedAt": "2026-10-22", "source": "branch-diff"}
  ]}
}
```

  `provenance` is present with `--provenance` (text mode appends a
  `last changed by <task> (<date>)` suffix per doc that has any).
- Exit codes: `0` normally; `1` when `--strict` and errors > 0; `2` on usage or I/O
  failure (no `.trellis/spec`, unreadable doc, invalid `--date`).
- `verify` with no `--date` uses today. It refuses paths outside `.trellis/spec`.

## 5. Traceability at archive

**New task.json fields** (`TaskData` is `total=False`; `create` does not write them,
so existing fixtures and tests that snapshot `create` output are untouched; readers
use `.get()` and treat absence as `[]` / `"none"`):

- `spec_changes: list[str]` — repo-relative POSIX paths under `.trellis/spec/`.
- `spec_changes_source: "none" | "manual" | "branch-diff" | "since-created" | "mixed"`.

**`derive_spec_changes(data, repo_root) -> (paths, source, warning)`** in
`common/spec_trace.py`:

1. `branch = data.get("branch")`, `base = data.get("base_branch")`. If both set and
   different: `tip` is `branch` when that ref still exists locally, else `HEAD`
   (after a merge HEAD may already sit on `base`, where `merge-base base HEAD`
   collapses the diff to nothing); `git merge-base <base> <tip>` →
   `git diff --name-only <mb> <tip> -- .trellis/spec` → source `branch-diff`.
2. Else: `git log --since=<createdAt> --name-only --format= -- .trellis/spec` →
   source `since-created` (approximate on shared branches; labeled as such).
3. Union with any `spec_changes` already recorded via `add-spec-change`; if both
   derived and manual are non-empty → `mixed`. Sort, dedupe, keep deleted paths
   (a task that removed a spec still changed it). A derivation that succeeds but
   finds nothing still records its method (`branch-diff` / `since-created` with
   `spec_changes: []`); `none` means only that git could not answer and nothing
   was recorded manually.
4. Any git failure or exception → return `(manual_entries, "manual" or "none",
   warning_text)`; the caller prints the warning and continues.

**Insertion point:** `cmd_archive`, immediately after `data["completedAt"] = today`
and before the `write_json(task_json_path, data)` call
(`common/task_store.py:~1350`). The archive commit scope (`safe_archive_paths_to_add`)
is unchanged because only task.json is modified.

**`task.py add-spec-change <dir> <path>`:** normalizes to POSIX repo-relative,
requires the path to start with `.trellis/spec/` and exist, appends if absent, sets
`spec_changes_source` to `manual` when it was `none` and to `mixed` when it was
`branch-diff` / `since-created` (a derived record plus a manual entry).

**Provenance lookup** (`spec_trace.collect_provenance(repo_root)`): reads every
`.trellis/tasks/archive/*/*/task.json` plus active tasks, returns
`{spec_path: [{task, completedAt, source}]}` sorted newest first.

## 6. Data flow

```text
Phase 3.3  agent edits spec docs ──► optional `spec.py verify <doc>` (stamps date)
Phase 3.4  batched commit (code + spec)
finish-work Step 1  `spec.py lint` (advisory summary in the survey)
task.py archive  ──► derive_spec_changes() ──► task.json{spec_changes, source} ──► archive/
later  `spec.py lint --provenance`  reads archived task.json ──► "last changed by task X"
```

## 7. Compatibility and migration

- Docs without frontmatter keep working; only L1 warns. No existing consumer parses
  spec bodies (`packages_context.py` scans directories; sub-agent injection inlines
  whole files, so a block adds ~4 lines per doc).
- New scripts reach existing users through the normal template-hash flow:
  `trellis update` backfills missing `.trellis/scripts/**` files; edits to
  `task_store.py` / `task.py` / `types.py` go through the standard 3-way conflict
  prompt. No migration manifest entry is required for additive files.
- Shipped `index.md.txt` / leaf template changes affect new `trellis init` only;
  `trellis update` never rewrites `spec/` without a registry (`update.ts:125-129`).
- Dogfood: `.trellis/scripts/**` stays byte-identical with templates
  (`regression.test.ts`); `.trellis/workflow.md` receives the same 3.3 hunk;
  `.trellis/spec/**` is migrated with `spec.py init-meta`.
- Git version: use `--format=%ci` and slice the date (works on git < 2.21, unlike
  `%cs`). Paths are normalized to POSIX for Windows.

## 8. Trade-offs

- **Hand-written frontmatter parser** (restricted subset) instead of PyYAML: required
  by the stdlib-only rule. Unsupported syntax fails loudly with a line number rather
  than being silently ignored.
- **Path-level staleness** rather than symbol-level: cheap, tool-independent, works in
  user projects without GitNexus. False positives when an unrelated edit touches a
  large source file; mitigated by keeping `sources` narrow.
- **Git-derived attribution** on a shared branch is approximate; the
  `spec_changes_source` label makes the precision explicit and `add-spec-change`
  provides an exact manual path.
- **Advisory only**: lint never blocks archive, commit, or finish-work (user
  decision this session).

## 9. Rollback

Everything is additive. Reverting the commit restores prior behavior: frontmatter
blocks are inert markdown to every other reader, and older scripts ignore the two
new task.json fields. No data migration to undo.

## 10. Testing

- `packages/cli/test/scripts/spec-lint.integration.test.ts`: temp repo with copied
  template scripts and a fixture `.trellis/spec` tree. One case per rule L1–L7 (each
  reported exactly once with `path:line`), clean-tree summary line, `--json` shape,
  `--strict` exit code, `verify` byte-identity except the stamped line, `init-meta`
  seeding from a `Sources:` list. Skips when `python3` is absent (existing `hasPython`
  pattern).
- `packages/cli/test/scripts/task-archive-spec-changes.integration.test.ts`: git repo
  with a feature branch touching `.trellis/spec/x.md` → archived task.json has
  `spec_changes` + `branch-diff`; shared-branch case → `since-created`; `git` removed
  from PATH → archive succeeds with warning and `none`; `add-spec-change` → `manual`.
- `regression.test.ts` byte-identity covers the mirrored scripts automatically.
- Template tests that enumerate shipped script files are updated for the four new
  files.
- Dogfood gate: `python3 .trellis/scripts/spec.py lint --strict` exits 0 on this repo
  after `init-meta` migration (AC6).
