# Repair v2 upgrades and central polyrepo execution

## Goal

Restore centrally managed product tasks with explicit control and execution repositories. User authorized direct implementation and verification in this session because codeg MCP is unavailable.

## Scope

- Register every shipped Python script for updates, including the Linear hook.
- Explicit package execution with a frozen source commit and merge target; preserve legacy single-repository tasks.
- Keep task artifacts in the control worktree, route writers, ranges, gates and partitions to the product worktree.
- Validate repository/worktree identity and protect control artifacts during delegation.
- Require separate product and control merge evidence before cleanup/archive.
- Sync verified templates to Trellis and worklog while preserving local configuration and existing tasks.
- No product code changes, product branch merges, pushes or publication.

## Acceptance criteria

- AC-1: Installed pristine Linear hooks update and every shipped Python template is registered.
- AC-2: A package task creates distinct control/product worktrees from the explicitly selected product ref; missing or invalid source fails before mutation.
- AC-3: Writers and GATE run in the product, prompts include control specs and product diffs, artifacts commit in control.
- AC-4: Wrong repository bindings and changes to control artifacts are rejected; failures preserve evidence.
- AC-5: Both merge boundaries are checked before task cleanup; existing single-repository integration tests pass.

## Verification map

| id | kind | check | file |
| --- | --- | --- | --- |
| AC-1 | manual | Template registry and update integration tests | packages/cli/test/templates/arbor.test.ts |
| AC-2 | manual | Real temporary Git repositories | packages/cli/test/scripts/v2-polyrepo.integration.test.ts |
| AC-3 | manual | Product test/implementation/gate/review lifecycle | packages/cli/test/scripts/v2-polyrepo.integration.test.ts |
| AC-4 | manual | Negative binding and control modification cases | packages/cli/test/scripts/v2-polyrepo.integration.test.ts |
| AC-5 | manual | Dual finish and existing v2 regression suites | packages/cli/test/scripts/v2-polyrepo.integration.test.ts |

## Test paths

- packages/cli/test/**
