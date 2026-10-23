# Implement: Spec freshness lint and change traceability

Work in `packages/cli/src/templates/trellis/scripts/` first, mirror to
`.trellis/scripts/` at the end of each Python step (`rsync -a --delete
packages/cli/src/templates/trellis/scripts/ .trellis/scripts/`, excluding
`__pycache__`). `regression.test.ts` enforces byte identity.

## Checklist

### Step 1 — `common/spec_meta.py` (frontmatter)

- [ ] `parse_frontmatter(text) -> FrontmatterResult` with `meta: dict`,
      `block_span: tuple[int, int] | None` (line indexes), `errors: list[(line, msg)]`.
      Supports `key: scalar`, `key:` + `- item`, `key: [a, b]`, blanks, `#` comments.
- [ ] `set_last_verified(text, date) -> str`: line-level replace or insert (§2 of
      design.md). Must leave every other byte unchanged.
- [ ] `build_block(sources, last_verified) -> str` for `init-meta`.
- [ ] `extract_markdown_sources(text) -> list[str]`: reads a `Sources:` bullet list
      in the first 30 lines, strips backticks.
- Validate: `python3 -m py_compile packages/cli/src/templates/trellis/scripts/common/spec_meta.py`

### Step 2 — `common/spec_lint.py` + `spec.py`

- [ ] `discover_docs(repo_root, paths, package)` → list of `Doc(path, kind)` with
      `kind in {"leaf", "index", "guide"}`; leaf/index detection follows the layout
      rules in design.md §2 (monorepo vs single-repo via `get_packages()`).
- [ ] Rules L1–L7 as pure functions `check_*(doc, ctx) -> list[Finding]`;
      `Finding(rule, severity, path, line, message, detail)`.
- [ ] L4 git probe: `run_git(["log", "-1", "--format=%ci", "--", *files], cwd=repo_root)`,
      slice `[:10]`; on `rc != 0` or empty stdout fall back to `max(st_mtime)` date.
- [ ] Reporters: text (one line per finding + summary; clean → single `OK` summary) and
      `--json` (shape in design.md §4). `--strict` → exit 1 when errors > 0; exit 2 on
      missing `.trellis/spec` or invalid `--date`.
- [ ] `cmd_verify(paths, date)`: refuse paths outside `.trellis/spec`; write with
      `write_text_atomic`.
- [ ] `cmd_init_meta(paths, dry_run)`: skip docs that already have a block; seed
      `last_verified` from `git log -1 --format=%ci -- <doc>` (fallback today).
- [ ] `spec.py` entry shim mirroring `get_context.py` (docstring usage + `main()`).
- Validate: `python3 -m py_compile` on both files; smoke run
  `python3 packages/cli/src/templates/trellis/scripts/spec.py lint --json | head`.

### Step 3 — `common/spec_trace.py`

- [ ] `derive_spec_changes(data, repo_root) -> tuple[list[str], str, str | None]`
      per design.md §5 (branch-diff / since-created / manual / mixed / none). Every
      git call goes through `run_git`; any exception is caught and returned as the
      warning string.
- [ ] `collect_provenance(repo_root) -> dict[str, list[dict]]` over
      `.trellis/tasks/archive/*/*/task.json` + active tasks, using `read_json`.
- Validate: `python3 -m py_compile`.

### Step 4 — task scripts

- [ ] `common/types.py`: add `spec_changes: list[str]` and `spec_changes_source: str`
      to `TaskData` (TypedDict is `total=False`; no `create` default).
- [ ] `common/task_store.py` `cmd_archive`: after `data["completedAt"] = today`, call
      `derive_spec_changes`; set both fields; print the warning (yellow) when present.
      Never change the return code because of derivation.
- [ ] `common/task_store.py`: `cmd_add_spec_change(args)` (validation per §5).
- [ ] `task.py`: `add-spec-change <dir> <path>` subparser + docstring usage line.
- Validate: `python3 -m py_compile` on the three files; run an existing archive test
  `pnpm -C packages/cli exec vitest run test/scripts/task-archive.integration.test.ts`
  to confirm no regression before adding new tests.

### Step 5 — mirror + registration (rollback point A)

- [ ] rsync scripts to `.trellis/scripts/`; confirm with
      `diff -r --exclude=__pycache__ packages/cli/src/templates/trellis/scripts .trellis/scripts`.
- [ ] `packages/cli/src/templates/trellis/index.ts`: four `readTemplate(...)` exports and
      four `scripts.set(...)` entries (`spec.py`, `common/spec_meta.py`,
      `common/spec_lint.py`, `common/spec_trace.py`).
