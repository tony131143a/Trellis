---
sources:
  - packages/cli/test/commands/update.integration.test.ts
  - packages/cli/test/commands/init.integration.test.ts
  - packages/cli/src/utils/file-writer.ts
  - packages/cli/src/configurators/index.ts
last_verified: 2026-11-13
---
# Mock Strategies

> Principles and patterns for mocking in tests.

---

## Core Principle: Minimal Mocking

Only mock **external dependencies** that are:
1. Non-deterministic (network, time, random)
2. Interactive (TTY prompts)
3. Side-effectful (child processes, file system writes to system paths)

**Never mock internal modules** — let real code execute through the full path.

---

## Standard Mock Set

For command-level integration tests, this is the minimal set:

| Dependency | Why Mock | How | Used In |
|------------|----------|-----|---------|
| `figlet` | ASCII banner, not testable output | `vi.mock("figlet")` | init, update |
| `inquirer` | Interactive prompts, no TTY in CI | `vi.mock("inquirer")` | init, update |
| `node:child_process` | Git config, Python script calls | `vi.mock("node:child_process")` | init, update |
| `process.cwd()` | Redirect to temp directory | `vi.spyOn(process, "cwd")` | init, update |
| `console.log/error` | Silence output | `vi.spyOn(console, "log")` | init, update |

---

## Mock Patterns

### Module Mock (hoisted)

```typescript
// Placed at top of file — vitest hoists vi.mock calls
vi.mock("figlet", () => ({
  default: { textSync: vi.fn(() => "ARBOR") },
}));

vi.mock("inquirer", () => ({
  default: { prompt: vi.fn().mockResolvedValue({ proceed: true }) },
}));

vi.mock("node:child_process", () => ({
  execSync: vi.fn().mockReturnValue(""),
}));
```

### Spy (partial mock)

```typescript
// In beforeEach
vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
vi.spyOn(console, "log").mockImplementation(noop);

// In afterEach
vi.restoreAllMocks(); // Restores all spies
```

---

## inquirer Mock: init vs update

The two commands have different inquirer skip conditions:

**init**: `--yes` flag skips all inquirer prompts. Mock can return empty `{}`.

```typescript
vi.mock("inquirer", () => ({
  default: { prompt: vi.fn().mockResolvedValue({}) },
}));
```

**update**: `--dryRun` returns before confirm prompt. Batch-resolution modes
(`force`, `skipAll`, `createNew`) must not hit the final confirm prompt either.
Plain interactive update paths and `migrate` without a batch flag may still
prompt, so the default mock should return `{ proceed: true }`.

```typescript
vi.mock("inquirer", () => ({
  default: { prompt: vi.fn().mockResolvedValue({ proceed: true }) },
}));
```

When testing a non-interactive batch path, clear the mock after setup and assert
it was not called:

```typescript
vi.mocked(inquirer.prompt).mockClear();
await update({ force: true });
expect(inquirer.prompt).not.toHaveBeenCalled();
```

---

## Things NOT to Mock

| What | Why |
|------|-----|
| `fs` (node:fs) | Tests run against real temp directories |
| `path` (node:path) | Pure computation, deterministic |
| Internal modules (`configurators/`, `utils/`, `templates/`) | Let real code execute |
| `chalk` | Auto-detects no TTY and disables colors |

---

## Known Gotchas

### Module-Level State: `setWriteMode`

`file-writer.ts` has module-level state for write mode. If one test sets `force` mode, subsequent tests inherit it unless reset. The `init()` function calls `setWriteMode()` internally, so integration tests that call `init()` are safe. But direct unit tests of `writeFile` must manage this state explicitly.

### Template Placeholder Resolution

`collectPlatformTemplates()` must return templates with `{{PYTHON_CMD}}` **already resolved** (matching what `configurePlatform()` writes to disk). The `resolvePlaceholders()` function in `configurators/shared.ts` handles this. Codex's `configure` is derived from its `collectTemplates` (`fromTemplates` in `configurators/index.ts`), so the two cannot disagree; Claude Code spells out both (`configureClaude` / `collectClaudeTemplates`), so a new placeholder must be resolved in both. `test/configurators/platforms.test.ts` ("configurePlatform writes collected templates byte-for-byte for every platform") catches a mismatch.

---

## DO / DON'T

### DO

- Keep mock count minimal (currently 3 module mocks: `figlet`, `inquirer`, `node:child_process`)
- Use `vi.mocked(fn).mockClear()` between tests if asserting call counts
- Match mock return values to real API shapes

### DON'T

- Don't mock internal modules to force specific code paths
- Don't forget `vi.unstubAllGlobals()` when using `vi.stubGlobal`
- Don't assume mock state resets between tests without explicit `mockClear()` or `restoreAllMocks()`
