Active task: /Users/xktang/person-resources/project/my/Trellis/.trellis/tasks/10-23-orch-spec-docs

Workspace rules (important):
- Your cwd is the git worktree /Users/xktang/person-resources/project/my/Trellis.worktrees/orchestrated-workflow (branch feat/orchestrated-workflow). Edit ONLY inside it, within your scope. Never edit files under /Users/xktang/person-resources/project/my/Trellis.
- Task artifacts: /Users/xktang/person-resources/project/my/Trellis/.trellis/tasks/10-23-orch-spec-docs/{implement.jsonl,prd.md}; parent /Users/xktang/person-resources/project/my/Trellis/.trellis/tasks/10-23-orchestrated-workflow/{prd.md,design.md}. In implement.jsonl, .trellis/tasks/ paths resolve against /Users/xktang/person-resources/project/my/Trellis; .trellis/spec/ paths resolve against your cwd.
- Scope: .trellis/spec/** in the worktree (new orchestration-contract.md, workflow-state-contract.md, commands-workflow.md, commands-update.md, index.md), packages/cli/src/templates/common/bundled-skills/** reference docs named in the PRD, and dogfood copies under .claude/skills/ only if the repo keeps them in sync (check first). Never edit code (packages/cli/src/**/*.ts, *.py) or tests.
- Engine status: the engine files under packages/cli/src/templates/trellis/orchestrator/ are being finished by another worker right now (core: ledger/channel/gitops/plancheck/render/session). Install (src/utils/orchestrator-assets.ts, workflow.ts, init.ts, update.ts, template-hash.ts, workflow-resolver.ts) and assets (workflow-orchestrated.md, conductor.md, briefs, cards) are final.
- No git write operations. Do not run the root `pnpm build`.

Order: do PRD requirements 2, 3, 4 first (they describe final code). Then draft requirement 1 (orchestration contract) from the spark contract and the worktree engine; mark any anchor into core-owned engine files you could not confirm as final with a trailing `<!-- verify -->` comment. You will get a follow-up turn to re-verify those anchors after the engine lands.

Validation: any doc/spec tests (grep packages/cli/test for tests reading these files, e.g. bundled skill or spec-lint tests) pass; `pnpm --filter @mindfoldhq/trellis typecheck` unaffected.

Report (≤25 lines): files changed with line ranges, each PRD requirement → where, the list of `<!-- verify -->` anchors.
