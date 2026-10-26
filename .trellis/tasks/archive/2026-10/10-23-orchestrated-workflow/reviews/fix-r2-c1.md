Fix round 2 for C-1 (same worktree, same rules as before: edit only under /Users/xktang/person-resources/project/my/Trellis.worktrees/orchestrated-workflow, no git write operations).

Finding to fix (verified, confirmed): r2-c1-correct-1 — details in /Users/xktang/person-resources/project/my/Trellis/.trellis/tasks/10-23-orchestrated-workflow/reviews/r2-c1-correct.json

Problem: the production wiring in `runSupervisor` (packages/cli/src/commands/channel/supervisor.ts ~292-317: `turnTrackerRef`, `getCurrentTurn: () => turnTrackerRef.current?.current()`, `turnTrackerRef.current = turnTracker`) is not covered by any test. Deleting the `getCurrentTurn` line leaves all 10 tests in channel-supervisor-shutdown.test.ts green, because the test re-builds that wiring locally.

Expected: the wiring that `runSupervisor` actually uses is exercised by a test. Preferred shape (follow the existing `createSupervisorTurnHooks` pattern): extract the controller + tracker construction (with the late-bound getter) into one small exported factory that `runSupervisor` calls, and make the tests build their worker through that factory instead of hand-wiring `turnTrackerRef`. Keep the "controller exists before spawn returns" ordering and the existing comments' intent. If you find a cleaner way that keeps production changes minimal, use it and explain why.

Done when:
- Mutation check: deleting the `getCurrentTurn` wiring (or the `turnTrackerRef.current = turnTracker` assignment) makes at least one test fail; restore afterwards. Report which tests fail for each mutation.
- `pnpm --filter @mindfoldhq/trellis typecheck` and `lint` clean; `npx vitest run test/commands/channel-supervisor-shutdown.test.ts test/commands/channel` (from packages/cli) green.

Report: files changed, the mutation results, and command outcomes. ≤20 lines.
