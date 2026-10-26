Fix round 1 for C-2 (details: /Users/xktang/person-resources/project/my/Trellis/.trellis/tasks/10-23-orchestrated-workflow/reviews/r1-c2-tests.json). Same workspace rules as before.

Fix:
- r1-c2-tests-1: add a test with a truncated / non-JSON `<worker>.config` → caller TTL fallback, no throw out of scanLiveWorkers / enforceSpawnBudget.
- r1-c2-tests-2: add one contract test that writes the sidecar through the production writer (writeSupervisorConfig, or the narrowest exported production path that spawn.ts uses) and then shows a 3h worker idle 10 min is spared by a 5m-policy cleanup. If the writer is not exported, export it minimally (or report NEEDS_SCOPE if that requires touching supervisor.ts — the other worker owns supervisor files; in that case tell me exactly which export you need).

Validation as before; report per finding id: fixed — how / test name.
