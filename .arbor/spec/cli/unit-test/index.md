---
sources:
  - packages/cli/vitest.config.ts
  - packages/cli/package.json
  - .github/workflows/ci.yml
  - .lintstagedrc
  - .husky/pre-commit
last_verified: 2026-11-16
---
# Unit Test Guidelines

> Testing conventions for `packages/cli`.

## Overview

Tests use Vitest with TypeScript ESM and live in a centralized `test/` directory mirroring `src/`. The goal is fast, reproducible tests with minimal mocking.

## Guidelines Index

| Guide | Description |
|-------|-------------|
| [Conventions](./conventions.md) | Infrastructure, isolation, when to write tests, naming, structure, assertions, anti-patterns |
| [Mock Strategies](./mock-strategies.md) | What to mock, the standard mock set, mock state |
| [Integration Patterns](./integration-patterns.md) | Function-level command tests, matrices, Python script tests |

## CI / Pipeline

- Pre-commit (`.husky/pre-commit`) runs only `lint-staged` (`.lintstagedrc`: `eslint --fix` and `prettier --write` on `packages/cli/src/**/*.ts`). Do not add tests there; a slow hook gets skipped with `--no-verify`.
- CI (`.github/workflows/ci.yml`) is the test gate: it compiles every tracked `.py` with the minimum supported Python, typechecks TypeScript and Python (`basedpyright`), then runs lint, build and the full suite.

## Pre-Development Checklist

1. Read [conventions.md](./conventions.md).
2. Read [mock-strategies.md](./mock-strategies.md).
3. For command-level or Python script tests, read [integration-patterns.md](./integration-patterns.md).

## Quality Check

From `packages/cli`:

```bash
pnpm lint && pnpm typecheck && pnpm test
pnpm test test/commands/init.integration.test.ts   # one file
pnpm test:coverage                                  # coverage report
```

Report any coverage gap you leave, with the reason.
