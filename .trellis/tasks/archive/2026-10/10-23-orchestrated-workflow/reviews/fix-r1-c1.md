Fix round 1 for C-1 (details: /Users/xktang/person-resources/project/my/Trellis/.trellis/tasks/10-23-orchestrated-workflow/reviews/r1-c1-correct.json, /Users/xktang/person-resources/project/my/Trellis/.trellis/tasks/10-23-orchestrated-workflow/reviews/r1-c1-tests.json). Same workspace rules as before. The PRD AC1 was corrected — re-read /Users/xktang/person-resources/project/my/Trellis/.trellis/tasks/10-23-channel-terminal-per-turn/prd.md.

Fix:
- r1-c1-correct-2 / r1-c1-tests-2: when finalizeOnExit synthesizes a cold-exit terminal while a turn is in flight, also append `turn_finished` for that turn (inputSeq, turnId from the turn tracker; outcome "error" for non-zero/signal exit, "done" for exit code 0), mirroring stdout.ts:209-222. The shutdown controller needs read access to the current turn (pass the tracker or a getter; keep the synchronous latch claim before any await). No turn in flight → unchanged behavior.
- r1-c1-tests-1: tests must exercise the real supervisor wiring, not a re-implemented hook. Prefer extracting the TurnTracker hook construction in supervisor.ts into a small exported factory used by both runSupervisor and the test (minimal change), so deleting the reset line in production makes a test fail. Verify that mutation yourself (in a scratch copy under $TMPDIR) and report it.
- r1-c1-tests-3: replace the fixed 25 ms sleep with a deterministic attach (e.g. start the waiter from a known seq / fromStart, or await the watcher-ready signal if one exists).
- Add tests: turn-2 crash → both `error` and `turn_finished` (correct inputSeq/turnId); `wait --kind turn_finished` wakes.

Do not touch: r1-c1-correct-1 (accepted as out of scope: pre-existing interrupt attribution — a late terminal of the aborted turn is popped against the interrupt turn by LIFO finish(); tracked as a follow-up).

Validation as before; report per finding id: fixed — how / test name.
