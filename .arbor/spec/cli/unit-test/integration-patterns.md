---
sources:
  - packages/cli/test/commands/update.integration.test.ts
  - packages/cli/test/commands/init.integration.test.ts
  - packages/cli/test/configurators/platforms.test.ts
  - packages/cli/test/scripts/spec-lint.integration.test.ts
  - packages/cli/test/scripts/driver-helpers.ts
last_verified: 2026-11-13
---
# Integration Test Patterns

> Patterns for function-level integration tests of CLI commands.

---

## Approach: Function-Level Integration (Approach B)

Instead of spawning CLI subprocesses, directly import and call `init()` / `update()` functions in real temp directories. This gives:

- Fast execution (~400ms per test file)
- Reproducible results (no network, no TTY)
- Precise control of external dependencies via mocks
- Full code path coverage from entry to file system output

**Trade-off**: Does not test CLI argument parsing (commander layer).

---

## Standard Test Setup

```typescript
describe("command() integration", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "arbor-test-"));
    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
    vi.spyOn(console, "log").mockImplementation(noop);
    vi.spyOn(console, "error").mockImplementation(noop);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();  // Only needed if vi.stubGlobal was used
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
```

---

## Common Patterns

### Pattern: Setup Project (for update tests)

Update tests need an initialized project as precondition:

```typescript
async function setupProject(): Promise<void> {
  await init({ yes: true, force: true });
}

it("test case", async () => {
  await setupProject();
  // ... modify state ...
  await update({ force: true });
  // ... assert results ...
});
```

### Pattern: Full Snapshot Comparison

For verifying an operation is a true no-op:

```typescript
const snapshotBefore = new Map<string, string>();
const walk = (dir: string) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else snapshotBefore.set(path.relative(tmpDir, full), fs.readFileSync(full, "utf-8"));
  }
};
walk(tmpDir);

await operation();

// Compare: no added, no removed, no changed files
```

### Pattern: Simulate Template Version Change

To test auto-update detection (template changed, user did not modify):

```typescript
// 1. Write "old content" to a template file
const oldContent = "# Old version\n";
fs.writeFileSync(targetFull, oldContent);

// 2. Update hash file to match old content (so update thinks user didn't modify it)
const hashes = JSON.parse(fs.readFileSync(hashFile, "utf-8"));
hashes[targetRelative] = computeHash(oldContent);
fs.writeFileSync(hashFile, JSON.stringify(hashes, null, 2));

// 3. Run update — should auto-update to current template
await update({ force: true });
expect(fs.readFileSync(targetFull, "utf-8")).toBe(currentTemplateContent);
```

### Pattern: Downgrade Protection

```typescript
// Set project version to future
fs.writeFileSync(versionPath, "99.99.99");

await update({});

// Version should NOT be changed — update refused to downgrade
expect(fs.readFileSync(versionPath, "utf-8")).toBe("99.99.99");
```

---

## Python Script Tests (`test/scripts/`)

The shipped Python scripts are tested by spawning them, not by importing:

- Each suite is wrapped in `describe.skipIf(!hasPython())(...)`; `hasPython()`
  runs `python3 --version` and the suite is skipped when it fails.
- The test builds a temp git repository, copies or writes the scripts and
  `.arbor/` fixtures into it, and runs the script with `spawnSync` /
  `execFileSync`, asserting on exit status, stdout/stderr and the files left
  behind (`spec-lint.integration.test.ts`: `runSpec(tmp, "lint", "--json")`).
- Driver tests (`arbor1-*.integration.test.ts`) share `driver-helpers.ts`
  (`symlinked-workflow-dir` uses only its `hasPython` / `TEMPLATE_SCRIPTS`):
  `setupProject()` copies
  `src/templates/arbor/scripts` into a control repository, and `fakeOrca()`
  writes a fake Orca CLI (`fake_orca.py`) plus the `executors:` config that
  points at it. The fake answers with recorded Orca shapes, keeps worker state
  under `<tmp>/orca/`, and never runs an agent; helpers play the workers. The
  real Orca CLI must never be called from tests.

---

## Test Matrix Design

Integration test scenarios should be organized as a numbered matrix (as in `test/commands/update.integration.test.ts`):

| # | Scenario | Options | Verification |
|---|----------|---------|--------------|
| 1 | No-op (same version) | `{}` | Zero file changes, no backup |
| 2 | Dry run | `{ dryRun: true }` | No file modifications |
| 3 | User-deleted file (with stored hash) | `{ force: true }` | File is not re-added |
| ... | | | |

Each test is numbered (`#1`, `#2`, ...) matching the matrix for traceability.

---

## Discovered Bugs (via integration tests)

Integration tests are effective at finding **cross-module inconsistencies**:

1. **Template placeholder roundtrip**: `init` resolves `{{PYTHON_CMD}}` → `python3`, but `update` compared against raw `{{PYTHON_CMD}}`. Every update detected false changes.

2. **Template list mismatch**: `update` listed files not created by `init`, causing phantom "new file" detections on same-version update.

Both bugs were invisible to unit tests (which test modules in isolation) but immediately surfaced when testing the full init→update flow. `test/configurators/platforms.test.ts` now pins the first class directly ("configurePlatform writes collected templates byte-for-byte for every platform"), and update scenario `#1` (same-version no-op) pins the second.

---

## DO / DON'T

### DO

- Use real file system operations (no mocking fs)
- Test the full flow: entry function → file system output
- Verify both positive outcomes (file created) and negative outcomes (file not changed)
- Clean up temp directories after every test

### DON'T

- Don't mock internal modules to simulate template changes — use filesystem manipulation instead
- Don't share temp directories between tests
- Don't depend on specific template content in assertions (use `computeHash` or read from init output)
