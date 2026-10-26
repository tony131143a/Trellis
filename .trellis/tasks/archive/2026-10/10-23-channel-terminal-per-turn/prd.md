# Channel: synthesize a terminal event when a later turn crashes (C-1)

Parent: `.trellis/tasks/10-23-orchestrated-workflow` (R1 / AC1; design §2). Independent of `10-23-channel-idle-ttl-per-worker`.

## Goal

When a channel worker process dies while a turn is in flight, the supervisor must emit a terminal event for that turn — on every turn, not only the first.

## Current defect

`terminalEmitted` (`packages/cli/src/commands/channel/supervisor/shutdown.ts:95`) is set by every adapter `done`/`error` (`supervisor/stdout.ts:201-203`) and never reset; turns start in `supervisor/inbox.ts:123-132` without a reset. After turn 1, the cold-exit guard at `shutdown.ts:191` skips synthesis, so a crash in turn 2+ emits nothing and `trellis channel wait` only returns on timeout. Side effect: the one-shot pre-timeout `supervisor_warning` (`supervisor/warning.ts:69-75`) never fires after turn 1.

## Requirements

- Synthesis on process exit is keyed on "a turn is in flight and has not emitted its terminal event" (reset at turn begin, or derive from `turnTracker.current()`).
- Exit while idle after a completed turn → no extra event.
- Explicit shutdown (kill / idle-timeout / timeout) still emits only `killed`; no duplicate synthetic event; the existing race protections (flag claimed synchronously before await) are preserved.
- `idle.ts:70-73` behavior unchanged.

## Acceptance Criteria

- [ ] Turn 1 `done`, then the worker process crashes during turn 2 → a synthesized `error` with `by=<worker>` is appended **and** a `turn_finished` for the in-flight turn (its `inputSeq` / `turnId`, `outcome: "error"`; `"done"` for a zero exit code), matching how `stdout.ts` / `inbox.ts` pair every terminal with `turn_finished`; an unfiltered `wait` and `wait --kind turn_finished` both wake. (Review r1: the original wording "`wait --kind done`" was wrong — a crash synthesizes `error`.)
- [ ] Turn 1 `done`, worker exits cleanly while idle → no additional terminal event.
- [ ] Explicit shutdown during a turn → only `killed`.
- [ ] `supervisor_warning` can fire in turn 2+.
- [ ] Tests listed as required in `.trellis/spec/cli/backend/commands-channel.md:1109` ("Cold-exit fallback synthesis", "markTerminalEmitted race") exist and pass.
- [ ] `pnpm --filter @mindfoldhq/trellis typecheck`, `lint`, and the channel test files pass.

## Out of scope

Spec text changes (handled by `10-23-channel-orchestrator-spec`).
