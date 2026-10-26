# Baseline: orchestrator engine port (E0)

Recorded 2026-10-23 in the worktree `Trellis.worktrees/orchestrated-workflow`
(branch `feat/orchestrated-workflow`). Engine = ported spark-harness v2, in the
template tree; tests = ported alongside but kept out of the template/package.

Paths:

- Engine: `packages/cli/src/templates/trellis/orchestrator/` (11 modules, `briefs/`, `conductor.md`)
- Tests: `packages/cli/test/python/orchestrator/` (`fakes.py` + 10 `test_*.py`)
- Wrapper: `packages/cli/test/scripts/orchestrator-unittest.test.ts`

## Unittest count

| Where | Interpreter | Result |
|---|---|---|
| spark-harness `/Users/xktang/person-resources/project/spark-harness/.trellis/orchestrator` (`-s tests -t tests`) | python3 3.14.4 | `Ran 436 tests in 142.7s` — **OK** |
| new location (`-s . -t .`) | python3 3.14.4 | `Ran 436 tests in 142.9s` — **OK** |
| new location (`-s . -t .`) | CPython **3.9.6** via `uv run --no-project --python 3.9 --python-preference only-system` | `Ran 436 tests in 137.3s` — **OK** |

Same 436 collected at the new location; no test was dropped or added in E0.
Command: `cd packages/cli/test/python/orchestrator && python3 -m unittest discover -s . -t . -p 'test_*.py'`.

### vitest wrapper

`pnpm --filter @mindfoldhq/trellis exec vitest run test/scripts/orchestrator-unittest.test.ts`

- with python3: **1 passed** (145 s). Per-test timeout raised to 10 min (repo default 10 s).
- without python3 on PATH (node only): **1 skipped** — the `describe.skipIf(!hasPython())`
  guard fires; the file is the only thing collected, so `pnpm test` still goes green.

The wrapper sets `PYTHONPATH=<engine>:<tests>` and strips `TRELLIS_*` session vars; it does
not need them for the suite to pass (each test file resolves the engine dir itself).

## Python 3.9 (`py_compile`)

`uv run --no-project --python 3.9 --python-preference only-system python -m py_compile <22 files>`
(11 engine + 11 test incl. `fakes.py`) → **0 errors**, exit 0. `PYTHONPYCACHEPREFIX` is set to
avoid writing `__pycache__` into the template tree.

## basedpyright (standard, pythonVersion 3.9)

Direct run on the engine dir (`basedpyright --outputjson packages/cli/src/templates/trellis/orchestrator`):

| File | errors | warnings | dominant rules |
|---|---:|---:|---|
| `integration.py` | 79 | 1 | `reportAttributeAccessIssue` ×79 (mixin attrs: `_settings`, `_child`, `git`, `_set_state`, …) |
| `orch.py` | 24 | 0 | `reportReturnType` ×16, `reportUnusedVariable` ×7, `reportArgumentType` ×1 |
| `pipeline.py` | 3 | 0 | `reportArgumentType` ×2, `reportCallIssue` ×1 |
| `guard.py` | 1 | 0 | `reportGeneralTypeIssues` ×1 |
| `plancheck.py` | 0 | 1 | `reportUnusedImport` |
| `channel.py`, `gitops.py`, `inject.py`, `ledger.py`, `render.py`, `session.py` | 0 | 0 | clean |
| **engine total** | **107** | **2** | |

Whole-project `pnpm --filter @mindfoldhq/trellis lint:py` → **111 errors, 70 warnings**.
Only 4 errors are outside the engine and unrelated to this task: `spec_lint.py`
(`.trellis/scripts/common/` and its `templates/trellis/scripts/common/` twin),
pre-existing. So `lint:py` is red today and the engine's 107 errors are the E1 delta.

No `pyrightconfig.json` change was needed: `packages/cli/src/templates/**/*.py` is already in
`include`. The test dir is deliberately **not** added.

## Packaging

- `scripts/copy-templates.js` copies `src/templates/` recursively, excluding only
  `__pycache__`, `.DS_Store`, `*.pyc`, `*.pyo`, `*.ts`. Verified after a copy:
  `dist/templates/trellis/orchestrator/` holds the 11 `.py` + `briefs/` (9 `.md`) + `conductor.md`,
  and **zero** `__pycache__`/`.pyc`. `package.json` ships `files: ["dist", …]`, so the engine
  rides into the npm tarball with no script change.
- `templates/trellis/index.ts` is **not** touched by the engine-port task (install is
  `orch-install`). Note: that worker is concurrently adding `getOrchestratorEngineFiles()`
  (seen in the working tree at `index.ts:129-160`) — install wiring, not this task.

## Wiring changes made in E0 (ecosystem-visible for E1)

1. Every test file + `fakes.py`: engine import path is now
   `ENGINE_DIR = <test dir>/../../../src/templates/trellis/orchestrator` instead of
   `parents[1]` (which pointed at `test/python/` after the move). `GUARD`/`INJECT` come from
   `ENGINE_DIR`; `DefaultMainRootTests` in `test_guard.py`/`test_inject.py` derive `repo_root`
   from `guard.__file__`/`inject.__file__` `parents[2]`, matching the engine's own resolution.
2. `ledger.py`: `ORCH_DIR` is now `Path(__file__).resolve().parent` (was
   `MAIN_ROOT/".trellis"/"orchestrator"`), so `BRIEFS_DIR` resolves both installed and in the
   template source tree. Equivalent at install; **without it the 10 `BriefTemplate` /
   `ValidateFixBrief` tests fail** with `[missing brief template …]`. Core owner must keep this.
3. `test_gitops.py` / `test_ledger.py`: `ignore_cleanup_errors=True` is 3.10+ only and broke the
   3.9 run (10 errors). Replaced by a local `_temp_dir()` helper that keeps the kwarg on 3.10+
   and omits it on 3.9.

## Signals for the E1 split

- Biggest basedpyright chunk is `integration.py`'s 79 mixin-attribute errors — likely needs
  annotated attributes / a declared protocol on the mixins. `orch.py` (24) is next.
- `ledger.ORCH_DIR` is now file-relative; `guard.py`/`inject.py` keep their own
  `MAIN_ROOT/".trellis"/"orchestrator"` (only `guard`/`inject` use theirs, unchanged).
- No new lint/packaging config is required by the port.