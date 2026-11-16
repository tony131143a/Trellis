---
sources:
  - packages/cli/test/commands/update.integration.test.ts
  - packages/cli/test/commands/init.integration.test.ts
  - packages/cli/src/utils/file-writer.ts
last_verified: 2026-11-16
---
# Mock Strategies

> What may be mocked, and how mock state is kept from leaking.

## Minimal Mocking

- Mock only external dependencies that are non-deterministic (network, time, random), interactive (TTY prompts) or side-effectful (child processes, writes to system paths).
- Never mock internal modules (`configurators/`, `utils/`, `templates/`) to force a code path; let the real code run. Simulate state through the filesystem instead.
- Do not mock `node:fs` or `node:path` (tests run against real temp directories) or `chalk` (it disables colors without a TTY).

## Standard Mock Set

- Command-level tests mock three modules, `figlet`, `inquirer` and `node:child_process`, with hoisted `vi.mock`, and spy on `process.cwd()` (redirected to the temp directory) and `console.log` / `console.error` (silenced). Exemplar: `test/commands/update.integration.test.ts`.
- Mock return values match the real API's shape.
- The default `inquirer` mock answers `{ proceed: true }`, because interactive update paths still prompt. A test of a path that must not prompt clears the mock after setup and asserts `inquirer.prompt` was not called.

## Mock State

- Mock state does not reset between tests on its own: `vi.mocked(fn).mockClear()` before asserting call counts, `vi.restoreAllMocks()` in `afterEach`, `vi.unstubAllGlobals()` after `vi.stubGlobal`.
- Module-level state leaks the same way. `utils/file-writer.ts` keeps the write mode set by `setWriteMode`; `init()` sets it, but a direct unit test of `writeFile` must set it explicitly.
