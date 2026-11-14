---
sources:
  - packages/cli/tsconfig.json
  - packages/cli/eslint.config.js
  - packages/cli/package.json
  - packages/cli/src/commands/init.ts
  - packages/cli/src/commands/update.ts
  - packages/cli/src/configurators/index.ts
  - packages/cli/src/types/ai-tools.ts
last_verified: 2026-11-13
---
# Quality Guidelines

> Code quality standards for backend/CLI development.

---

## Overview

This project enforces strict TypeScript and ESLint rules to maintain code quality. The configuration prioritizes type safety, explicit declarations, and modern JavaScript patterns.

---

## TypeScript Configuration

### Strict Mode

The project uses `strict: true` in `tsconfig.json`:

```json
{
  "compilerOptions": {
    "strict": true,
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext"
  }
}
```

This enables:
- `strictNullChecks` - Null and undefined must be explicitly handled
- `strictFunctionTypes` - Function parameter types are checked strictly
- `strictPropertyInitialization` - Class properties must be initialized
- `noImplicitAny` - All types must be explicit
- `noImplicitThis` - `this` must have explicit type

---

## ESLint Rules

### Forbidden Patterns

| Rule | Setting | Reason |
|------|---------|--------|
| `@typescript-eslint/no-explicit-any` | `error` | Forces proper typing |
| `@typescript-eslint/no-non-null-assertion` | `error` | Prevents runtime null errors |
| `no-var` | `error` | Use `const` or `let` instead |

### Required Patterns

| Rule | Setting | Description |
|------|---------|-------------|
| `@typescript-eslint/explicit-function-return-type` | `error` | All functions must declare return type |
| `@typescript-eslint/prefer-nullish-coalescing` | `error` | Use `??` instead of `\|\|` for defaults |
| `@typescript-eslint/prefer-optional-chain` | `error` | Use `?.` for optional access |
| `prefer-const` | `error` | Use `const` when variable is not reassigned |

### Exceptions

```javascript
// eslint.config.js
rules: {
  "@typescript-eslint/explicit-function-return-type": [
    "error",
    {
      allowExpressions: true,          // Arrow functions in callbacks OK
      allowTypedFunctionExpressions: true,  // Typed function expressions OK
    },
  ],
  "@typescript-eslint/no-unused-vars": [
    "error",
    {
      argsIgnorePattern: "^_",   // Prefix unused params with _
      varsIgnorePattern: "^_",   // Prefix unused vars with _
    },
  ],
}
```

---

## Code Patterns

### Return Type Declarations

All functions must have explicit return types:

```typescript
// Good: Explicit return type
function detectProjectType(cwd: string): ProjectType {
  // ...
}

async function init(options: InitOptions): Promise<void> {
  // ...
}

// Bad: Missing return type (ESLint error)
function detectProjectType(cwd: string) {
  // ...
}
```

### Nullish Coalescing

Use `??` for default values, not `||`:

```typescript
// Good: Nullish coalescing
const name = options.name ?? "default";
const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
const depNames = Object.keys(allDeps ?? {});

// Bad: Logical OR (treats empty string, 0 as falsy)
const name = options.name || "default";
```

### Optional Chaining

Use `?.` for optional property access:

```typescript
// Good: Optional chaining
const version = config?.version;
const deps = pkg?.dependencies?.["react"];

// Bad: Manual checks
const version = config && config.version;
```

### Const Declarations

Use `const` by default, `let` only when reassignment is needed:

```typescript
// Good: const for non-reassigned
const cwd = process.cwd();
const options: InitOptions = { force: true };

// Good: let for reassigned
let developerName = options.user;
if (!developerName) {
  developerName = detectFromGit();
}

// Bad: let for non-reassigned
let cwd = process.cwd();  // ESLint error: prefer-const
```

### Unused Variables

Prefix unused parameters with underscore:

```typescript
// Good: Prefixed with underscore
function handler(_req: Request, res: Response): void {
  res.send("OK");
}

// Bad: Unused without prefix (ESLint error)
function handler(req: Request, res: Response): void {
  res.send("OK");
}
```

---

## Interface and Type Patterns

### Interface Definitions

Define interfaces for structured data:

