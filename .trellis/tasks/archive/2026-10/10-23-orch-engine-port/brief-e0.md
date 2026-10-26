Active task: /Users/xktang/person-resources/project/my/Trellis/.trellis/tasks/10-23-orch-engine-port

Workspace rules (important):
- Your cwd is the git worktree /Users/xktang/person-resources/project/my/Trellis.worktrees/orchestrated-workflow (branch feat/orchestrated-workflow). Edit ONLY inside it, within your scope below. Never edit files under /Users/xktang/person-resources/project/my/Trellis except the report file named below.
- Task artifacts live in the main checkout (/Users/xktang/person-resources/project/my/Trellis/.trellis/tasks/...). In implement.jsonl, paths starting with .trellis/tasks/ resolve against /Users/xktang/person-resources/project/my/Trellis; .trellis/spec/ paths resolve against your cwd.
- Other workers edit other files in the same worktree at the same time. Touch nothing outside your scope; if you need something outside, stop and report NEEDS_SCOPE: <file> — <why>.
- No git write operations (commit/merge/stash/reset/checkout/add). Do not run the root `pnpm build`.
- git-heavy vitest files may time out because of a slow git wrapper on PATH; rerun them with PATH filtered of '.git-ai' before treating a timeout as a real failure.

Read: /Users/xktang/person-resources/project/my/Trellis/.trellis/tasks/10-23-orch-engine-port/{implement.jsonl,prd.md}; parent /Users/xktang/person-resources/project/my/Trellis/.trellis/tasks/10-23-orchestrated-workflow/design.md §3-§4.

This turn is phase E0 only (wiring, no behavior change). You will be asked to do E1 (the "core" files) in the next turn, keeping your context.

Scope for E0: the engine .py files and tests already copied into packages/cli/src/templates/trellis/orchestrator/ and packages/cli/test/python/orchestrator/ (import/path wiring only), new packages/cli/test/scripts/orchestrator-unittest.test.ts, packaging/lint config only if required (scripts/copy-templates.js, pyrightconfig / package.json lint:py scope — explain any change), and /Users/xktang/person-resources/project/my/Trellis/.trellis/tasks/10-23-orch-engine-port/research/engine-baseline.md. Do not edit orchestrator/briefs/ or orchestrator/conductor.md (another worker owns them).

Done when:
- `python3 -m unittest discover` over test/python/orchestrator passes from the new location with the same test count as spark (436 expected; report the real number).
- The vitest wrapper passes and skips cleanly without python3.
- Python 3.9: `uv run --python 3.9 python -m py_compile` on all engine + test files, and the unittest suite under 3.9 (uv is at /usr/local/bin/uv) — report results; fix only wiring-level issues now, list the rest.
- engine-baseline.md records: unittest count, basedpyright error count per engine file (`pnpm lint:py` and/or direct basedpyright on the orchestrator dir), 3.9 results, and anything about packaging (does the npm package include orchestrator/ without __pycache__; init still does not install it).
- `pnpm typecheck` and `pnpm lint` clean.

Report (≤20 lines): files changed, the numbers above, and anything that will affect the E1 split.
