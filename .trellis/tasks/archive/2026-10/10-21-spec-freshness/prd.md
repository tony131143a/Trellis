# Spec freshness lint and change traceability

## Goal

Spec docs under `.trellis/spec/` are the harness's feedforward guides. Today nothing
detects when they drift from the code they describe, when their links or index rows
rot, or which task introduced a rule. This task adds:

1. A stdlib-only Python `spec lint` that reports stale, broken, or placeholder spec
   docs (advisory, not a gate).
2. Archive-time recording of the spec files each task changed, so "why does this
   rule exist" can be traced to a task and, via `trellis mem`, to the conversation.

User value: agents and authors see which spec docs are trustworthy before loading
them; rule provenance becomes answerable without git archaeology.

## Background

- `.trellis/spec/` in this repo: 37 leaf docs + 6 `index.md`. No doc uses YAML
  frontmatter. One doc (`cli/backend/commands-ablate.md`) opens with a `Sources:`
  bullet list of code paths. Index tables have a `Status` column (`Done` / `To fill`).
- `workflow.md:31` and `templates/common/skills/check.md` tell agents to read each
  index's "Pre-Development Checklist" and "Quality Check" sections. The shipped
  templates `templates/markdown/spec/{backend,frontend}/index.md.txt` have neither;
  only this repo's own `.trellis/spec/cli/backend/index.md:40,69` has them.
- Shipped leaf templates mark unfilled sections with `(To be filled by the team)`
  (e.g. `templates/markdown/spec/backend/error-handling.md.txt:20`).
- Script constraints: Python 3.9+, stdlib only (`spec/cli/backend/script-conventions.md`).
  `.trellis/scripts/**` and `packages/cli/src/templates/trellis/scripts/**` must stay
  byte-identical (`test/regression.test.ts`). New shipped scripts must be registered
  in `templates/trellis/index.ts` `getAllScripts()`.
- `task.json` schema (`common/types.py:21`, `TaskData`, `total=False`) carries
  `createdAt`, `branch`, `base_branch`, `creator`, `assignee`; `relatedFiles` is
  declared but unused anywhere.
- Archive flow: `cmd_archive` (`common/task_store.py:1257`) sets `status` /
  `completedAt` and writes `task.json` before the move; `_auto_commit_archive`
  (`task_store.py:1463`) stages only task paths. Spec edits happen in Phase 3.3 and are
  committed in Phase 3.4, so by archive time the task's spec changes are in git history.
- No existing consumer parses spec doc bodies: `packages_context.py` scans directories
  only; sub-agent injection inlines whole files. Adding frontmatter cannot break a
  reader.
- `finish-work` Step 1 runs `get_context.py --mode record`; natural place to surface
  a lint summary.
- Python scripts are tested from vitest by copying template scripts into a temp repo
  and running them with `spawnSync("python3", ...)`
  (`test/scripts/task-children-normalization.integration.test.ts`).

## Key decisions

- **D1 Metadata lives in YAML frontmatter** per doc (`sources`, `last_verified`),
  parsed by a hand-written restricted-subset parser (stdlib constraint). Chosen over
  a body convention or a sidecar manifest. (User decision, this session.)
- **D2 Advisory only.** Lint never blocks `archive`, commit, or `finish-work`.
  (User direction, this session.)
- **D3 Phase 1 scope** = lint + archive-time traceability + shipped index template
  fix. Doc-gardening and rule promotion are later tasks.
- **D4 Provenance is derived, not written into docs.** `spec_changes` is stored on
  the archived `task.json`; lint reads it back. Spec docs are never edited at archive.
- **D5 `create` does not write the new task.json fields**; readers treat absence as
  empty, so existing tasks and fixtures are untouched.

## Requirements

- **R1 Spec metadata.** Each leaf spec doc can declare frontmatter with `sources`
  (repo-relative paths or globs the doc describes) and `last_verified` (ISO date).
  Required for layer leaf docs, optional for `guides/*.md` and `index.md`.
