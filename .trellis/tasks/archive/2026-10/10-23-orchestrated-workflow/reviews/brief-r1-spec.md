REPORT-ONLY review. Do NOT modify, create, or delete any file except the single output JSON named below. No git write operations. Scratch experiments only under $TMPDIR.

Repo under review: the git worktree /Users/xktang/person-resources/project/my/Trellis.worktrees/orchestrated-workflow (branch feat/orchestrated-workflow). Changed doc: `git -C /Users/xktang/person-resources/project/my/Trellis.worktrees/orchestrated-workflow diff HEAD -- .trellis/spec/cli/backend/commands-channel.md`. The channel code it describes is also changed in this worktree (`git -C /Users/xktang/person-resources/project/my/Trellis.worktrees/orchestrated-workflow diff HEAD -- packages/cli/src/commands/channel`); review against the worktree code, not HEAD.
Task: /Users/xktang/person-resources/project/my/Trellis/.trellis/tasks/10-23-channel-orchestrator-spec/prd.md.
Dimension: accuracy — every behavioral statement and file:line anchor in the changed/added text matches the worktree code; nothing an orchestrator author would rely on is wrong or missing from the PRD's list (send seq / turn_finished.inputSeq, crash detection, resume, per-worker idle TTL, max_live_workers, trusted_context_dirs, agent lookup, last-line JSON, project key). Check anchors by opening the cited lines.

Rules: report only statements that are wrong, misleading, or missing per the PRD; no style nits. Every finding needs a concrete failure_scenario (an orchestrator author follows the text → what goes wrong). Order by severity.

Output: write JSON to /Users/xktang/person-resources/project/my/Trellis/.trellis/tasks/10-23-orchestrated-workflow/reviews/r1-spec.json :
{"dimension": "accuracy", "findings": [{"id": "r1-spec-1", "file": "...", "line": 0, "severity": "high|med|low", "summary": "...", "failure_scenario": "...", "evidence": "code you checked (file:line) and what it actually does"}]}
An empty findings list is a valid result. Final message: one line per finding (id, severity, summary) or "no findings".
