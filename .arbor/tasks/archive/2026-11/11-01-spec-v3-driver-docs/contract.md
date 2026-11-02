# Spec docs: v3 driver, conductor and executors replace v1 dispatch

## Goal

The backend spec under `.arbor/spec/cli/backend/` still documents the v1 dispatch machinery (`dispatch.py`, `arbor dispatch`, `inject-delegation-context.py`, `codeg-setup`, `prd.md`, dispatch targets). Rewrite those parts so the docs describe what ships today: the `arbor.py` driver (roles run through `executors:` in `.arbor/config.yaml`), the conductor (`arbor.py conduct`, `--as-conductor`, `task.json.conductor`), parent/child commands (`children`, parent `gate`, `run --role review --mode sweep --range`), and `contract.md` as the task artifact. A regression test pins the result so the v1 names cannot creep back.

## Scope

- in: `.arbor/spec/cli/backend/commands-dispatch.md` (rewrite as the `arbor.py` command-surface spec; keep the file name so links stay valid, change the title), `.arbor/spec/cli/backend/dispatch.md` (prompt contract: driver-assembled prompts, header protocol, executors, codeg-mcp as the alternative; drop targets/registry/codeg-setup), `.arbor/spec/cli/backend/platform-integration.md` (shared-hooks list, context-order rows, `inject-delegation-context` paragraphs and the hook table row; describe `guard-builtin-agent.py` denying `Role:`/`Conductor:` prompts and native sub-agent tools instead), `.arbor/spec/cli/backend/workflow-state-contract.md` (replace `dispatch.py`/`prd.md` mentions with the driver and `contract.md`), `.arbor/spec/cli/backend/index.md` (row and routing line for commands-dispatch.md), the frontmatter `sources:` lists of the edited docs (point at the real files: `packages/cli/src/templates/arbor/scripts/arbor.py`, `common/driver/*.py`, `common/dispatch_context.py`, `shared-hooks/guard-builtin-agent.py`), and one new regression test `packages/cli/test/spec/backend-docs.test.ts`.
- out: every other spec doc, `.arbor/workflow.md`, the driver code, the templates under `packages/cli/src/templates/`, `README.md`. No behaviour changes; prose and one test file only. Do not restructure the 7-section layout of the docs; edit in place.

## Acceptance criteria

- AC-1: Given the five docs in scope When they are searched for `dispatch.py`, `arbor dispatch`, `inject-delegation-context`, `codeg-setup`, `codeg-assistants.json`, `dispatch-target` or `prd.md` Then no line matches (the strings may appear only inside a sentence that says they were removed in 0.2.0, on a line that also contains the word `removed`).
- AC-2: Given `commands-dispatch.md` When it is read Then it documents every `arbor.py` subcommand that `python3 .arbor/scripts/arbor.py --help` lists (`next`, `run`, `gate`, `decide`, `canary`, `override`, `status`, `resume`, `abandon`, `prompt`, `bind`, `collect`, `finish`, `conduct`, `children`), the global options `--task`, `--executor`, `--as-conductor`, the exit codes 0/1/2, and the `conduct` options `--brief`, `--collect`, `--cancel`, `--dry-run`.
- AC-3: Given `dispatch.md` When it is read Then its header protocol lists `Active task:`, `Role:`, `Mode:`, `Range:`, `Dispatch:` for roles and `Active task:` + `Conductor:` + `Executor:` + `Run:` for the conductor, and its context order is jsonl entries → `contract.md` → `design.md` → `waves.md` (no `prd.md`, no `implement.md`).
- AC-4: Given `platform-integration.md` When its hook table is read Then it has no `inject-delegation-context.py` row and its `guard-builtin-agent.py` row names both `Role:` and `Conductor:` prompts.
- AC-5: Given the edited docs When `python3 .arbor/scripts/spec.py lint` runs Then it reports no error for any doc in scope (warnings about other docs are allowed), and every `sources:` path in their frontmatter exists in the repository.

## Verification map

| id   | kind   | check                                   | file |
|------|--------|-----------------------------------------|------|
| AC-1 | auto   | `pnpm --dir packages/cli exec vitest run test/spec/backend-docs.test.ts -t AC-1` | packages/cli/test/spec/backend-docs.test.ts |
| AC-2 | auto   | `pnpm --dir packages/cli exec vitest run test/spec/backend-docs.test.ts -t AC-2` | packages/cli/test/spec/backend-docs.test.ts |
| AC-3 | auto   | `pnpm --dir packages/cli exec vitest run test/spec/backend-docs.test.ts -t AC-3` | packages/cli/test/spec/backend-docs.test.ts |
| AC-4 | auto   | `pnpm --dir packages/cli exec vitest run test/spec/backend-docs.test.ts -t AC-4` | packages/cli/test/spec/backend-docs.test.ts |
| AC-5 | auto   | `pnpm --dir packages/cli exec vitest run test/spec/backend-docs.test.ts -t AC-5` | packages/cli/test/spec/backend-docs.test.ts |

## Interface pins

- The test reads the docs from `path.resolve(__dirname, "../../../../.arbor/spec/cli/backend/<doc>.md")` (repo root relative to `packages/cli/test/spec/`); it must not import application code.
- AC-5 runs `python3 .arbor/scripts/spec.py lint` from the repo root with `spawnSync` and parses its stdout lines (`ERROR <rule> <path>:<line> ...`); it checks frontmatter `sources:` paths with `fs.existsSync` against the repo root.
- The vitest test names are exactly `AC-1` … `AC-5` (one `it` per criterion) so `-t AC-n` selects one criterion.
- Frontmatter of every spec doc keeps the existing shape: `---`, `sources:` list, `last_verified: YYYY-MM-DD`, `---`.

## Test paths

- packages/cli/test/spec/**
