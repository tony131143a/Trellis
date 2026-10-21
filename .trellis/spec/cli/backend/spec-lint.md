---
sources:
  - packages/cli/src/templates/trellis/scripts/spec.py
  - packages/cli/src/templates/trellis/scripts/common/spec_*.py
last_verified: 2026-10-21
---
# `spec.py` — Spec Freshness Lint and Change Traceability (Code Spec)

Executable contracts for `.trellis/scripts/spec.py`, `common/spec_meta.py`,
`common/spec_lint.py`, `common/spec_trace.py`, and the `spec_changes` fields that
`task.py archive` writes. Read this before editing any of those files or the
frontmatter of a spec doc.

## 1. Scope / Trigger

| Trigger | Why code-spec depth |
|---------|---------------------|
| New script entry point `spec.py` with three subcommands | New CLI surface shipped to every user project |
| YAML frontmatter on spec docs (`sources`, `last_verified`) | Cross-tool file contract: authors, agents, lint, and `init-meta` all read/write it |
| Two new optional `task.json` fields written at archive | Persistent schema shared by `task.py`, `spec.py lint --provenance`, and future readers |
| Line-level rewrites of user-owned docs (`verify`, `init-meta`) | Filesystem safety: must never re-serialize or change line endings |

The lint is **advisory by design**. Nothing in Trellis gates archive, commit, or
`finish-work` on its result. Do not add such a gate without a product decision.

## 2. Signatures

```text
spec.py lint      [PATH...] [--package NAME] [--json] [--strict] [--provenance]
spec.py verify    PATH...   [--date YYYY-MM-DD]
spec.py init-meta [PATH...] [--dry-run]
task.py add-spec-change <task-dir> <spec-path>
```

```python
# common/spec_meta.py
parse_frontmatter(text: str) -> FrontmatterResult   # meta, block_span, key_lines, item_lines, errors
set_last_verified(text: str, date: str) -> str       # line-level, preserves EOL
build_block(sources: list[str], last_verified: str | None, eol: str = "\n") -> str
extract_markdown_sources(text: str) -> list[str]     # `Sources:` bullets in first 30 lines

# common/spec_trace.py
derive_spec_changes(data: dict, repo_root: Path) -> tuple[list[str], str, str | None]
collect_provenance(repo_root: Path) -> dict[str, list[dict]]
manual_spec_changes(data: dict) -> list[str]

# common/io.py (extended, default unchanged)
write_text_atomic(path: Path, text: str, newline: str | None = None) -> bool
```

## 3. Contracts

### Frontmatter

```markdown
---
sources:
  - packages/cli/src/commands/ablate.ts
  - packages/cli/src/commands/channel/**/*.ts
last_verified: 2026-10-21
---
```

- Block: line 1 is exactly `---`, closed by the next line that is exactly `---`.
- Grammar (hand-written, stdlib only): `key: scalar`, `key:` + `  - item`,
  `key: [a, b]`, blank lines, `#` comments. Anything else is `invalid-metadata`.
  Unknown keys are kept verbatim.
- `sources`: repo-relative POSIX paths or globs (`* ? [ **`), resolved with
  `Path(repo_root).glob`. Absolute paths and `..` segments are `invalid-source`.
- `last_verified`: `YYYY-MM-DD`, a real calendar date.
- Required for layer leaf docs (`spec/<pkg>/<layer>/*.md`, or `spec/<layer>/*.md`
  in single-repo), excluding `index.md`. Optional for `guides/*.md` and every
  `index.md`; when present it is validated and L2 / L4 apply.

### Rules

| Id | Severity | Fires when |
|----|----------|------------|
| `missing-metadata` | warn | required doc has no block, empty `sources`, or no `last_verified` |
| `invalid-metadata` | error | block line outside the grammar, or `last_verified` not a real date |
| `invalid-source` | error | `sources` entry is absolute or contains `..` |
| `dead-source` | error | `sources` entry matches zero files |
| `broken-link` | error | relative `](x.md)` / `](x.md#a)` target missing; skips URLs, `mailto:`, pure `#anchor`, fenced blocks, inline code |
| `stale` | warn | newest `git log -1 --format=%ci` over matched sources is after `last_verified`; mtime fallback without git |
| `placeholder` | info | index row Status `To fill`, or `(To be filled by the team)` / `To fill` in body text |
| `missing-section` | warn | layer `index.md` lacks `## Pre-Development Checklist` or `## Quality Check` |
| `unlisted-doc` | warn | layer leaf doc not linked from its sibling `index.md` |

Findings carry `path:line`; line `0` means the whole file.

### Output

- Text: one line per finding (`SEV  rule  path:line  message`), then
  `spec lint: N docs, E errors, W warnings, I info`. A clean run prints only
  `spec lint: N docs, 0 findings`.