```typescript
// Good: Interface for options
interface InitOptions {
  claude?: boolean;
  codex?: boolean;
  yes?: boolean;
  user?: string;
  force?: boolean;
  skipExisting?: boolean;
}

// Good: Interface for return types
interface WriteOptions {
  mode: WriteMode;
}
```

### Type Aliases

Use type aliases for unions and computed types:

```typescript
// Good: Type alias for union
export type AITool = "claude-code" | "codex";
export type WriteMode = "ask" | "force" | "skip" | "append";
export type ProjectType = "frontend" | "backend" | "fullstack" | "unknown";

// Good: Type alias with const assertion
export const DIR_NAMES = {
  WORKFLOW: ".arbor",
  WORKSPACE: "workspace",
} as const;
```

### Export Patterns

Export types explicitly:

```typescript
// Good: Explicit type export
export type { WriteMode, WriteOptions };
export { writeFile, ensureDir };

// Good: Combined export
export type WriteMode = "ask" | "force" | "skip" | "append";
export function setWriteMode(mode: WriteMode): void {
  // ...
}
```

---

## Forbidden Patterns

### Never Use `any`

```typescript
// Bad: Explicit any
function process(data: any): void { }

// Good: Proper typing
function process(data: Record<string, unknown>): void { }
function process<T>(data: T): void { }
```

### Never Use Non-Null Assertion

```typescript
// Bad: Non-null assertion
const name = user!.name;

// Good: Proper null check
const name = user?.name ?? "default";
if (user) {
  const name = user.name;
}
```

### Never Use `var`

```typescript
// Bad: var declaration
var count = 0;

// Good: const or let
const count = 0;
let mutableCount = 0;
```

---

## Quality Checklist

Before committing, ensure:

- [ ] `pnpm lint` passes with no errors
- [ ] `pnpm typecheck` passes with no errors
- [ ] All functions have explicit return types
- [ ] No `any` types in code
- [ ] No non-null assertions (`x!` operator)
- [ ] Using `??` instead of `||` for defaults
- [ ] Using `?.` for optional property access
- [ ] Using `const` by default, `let` only when needed
- [ ] Unused variables prefixed with `_`

---

## Running Quality Checks

```bash
# Run ESLint
pnpm lint

# Run TypeScript type checking
pnpm typecheck

# Run both
pnpm lint && pnpm typecheck
```

---

## CLI Design Patterns

### Explicit Flags Take Precedence

When a CLI has both explicit flags (`--tool`) and convenience flags (`-y`), explicit flags must always win:

```typescript
// Bad: -y overrides explicit flags
if (options.yes) {
  tools = ["claude", "codex"]; // Ignores --claude, --codex!
} else if (options.claude || options.codex) {
  // Build from flags...
}

// Good: Check explicit flags first
const explicitTools = TOOLS.filter((t) => options[t.key as keyof InitOptions]);
if (explicitTools.length > 0) {
  // Build from explicit flags (works with or without -y)
} else if (options.yes) {
  // Default only when no explicit flags
}
```

`init()` and `handleReinit()` in `commands/init.ts` both follow this order.

**Why**: Users specify explicit flags intentionally. The `-y` flag means "skip interactive prompts", not "ignore my other flags".

### Scenario: Non-Interactive Batch Flags Must Not Prompt

#### 1. Scope / Trigger

- Trigger: any command that accepts batch-resolution flags such as `--force`,
  `--skip-all`, `--create-new`, or a command-specific `--yes`.
- Reason: these flags are explicit consent for non-interactive execution. A
  later confirmation prompt can crash CI or smoke tests when stdin is closed.

#### 2. Signatures

- `arbor update --force`
- `arbor update --skip-all`
- `arbor update --create-new`
- `arbor update --force --migrate`
- `update({ force?: boolean, skipAll?: boolean, createNew?: boolean, migrate?: boolean })`

#### 3. Contracts

- `--force`, `--skip-all`, and `--create-new` resolve file conflicts without
  per-file prompts.
- The same flags also bypass the final `Proceed?` confirmation prompt.
- `--migrate` alone may still prompt for modified migration entries and final
  confirmation.
- `--dry-run` must return before any mutation or confirmation prompt.
- A no-op update with batch flags must still complete without touching
  `inquirer.prompt`.

