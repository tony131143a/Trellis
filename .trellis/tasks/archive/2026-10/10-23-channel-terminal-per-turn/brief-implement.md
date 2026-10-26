Active task: /Users/xktang/person-resources/project/my/Trellis/.trellis/tasks/10-23-channel-terminal-per-turn

Workspace rules (important):
- Your cwd is the git worktree /Users/xktang/person-resources/project/my/Trellis.worktrees/orchestrated-workflow (branch feat/orchestrated-workflow). Edit code ONLY there. Never edit files under /Users/xktang/person-resources/project/my/Trellis except as stated below.
- Task artifacts live in the main checkout: read /Users/xktang/person-resources/project/my/Trellis/.trellis/tasks/10-23-channel-terminal-per-turn/{implement.jsonl,prd.md}. In implement.jsonl, paths starting with .trellis/tasks/ resolve against /Users/xktang/person-resources/project/my/Trellis; .trellis/spec/ paths resolve against your cwd (identical content). Parent design: /Users/xktang/person-resources/project/my/Trellis/.trellis/tasks/10-23-orchestrated-workflow/design.md §2.
- Another worker edits packages/cli/src/commands/channel/guard.ts and test/commands/channel-guard.test.ts in the same worktree at the same time. Do not touch those two files.
- Your scope: packages/cli/src/commands/channel/supervisor/**, packages/cli/src/commands/channel/supervisor.ts if needed, and channel supervisor tests under packages/cli/test/commands/ (new test files are fine). If you need anything outside, stop and report NEEDS_SCOPE: <file> — <why>.
- No git commit/merge/stash/reset/checkout. Do not run the root `pnpm build` or root `pnpm typecheck`.
- Validation (run from /Users/xktang/person-resources/project/my/Trellis.worktrees/orchestrated-workflow/packages/cli): `pnpm typecheck`, `pnpm lint`, `npx vitest run test/commands/channel.test.ts test/commands/channel-wait-warning.test.ts test/commands/channel-supervisor-idle.test.ts <your new test files>`. Baseline before your change: those existing files pass.

Task: implement the PRD (C-1). Key constraints from the PRD: synthesis keyed on an in-flight turn without a terminal event; no extra event when exiting idle after a completed turn; explicit shutdown still only `killed`; keep the synchronous claim that prevents duplicate synthesis; add the missing "Cold-exit fallback synthesis" and "markTerminalEmitted race" tests required by .trellis/spec/cli/backend/commands-channel.md (Tests Required, ~line 1109).

Report: files changed (path:line ranges), how each acceptance criterion is met with the test name that proves it, and the exact validation commands with results.
