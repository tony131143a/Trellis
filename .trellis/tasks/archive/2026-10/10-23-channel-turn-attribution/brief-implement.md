Active task: /Users/xktang/person-resources/project/my/Trellis/.trellis/tasks/10-23-channel-turn-attribution

Workspace rules (important):
- Your cwd is the git worktree /Users/xktang/person-resources/project/my/Trellis.worktrees/orchestrated-workflow (branch feat/orchestrated-workflow). Edit code ONLY there, within your scope. The only file you write under /Users/xktang/person-resources/project/my/Trellis is /Users/xktang/person-resources/project/my/Trellis/.trellis/tasks/10-23-channel-turn-attribution/research/stream-turns.md.
- Task artifacts: /Users/xktang/person-resources/project/my/Trellis/.trellis/tasks/10-23-channel-turn-attribution/{implement.jsonl,prd.md}; parent /Users/xktang/person-resources/project/my/Trellis/.trellis/tasks/10-23-orchestrated-workflow/{prd.md,design.md,follow-ups.md (F-1, F-2)}. In implement.jsonl, .trellis/tasks/ paths resolve against /Users/xktang/person-resources/project/my/Trellis; .trellis/spec/ paths resolve against your cwd.
- Scope: packages/cli/src/commands/channel/adapters/claude.ts, packages/cli/src/commands/channel/supervisor/** and supervisor.ts, channel tests under packages/cli/test/commands/ (new files fine), packages/cli/src/templates/trellis/orchestrator/briefs/*.md (requirement 5 only). Other workers are reviewing the engine .py files and editing specs at the same time — never touch packages/cli/src/templates/trellis/orchestrator/*.py, tests under packages/cli/test/python/, or .trellis/spec/**. If you need anything else, stop and report NEEDS_SCOPE: <file> — <why>.
- C-1 (per-turn cold-exit synthesis, createSupervisorRuntime) already landed uncommitted in this worktree: build on it.
- Experiments: use the real `star` CLI (on PATH) in a scratch dir under $TMPDIR with tiny prompts; never point experiments at this repo or any channel under ~/.trellis/channels. You can also read existing raw logs under ~/.trellis/channels/-Users-xktang-person-resources-project-my-Trellis/tw-orch/*.log (read-only; e.g. eng-core.log lines ~566-592 show self-initiated turns).
- No git write operations. Do not run the root `pnpm build`. Before ending your turn, wait for every background command you started to finish.
- git-heavy vitest files may time out under load; rerun with PATH filtered of '.git-ai' before treating a timeout as real.

Task: implement the PRD (requirements 1-5) — research first, then the smallest change that attributes results correctly.

Validation (from /Users/xktang/person-resources/project/my/Trellis.worktrees/orchestrated-workflow/packages/cli): `pnpm typecheck`, `pnpm lint`, `npx vitest run test/commands/channel.test.ts test/commands/channel-supervisor-shutdown.test.ts test/commands/channel-wait-warning.test.ts test/commands/channel-supervisor-idle.test.ts test/templates/orchestrated-assets.test.ts <your new tests>`.

Report (≤25 lines): the signal you chose and why (with the recorded sequences), files changed, each AC → test, validation results.