- [ ] Update tests that enumerate shipped scripts:
      `packages/cli/test/commands/update.integration.test.ts` (grep `add_session.py`
      for the list) and `packages/cli/test/commands/init.integration.test.ts` if it
      lists script files.
- Validate: `pnpm -C packages/cli exec vitest run test/regression.test.ts
  test/commands/init.integration.test.ts test/commands/update.integration.test.ts`.
- Rollback point A: reverting Steps 1–5 removes four files and three small diffs; no
  template text touched yet.

### Step 6 — templates and workflow text

- [ ] `templates/markdown/spec/backend/index.md.txt` and `frontend/index.md.txt`: add
      `## Pre-Development Checklist` and `## Quality Check` sections modeled on
      `.trellis/spec/cli/backend/index.md:40,69`, with generic `To fill` pointers.
- [ ] Shipped leaf templates (11 files under `templates/markdown/spec/{backend,frontend}/`
      excluding `index.md.txt`): prepend
      `---\nsources: []\n---\n` (no `last_verified`; `init-meta` / `verify` stamp it).
- [ ] `templates/common/commands/finish-work.md` Step 1: add
      `{{PYTHON_CMD}} ./.trellis/scripts/spec.py lint` with one sentence: advisory,
      report findings to the user, do not block.
- [ ] `templates/trellis/workflow.md` step 3.3 and `.trellis/workflow.md` step 3.3
      (identical hunk): after updating a spec doc, run `spec.py verify <doc>`; run
      `spec.py lint` to see stale or broken docs.
- [ ] `templates/common/skills/update-spec.md`: new short section "Spec metadata"
      (frontmatter fields, when to `verify`, where `spec lint` findings come from).
- Validate: `pnpm -C packages/cli exec vitest run test/templates` (marker / routing
  invariants still hold).

### Step 7 — new tests

- [ ] `packages/cli/test/scripts/spec-lint.integration.test.ts`: fixture tree covering
      L1–L7 (one finding each, `path:line` asserted), clean summary, `--json` shape,
      `--strict` exit 1, `verify` byte-identity except the stamped line, `init-meta`
      seeding from a `Sources:` list. Copy the `hasPython` / `setupRepo` pattern from
      `task-children-normalization.integration.test.ts`.
- [ ] `packages/cli/test/scripts/task-archive-spec-changes.integration.test.ts`:
      feature-branch → `branch-diff`; shared branch → `since-created`; `PATH` without
      git → archive still exits 0, `spec_changes_source == "none"`, warning printed;
      `add-spec-change` → `manual`; manual + derived → `mixed`.
- Validate: `pnpm -C packages/cli exec vitest run test/scripts`.

### Step 8 — dogfood migration (rollback point B)

- [ ] `python3 .trellis/scripts/spec.py init-meta` over `.trellis/spec/` (37 docs).
- [ ] Fill `sources` for the docs with an obvious mapping: `cli/backend/commands-*.md`
      → `packages/cli/src/commands/<name>.ts` (+ `channel/` dir), `script-conventions.md`
      → `packages/cli/src/templates/trellis/scripts/**/*.py`,
      `workflow-state-contract.md` → `packages/cli/src/templates/shared-hooks/*.py` +
      `templates/trellis/workflow.md`. Leave the rest `sources: []` (L1 warns; allowed
      by AC6).
- [ ] Fix any `broken-link` / `dead-source` errors the lint reports on this repo.
- Validate: `python3 .trellis/scripts/spec.py lint --strict` exits 0.
- Rollback point B: `git checkout -- .trellis/spec` undoes the migration independently
  of the code.

### Step 9 — full validation before check

```bash
git ls-files -z '*.py' | xargs -0 python3 -m py_compile
pnpm lint && pnpm typecheck
pnpm -C packages/cli exec vitest run
python3 .trellis/scripts/spec.py lint --strict
diff -r --exclude=__pycache__ packages/cli/src/templates/trellis/scripts .trellis/scripts
```

## Risky files

- `common/task_store.py` — archive path; the only change is additive and wrapped so
  derivation can never return non-zero. Re-run `task-archive.integration.test.ts`.
- `templates/trellis/index.ts` — a missing `scripts.set` means `trellis init` ships
  without the script; `init.integration.test.ts` must list the four new files.
- `.trellis/scripts/**` parity — any edit in one tree without the mirror fails
  `regression.test.ts`.

## Follow-ups before `task.py start`

- `implement.jsonl` / `check.jsonl` curated (spec entries, no code paths).
- User has approved the final planning summary.

## Phase 3.3 note (after implementation)

Add `.trellis/spec/cli/backend/spec-lint.md` (code-spec: CLI contract, frontmatter
grammar, rule table, task.json fields, error matrix) and an index row + a
Pre-Development Checklist entry for `spec.py` / `common/spec_*.py` edits.
