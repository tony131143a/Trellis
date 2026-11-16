---
sources:
  - packages/cli/test/commands/update.integration.test.ts
  - packages/cli/test/commands/init.integration.test.ts
  - packages/cli/test/configurators/platforms.test.ts
  - packages/cli/test/scripts/driver-helpers.ts
last_verified: 2026-11-16
---
# Integration Test Patterns

> Function-level integration tests of CLI commands and spawned tests of the shipped Python scripts.

## Function-Level Integration

- Command tests import and call `init()` / `update()` in a real temp directory instead of spawning the CLI: fast, no network or TTY, the full path from entry function to filesystem output. The trade-off is that commander argument parsing is not covered.
- An update test builds its precondition by running `init()` (`setupProject()` in `test/commands/update.integration.test.ts`), not by hand-writing project state.
- Template or version changes are simulated through the filesystem (old content plus its `computeHash` in `.template-hashes.json`, a different `.version`), never by mocking internal modules.
- Assertions do not depend on literal template content; use `computeHash` or read what `init` wrote.
- Verify negative outcomes (file not changed, not re-added) as well as positive ones.

## Cross-Module Invariants

Integration tests are where inconsistencies between modules surface, since unit tests see each module in isolation. What `init` writes and what `update` compares must agree: `test/configurators/platforms.test.ts` ("configurePlatform writes collected templates byte-for-byte for every platform") and update scenario `#1` (same-version update is a true no-op) pin it.

## Test Matrix

Scenarios form a numbered matrix (scenario, options, verification), and each test name carries its number (`#1`, `#2`, ...) for traceability, as in `test/commands/update.integration.test.ts`.

## Python Script Tests (`test/scripts/`)

- Shipped Python scripts are tested by spawning them (`spawnSync` / `execFileSync`) in a temp git repository holding the scripts and `.arbor/` fixtures, asserting on exit status, output and the files left behind.
- Each suite is wrapped in `describe.skipIf(!hasPython())`.
- Driver tests share `test/scripts/driver-helpers.ts`; `fakeOrca()` installs a fake Orca CLI that answers with recorded shapes and never runs an agent. The real Orca CLI must never be called from tests.
