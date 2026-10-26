Fix round 1 for the channel spec (same rules: edit only .trellis/spec/cli/backend/commands-channel.md in the worktree; no git write operations).

All three findings in /Users/xktang/person-resources/project/my/Trellis/.trellis/tasks/10-23-orchestrated-workflow/reviews/r1-spec.json are confirmed:
- r1-spec-1: replace the "never supervisor:<worker>" claim with the real author table (adapter / cold-exit synthesized terminals → `<worker>`; startup, post-spawn process error, handshake, stdout-pipeline errors and `killed` → `supervisor:<worker>`), and state what `wait --from <worker>` actually matches for those authors (check wait.ts filtering). Give the orchestrator the recipe that does not hang (e.g. which `--from` / `--kind` combination plus supervisor pid liveness).
- r1-spec-2: fix the writeSupervisorConfig anchor (supervisor.ts:681-691).
- r1-spec-3: say tasks/workspace symlinks are auto-trusted by default (`context-trust.ts:21`, `:138-154`, opt-out `channel.auto_trust_trellis_symlinks: false`); `trusted_context_dirs` is needed for a symlinked `.trellis` itself / other entries. Fix the anchor range.
Re-check every anchor you touch. Report ≤10 lines.
