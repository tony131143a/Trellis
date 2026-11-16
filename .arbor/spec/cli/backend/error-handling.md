---
sources:
  - packages/cli/src/cli/index.ts
  - packages/cli/src/commands/init.ts
last_verified: 2026-11-16
---
# Error Handling

> How errors are handled in this CLI project.

Errors bubble up to the command handler, which shows a user-friendly message and exits with a code scripts can rely on.

## Rules

- Every command action in `cli/index.ts` is wrapped in one top-level try/catch: it prints `chalk.red("Error:")` with the message, prints the stack trace only when `DEBUG` or `ARBOR_DEBUG` is set, and calls `process.exit(1)`.
- Utility functions do not catch errors unless they can handle them meaningfully. Do not catch and re-throw a new error that drops the original.
- A caught `error` is `unknown`: read it with `error instanceof Error ? error.message : error`, never `error.message` directly.
- Any error exits with code 1; never exit 0 on an error condition.
- An optional operation may fail silently (for example `git config user.name`), but an empty `catch` carries a comment saying why it is safe to ignore.
- An operation that fails without stopping the command degrades with a yellow warning and the manual command to run instead (developer initialization in `handleReinit`, `commands/init.ts`).
- Functions that check conditions signal through a returned result object or boolean rather than throwing (`checkPackageJson` in `utils/project-detector.ts`).
