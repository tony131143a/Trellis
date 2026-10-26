Active task: /Users/xktang/person-resources/project/my/Trellis/.trellis/tasks/10-23-channel-idle-ttl-per-worker

Workspace rules (important):
- Your cwd is the git worktree /Users/xktang/person-resources/project/my/Trellis.worktrees/orchestrated-workflow (branch feat/orchestrated-workflow). Edit code ONLY there. Never edit files under /Users/xktang/person-resources/project/my/Trellis except as stated below.
- Task artifacts live in the main checkout: read /Users/xktang/person-resources/project/my/Trellis/.trellis/tasks/10-23-channel-idle-ttl-per-worker/{implement.jsonl,prd.md}. In implement.jsonl, paths starting with .trellis/tasks/ resolve against /Users/xktang/person-resources/project/my/Trellis; .trellis/spec/ paths resolve against your cwd (identical content). Parent design: /Users/xktang/person-resources/project/my/Trellis/.trellis/tasks/10-23-orchestrated-workflow/design.md §2.
- Another worker edits packages/cli/src/commands/channel/supervisor/** and supervisor tests in the same worktree at the same time. Do not touch those.
- Your scope: packages/cli/src/commands/channel/guard.ts, packages/cli/src/commands/channel/store/** only if a read helper is needed, and packages/cli/test/commands/channel-guard.test.ts. If you need anything outside, stop and report NEEDS_SCOPE: <file> — <why>.
- No git commit/merge/stash/reset/checkout. Do not run the root `pnpm build` or root `pnpm typecheck`.
- Validation (run from /Users/xktang/person-resources/project/my/Trellis.worktrees/orchestrated-workflow/packages/cli): `pnpm typecheck`, `pnpm lint`, `npx vitest run test/commands/channel-guard.test.ts test/commands/channel.test.ts`. Baseline before your change: those files pass.

Task: implement the PRD (C-2): idle cleanup judges each candidate by the idleTimeoutMs in its own <channelDir>/<worker>.config, falling back to the caller's TTL when missing/invalid; per-worker 0 = never idle-cleaned; caller TTL 0 keeps disabling the scan. Keep the change minimal and match existing guard.ts style.

Report: files changed (path:line ranges), how each acceptance criterion is met with the test name that proves it, and the exact validation commands with results.
