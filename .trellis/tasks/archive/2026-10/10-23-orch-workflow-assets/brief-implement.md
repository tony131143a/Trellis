Active task: /Users/xktang/person-resources/project/my/Trellis/.trellis/tasks/10-23-orch-workflow-assets

Workspace rules (important):
- Your cwd is the git worktree /Users/xktang/person-resources/project/my/Trellis.worktrees/orchestrated-workflow (branch feat/orchestrated-workflow). Edit ONLY inside it, within your scope below. Never edit files under /Users/xktang/person-resources/project/my/Trellis except the report file named below.
- Task artifacts live in the main checkout (/Users/xktang/person-resources/project/my/Trellis/.trellis/tasks/...). In implement.jsonl, paths starting with .trellis/tasks/ resolve against /Users/xktang/person-resources/project/my/Trellis; .trellis/spec/ paths resolve against your cwd.
- Other workers edit other files in the same worktree at the same time. Touch nothing outside your scope; if you need something outside, stop and report NEEDS_SCOPE: <file> — <why>.
- No git write operations (commit/merge/stash/reset/checkout/add). Do not run the root `pnpm build`.
- git-heavy vitest files may time out because of a slow git wrapper on PATH; rerun them with PATH filtered of '.git-ai' before treating a timeout as a real failure.

Read: /Users/xktang/person-resources/project/my/Trellis/.trellis/tasks/10-23-orch-workflow-assets/{implement.jsonl,prd.md}; parent /Users/xktang/person-resources/project/my/Trellis/.trellis/tasks/10-23-orchestrated-workflow/{prd.md,design.md §5 and §7}.

Scope: exactly the files in the PRD's Files table (packages/cli/src/templates/trellis/workflow-orchestrated.md, orchestrator/conductor.md, orchestrator/briefs/*.md, agents/review-finder.md, agents/review-verify.md, agents/simplify.md, test/templates/orchestrated-assets.test.ts). The engine .py files next to them are being edited by other workers — read them, never edit them.

Before editing any brief, snapshot each brief's `$name` placeholder set; the set must be identical afterwards.

Validation (from /Users/xktang/person-resources/project/my/Trellis.worktrees/orchestrated-workflow/packages/cli): `pnpm typecheck`, `pnpm lint`, `npx vitest run test/templates/trellis.test.ts test/templates/orchestrated-assets.test.ts`, the CJK/spark scan, and `git diff --quiet -- src/templates/trellis/workflow.md src/templates/trellis/agents/check.md src/templates/trellis/agents/implement.md src/templates/trellis/agents/research.md`.

Report (≤25 lines): files and what each now says in one line, placeholder check result, each acceptance criterion → evidence, validation commands with results.
