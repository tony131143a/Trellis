---
sources:
  - packages/cli/vitest.config.ts
  - packages/cli/test/setup.ts
  - packages/cli/eslint.config.js
last_verified: 2026-11-16
---
# Test Conventions

> File naming, structure, isolation, and what is worth testing.

## Test Infrastructure

- Tests run under Vitest as ESM, configured in `packages/cli/vitest.config.ts`; `pnpm lint` runs `eslint src/ test/`, so tests are linted too.
- Run `pnpm test:coverage` for coverage numbers; do not maintain a manual coverage table.

## Test Isolation

- `test/setup.ts` (registered as `setupFiles`) runs before any test: it deletes host-session env vars (`CLAUDE_PROJECT_DIR`, `CODEX_THREAD_ID`, ...) so a suite run inside an agent session sees the same environment as CI, and sets `GIT_TRACE2_EVENT=0`.
- `GIT_TRACE2_EVENT` is set to `"0"` rather than deleted: global Trace2 listeners keep writing Git objects after a fixture's command exits and race `rmSync`, and deleting the variable would still inherit the user's global configuration. `test/git-isolation.integration.test.ts` proves the override reaches a Git child process.
- Add a variable to the delete list when a production resolver honors it as a user override, when a script under test writes to the path it names, or when it redirects a script's notion of which repository it is in.
- A test that intentionally exercises an env override sets the variable inside the test and restores it in `afterEach`.

## When to Write Tests

A change with logic branches gets a test; pure data or text does not.

- New standalone function with predictable input and output: unit test.
- Bug fix: regression test in `test/regression.test.ts`.
- Changed init/update end-to-end behavior: integration scenario in `test/commands/init.integration.test.ts` or `test/commands/update.integration.test.ts`.
- New platform: covered by `test/registry-invariants.test.ts`.
- No test for template text or doc content, CLI flag description text, or a new migration manifest (`test/migrations/index.test.ts` checks every manifest).

## File Naming

- Mirror `src/` under `test/`, one test file per source module; regression tests are the exception.
- Suffix `.test.ts` for unit tests, `.integration.test.ts` for integration tests.

## Test Structure

- Each test uses its own temp directory (`fs.mkdtempSync`) and removes it in `afterEach`, together with `vi.restoreAllMocks()`; no temp files outlive a test.
- Tests do not depend on execution order, timers, network or global state.
- Call `vi.unstubAllGlobals()` after any `vi.stubGlobal`.

## Assertion Patterns

- Prefer exact matchers (`toBe`, `toEqual`) over loose ones (`toBeTruthy`, `length > 0`).
- To prove an operation made zero changes, compare a full directory snapshot before and after: no added, removed or changed files.
- Counts on growing data (manifests, scripts, platforms) are derived from the source of truth (filesystem, registry), never hardcoded; a hardcoded count fails on unrelated changes.

## ESLint Compatibility

Tests get the shared presets (`no-explicit-any`, `no-non-null-assertion`, `no-empty-function`); the `src/**/*.ts` override block in `packages/cli/eslint.config.js` does not apply to `test/`. Use a disable comment for an intentional empty function and a cast instead of `!`.

## Test Anti-Patterns

A test verifies meaningful behavior, not what TypeScript, the runtime or the implementation already restates. Before writing one, ask:

1. Does TypeScript already guarantee this (`typeof`, `Array.isArray`, property existence)? Skip it.
2. Is it a trivial passthrough (a getter returning a registry entry)? Test the consumer's behavior instead.
3. Is it already tested elsewhere? Each invariant has one canonical file: registry consistency in `test/registry-invariants.test.ts`, derived helpers in `test/configurators/index.test.ts`.
4. Does it depend on data that grows over time? Use a dynamic count.
5. Does it test behavior or restate the implementation? Only behavior.
6. Does the input actually reach the code path? Mental deletion test: would the assertion fail if the feature were deleted? If not, the input is tautological and gives false confidence.
7. For a bug fix, do the args match the reporter's command? See below.

Assertions that a sibling assertion already implies are merged into one.

### Bug-Fix Tests Must Reproduce the Reported Flag Combination

A bug-fix test calls the command with exactly the flags the reporter used. Convenience flags (`force`, `skipExisting`) that skip prompts also short-circuit reinit, dispatch and interactive guards, so adding one can route the test around the bug: test green is not bug fixed. Each extra flag must be required to reach the reproduction state. The structural side is `cli/backend/quality-guidelines.md` → "CLI design rules".

### Regression Tests Follow Moved Code

When a refactor moves code between files, search `test/regression.test.ts` for the affected files and point the assertions at the new location.

### Helper Setup Functions Are Load-Bearing

A helper that produces fixture state decides which production branch every caller exercises; if production starts discriminating on a property the helper happens to produce, callers silently test another scenario. Before changing such a helper, grep its callers and trace each against the new behavior, and document its load-bearing invariants in a JSDoc comment on the helper.
