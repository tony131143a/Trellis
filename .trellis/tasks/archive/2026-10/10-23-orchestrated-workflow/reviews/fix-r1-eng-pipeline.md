Fix round 1 for orch-engine-port, owner pipeline (same scope/rules as your E1 brief; you were resumed after a restart and keep your context). Before ending your turn, wait for every background command you started.

Confirmed findings (/Users/xktang/person-resources/project/my/Trellis/.trellis/tasks/10-23-orchestrated-workflow/reviews/r1-eng-pipeline.json, r1-eng-tests.json):
- r1-eng-pipeline-1: the worker_guard parser must strip an inline `# comment` and quotes exactly like guard.ts `stripValue` (guard.ts:233-239); test with a commented value.
- r1-eng-pipeline-2: gates come from plan.json settings only (decision). Fix the notice text and the ledger.py comments that claim config.yaml is a gate source (ledger.py is core's file, but core's worker is gone — you may edit those two comment lines in ledger.py only).
- r1-eng-pipeline-3: the concurrency line = min(budget-based count, settings.max_parallel_children); test with a large budget.
- r1-eng-pipeline-4: both budget messages name `TRELLIS_CHANNEL_MAX_LIVE_WORKERS` (highest precedence) alongside config.yaml and settings.
- r1-eng-tests-2: add a test pinning that reviewers/finders (child review, simplify review, integration review) are spawned with agent `review-finder`; prove it fails if the name is reverted.
- r1-eng-tests-1: accepted, no change (the `## 验收标准` alias is a documented exception now in the PRD).
Validation: full unittest suite, basedpyright on your files, 3.9 py_compile. Report ≤10 lines.
