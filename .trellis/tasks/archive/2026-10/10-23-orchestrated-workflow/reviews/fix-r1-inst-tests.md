Fix round 1a for orch-install — tests only (same scope and rules as before). A separate correctness review of your implementation is still running; its findings come in a later message, so do not refactor the implementation now.

All six findings in /Users/xktang/person-resources/project/my/Trellis/.trellis/tasks/10-23-orchestrated-workflow/reviews/r1-inst-tests.json are confirmed (each has a mutation that stays green). Add the missing assertions/cases:
- tests-1: switching away keeps a user-modified engine file / card (hash mismatch), lists it, and deletes the pristine ones.
- tests-2: after stripping, the pre-existing Trellis hook entries in settings.json are still present (assert the exact remaining entries).
- tests-3: D4 leaves a non-6 value (e.g. 4 and 32) untouched on select, and update's preserveExistingWorkerGuardConfig keeps a non-default value.
- tests-4: assert the PreToolUse matcher string exactly.
- tests-5: AC5 — assert settings.json bytes (and the installed file set) for a non-orchestrated init against the pre-change expectation (e.g. the default Claude settings template rendered without any orchestrator entries), not just "no substring".
- tests-6: Claude Code not configured → install succeeds and prints the constraint-layer notice (assert the message).
For each, confirm it fails against the corresponding mutation (scratch copy under $TMPDIR) and passes on the real code. Report ≤12 lines.
