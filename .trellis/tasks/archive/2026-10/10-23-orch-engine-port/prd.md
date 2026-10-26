# Orchestrator engine: port and generalize

Parent: `.trellis/tasks/10-23-orchestrated-workflow` (R5 / AC7; design §3, §4). Runs in parallel with `10-23-orch-workflow-assets`; `10-23-orch-install` depends on both.

## Goal

The spark-harness orch v2 engine lives in `packages/cli/src/templates/trellis/orchestrator/` with no spark bindings, works whether `.trellis/` is tracked or not, and its unittest suite runs inside `pnpm test`.

## Starting point

Copied verbatim from spark-harness `.trellis/orchestrator/` (v2) into the worktree `/Users/xktang/person-resources/project/my/Trellis.worktrees/orchestrated-workflow`:

- `packages/cli/src/templates/trellis/orchestrator/{channel,gitops,guard,inject,integration,ledger,orch,pipeline,plancheck,render,session}.py`
- `packages/cli/test/python/orchestrator/{fakes,test_*}.py` (436 tests in spark)
- `briefs/` and `conductor.md` are owned by `10-23-orch-workflow-assets` — this task does not edit them and must not change which `$placeholders` the engine passes to each brief.

Spark contract: `/Users/xktang/person-resources/project/spark-harness/.trellis/orchestrator/design.md` §15.

## Phases and ownership

**E0 — wiring (one worker, before E1).** No behavior change.
- Tests import the engine from the template location; `MAIN_ROOT` / `BRIEFS_DIR` resolution keeps working when installed at `<project>/.trellis/orchestrator/`.
- vitest wrapper `packages/cli/test/scripts/orchestrator-unittest.test.ts` runs `python3 -m unittest discover` over `test/python/orchestrator/`; `skipIf` python3 is missing; generous timeout.
- Packaging: `scripts/copy-templates.js` ships the engine (no `__pycache__`); `templates/trellis/index.ts` is not changed (install is `orch-install`).
- Baseline: record basedpyright error counts per file (`pnpm --filter @mindfoldhq/trellis lint:py`) and the unittest count in `research/engine-baseline.md` of this task.

**E1 — generalize (three workers in parallel, disjoint files).**

| Owner | Files |
|---|---|
| core | `ledger.py`, `channel.py`, `gitops.py`, `plancheck.py`, `render.py`, `session.py` + `test_ledger/channel/gitops/plancheck/render/session.py` |
| pipeline | `pipeline.py`, `integration.py`, `orch.py` + `test_pipeline.py`, `test_orch.py`, `fakes.py` |
| hooks | `guard.py`, `inject.py` + `test_guard.py`, `test_inject.py` |

Shared contract (core implements, others call): `ledger.resolve_trellis_cli(env: Mapping[str, str] | None = None) -> list[str]` returns the argv prefix: `TRELLIS_CLI`, then legacy `TRELLIS_BIN` (a value ending in `.js` → `["node", value]`), then `shutil.which("trellis")`, then `shutil.which("tl")`; none found → raise `ledger.TrellisCliNotFound` with an actionable message. `guard.py` stays import-independent of `ledger` (hook start-up cost) and mirrors the same resolution for its whitelist.

## Requirements

1. **Defaults (core, `ledger.py` `DEFAULT_SETTINGS`)**: `quick_gate` / `full_gate` / `integration_setup` = `[]`; English `commit_messages`: `simplify: "refactor: simplify $title"`, `post_merge_fix: "fix: repair post-merge build"`, `gate_fix: "fix: repair integration gate"`, `resolve_merge: "merge: merge $integration_branch into $branch (resolve conflicts)"`, `sync_base: "merge: merge $base_branch into $integration_branch (sync base)"`; `hot_files` = common manifests/lockfiles (`**/go.mod`, `**/go.sum`, `**/package.json`, `**/package-lock.json`, `**/pnpm-lock.yaml`, `**/yarn.lock`, `**/Cargo.toml`, `**/Cargo.lock`, `**/pyproject.toml`, `**/uv.lock`, `**/poetry.lock`). `plan` prints a notice (not an error) when both gates are empty (pipeline). Gates come from plan.json `settings` only (config.yaml is not a gate source — conductor decision 2026-10-23).
2. **CLI resolution**: remove every machine path (`DEFAULT_TRELLIS_BIN`, `ledger.py:33`, `guard.py:41`); `channel.py` invokes via `resolve_trellis_cli()` (core). The guard whitelist for `trellis channel (messages|list)` accepts `trellis`, `tl`, and the `TRELLIS_CLI` / `TRELLIS_BIN` value with or without `node` (hooks).
3. **Budget (pipeline, `orch.py:320/399`)**: effective budget = min(`settings.max_live_workers`, channel budget). Channel budget uses the same precedence as `packages/cli/src/commands/channel/guard.ts:80-95`: env `TRELLIS_CHANNEL_MAX_LIVE_WORKERS` → `.trellis/config.yaml` `channel.worker_guard.max_live_workers` → 6; match that file's meaning of `0`. `plan` prints how many children can run concurrently under the effective budget and, when that is 1, how to raise it.
4. **Card names (pipeline, `pipeline.py:93-96`, `integration.py:32`)**: reviewers dispatch `review-finder`, verifiers `review-verify`, simplify `simplify`, implementers `implement`, scans `research`.
5. **Tracked `.trellis` (design §4)**:
   - core: `gitops` helper detects tracked mode (`git ls-files --error-unmatch .trellis/workflow.md` in the main root); worktree setup creates the `.trellis` symlink only in untracked mode; the engine never commits `.trellis/**` in either mode (keep the stray-`.trellis` reset and `clean -e .trellis`).
   - pipeline: in tracked mode `orch start` fails with a commit hint unless `.trellis/orchestrator/orch.py` and the cards `implement`, `research`, `review-finder`, `review-verify`, `simplify` exist on the base branch (`git cat-file -e <base>:<path>`); the owns/scope check ignores `.trellis/**`.
   - Task artifacts (briefs, review outputs) keep using absolute main-checkout paths.
6. **English**: comments, docstrings and every user-facing string (errors, decision text, `NEXT:` hints) in English; tests updated. No CJK characters remain in engine or tests, except the documented functional alias `## 验收标准` in `orch.py` `ACCEPTANCE_HEADINGS` (and the test that covers it) — conductor decision 2026-10-23.
7. **Python**: 3.9 runtime compatible (`uv run --python 3.9 python -m py_compile …` and the unittest suite under 3.9); basedpyright (standard, 3.9) clean for the engine.
8. Everything else keeps spark v2 behavior (state machine, ledger schema, guard rules, `orchestrating` status writer). No new features.

## Acceptance Criteria

- [ ] Unittest suite green via the vitest wrapper; test count ≥ 436 minus removed spark-only cases, each removal listed in the report.
- [ ] `pnpm --filter @mindfoldhq/trellis lint:py`, `typecheck`, `lint` clean.
- [ ] 3.9 `py_compile` passes for engine and tests; unittest passes under 3.9.
- [ ] `grep -rnE 'spark|agent-evaluation-system|golangci|/Users/'` over engine and tests finds nothing; a CJK scan finds only the documented `ACCEPTANCE_HEADINGS` alias and its test.
- [ ] `templates/trellis/index.ts`, bundled agent cards, `briefs/`, `conductor.md` untouched by this task.

## Out of scope

Install / remove / update wiring (`orch-install`); brief and conductor wording (`orch-workflow-assets`); specs (`orch-spec-docs`).