#### 4. Validation & Error Matrix

| Condition | Required behavior |
|-----------|-------------------|
| `update --force --migrate` in non-TTY shell | exits 0 or a domain error; never crashes with readline/inquirer lifecycle errors |
| `update --force` with modified template | overwrites, updates hash, no prompt |
| `update --skip-all` with modified template | preserves file, no prompt |
| `update --create-new` with modified template | writes `.new`, no prompt |
| `update --migrate` without batch flag | may prompt interactively |
| `update --dry-run` | no prompt, no backup, no writes |

#### 5. Good/Base/Bad Cases

- Good: `node dist/cli/index.js update --force --migrate` can run as a smoke
  test with closed stdin and either update files or report already up to date.
- Base: `arbor update --migrate` in a terminal asks the user how to handle
  modified migrated files.
- Bad: `--force` resolves file conflicts but still asks `Proceed?`, then
  crashes in CI with `ERR_USE_AFTER_CLOSE`.

#### 6. Tests Required

- Integration test that clears the `inquirer.prompt` mock after setup and
  asserts `update({ force: true })` does not call it.
- Existing force/skip/create-new tests must continue to assert file outcomes.
- Real CLI smoke test after build:
  `node packages/cli/dist/cli/index.js update --force --migrate`.

#### 7. Wrong vs Correct

##### Wrong

```typescript
if (!options.dryRun) {
  await inquirer.prompt([{ name: "proceed", message: "Proceed?" }]);
}
```

##### Correct

```typescript
const batchMode = options.force || options.skipAll || options.createNew;
if (!options.dryRun && !batchMode) {
  await inquirer.prompt([{ name: "proceed", message: "Proceed?" }]);
}
```

### Data-Driven Configuration

When handling multiple similar options, use arrays with metadata instead of repeated if-else:

```typescript
// Bad: Repetitive if-else
if (options.claude) tools.push("claude");
if (options.codex) tools.push("codex");
// ... repeated logic, easy to miss one

// Good: Data-driven approach — one list derived from the AI_TOOLS registry
// (configurators/index.ts getInitToolChoices())
const TOOLS = [
  { key: "claude", name: "Claude Code", defaultChecked: true },
  { key: "codex", name: "Codex", defaultChecked: false },
];

// Single source of truth for:
// - Building from flags: TOOLS.filter(t => options[t.key])
// - Interactive choices: TOOLS.map(t => ({ name: t.name, value: t.key }))
// - Default values: TOOLS.filter(t => t.defaultChecked)
```

**Benefits**:
- Adding a new tool = adding one `AI_TOOLS` entry in `types/ai-tools.ts`
- Display name, flag key, and default are co-located
- Less code duplication, fewer bugs

---

## String Sanitization Patterns

### Never Use `str.strip()` to Remove Surrounding Quotes

Python's `str.strip(chars)` removes **all matching characters from both ends greedily** — it is NOT "remove one pair of surrounding quotes":

```python
# Bad: Greedy strip eats nested quotes
value = raw.strip('"').strip("'")
# "echo 'hello'" → strip('"') → echo 'hello' → strip("'") → echo  hello
#                                                               ^^^^ BROKEN!

# Good: Remove exactly one layer of matching outer quotes
def _unquote(s: str) -> str:
    if len(s) >= 2 and s[0] == s[-1] and s[0] in ('"', "'"):
        return s[1:-1]
    return s

value = _unquote(raw)
# "echo 'hello'" → echo 'hello'  ✓
```

In TypeScript, the equivalent safe pattern:

```typescript
// Bad: No quote handling at all
const value = match[1].trim();
// "path" → still has quotes

// Good: Regex removes exactly one from each end
const value = match[1].trim().replace(/^['"]|['"]$/g, "");
```

**Why this matters**: When parsed values are passed to `shell=True` (subprocess) or used as file paths, corrupted quotes cause shell injection-style errors or silent path mismatches.

**Rule**: Always test string sanitization with nested/mixed quote inputs: `"it's here"`, `'say "hi"'`, `"echo 'hello'"`.

---

## Routing Fixes: Audit ALL Entry Paths Before Claiming a Fix Is Complete

