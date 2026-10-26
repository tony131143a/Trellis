# Smoke run: orchestrated workflow, tracked `.trellis` (AC8)

Date: 2026-10-23. CLI: worktree build of `feat/orchestrated-workflow` (`Trellis.worktrees/orchestrated-workflow/packages/cli/bin/trellis.js`, via `TRELLIS_CLI`). Toy repo: `/tmp/orch-smoke/toy` (Python package `calc` + `tests/`, unittest). Workers: `star` (cards switched from `provider: claude` because the local `claude` CLI is not logged in). Conductor: the main Claude Code session.

## Setup

1. `git init`, toy project committed.
2. `trellis init --workflow orchestrated --claude -u smoke -y` → "Installed 24 orchestrated asset files", "Raised channel.worker_guard.max_live_workers to 16", "Installed Claude Code guard / inject hooks". Verified: `.trellis/orchestrator/` (11 modules, briefs, conductor.md), cards `review-finder` / `review-verify` / `simplify`, three hook entries in `.claude/settings.json` (PreToolUse matcher `Bash|Edit|Write|MultiEdit|NotebookEdit|Agent|Task|mcp__.*`, SessionStart, UserPromptSubmit), `[workflow-state:orchestrating]` block in workflow.md (AC4 install side).
3. Everything committed on `main` (tracked mode: cards and engine must be on the base branch).
4. Parent task `10-23-calc-helpers`; plan with two independent children `add-fn` (owns `calc/a.py`, `tests/test_a.py`) and `mul-fn` (owns `calc/b.py`, `tests/test_b.py`); review dimensions correctness + tests; gates = unittest.

## Runs

| Run | Result | Cause | Engine behavior |
|---|---|---|---|
| 1 | both children `validate_fail` | plan error: `unittest discover -s tests -t .` needs `tests/` to be a package | auto-fix sent to the implement worker twice, then a `validate_fail` decision — correct. `abort` removed worktrees, branches and channels; stage `aborted`, parent status `planning`. |
| 2 | both children `scope` decision | toy repo had no `.gitignore`; validation wrote `__pycache__/*.pyc` | owns check flagged them — correct (accepting would commit `.pyc`). |
| 3 | `ready_to_finish` without decisions, then `finish` | — | full pipeline per child: provisioning → implementing → validating → scope_check → reviewing → (verifying) → approved → checkpoint commit → simplifying (no change) → queued_merge → merged; integration gates passed; `finish` merged `feat/10-23-calc-helpers` into `main` (`merge: merge feat/10-23-calc-helpers (Add arithmetic helpers) into main`), cleaned worktrees / branches / channels, parent status back to `in_progress`. |

Run 3 detail: `add-fn` finder reported 1 test finding, the verifier marked it REJECTED → auto-pass; `mul-fn` finders reported none. Diff `main` vs the pre-orchestration base: only the four owned files (+42 lines), no `.trellis/**` path; 7 tests pass on `main`. Restart between runs followed workflow-orchestrated.md 2.3 (abort → remove `orchestration.json` → `scan` → `plan` → `start`).

## Findings fed back into the engine / docs

- `.trellis/orchestrator/locks/` is created at runtime and appears untracked in tracked mode → move runtime lock/pid state under `.trellis/.runtime/orchestrator/` (already ignored).
- `.worktrees/` appears untracked in the main checkout in tracked mode → `start` adds `/.worktrees/` to `.git/info/exclude`.
- The report printed by `abort` still lists decide/advance `NEXT:` hints for an aborted ledger (pre-existing in spark) → print the restart route instead.
- conductor.md: before `start`, make sure files produced by validate/gate commands are gitignored.
