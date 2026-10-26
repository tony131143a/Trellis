# Channel: do not finish a user turn on a self-initiated provider turn (C-3)

Parent: `.trellis/tasks/10-23-orchestrated-workflow` (follow-up F-2 in the parent `follow-ups.md`, promoted into scope by the user on 2026-10-23). Independent of the other children; the orchestrator spec (`commands-channel.md` "Long-lived orchestrator integration") and `orchestration-contract.md` get a short update afterwards.

## Goal

`turn_finished{inputSeq}` for a channel message is written only when the provider has finished processing **that message**, never because an unrelated provider turn ended.

## Current defect (observed)

Claude-family workers (`claude`, `star`) that run background commands get a self-initiated provider turn when a background task finishes. In the raw stream (`~/.trellis/channels/<project>/<channel>/<worker>.log`) such a turn looks like `system{subtype:"task_notification"}` → `system{subtype:"init"}` → … → `result`. The supervisor treats every adapter `done`/`error` as the terminal of the in-flight user turn (`supervisor/stdout.ts` terminal handling → `turnTracker.finish()`), so:

- a message sent while a self-initiated turn is running gets `turn_finished` when that self turn's `result` arrives (observed: worker `eng-core`, message seq 1139 → `turn_finished` after 20 s from a 37 s self turn; the real work finished 29 min later with no `turn_finished`);
- an orchestrator waiting for `turn_finished.inputSeq == seq` (bundled engine `orchestrator/channel.py:368-375`) proceeds while the worker is still editing.

## Requirements

1. Determine, by experiment with the real `star` CLI (cheap prompts; scratch dir under `$TMPDIR`; run a worker that starts a short background command and receives a message while the notification turn runs), how stream-json marks turn boundaries and origins: `system/task_notification`, `system/init`, and what `--replay-user-messages` echoes and when (supported by both `claude` and `star`). Record the observed sequences in `research/stream-turns.md` of this task.
2. Claude adapter + supervisor attribute each provider `result` to the turn that produced it: a self-initiated provider turn does not finish (or pop) the in-flight user turn. Choose the most reliable signal from the experiment (e.g. `task_notification` before `init` while the provider is idle, or replayed user-message echoes); document why.
3. Self-initiated turn terminals stay visible in the event log but are distinguishable (e.g. a field on the `done`/`error` event such as `selfInitiated: true`), do not produce `turn_finished`, and do not wake `wait --kind turn_finished`. Decide and document whether they still wake `wait --kind done`.
4. Interaction with existing behavior stays correct: C-1 cold-exit synthesis (a crash during a self turn while a user turn is queued/in flight), interrupt/abort (F-1 must not get worse), idle timer pause/reset, `supervisor_warning`, codex adapter unchanged.
5. Interim mitigation (independent of the fix): the orchestrator briefs `implement.md`, `fix.md`, `resolve.md`, `simplify.md`, `finder.md`, `verify.md`, `scan.md`, `gate-fix.md`, `validate-fix.md` under `packages/cli/src/templates/trellis/orchestrator/briefs/` tell the worker to wait for every background command it started to finish before ending its turn. Placeholder sets unchanged (`test/templates/orchestrated-assets.test.ts` snapshot).

## Acceptance Criteria

- [ ] `research/stream-turns.md` shows the recorded raw sequences for: plain user turn; self-initiated notification turn; message arriving during a self turn; notification arriving during a user turn.
- [ ] Test (fixture stream replay through the real adapter + supervisor wiring): message M in flight, a self turn's `result` arrives → no `turn_finished{inputSeq:M}`; M's own `result` → exactly one `turn_finished{inputSeq:M}`.
- [ ] Test: notification arriving mid user turn does not split or end the user turn.
- [ ] Existing channel tests pass (`test/commands/channel*.test.ts`, `channel-supervisor-shutdown.test.ts`).
- [ ] Briefs carry the background-command rule; asset tests pass.
- [ ] `pnpm --filter @mindfoldhq/trellis typecheck`, `lint` clean.

## Out of scope

Codex / other adapters; F-1 (interrupt attribution) beyond not regressing it; spec text (done afterwards by the docs worker).
