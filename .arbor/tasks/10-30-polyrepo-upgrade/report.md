# Verification and delivery

User approved direct implementation and verification for this session because the required codeg MCP tools were unavailable. No delegated role runs or driver gate results are claimed.

## Changes

- `getAllScripts()` now includes the Linear hook and the new execution module. Registry coverage compares the complete installed Python tree with update contents; a same-version upgrade regression verifies pristine legacy hook replacement.
- Independent Git packages require explicit `task.py start --execution package --base-ref <ref> --merge-target <local-branch>`. The source ref resolves to a frozen commit. `--execution control` keeps parent/documentation tasks in control.
- `execution_binding` records repository identity, control/product worktrees, source, target and policy. Driver loads validate binding and worktree registration. Existing started tasks without a binding retain their old execution model.
- Control artifacts and product execution are separated throughout dispatch, MCP prepare/collect, prompt diffs, GATE and partition merging. Product partitions dispatch serially. Content snapshots protect control artifacts and both main checkouts, including pre-existing dirty files; failed product validation preserves evidence.
- Finish records product merge evidence in control, then requires a control merge. Both local merges require --no-ff; product identity, tip and cleanliness are checked before cleanup. Archive uses control metadata for pointers/spec changes.
- Formal update applied to Trellis dogfood and worklog; all Python scripts match source exactly. Existing customized config/hooks were preserved. Worklog's 499 existing config/task/spec/journal files were unchanged by hash comparison.

## Verification

- 14 relevant Vitest suites: 192 tests passed, including new real-Git polyrepo and same-version update tests.
- Build, ESLint, TypeScript checking and git diff --check passed.
- Basedpyright baseline and current tree both report 28 errors; no new diagnostic messages. Compared HEAD archive with working tree, not inferred from a failing run.
- All four worklog git:true package paths resolve to independent Git repositories.
- Tests run with isolated Git global/system config and C locale. Host git-ai trace processing otherwise writes asynchronous notes during temporary repository cleanup.

## Boundaries

- No product changes, real product task starts, merges, pushes or publication.
- Product tasks use the explicit local two-merge finish flow; automatic PR creation is not implemented for product tasks.
- Product partition dispatches are serialized. Startup failures preserve journals/worktrees for inspection; generalized automatic recovery is not implemented.
- Manifests retain control-relative semantics; contract code/test paths are product-relative. This does not implement the broader namespaced manifest/source-refresh API proposed in the worklog research.
- The package remains at development version 0.2.0; same-version template updates are supported and tested.

## Worklog upstream follow-up (2026-10-30)

- Reproduced both worklog defects against the current templates: an empty product GATE advanced to REVIEW, and CONTRACT violation cleanup removed unattributed files.
- Product GATE now records GATE-EMPTY as a failure; CONTRACT violations retain files and commits for inspection. Source templates, dogfood scripts, workflow guidance and template hashes are synchronized.
- Added empty-product, command-only pass/fail and legacy-control GATE regressions; updated CONTRACT preservation assertions. Before the fix, exactly two assertions failed in the targeted suites; after the fix all 16 passed.
- Broader verification: 15 Vitest suites / 531 tests passed, plus 14 worklog PolyrepoTest checks loaded against the actual upstream scripts. Build, ESLint, TypeScript, script-tree parity and git diff --check passed.