- `--json`: `{"docs", "findings": [{rule, severity, path, line, message, detail}],
  "summary": {errors, warnings, info}}`, plus `"provenance": {path: [{task,
  completedAt, source}]}` with `--provenance`.

### task.json fields

| Field | Type | Written by |
|-------|------|-----------|
| `spec_changes` | `list[str]`, repo-relative POSIX under `.trellis/spec/`, sorted, deduped, deleted paths kept | `task.py archive`, `task.py add-spec-change` |
| `spec_changes_source` | `"none" \| "manual" \| "branch-diff" \| "since-created" \| "mixed"` | same |

- `task.py create` does **not** write either field. Readers use `.get()` and treat
  absence as `[]` / `"none"`.
- `branch-diff`: task `branch` differs from `base_branch`. Tip is `branch` when the
  ref still exists locally, else `HEAD`; `git diff --name-only $(merge-base base tip) tip`.
  When base already contains the tip (branch merged before archive), `merge-base` is
  the tip itself, so the fork point is taken from the oldest merge commit on base whose
  second parent contains the tip: `merge-base <merge>^1 tip`. A fast-forward merge has
  no such commit and still yields `[]`; deleting the branch ref before archive loses the
  tip entirely. Archive before deleting the branch.
- `since-created`: otherwise; `git log --since=<createdAt>` over `.trellis/spec`.
  Approximate on shared branches, which is why the label is stored.
- A derivation that succeeds with no hits still stores its method and `[]`.
  `none` means git could not answer and nothing was added manually.
- `add-spec-change` moves `none → manual` and `branch-diff / since-created → mixed`.

## 4. Validation & Error Matrix

| Condition | Result |
|-----------|--------|
| `lint` finds errors, no `--strict` | exit 0, findings printed |
| `lint --strict` with ≥1 error | exit 1 |
| no `.trellis/spec` directory, unreadable doc | exit 2, stderr names the path |
| `verify` / `init-meta` path not under `.trellis/spec` | exit 2, `spec verify: <path> is not under .trellis/spec` |
| `verify --date 2026-13-40` | exit 2, `--date is not a real date` |
| `verify` on a doc without a block | prepends `sources: []` + `last_verified` |
| `init-meta` on a directory | seeds only required leaf docs that lack a block |
| `archive` with git missing or `merge-base` failing | archive exits 0, yellow warning, `spec_changes_source` = `manual` or `none` |
| `archive` with any exception in derivation | same as above; derivation can never change archive's exit code |
| `add-spec-change` path outside `.trellis/spec/` or missing | exit 1, task.json unchanged |

## 5. Good / Base / Bad Cases

- **Good**: a leaf doc lists two narrow source files, `last_verified` after their
  last commit. Lint prints nothing for it.
- **Base**: a doc with `sources: []`. One `missing-metadata` warning; strict mode
  still exits 0. This is the expected state for docs that describe conventions
  rather than specific files.
- **Bad**: `sources: [packages/cli/src/**]`. Never `dead-source`, but goes `stale`
  on almost every commit, so the warning stops carrying information. Keep
  `sources` to the files the doc actually describes.

## 6. Tests Required

| Test file | Assertion points |
|-----------|------------------|
| `test/scripts/spec-lint.integration.test.ts` | each rule fires exactly once on its fixture with `path:line`; clean tree prints one summary line; `--json` shape; `--strict` exit 1; exit 2 cases; `verify` changes only the date bytes; `init-meta` seeds from a `Sources:` list; CRLF docs survive lint, `verify`, `init-meta` with zero bare `\n` |
| `test/scripts/task-archive-spec-changes.integration.test.ts` | `branch-diff` on a feature branch, after HEAD returns to base, and after the branch was merged into base (base-only spec edits excluded); `since-created` on a shared branch; git removed from PATH → exit 0 + warning + `none`; `manual`; `mixed`; `create` writes neither field |
| `test/regression.test.ts` (existing) | both script trees byte-identical, including the four new files |
| dogfood | `python3 .trellis/scripts/spec.py lint --strict` exits 0 on this repo |

## 7. Wrong vs Correct

### Wrong — detecting line endings after `read_text()`

```python
text = path.read_text(encoding="utf-8")   # universal newlines: \r\n is already \n
eol = "\r\n" if "\r\n" in text else "\n"  # never true
path.write_text(set_last_verified(text, today))  # CRLF doc rewritten as LF
```

Every byte after the first line ending changes, so `verify` produces a whole-file
diff and AC "only the date changes" fails. On Windows the reverse happens: LF docs
become CRLF because `write_text` translates `\n` to `os.linesep`.

### Correct — read and write without newline translation

```python
with open(path, encoding="utf-8", newline="") as fh:   # keeps \r\n
    text = fh.read()
new_text = set_last_verified(text, today)             # inserted lines copy neighbour EOL
write_text_atomic(path, new_text, newline="")         # writes bytes as given
```

Any new code in this module that rewrites a user doc must use this pair.
