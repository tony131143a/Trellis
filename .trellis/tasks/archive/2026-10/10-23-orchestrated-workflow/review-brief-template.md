REPORT-ONLY review. Do NOT modify, create, or delete any file except the single output JSON named below. No git write operations. Scratch experiments only under $TMPDIR (copy what you need there).

Repo under review: the git worktree __WT__ (branch feat/orchestrated-workflow), uncommitted working-tree changes vs HEAD: run `git -C __WT__ diff HEAD -- __PATHS__` and `git -C __WT__ status --porcelain`.
Task: __TASK__ (read prd.md there; parent design __M__/.trellis/tasks/10-23-orchestrated-workflow/design.md §2; research __M__/.trellis/tasks/10-23-orchestrated-workflow/research/tests-specs-channel.md).
Dimension: __DIM__
- correctness: real defects in the changed behavior — races, missed paths, duplicate/missing events, backward-compat breaks, wrong fallbacks. Reproduce with a concrete scenario when possible (you may run vitest from __WT__/packages/cli).
- tests: do the new/changed tests actually prove each acceptance criterion in prd.md; would they fail on the old code; flakiness (timers, real processes, fs races); missing required cases.

Rules: only report defects introduced or left unfixed by this change that matter for the PRD; no style nits. Every finding needs a concrete failure_scenario (inputs/state → wrong result). Order by severity.

Output: write JSON to __OUT__ :
{"dimension": "__DIM__", "findings": [{"id": "__ID__-1", "file": "...", "line": 0, "severity": "high|med|low", "summary": "...", "failure_scenario": "...", "evidence": "how you confirmed it (command/output or code reasoning)"}]}
An empty findings list is a valid result. Final message: one line per finding (id, severity, summary) or "no findings".
