---
sources:
  - packages/cli/src/commands/init.ts
  - packages/cli/src/cli/index.ts
last_verified: 2026-11-16
---
# Logging Guidelines

> How console output is done in this CLI project.

This is a user-facing CLI: output goes through `console.log()` / `console.error()` coloured with `chalk`, not a structured logging library. Never use raw ANSI escape codes.

## Colour conventions

| Colour | Usage |
|--------|-------|
| `chalk.cyan()` | Headers, banners, section titles |
| `chalk.blue()` | Action in progress, step indicators |
| `chalk.green()` | Success messages |
| `chalk.yellow()` | Warnings, skipped items, retry hints |
| `chalk.red()` | Errors, conflicts, destructive actions |
| `chalk.gray()` | Secondary info, hints, paths |
| `chalk.white()` | Highlighted inline values |

Do not mix colour meanings (for example red for a non-error).

## Rules

- Errors go to `console.error()`, never `console.log()`.
- Emojis mark steps for visual scanning; use them sparingly.
- Indentation shows hierarchy: sub-steps under a step are indented (`   ↳ ...`), and blank lines separate sections.
- Debug output appears only when `DEBUG` or `ARBOR_DEBUG` is set.
- Do not log sensitive information.