- **R2 `spec lint`.** New entry script `spec.py` + `common/spec_lint.py`, scanning
  `.trellis/spec/**/*.md` (optionally filtered by path or `--package`). Checks:
  - L1 `missing-metadata` (warn): required doc without frontmatter, with empty
    `sources`, or without `last_verified`.
  - L2 `dead-source` (error): a `sources` entry matches no file.
  - L3 `broken-link` (error): relative markdown link whose target does not exist.
  - L4 `stale` (warn): newest commit date over the doc's source files is after
    `last_verified` (filesystem mtime fallback when git is unavailable).
  - L5 `placeholder` (info): index rows with Status `To fill`, or
    `(To be filled by the team)` / `To fill` in a doc body.
  - L6 `missing-section` (warn): layer `index.md` lacking "Pre-Development Checklist"
    or "Quality Check".
  - L7 `unlisted-doc` (warn): layer leaf doc not linked from its `index.md`.
  Output: text grouped by severity with `path:line`; one summary line when clean;
  `--json`. Exit 0 by default; `--strict` exits 1 when errors exist; 2 on usage/IO
  failure.
- **R3 `spec verify <path...>`.** Stamps `last_verified` (today or `--date`) after a
  human or agent re-checked the doc. Changes nothing else in the file.
- **R4 `spec init-meta`.** Seeds frontmatter on docs that lack it: `sources` from an
  existing `Sources:` bullet list when present (else empty), `last_verified` from the
  doc's last commit date (else today). Used once for this repo's migration and
  available to users.
- **R5 Traceability at archive.** `task.py archive` derives the spec files this task
  changed and writes `spec_changes: [paths]` plus `spec_changes_source`
  (`branch-diff` | `since-created` | `manual` | `mixed` | `none`) into `task.json`
  before the move. Branch-diff when `branch` differs from `base_branch`; otherwise
  commits since `createdAt`. `task.py add-spec-change <dir> <path>` records paths git
  cannot attribute. Derivation failure warns and never blocks archive.
- **R6 Provenance in lint.** `spec lint --provenance` (and `--json`) reports, per doc,
  the task(s) that last changed it from archived `task.json` records.
- **R7 Templates.** Shipped backend/frontend `index.md.txt` gain "Pre-Development
  Checklist" and "Quality Check" sections; shipped leaf templates carry a seed
  frontmatter block (`sources: []`).
- **R8 Workflow integration (advisory).** `finish-work` Step 1 prints the lint
  summary; workflow step 3.3 (template and dogfood copy) and the
  `trellis-update-spec` skill mention `spec verify` and the metadata fields.
- **R9 Dogfood migration.** This repo's spec docs get frontmatter via `init-meta`,
  obvious `sources` are filled (`commands-*.md`, `script-conventions.md`,
  `workflow-state-contract.md`), and the tree passes `spec lint --strict`.

## Acceptance Criteria

- **AC1** On a fixture repo containing one dead source, one broken link, one stale
  doc, one `To fill` row, one placeholder body line, one unlisted doc, and one index
  missing both sections, `spec lint` reports each finding exactly once with
  `path:line`, in text and `--json`; exit 0 by default, 1 with `--strict`.
- **AC2** On a clean fixture, output is a single summary line.
- **AC3** `spec verify` changes only the `last_verified` line; every other byte of the
  file is identical.
- **AC4** `spec init-meta` on a doc with a `Sources:` bullet list produces frontmatter
  whose `sources` equal that list; the original body is unchanged below the block.
- **AC5** Archiving a task on a feature branch whose commits touched
  `.trellis/spec/x.md` yields `spec_changes: [".trellis/spec/x.md"]` and
  `spec_changes_source: "branch-diff"`. On a shared branch the source is
  `since-created`. With git unavailable, archive still exits 0 with a warning and
  `spec_changes_source: "none"`. `add-spec-change` yields `manual`.
- **AC6** Shipped index templates contain both sections; `regression.test.ts`
  byte-identity passes; the four new scripts are registered in `getAllScripts()` and
  every test that enumerates shipped scripts is updated.
- **AC7** This repo's own spec docs pass `spec lint --strict` (0 errors; warnings
  allowed for docs whose `sources` remain empty).
- **AC8** Python 3.9 `py_compile` check and stdlib-only constraint hold; `pnpm lint`
  and `pnpm typecheck` pass.

## Out of scope

- Doc-gardening skill or any automatic rewriting of stale doc bodies (phase 2).
- Rule promotion, violation ledger, enforcement levels (phase 2).
- Gating `archive`, `commit`, or `finish-work` on lint results.
- Symbol-level drift detection (GitNexus); path-level only.
- Writing `changed_by` into spec docs; provenance is derived from archived task
  records and git.
- A TypeScript `trellis spec` CLI subcommand (Python script only in phase 1).
- Regenerating per-platform dogfood copies of skills/commands under `.claude/` etc.
  (templates are the source of truth; dogfood regen is a separate chore).
