Active task: /Users/xktang/person-resources/project/my/Trellis/.trellis/tasks/10-23-orch-install

Workspace rules (important):
- Your cwd is the git worktree /Users/xktang/person-resources/project/my/Trellis.worktrees/orchestrated-workflow (branch feat/orchestrated-workflow). Edit ONLY inside it. Never edit files under /Users/xktang/person-resources/project/my/Trellis.
- Task artifacts live in the main checkout: read /Users/xktang/person-resources/project/my/Trellis/.trellis/tasks/10-23-orch-install/{implement.jsonl,prd.md}; parent /Users/xktang/person-resources/project/my/Trellis/.trellis/tasks/10-23-orchestrated-workflow/{prd.md,design.md §6 and §8}. In implement.jsonl, .trellis/tasks/ paths resolve against /Users/xktang/person-resources/project/my/Trellis; .trellis/spec/ paths resolve against your cwd.
- Other workers are editing, at the same time and in the same worktree: the engine .py files under packages/cli/src/templates/trellis/orchestrator/ and its tests under packages/cli/test/python/orchestrator/ (three workers), and the assets packages/cli/src/templates/trellis/{workflow-orchestrated.md, orchestrator/conductor.md, orchestrator/briefs/*.md, agents/review-finder.md, agents/review-verify.md, agents/simplify.md}, test/templates/orchestrated-assets.test.ts (one worker). Never edit those. Treat their contents as opaque files to install. workflow-orchestrated.md and the three cards may not exist yet when you start: build the mechanism first and wire the tests that need them last; if they are still missing then, report it instead of creating them.
- Everything else under packages/cli/ (src/utils/workflow-resolver.ts, src/commands/{workflow,init,update}.ts, src/configurators/**, src/templates/trellis/index.ts, src/templates/claude/** if needed, tests) is your scope. Spec files under .trellis/spec are not (orch-spec-docs).
- No git write operations (commit/merge/stash/reset/checkout/add). Do not run the root `pnpm build`.
- git-heavy vitest files may time out because of a slow git wrapper on PATH; rerun them with PATH filtered of '.git-ai' before treating a timeout as a real failure.

Task: implement the PRD. Follow existing patterns (statusLine opt-in, preserveExistingRegistryConfig, scrubHooksJson) rather than inventing new mechanisms; the smallest change that meets each requirement.

Validation (from /Users/xktang/person-resources/project/my/Trellis.worktrees/orchestrated-workflow/packages/cli): `pnpm typecheck`, `pnpm lint`, the test files you touched, and finally `pnpm test` (report any failure with its file and whether it reproduces with native git).

Report (≤30 lines): files changed (path:line ranges), each requirement and acceptance criterion → the test that proves it, validation commands with results.