**Trigger**: Modifying any decision logic in a command that has multiple entry paths into the same downstream behavior — `arbor init` (handleReinit fast-path + main flow), `arbor update` (force vs interactive), or any function with early-return guards above the change point.

**Common mistake**: Patch the dispatch you grepped for, manually verify on one fixture, ship. The other entry path stays broken because (a) it short-circuits before reaching your fix, (b) the manual fixture happened to use a flag combination that bypassed the unfixed path, and (c) the test you wrote also used that convenient bypass flag.

### Scope / Trigger
- Any change inside a function that contains an early-return guard like `if (!isFirstInit && !options.force && !options.skipExisting) { ...; return; }` (the re-init fast path in `init()`) followed by additional logic later.
- Any change to a "create X if conditions hold" branch where another sibling function makes the same kind of decision.
- Bug-fix work where the user reported one specific flag combination — assume there are other combinations that hit the same defect via a different path.

### Audit Contract

Before landing the fix, produce an entry-path inventory:

```bash
# Find every early-return guard / fast path in front of the code you changed
rg -n "handleReinit|reinitDone|return true" packages/cli/src/commands/init.ts
```

For each entry path, record:

| Entry path | Reaches your fix? | Flag combination required to enter it | Flag combination that *bypasses* it |
|------------|-------------------|---------------------------------------|-------------------------------------|
| Path A: `init()` main flow | yes (your fix is here) | `--force` or `--skip-existing` (skips reinit) | (always reachable when entered) |
| Path B: `handleReinit` early return | **no** | none of force / skipExisting / first-init | `--force` or `--skip-existing` |

If any entry path doesn't reach the fix, you have two options:

1. **Extend the fix** so all paths funnel into the same logic (e.g. relax the guard at the early-return so the case you care about falls through to the patched dispatch).
2. **Patch each path individually** — only when funneling is structurally infeasible.

Funneling is preferred: it eliminates the class of bug, not just the instance.

### Tests Required
- **One test per entry path**, asserting the fix's effect using the exact flag combination that selects that path.
- A test that uses a "convenience" flag (`force: true`) to bypass an entry-path guard does NOT cover that entry path — it covers the bypass route. See `cli/unit-test/conventions.md` → "Bug-Fix Tests Must Reproduce the Reported Flag Combination".
- After landing, re-build the CLI and run the user's exact reported command on a fixture. If you can't reproduce the bug pre-fix on that fixture, your repro is wrong, not the fix.

### Why

Multi-entry dispatch is a structural force-multiplier for bugs: every entry path is a separate opportunity for the original defect to manifest, and the cost of missing one is "the user re-files the same issue with slightly different flags." Auditing each entry path takes 5 minutes; missing one costs a release cycle.

---

## Native dependency policy

### Cautionary tale — 0.6.0-beta.3 → 0.6.0-beta.4 emergency revert

An upstream Trellis 0.6.0-beta.3 added `better-sqlite3` (a native C++ binding) to read an AI tool's session storage, which had switched to SQLite. On Windows + China network, the failure cascade was:

1. `prebuild-install` tries to download a prebuilt binary from the GitHub releases CDN.
2. CDN times out (China network reliability for `github.com/.../releases/download/...` is poor).
3. `node-gyp` source-build fallback kicks in.
4. Source build needs Visual Studio 2017+ Build Tools, which most Windows users don't have installed.
5. Install fails — **`arbor` itself can no longer be installed at all**.

Time to detect: ~4 hours after publish. Fix: emergency revert in 0.6.0-beta.4 (removed `better-sqlite3` and degraded the SQLite reader to a soft fallback). Arbor has no session-storage reader, and `packages/cli/package.json` has no native dependency: the runtime `dependencies` (`chalk`, `commander`, `figlet`, `inquirer`, `zod`) are pure JS and there is no `optionalDependencies` block. The policy below is what keeps it that way.

The lesson: **a native dep that fails to install fails the entire CLI**, not just one feature. For a productivity tool, that tradeoff is unacceptable unless the perf benefit is dramatic and unreplaceable.

### Rules

#### 1. Avoid native deps in the arbor CLI by default

Arbor is a productivity / scaffolding tool. Install reliability across all OS / network conditions matters more than per-call perf. The default answer to "should we add this native dep?" is **no**.

