---
sources:
  - packages/cli/tsconfig.json
  - packages/cli/eslint.config.js
  - packages/cli/package.json
last_verified: 2026-11-16
---
# Quality Guidelines

> Code quality standards for backend/CLI development.

## TypeScript

`packages/cli/tsconfig.json` sets `strict: true` (ES modules, `module: NodeNext`). Null and undefined are handled explicitly, and no type is implicit.

## ESLint rules

Enforced by `packages/cli/eslint.config.js`; never ignore an ESLint or TypeScript error.

- Forbidden: `any` (`no-explicit-any`), the non-null assertion `x!` (`no-non-null-assertion`), `var` (`no-var`).
- Every function declares its return type (`explicit-function-return-type`); callback expressions and typed function expressions are exempt.
- Defaults use `??`, not `||` (`prefer-nullish-coalescing`): `||` treats `""` and `0` as missing.
- Optional access uses `?.` (`prefer-optional-chain`).
- `const` by default, `let` only when reassigned (`prefer-const`).
- Unused parameters and variables are prefixed with `_` (`no-unused-vars` ignore pattern).

## Types

- Interfaces for structured data (options, return objects); type aliases for unions and computed types.
- Export types explicitly.

## CLI design rules

- **Explicit flags take precedence.** A convenience flag such as `-y` means "skip interactive prompts", not "ignore my other flags": check explicit flags first and apply defaults only when none were given (`init()` and `handleReinit()` in `commands/init.ts`).
- **Batch flags never prompt.** `--force`, `--skip-all`, `--create-new` (or a command-specific `--yes`) are consent for non-interactive execution, so they also bypass the final confirmation; `--dry-run` returns before any mutation or prompt. A later prompt crashes CI and smoke tests when stdin is closed. Exemplar: the `Proceed?` gate in `commands/update.ts`.
- **Data-driven options.** Similar options come from one registry, not repeated if-else: adding a tool is one `AI_TOOLS` entry in `types/ai-tools.ts`, from which `getInitToolChoices()` (`configurators/index.ts`) derives flags, choices and defaults.
- **A fix reaches every entry path.** When a command has several entry paths into the same behaviour (early-return guards, fast paths such as `handleReinit`), list them before claiming a fix; prefer funnelling them into one logic over patching each. Write one test per entry path, using the flag combination that selects it: a convenience flag that bypasses a guard does not cover that path.
- **Unquote exactly one layer.** Remove one pair of matching surrounding quotes; never Python's greedy `str.strip('"')`. Test sanitization with nested and mixed quotes (`"echo 'hello'"`).

## Native dependency policy

- The CLI takes no native dependency by default: a native dep that fails to install fails the entire CLI, not one feature. Install reliability across OS and network conditions matters more than per-call performance. The runtime `dependencies` in `packages/cli/package.json` are pure JS.
- A native dep is justified only when its performance benefit is dramatic and unreplaceable in pure JS or WASM, and shelling out to a system tool is not viable. Prefer, in order: pure JS, a WASM bundle, shelling out to a system CLI, a stable Node built-in.
- If one ships anyway, it goes under `optionalDependencies`, every load site is wrapped in try/catch with a stderr hint, and the soft-degrade path returns useful output rather than throwing. Install is tested on a clean Windows VM without build tools behind a restricted network.

## Quality check

From the repository root:

```bash
pnpm lint
pnpm typecheck
```
