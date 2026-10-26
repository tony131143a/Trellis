# Channel spec: long-lived orchestrator integration

Parent: `.trellis/tasks/10-23-orchestrated-workflow` (R3 / AC3; design §1). Depends on `10-23-channel-terminal-per-turn` and `10-23-channel-idle-ttl-per-worker` being merged (the spec describes their behavior).

## Goal

`.trellis/spec/cli/backend/commands-channel.md` documents the post-fix runtime behavior and gives orchestrator authors (scripts that drive many long-lived workers) one section with the contract they rely on.

## Requirements

- Update the ShutdownController section (~336-343) for per-turn terminal synthesis (C-1).
- Update the Worker OOM guard section (~563-695) for per-worker idle TTL (C-2).
- New section "Long-lived orchestrator integration", covering: `send` returns the event `seq` and completion is `turn_finished.inputSeq == seq`; crash detection (synthesized terminal events; supervisor pid as defense); `spawn --resume <session-id>` with the same `--cwd`/`--agent` and re-sending the in-flight message; per-worker `--idle-timeout` and project-wide `max_live_workers`; `trusted_context_dirs` for symlinked `.trellis`; agent lookup by name under `<cwd>/.trellis/agents/` only; parse the last stdout line as JSON (update notices share stdout); keep one project key (invoke from the same cwd / `TRELLIS_CHANNEL_PROJECT`).
- Every statement is checked against the code after both fixes land.

## Acceptance Criteria

- [ ] The three sections exist and match the merged code (spot-checked file:line anchors).
- [ ] `.trellis/spec/cli/backend/index.md` still routes channel work to `commands-channel.md`.