#### 2. If absolutely needed, use `optionalDependencies` + soft-degrade

Place the dep under `optionalDependencies` (not `dependencies`) so install never hard-fails on it. Wrap every load site in a try/catch with a clear "feature unavailable" stderr hint:

```typescript
let nativeReader: NativeReader | null = null;
try {
  // Dynamic import keeps install-time failure away from the load barrel
  nativeReader = (await import("better-sqlite3")).default as NativeReader;
} catch {
  process.stderr.write(
    "[arbor] native reader unavailable " +
    "(better-sqlite3 not installed). Falling back to the pure-JS path.\n"
  );
}

if (nativeReader) {
  // Use native path
} else {
  // Soft-degrade: degraded but functional output
}
```

When the native reader is unavailable, the function should return degraded but non-empty output rather than throwing.

#### 3. Test on Windows + restricted network before shipping

Even when a prebuild exists for the target platform, the GitHub releases CDN is unreliable from China and other constrained networks. The node-gyp source-build fallback then requires C compiler tooling that users typically don't have (MSVC on Windows, Xcode CLT on macOS, build-essential on Linux).

Required pre-ship matrix for any native dep:

| Environment | What to verify |
|---|---|
| Windows (clean VM, no VS Build Tools) + China-route network | `pnpm install` succeeds; CLI starts without the feature |
| macOS (clean, no Xcode CLT) | Install succeeds; falls back gracefully |
| Linux (Alpine / minimal Docker) | Install succeeds; musl vs glibc prebuild matches |

#### 4. Decision framework

A native dep is justified only when **both** are true:

- The perf benefit is **dramatic** (orders of magnitude, not 2-3x) AND unreplaceable in pure JS / WASM.
- Shell-out to a system tool (`sqlite3`, `ffmpeg`, etc.) is not viable — usually because the system tool isn't standard across target platforms or per-call dispatch overhead is prohibitive.

If only one is true, pick a non-native alternative.

#### 5. Alternative ladder (in preference order)

| Option | Install risk | Perf | Notes |
|---|---|---|---|
| Pure JS | none | baseline | Always the first choice. Most CLI workloads are I/O-bound, not CPU-bound. |
| WASM bundle | none (one-time bundle size cost ~1-2 MB) | ~1.5-3x slower than native, usually fine | E.g. `sql.js` for SQLite reads. Bundled at build time, no install-time fetch. |
| Shell out to system CLI | low (Windows-PATH / "is it installed" risk) | per-call dispatch overhead | Zero install deps, but introduces "is sqlite3 / ffmpeg on PATH?" branching. Acceptable when the tool is broadly assumed present. |
| `node:sqlite` etc. (Node built-ins) | none | native | Once these graduate from experimental in Node LTS, they become the preferred path. As of Node 22 LTS, `node:sqlite` is still experimental — track upstream. |
| Native dep + `optionalDependencies` + soft-degrade | medium (still fails to install on a non-trivial fraction of Windows users) | native | Last resort. Only when steps 1-4 are ruled out and the soft-degrade path is genuinely usable. |

#### 6. Audit checklist when adding any native dep

Before merging a PR that adds a native dep:

- [ ] Is it under `optionalDependencies` (not `dependencies`)?
- [ ] Is every load site wrapped in try/catch with a stderr hint?
- [ ] Does the soft-degrade path produce useful output, or does it just throw with a different message?
- [ ] Has install been tested on a clean Windows VM without VS Build Tools, behind a China-route proxy?
- [ ] Is the perf benefit measured (not assumed) and dramatic?
- [ ] Has the WASM alternative been benchmarked and rejected with numbers?
- [ ] Does the spec / PR description state which alternative ladder rungs were considered and why each was rejected?

If any answer is "no", the dep doesn't ship.

---

## DO / DON'T

### DO

- Declare explicit return types on all functions
- Use `const` by default
- Use `??` for default values
- Use `?.` for optional access
- Define interfaces for structured data
- Prefix unused parameters with `_`

### DON'T

- Don't use `any` type
- Don't use non-null assertion (`x!` operator)
- Don't use `var`
- Don't use `||` for default values (use `??`)
- Don't leave implicit return types
- Don't ignore ESLint or TypeScript errors
