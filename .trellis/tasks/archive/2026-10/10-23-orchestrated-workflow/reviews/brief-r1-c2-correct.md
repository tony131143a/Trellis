REPORT-ONLY review. Do NOT modify, create, or delete any file except the single output JSON named below. No git write operations. Scratch experiments only under $TMPDIR (copy what you need there).

Repo under review: the git worktree /Users/xktang/person-resources/project/my/Trellis.worktrees/orchestrated-workflow (branch feat/orchestrated-workflow), uncommitted working-tree changes vs HEAD: run `git -C /Users/xktang/person-resources/project/my/Trellis.worktrees/orchestrated-workflow diff HEAD -- packages/cli/src/commands/channel/guard.ts packages/cli/test/commands/channel-guard.test.ts` and `git -C /Users/xktang/person-resources/project/my/Trellis.worktrees/orchestrated-workflow status --porcelain`.
Task: /Users/xktang/person-resources/project/my/Trellis/.trellis/tasks/10-23-channel-idle-ttl-per-worker (read prd.md there; parent design /Users/xktang/person-resources/project/my/Trellis/.trellis/tasks/10-23-orchestrated-workflow/design.md §2; research /Users/xktang/person-resources/project/my/Trellis/.trellis/tasks/10-23-orchestrated-workflow/research/tests-specs-channel.md).
Dimension: correctness
- correctness: real defects in the changed behavior — races, missed paths, duplicate/missing events, backward-compat breaks, wrong fallbacks. Reproduce with a concrete scenario when possible (you may run vitest from /Users/xktang/person-resources/project/my/Trellis.worktrees/orchestrated-workflow/packages/cli).
- tests: do the new/changed tests actually prove each acceptance criterion in prd.md; would they fail on the old code; flakiness (timers, real processes, fs races); missing required cases.

Rules: only report defects introduced or left unfixed by this change that matter for the PRD; no style nits. Every finding needs a concrete failure_scenario (inputs/state → wrong result). Order by severity.

Output: write JSON to /Users/xktang/person-resources/project/my/Trellis/.trellis/tasks/10-23-orchestrated-workflow/reviews/r1-c2-correct.json :
{"dimension": "correctness", "findings": [{"id": "r1-c2-correct-1", "file": "...", "line": 0, "severity": "high|med|low", "summary": "...", "failure_scenario": "...", "evidence": "how you confirmed it (command/output or code reasoning)"}]}
An empty findings list is a valid result. Final message: one line per finding (id, severity, summary) or "no findings".

Also scrutinize: both scanLiveWorkers branches (event registry and reservation), workers spawned by older CLI versions, and .config written before the reservation (spawn.ts ~259-292).
