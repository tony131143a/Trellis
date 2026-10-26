# Research: Claude/star stream-json turn boundaries and origins (C-3)

Requirement 1 of this task. All sequences are raw `--output-format stream-json`
lines captured from real runs; fields irrelevant to the question
(`uuid`, `session_id`, `timestamp`, `modelUsage`, `usage`, …) are elided as `…`.
Experiments ran in a scratch dir (`$TMPDIR/attr-exp`), never against a real
channel.

## Environment / method

- `star` **1.0.49** (StarFactory) and `claude` **2.1.309** (Claude Code) on
  macOS. Driver: `$TMPDIR/attr-exp/drive.mjs` — spawns the provider as
  `-p --input-format stream-json --output-format stream-json --verbose
  --permission-mode bypassPermissions --dangerously-skip-permissions
  --replay-user-messages`, logs every stdout line with an elapsed-ms prefix,
  and writes scheduled stdin user messages exactly as
  `encodeClaudeUserMessage` does.
- Trigger for a self-initiated turn: the prompt asks the model to run
  `Bash { command: "sleep N; echo BGDONE", run_in_background: true }`.
- **`claude` could not produce full sequences in this environment**: every
  request returns an `assistant` line
  `content:[{type:"text",text:"Not logged in · Please run /login"}]` and a
  `result` with `terminal_reason:"api_error"` (it is not authenticated here —
  `star` uses its own managed key). The one thing that *was* observable
  confirms the shared protocol: `claude` renders the channel echo verbatim as
  `{"type":"user","message":{…},"isReplay":true}` (line 3125 of the recording),
  i.e. identical to `star`. All full sequences below are therefore from `star`;
  the adapter code is shared verbatim between the two (`adapters/index.ts`
  reuses Claude's arg builder, parser and encoders for `star`).

## Finding 1 — `--replay-user-messages` is the origin signal

With the flag, the provider echoes **every input it is about to process** on
stdout as `{"type":"user", …, "isReplay":true}`. Two kinds of echo exist:

| Input | Echoed shape | `systemUserKind` |
|-------|--------------|------------------|
| A channel message we wrote to stdin | `message.content` = `[{type:"text",text:"…"}]` | absent |
| The provider's own background-task notification | `message.content` = `"<task-notification>…"` (a plain string) | `"task-notification"` |

Without the flag neither echo is emitted (verified: a background-task run with
`replay:false` shows only `system{task_notification}` → `system{init}` → `result`
and no `user` line at all). The flag is accepted by both binaries and is now
part of `buildClaudeArgs`.

## Finding 2 — `system{init}` marks *boundaries*, not *origins*

`system{subtype:"init", session_id:…}` appears at the start of **every**
provider turn — session start, channel turn, and self turn alike. It therefore
cannot distinguish a channel turn from a self turn (see sequence 3, where a
fresh `init` precedes both the notification turn and the following channel
turn). The bare `system{subtype:"task_notification"}` event is unreliable on its
own: the provider emits it on the event stream independently of whether a
provider turn is started for it, so keying off it risks misreading a
still-running channel turn as a self turn.

## Sequences (star 1.0.49, `--replay-user-messages`)

### 1. Plain user turn

```
[  3011] >>> STDIN {"type":"user","message":{"role":"user","content":[{"type":"text","text":"Reply with exactly the word PONG and nothing else."}]}}
[  3164] OUT {"type":"system","subtype":"init","cwd":…,"session_id":"d667…",…}
[  4604] OUT {"type":"user","message":{"role":"user","content":[{"type":"text","text":"Reply with exactly the word PONG and nothing else."}]},"parent_tool_use_id":null,…,"isReplay":true}
[  4605] OUT {"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"PONG"}],…},…}
[  4638] OUT {"type":"result","subtype":"success","is_error":false,"duration_ms":1608,"num_turns":1,"result":"PONG","stop_reason":"end_turn",…}
```

Shape: `init` → **channel echo** → `assistant` → `result`.

### 2. Self-initiated (background-task notification) turn

Prompt: start `sleep 20` in the background, then answer `BG-STARTED`.

```
[  3012] >>> STDIN {"type":"user",…,"text":"…run_in_background=true… sleep 20; echo BGDONE … reply with exactly: BG-STARTED"}}
[  3171] OUT {"type":"system","subtype":"init",…}
[ 12430] OUT {"type":"user",…,"text":"…run_in_background=true…"},"isReplay":true}          ← channel echo
[ 12430] OUT {"type":"assistant","content":[{"type":"text","text":"I'll start that background command."}]}
[ 12605] OUT {"type":"assistant","content":[{"type":"tool_use","name":"Bash","input":{"command":"sleep 20; echo BGDONE","run_in_background":true}}]}
[ 15297] OUT {"type":"system","subtype":"task_started","task_id":"bzj38wy6l",…}            ← bg command registered
[ 15297] OUT {"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_2e66…","content":"Command running in background…"}]}}   ← tool_result (not a replay echo)
[ 18013] OUT {"type":"assistant","content":[{"type":"text","text":"BG-STARTED"}]}
[ 18042] OUT {"type":"result","subtype":"success","duration_ms":15012,"num_turns":2,"result":"BG-STARTED",…}   ← channel turn ends
[ 35303] OUT {"type":"system","subtype":"task_notification","task_id":"bzj38wy6l","status":"completed","summary":"Background command … completed (exit code 0)",…}
[ 35307] OUT {"type":"system","subtype":"init",…}                                          ← new provider turn
[ 35307] OUT {"type":"user","message":{"role":"user","content":"<task-notification>\n<task-id>bzj38wy6l</task-id>…"},"isReplay":true,"systemUserKind":"task-notification"}   ← SELF echo
[ 37240] OUT {"type":"assistant","content":[{"type":"thinking",…}]}
[ 37246] OUT {"type":"assistant","content":[{"type":"text","text":"后台命令已完成（退出码 0），输出为 `BGDONE`。"}]}
[ 37283] OUT {"type":"result","subtype":"success","duration_ms":1970,"num_turns":1,…}      ← SELF turn terminal
```

Shape: `task_notification` → `init` → **notification echo
(`isReplay:true, systemUserKind:"task-notification"`)** → `assistant` → `result`.

### 3. Channel message arriving while a self turn runs (the F-2 defect)

Same as 2, but the second message is written the instant `task_notification`
appears (the driver matches the line and fires the stdin write, mirroring the
supervisor's inbox watcher).

```
[  8262] OUT {"type":"user",…},"isReplay":true}                                  ← U1 echo
[ 12372] OUT {"type":"result",…,"num_turns":2,"result":"BG-STARTED"}             ← U1 terminal
[ 26214] OUT {"type":"system","subtype":"task_notification","task_id":"bujk2kxu9",…}
[ 26214] >>> STDIN {"type":"user","message":{"role":"user","content":[{"type":"text","text":"Reply with exactly: MSG-DURING-SELF"}]}}   ← U2 written while the self turn runs
[ 26216] OUT {"type":"system","subtype":"init",…}
[ 26217] OUT {"type":"user","message":{"role":"user","content":"<task-notification>…"},"isReplay":true,"systemUserKind":"task-notification"}
[ 28433] OUT {"type":"assistant","content":[{"type":"text",…}]}
[ 28455] OUT {"type":"result",…,"num_turns":1,"result":"Background command completed (exit code 0)."}   ← SELF terminal, U2 NOT echoed yet
[ 28459] OUT {"type":"system","subtype":"init",…}                                ← next turn starts
[ 29935] OUT {"type":"user","message":{"role":"user","content":[{"type":"text","text":"Reply with exactly: MSG-DURING-SELF"}]},"isReplay":true}   ← U2 echo
[ 29935] OUT {"type":"assistant",…}
[ 29938] OUT {"type":"result",…,"num_turns":1,"result":"MSG-DURING-SELF"}        ← U2 terminal
```

This is the defect exactly: U2 was written to stdin (so the supervisor's stop
`turnTracker.begin(seq)` already fired) **before** the self turn's `result`
arrived. Attributing that `result` to the in-flight turn is what produced the
bogus `turn_finished{inputSeq:1139}` after ~20 s. Note the provider does **not**
echo a queued stdin message until the turn that consumes it starts, so the last
echo before a `result` is always that `result`'s origin.

### 4. Notification arriving while a user turn runs

Prompt: start `sleep 5` in the background, then run `sleep 40` in the
foreground, then answer `LONG-DONE`. The background command finishes ~10 s into
the user turn.

```
[  7940] OUT {"type":"user",…,"isReplay":true}                                    ← user echo
[ 10603] OUT {"type":"system","subtype":"task_started","task_id":"bwr5l5zsh",…}
[ 10603] OUT {"type":"user",…"type":"tool_result","content":"Command running in background…"}   ← bg started (~10.6 s)
[ 70882] OUT {"type":"user",…"type":"tool_result","content":"LONG-DONE"}          ← foreground command done (~70.9 s)
[ 89177] OUT {"type":"result",…,"duration_ms":86138,"num_turns":3,"result":"LONG-DONE"}   ← USER turn terminal (~89.2 s)
[ 89182] OUT {"type":"system","subtype":"task_notification","task_id":"bwr5l5zsh",…}      ← notification only AFTER the user turn ended
[ 89185] OUT {"type":"system","subtype":"init",…}
[ 89185] OUT {"type":"user","…"content":"<task-notification>…","isReplay":true,"systemUserKind":"task-notification"}
[ 91400] OUT {"type":"assistant",…}
[ 91404] OUT {"type":"result",…,"num_turns":1,"result":"LONG-DONE"}               ← self turn terminal
```

The background command completed ~79 s before the user turn did, yet neither
`task_notification` nor its echo was delivered mid-turn: the provider defers the
notification turn until the current turn ends. So a notification cannot split a
user turn in practice — and, because the turn origin only moves on an *echo*, a
`task_notification` that did get emitted eagerly mid-turn would still not
re-attribute the user turn's own `result`.

## Chosen signal (requirement 2)

**The replayed user-message echo (`{"type":"user", …, "isReplay":true}`) is the
turn-origin signal; `systemUserKind` distinguishes self-initiated from
channel-originated turns.**

`ClaudeCtx.turnOrigin` is set to `"self"` when a replayed echo carries
`systemUserKind` (currently only `"task-notification"`) and to `"channel"`
otherwise; `parseClaudeLine` stamps `selfInitiated: true` on the `done`/`error`
produced by the turn in flight. Why this signal and not the alternatives:

- **Direct attribution.** The echo is emitted at the start of the provider turn
  that consumes that input, so "the last echo before a `result`" *is* the answer
  to "which input does this `result` belong to" — including the queued-message
  case in sequence 3, where the self `result` arrives before U2's echo.
- **`init` cannot distinguish origins** (Finding 2): it fires for channel turns
  too.
- **`task_notification` alone is a weaker proxy.** It is an event-stream
  marker, not a turn-boundary marker; using it would also make the design depend
  on the provider *never* emitting it mid-turn, which nothing guarantees.
- **Fail-safe default.** `turnOrigin` starts as `"channel"`, so a provider that
  never echoes (older CLI without the flag) degrades to today's behaviour
  instead of the strictly worse "user turns never finish".

## Decisions (requirement 3)

- A self-initiated terminal keeps `kind: "done"`/`"error"` and gains
  `selfInitiated: true`; it produces **no** `turn_finished`, so
  `wait --kind turn_finished` never wakes for it.
- **It still wakes `wait --kind done`** (test
  `keeps a self terminal visible to wait --kind done …`). Rationale: it is a
  genuine provider terminal kept for observability, and narrowing `wait` would
  require changing `store/filter.ts` (out of this task's scope) plus a new
  filter dimension. The authoritative turn-attribution contract is
  `turn_finished{worker,inputSeq}` — what the bundled engine matches
  (`orchestrator/channel.py:368-375`) — so a conductor that only keys on bare
  `done` is not the contract this fix targets; the brief rule (requirement 5)
  additionally keeps background commands from spanning a turn boundary.
- `stdout.ts` skips `markTerminalEmitted()` for a self-initiated terminal, so
  the per-turn cold-exit latch still belongs to the channel turn (C-1): a crash
  during a self turn synthesises a terminal + `turn_finished` for the in-flight
  user turn (test `still synthesises a cold-exit terminal …`).
- Interrupt/abort (F-1) is untouched: an aborted turn's late `result` is still
  an echoed (channel) terminal, so it pops LIFO exactly as before — not worse.
- Codex adapter unchanged (its `JsonRpc` path never produces these echoes; it
  is `AdapterCtx`-typed per provider).

## Residual gap (out of scope — follow-up)

`reduceWorkerRegistry` (`packages/core/src/channel/internal/store/worker-state.ts:215`)
flips `activity` to `"idle"` and sets `idleSince` on **any** non-synthesised
`done`, including a self-initiated one, while the channel turn is still running.
`isIdleCleanupEligible` (`guard.ts:533`) then becomes true once the TTL elapses
— unchanged from before this fix (that path is not a regression), but it still
attributes idle-ness to the wrong turn. A core-side guard on
`selfInitiated === true` would close it.