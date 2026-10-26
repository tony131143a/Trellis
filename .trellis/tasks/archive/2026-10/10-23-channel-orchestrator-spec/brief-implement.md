Active task: /Users/xktang/person-resources/project/my/Trellis/.trellis/tasks/10-23-channel-orchestrator-spec

Workspace rules (important):
- Your cwd is the git worktree /Users/xktang/person-resources/project/my/Trellis.worktrees/orchestrated-workflow (branch feat/orchestrated-workflow). Edit ONLY inside it, within your scope below. Never edit files under /Users/xktang/person-resources/project/my/Trellis except the report file named below.
- Task artifacts live in the main checkout (/Users/xktang/person-resources/project/my/Trellis/.trellis/tasks/...). In implement.jsonl, paths starting with .trellis/tasks/ resolve against /Users/xktang/person-resources/project/my/Trellis; .trellis/spec/ paths resolve against your cwd.
- Other workers edit other files in the same worktree at the same time. Touch nothing outside your scope; if you need something outside, stop and report NEEDS_SCOPE: <file> — <why>.
- No git write operations (commit/merge/stash/reset/checkout/add). Do not run the root `pnpm build`.
- git-heavy vitest files may time out because of a slow git wrapper on PATH; rerun them with PATH filtered of '.git-ai' before treating a timeout as a real failure.

Read: /Users/xktang/person-resources/project/my/Trellis/.trellis/tasks/10-23-channel-orchestrator-spec/{implement.jsonl,prd.md}; parent /Users/xktang/person-resources/project/my/Trellis/.trellis/tasks/10-23-orchestrated-workflow/{prd.md,design.md §2}.

Scope: .trellis/spec/cli/backend/commands-channel.md in the worktree (and .trellis/spec/cli/backend/index.md only if routing needs a line).

Task: implement the PRD. The two runtime fixes are complete in this worktree (uncommitted; see `git diff -- packages/cli/src/commands/channel`):
- C-1: packages/cli/src/commands/channel/supervisor/shutdown.ts (resetTerminalEmitted, getCurrentTurn, cold-exit synthesis of error/done + turn_finished) and supervisor.ts (createSupervisorRuntime / createSupervisorTurnHooks).
- C-2: packages/cli/src/commands/channel/guard.ts (per-worker idleTimeoutMs from <worker>.config, fallback to the caller TTL).
For the "Long-lived orchestrator integration" section, the reference client is /Users/xktang/person-resources/project/spark-harness/.trellis/orchestrator/channel.py (send seq, turn_finished.inputSeq, pid liveness, resume, last-line JSON). Describe the contract generically; do not mention spark-harness. Every behavioral statement must be checked against the worktree code; cite file:line anchors for the key ones. Keep the spec's existing style and English.

Report (≤25 lines): sections added/changed with line ranges, and each PRD requirement → where it is covered.
