Active task: /Users/xktang/person-resources/project/my/Trellis/.trellis/tasks/10-23-orch-engine-port

Phase E1 of /Users/xktang/person-resources/project/my/Trellis/.trellis/tasks/10-23-orch-engine-port/prd.md (read it again: Phases and ownership, Requirements 1-8, Acceptance Criteria). Three workers run E1 at the same time in the same worktree with disjoint files: core, pipeline, hooks (table in the PRD). Baseline from E0: /Users/xktang/person-resources/project/my/Trellis/.trellis/tasks/10-23-orch-engine-port/research/engine-baseline.md.

Rules for E1:
- Edit only your owner's files from the PRD table. Shared contract: `ledger.resolve_trellis_cli()` / `ledger.TrellisCliNotFound` as defined in the PRD (core implements it first).
- Keep spark v2 behavior except what the PRD requirements change. No new features, no refactors beyond what a requirement needs.
- English everywhere in your files (comments, docstrings, user-facing strings); update your tests to match.
- Your files must end basedpyright-clean (standard, Python 3.9) and py_compile under 3.9 (`uv run --python 3.9 python -m py_compile <files>`).
- Run your own test modules while working; at the end run the whole suite once. Failures in modules owned by another worker: report them, do not fix them.
- Scan your files: `grep -nE 'spark|agent-evaluation-system|golangci|/Users/'` and a CJK scan must be empty.

Your owner: core. Requirements for you: 1 (DEFAULT_SETTINGS only), 2 (resolver + channel.py; do this first so the others can call it), 5 (gitops part), 6, 7, plus test fixtures in your test files.

Report (≤25 lines): per requirement what changed (file:line), test count for your modules and for the full suite, basedpyright and 3.9 results, scan results, any removed test with reason.

Cross-owner decisions (binding): /Users/xktang/person-resources/project/my/Trellis/.trellis/tasks/10-23-orch-engine-port/e1-decisions.md
