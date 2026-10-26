# Channel: idle cleanup honours each worker's own TTL (C-2)

Parent: `.trellis/tasks/10-23-orchestrated-workflow` (R2 / AC2; design §2). Independent of `10-23-channel-terminal-per-turn`.

## Goal

Spawn-time idle cleanup must judge every live worker against the idle TTL that worker was spawned with, not the TTL of the spawn that triggers the cleanup.

## Current defect

`spawn.ts:180-197` → `enforceSpawnBudget` (`guard.ts:597-601`) passes the new spawn's `policy.idleTimeoutMs` to `cleanupExpiredIdleWorkers` (`guard.ts:508`, eligibility `480-493`), which applies it to every candidate. A worker spawned with `--idle-timeout 3h` is killed by any default-5m spawn after 5 minutes idle.

Each worker's own TTL is already persisted: `<channelDir>/<worker>.config` JSON field `idleTimeoutMs`, written by `spawn.ts:259-283` via `writeSupervisorConfig` (`supervisor.ts:603-614`), path from `workerFile` (`store/paths.ts:117-125`), deleted on exit (`supervisor.ts:561`, `kill.ts:163`).

## Requirements

- `scanLiveWorkers` (`guard.ts:294-381`) or the cleanup step reads each candidate's `.config` `idleTimeoutMs` and uses it for eligibility.
- Missing / unreadable / invalid `.config` → fall back to the caller's TTL (backward compatible).
- A per-worker `idleTimeoutMs` of `0` means that worker is never idle-cleaned; caller TTL `0` still disables cleanup for the scan (existing semantics).

## Acceptance Criteria

- [ ] Worker A with `.config` `idleTimeoutMs` = 3h, idle 10 min; a spawn with a 5m policy does not clean A.
- [ ] Worker B with `.config` 5m (and worker C with no `.config`), idle 10 min → cleaned.
- [ ] Existing `channel-guard.test.ts` cases pass; new cases cover A/B/C and the `0` semantics.
- [ ] `pnpm --filter @mindfoldhq/trellis typecheck`, `lint`, and the channel test files pass.

## Out of scope

Spec text changes (handled by `10-23-channel-orchestrator-spec`).
