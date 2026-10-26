Fix round 3 for C-3 (same scope/rules; you were resumed after a restart and keep your context; scope additionally includes packages/core/src/channel/internal/store/filter.ts and packages/cli/src/commands/channel/{wait,run}.ts with their tests). Before ending your turn, wait for every background command you started.

Findings (/Users/xktang/person-resources/project/my/Trellis/.trellis/tasks/10-23-orchestrated-workflow/reviews/r1-c3-correct.json, r1-c3-tests.json):
- r1-c3-correct-1 → conductor decision overrides your earlier choice: `trellis channel wait` (all --kind forms, including the default kind set) and `run`'s waitForDone must NOT be woken by a `done`/`error` carrying `selfInitiated: true`; the events stay in the log and in `channel messages`. Implement it once on the read side (filter) rather than per command if that is cleaner. Tests: wait --kind done and an unfiltered wait ignore a self terminal and wake on the real one.
- r1-c3-tests-1: replace the AC-3 fixture with the recorded shape from research/stream-turns.md §4 (notification deferred until after the user turn's result) and assert the user turn finishes once and the deferred self turn produces no turn_finished; it must fail on pre-C-3 code.
- r1-c3-tests-2: add the no-echo fail-safe case (a provider that never echoes: result with no preceding replay → exactly one turn_finished).
- r1-c3-tests-3: assert in orchestrated-assets.test.ts that every brief carries the background-command rule (stable substring).
Validation as before plus the core package tests. Report ≤10 lines.
