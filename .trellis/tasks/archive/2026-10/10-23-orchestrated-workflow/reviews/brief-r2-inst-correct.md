REPORT-ONLY review. Do NOT modify, create, or delete any file except the single output JSON named below. No git write operations. Scratch experiments only under $TMPDIR.

Repo: worktree /Users/xktang/person-resources/project/my/Trellis.worktrees/orchestrated-workflow. Focus: the round-1b fixes of orch-install described in /Users/xktang/person-resources/project/my/Trellis/.trellis/tasks/10-23-orchestrated-workflow/reviews/fix-r1-inst-correct.md for findings in /Users/xktang/person-resources/project/my/Trellis/.trellis/tasks/10-23-orchestrated-workflow/reviews/r1-inst-correct.json. Changed code: packages/cli/src/utils/template-hash.ts (initializeHashes walk), packages/cli/src/constants/orchestrator.ts (new), packages/cli/src/commands/init.ts (full re-init with/without --workflow on a selected project), packages/cli/src/utils/orchestrator-assets.ts (removeOrchestratorAssets). Use `git -C /Users/xktang/person-resources/project/my/Trellis.worktrees/orchestrated-workflow diff HEAD -- <file>` for tracked files.
Task PRD: /Users/xktang/person-resources/project/my/Trellis/.trellis/tasks/10-23-orch-install/prd.md.

Dimension: correctness of these fixes and their blast radius —
- initializeHashes is used by every init / re-init: can the new orchestrator skip or the "seed from loadHashes even in replace mode" change keep stale hashes for other files, drop hashes that should be rewritten, or change results for projects that never selected orchestrated (AC5)? Check every caller of initializeHashes and its replace/merge modes.
- init.ts: does the new re-init branch change behavior for non-orchestrated projects or for the re-init fast path (handleReinit)? Is the live-orchestration refusal consistent with `trellis workflow`?
- removeOrchestratorAssets: modified files kept but hash dropped — any path where update now treats them as new template files to add, or reports conflicts?
Machine is loaded: run only targeted vitest files; treat 10 s git timeouts as load.

Rules: only defects that matter; concrete failure_scenario (inputs/state → wrong result); order by severity.
Output JSON to /Users/xktang/person-resources/project/my/Trellis/.trellis/tasks/10-23-orchestrated-workflow/reviews/r2-inst-correct.json :
{"dimension": "correctness", "findings": [{"id": "r2-inst-correct-1", "file": "...", "line": 0, "severity": "high|med|low", "summary": "...", "failure_scenario": "...", "evidence": "..."}]}
Empty findings is valid. Final message: one line per finding or "no findings".
