---
sources:
  - packages/cli/src/templates/shared-hooks/*.py
  - packages/cli/src/templates/arbor/workflow.md
  - packages/cli/src/templates/arbor/scripts/common/tasks.py
last_verified: 2026-10-28
---
# Workflow-State Breadcrumb Contract

> Runtime contract for the per-turn `<workflow-state>` breadcrumb that
> `inject-workflow-state.py` injects into every UserPromptSubmit.

---

## Overview

The breadcrumb is the **only** per-turn channel that fires while an Arbor task
is active. It is intended for the main AI session, while sub-agent context
normally arrives through the dispatch hook (or `dispatch.py`) and the header
protocol described in `dispatch.md`. Host behavior can still surface the
breadcrumb inside sub-agent turns, though, and hooks do not currently expose a
stable main-vs-sub-agent identity signal. Therefore: **every `[required · once]`
step that the workflow-walkthrough mandates for a given phase must also be
mentioned in that phase's breadcrumb tag block, and breadcrumb text must be
safe when read by a sub-agent.** If required gates are absent, the AI in the
main session will silently skip them. Prior bugs around planning gates and
Phase 3.4 commit reminders hit exactly this failure mode.

This document is the source of truth for the runtime mechanics. The user-facing
breadcrumb body lives in `.arbor/workflow.md`; this spec covers everything
**around** it (parsers, writers, lifecycle, reachability).

---

## Marker syntax

Each breadcrumb body lives in a managed block of `.arbor/workflow.md`:

```
[workflow-state:STATUS]
<one or more lines of body text>
[/workflow-state:STATUS]
```

- STATUS character set: `[A-Za-z0-9_-]+` (letters, digits, underscores,
  hyphens). Examples: `planning`, `in_progress`, `in-review`, `blocked-by-team`.
- The body is read verbatim and inlined into the `<workflow-state>` block.
- Both the opening and closing tags must end with the same STATUS string.

The regex used by the Python hook (`packages/cli/src/templates/shared-hooks/inject-workflow-state.py`)
is:

```
[workflow-state:([A-Za-z0-9_-]+)]\s*\n(.*?)\n\s*[/workflow-state:\1]
```

### Invariant: parser regex ↔ strip regex must use the same `\1` backreference

There are two regex consumers of the marker syntax:

1. **Parser** — extracts tag content for breadcrumb emission. Lives in `inject-workflow-state.py` (`_TAG_RE`).
2. **Stripper** — removes tag blocks from the workflow.md range injected at SessionStart (so AI doesn't read each block twice — once in the workflow overview, once in the per-turn breadcrumb). Lives in `session-start.py`, `workflow_phase.py`, and any future SessionStart-equivalent script.

Both regexes MUST use the `\1` backreference variant — `[workflow-state:([A-Za-z0-9_-]+)]...[/workflow-state:\1]` — so they only match well-formed pairs (same STATUS on open and close). A non-backreference variant like `[workflow-state:[A-Za-z0-9_-]+]...[/workflow-state:[A-Za-z0-9_-]+]` permits `STATUS_A...STATUS_B` mismatches, which can swallow surrounding content if a user typo'd the closing tag.

**Symptom of drift**: parser would refuse to emit content for a typo'd block (because parser uses `\1`), but stripper would silently consume it from the SessionStart payload (because stripper used the loose form). End result: the AI never sees that content via either channel — silent loss.

**Test invariant**: `test/regression.test.ts` `[strip-breadcrumb] _strip_breadcrumb_tag_blocks only strips matched STATUS pairs` covers the three boundary cases (matched, mismatched, nested orphan) for the strip side. The parser already enforces same-status pairing structurally via `\1`.

---

## Runtime contract

1. On every UserPromptSubmit (or platform equivalent — see hook reachability
   matrix below), the hook receives stdin JSON containing `cwd`.
2. It walks up from `cwd` to find `.arbor/`. If none, exit 0.
3. It calls `common.active_task.resolve_active_task()` to look up the
   per-session active task. If absent → status is the pseudo `no_task`. If
   the pointer is stale (task dir deleted) → status is `stale_<source_type>`.
4. Otherwise it reads `task.json.status` from the resolved task directory. If
   the task directory exists but `task.json` is missing, malformed, or has no
   usable status, the hook emits the `task_error` pseudo-status and keeps the
   task directory name in the breadcrumb header.
5. It opens `.arbor/workflow.md` and parses every `[workflow-state:STATUS]`
   block.
6. Key selection. For a readable task the hook resolves the tier with
   `common.tasks.resolve_tier(task_dir, task_data)`: `meta.tier` when it is
   one of `light | standard | full` (case and surrounding whitespace
   ignored), otherwise inferred from the artifacts on disk (`implement.md` →
   full, `design.md` → standard, else light). `task.py start`, session-start
   and `get_context.py` use the same helpers, so they cannot disagree. The
   first key that exists in the parsed map wins:
   1. `<status>-parallel`, only when the tier is `full` and
      `meta.execution == "parallel"` (`task.py start` refuses parallel
      below full);
   2. `<status>-<tier>`;
   3. `<status>`.

   Custom statuses walk the same chain. No `planning-*` blocks ship, so a
   planning task lands on `planning`. There are no `*-inline` keys.
   `no_task`, `task_error` and `stale_*` skip tier resolution.
7. It looks up the selected key in the parsed map. If found → emits the
   block body in `<workflow-state>...</workflow-state>`. If not found →
   emits the generic line `Refer to workflow.md for current step.`
   The first line inside the block is the header: `Status: no_task` without
   a task, otherwise `Task: <id> (<status>) · Tier: <tier>`, with
   ` (inferred)` appended to the tier when `meta.tier` is absent or invalid.
   The tier stays outside the parentheses because regression tests pin the
   `Task: <id> (<status>)` substring. `task_error` and `stale_*` headers
   carry no tier segment.
8. The output JSON has shape:

   ```json
   {"hookSpecificOutput": {
     "hookEventName": "<platform-event-name>",
     "additionalContext": "<workflow-state>...</workflow-state>"
   }}
   ```

   The platform host injects `additionalContext` as system-level preamble
   for that turn.

   `hookEventName` MUST echo the host's per-turn event name or the host's
   schema validator will reject the payload. Both supported platforms (Claude
   Code and StarFactory, a Claude Code fork) use `UserPromptSubmit`, and
   `inject-workflow-state.py` currently emits that literal. `_detect_platform()`
   in the same file resolves `star` (via `STARFACTORY_PROJECT_DIR` or a
   `.starFactory` hook path) before `claude`, because StarFactory also exports
   `CLAUDE_PROJECT_DIR`, and the resulting platform name feeds the session
   context key. When adding a new hook-capable platform whose per-turn event
   name is not `UserPromptSubmit`, add an event-name selector keyed on
   `_detect_platform()` instead of hardcoding `UserPromptSubmit` at a new
   emission site.

---

## Source of truth

`workflow.md` is **the only editable source** for breadcrumb body text. The
hook script (`inject-workflow-state.py`) contains only the parser, no fallback text.

**Why no fallback dicts**: upstream Trellis before v0.5.0-beta.20 shipped
a `_FALLBACK_BREADCRUMBS` dict in each hook script mirroring the
workflow.md content. The mirror inevitably drifted (different word polish in
each file), and the architecture invited copy-paste skew. Removing the
fallback collapses three sources to one. When `workflow.md` is missing or a
tag is absent, the hook degrades to the generic line — visible to the user as
an obvious bug they can fix, rather than being silently masked.

To customize breadcrumb wording, edit the `[workflow-state:STATUS]` block in
`.arbor/workflow.md`. No script change required.

### Update boundary

The `[workflow-state:STATUS]` blocks are not the only runtime-sensitive
content in `workflow.md`. Phase headings and step headings are parsed by
`workflow_phase.py` / `get_context.py` when step-specific instructions are
loaded.

For that reason, `arbor update` must update `workflow.md` as one managed
template file whenever the installed file still matches its tracked template
hash. It must not partially merge only `[workflow-state:*]` blocks. User edits
are protected by the normal hash-based modified-file flow, not by preserving
arbitrary prose outside tag blocks during automatic updates.

Regression invariant: an older hash-tracked workflow must be replaced by the
current packaged template, so step detail such as Phase 2.1 still loads.
`workflow_phase.py` matches step headings with `\d+[PF]?\.\d+`, so Phase 2P steps (`2P.0` and up) and Phase 2F steps (`2F.1` and up) load with `--step` as well.

---

## Status writer table

The table below enumerates every code path that writes `task.json.status` —
i.e., every path that can change which breadcrumb fires next turn. **Adding
a new writer requires updating this spec.**

| # | Writer | File | Value | Trigger |
|---|--------|-----------|-------|---------|
| 1 | `cmd_create` | `.arbor/scripts/common/task_store.py` (`cmd_create`) | `"planning"` | `task.py create "<title>"` (also visibly auto-sets the session active-task pointer when session identity is available; `--no-start` skips pointer movement for backlog batching — see R7 in 04-30-workflow-state-commit-gap PRD) |
| 2 | `_record_start_state` (called from both `cmd_start` branches) | `.arbor/scripts/task.py` (`_record_start_state`) | `"in_progress"` (gated on prior `"planning"`; the same write also records `task.json.branch` when empty) | `task.py start <dir>` |
| 3 | `cmd_archive` | `.arbor/scripts/common/task_store.py` (`cmd_archive`) | `"completed"` (flip + archive `mv`, but only after `_validate_branch_metadata` passes) | `task.py archive <dir>` |
| 4 | `emptyTaskJson` factory | `packages/cli/src/utils/task-json.ts` (`emptyTaskRecord`, aliased as `emptyTaskJson`) | `"planning"` (default) | TS callers (init, update) |
| 5 | `getBootstrapTaskJson` | `packages/cli/src/commands/init.ts` (`getBootstrapTaskJson`) | `"in_progress"` (override) | `arbor init` (creator path) |
| 6 | `getJoinerTaskJson` | `packages/cli/src/commands/init.ts` (`getJoinerTaskJson`) | `"in_progress"` (override) | `arbor init` (joiner path) |
| 7 | migration-task via `emptyTaskJson` | `packages/cli/src/commands/update.ts` (migration-task block) | `"planning"` (override on factory) | `arbor update --migrate` for breaking-change manifest |

**No other writer exists.** No hook script writes `task.json.status` — verified
by `grep -rn '"status"' .arbor/scripts/`. The Linear-sync hook (`linear_sync.py`)
writes `meta.linear_issue` only.

---

## Lifecycle events ≠ status transitions

Lifecycle events fire on task-management commands, NOT on status changes.
Subscribers must understand the difference:

| Event | Emitted at | Status when fired |
|-------|------------|-------------------|
| `after_create` | end of `cmd_create` | `"planning"` (just written) |
| `after_start` | end of `cmd_start` | `"in_progress"` if status was `"planning"`; otherwise unchanged. Re-running `start` does NOT re-fire status flip. |
| `after_finish` | end of `cmd_finish` | **unchanged** — `cmd_finish` only clears the per-session active-task pointer. Status stays whatever it was (typically `"in_progress"`). |
| `after_archive` | end of `cmd_archive` | `"completed"` (just written, then dir moved to `archive/YYYY-MM/`) |

**Common mistake**: subscribing to `after_finish` to mark a task "done" in an
external system (Linear, Jira). `after_finish` means "AI session closed its
pointer to this task" — the task may resume in a different session. The
correct event for "task is done" is `after_archive`.

---

## Reachability matrix

Which breadcrumbs actually fire in normal flow:

| Status | Reachability | Notes |
|--------|--------------|-------|
| `no_task` | ✅ reachable | Pseudo-status; emitted when `resolve_active_task()` returns no pointer. |
| `task_error` | ✅ reachable | Pseudo-status; emitted when a session task pointer resolves to a directory whose `task.json` cannot be read or has no usable `status`. |
| `planning` | ✅ reachable | After `cmd_create` (which now auto-sets the session pointer when available) and before `cmd_start`. |
| `in_progress-light` / `in_progress-standard` / `in_progress-full` | ✅ reachable | After `cmd_start`, until `cmd_archive`, for serial tasks of that tier (pinned `meta.tier` or inferred). Not stored statuses: breadcrumb keys derived from status plus tier. |
| `in_progress-parallel` | ✅ reachable | Same status window, for tier `full` tasks with `meta.execution=parallel` (set with `task.py set-meta <dir> execution parallel`). A lower tier with `execution=parallel` reads its tier block; `task.py start` refuses that combination for planning tasks. |
| `in_progress` | ⚠️ fallback only | Read only when workflow.md has no block for the task's tier (a customised workflow.md that predates tiers). The shipped body tells the agent to pin a tier and keeps the 3.3 / 3.4 gates. |
| `completed` | ❌ DEAD in normal flow | `cmd_archive` writes `status="completed"` and immediately moves the task dir to `archive/`. The session-pointer cleanup in `clear_task_from_sessions` runs before the move, so the resolver loses the pointer in the same call. The block body in workflow.md is preserved for a future status-transition redesign (e.g. an explicit `in_progress → completed` command) but no current code path produces it. |
| `stale_<source_type>` | ✅ reachable (rare) | Synthesized when the session pointer references a deleted task directory. Emits the generic body via `build_breadcrumb` because no `stale_*` tag is shipped. |

**Test invariants**: workflow-state blocks must preserve the runtime gates
that cannot be recovered from model memory. `no_task` triages (quick path or
a proposed tier) and asks for task-creation consent; planning lists the
artifacts each tier requires before start; every `in_progress*` block keeps
the commit step (3.4) reachable before `/arbor:finish-work`. See:

- `test/templates/arbor.test.ts`, `[required · once] steps appear in every
  breadcrumb block of their tier scope`: it parses every
  `[required · once]` step heading in the shipped workflow.md
  and asserts the step number appears in each breadcrumb block that covers
  it (`1.0` → `no_task`, `1.x` → `planning`, later steps → the
  `in_progress-<tier>` block of every tier the step applies to, plus
  `in_progress-parallel` for full). The same file pins the block set and
  checks that no parsed block body contains `[workflow-state:`, so a prose
  line ending in a tag token cannot swallow a real block.
- `test/scripts/dispatch-config.integration.test.ts`, the tier and parallel
  breadcrumb group: the key chain, the header format, inferred tiers,
  `task_error` without a tier, and each tier reading only its own block from
  the shipped workflow.md.
- `test/regression.test.ts` keeps the planning-artifact and commit (3.4)
  wording pins and the `Task: <id> (<status>)` header pins.

---

## Custom statuses

Forks can define custom statuses. To do so:

1. Add a `[workflow-state:my-status]...[/workflow-state:my-status]` block to
   `.arbor/workflow.md` (STATUS charset: `[A-Za-z0-9_-]+`). Optional
   `my-status-<tier>` (and, for tier full, `my-status-parallel`) variants
   are picked through the same key chain as the shipped statuses.
2. Add a lifecycle hook (`task.json.hooks.after_*`) that writes
   `task.json.status = "my-status"` at the appropriate event. Without a
   writer, the tag is never read because no task ever carries that status.
3. (Optional) Add the status to `.arbor/spec/cli/backend/workflow-state-contract.md`'s
   writer table when shipping the customization to other repos.

---

## Hook reachability matrix

The breadcrumb is **intended** for the main AI session. Dispatched assistants
(codeg sessions running `star` or `pi`) get their context from the dispatch
hook or from `dispatch.py`, but they may still read project files such as
`AGENTS.md` and `workflow.md`, and a host may run per-turn hooks for them.
Arbor must not rely on categorical breadcrumb invisibility inside assistants.

| Channel | Main session | Dispatched assistant |
|---------|:------------:|:--------------------:|
| `<workflow-state>` per-turn breadcrumb | ✅ | ⚠️ possible host-dependent exposure |
| PreToolUse dispatch hook (inlines `implement.jsonl`/`check.jsonl` + task artifacts into the `delegate_to_agent` task text) | ❌ | ✅ (applied to the text the main agent sends) |
| `dispatch.py` assembler (terminal path, same text as the hook) | ❌ | ✅ |
| Pull protocol in `.arbor/agents/<role>.md` (when `<!-- arbor-hook-injected -->` is absent) | N/A | fallback |

**Implication**: dispatch-relevant guidance must be carried by the header
protocol and the assistant instruction sources, in this artifact order:
jsonl entries -> `prd.md` -> `design.md if present` -> `implement.md if
present`. Breadcrumb text must be safe if an assistant sees it: the dispatch
guidance in `in_progress` and `in_progress-parallel` self-exempts a session
whose first prompt starts with `Active task:` + `Role:` so it performs the
role directly instead of dispatching again. The same rule applies to every
`in_progress*` block (fallback, three tiers, parallel). See `dispatch.md` in this
directory.

---

## DO

- Edit `.arbor/workflow.md` `[workflow-state:STATUS]` blocks for breadcrumb
  body changes; never touch the parser scripts.
- Keep `arbor update` whole-file behavior for hash-tracked `workflow.md`.
  Breadcrumb tag updates alone are insufficient because the step headings
  outside those tags are runtime input too.
- Add a writer-table row to this spec when introducing a new status writer.
- Run the regression tests after editing breadcrumb bodies.
- When adding a `[required · once]` step to the workflow walkthrough, add a
  matching enforcement line to every breadcrumb block that covers it (for
  Phase 2 / 2F / 3 steps, each `in_progress-<tier>` block of the tiers the
  step applies to) in the same commit.

## DON'T

- Don't add fallback breadcrumb dicts back to `inject-workflow-state.py` or
  `.js`. Drift is structurally guaranteed.
- Don't implement special partial merging for `workflow.md` unless every
  runtime parser that consumes headings and breadcrumb tags
  has an explicit compatibility strategy and upgrade test coverage.
- Don't introduce a `task.json.status` writer without updating this spec.
- Don't subscribe to `after_finish` to detect task completion — it doesn't
  mean what you think. Use `after_archive`.
- Don't silently re-route a writer to a different status without auditing
  every breadcrumb consumer (`session-start.py`, `inject-workflow-state.py`,
  `task.py list`, etc.).
- Don't rely on sub-agents not seeing the breadcrumb. If guidance is sub-agent
  relevant, propagate it via the appropriate channel above and keep the
  breadcrumb wording self-exempting.

---

## Mandatory triggers (must update this spec when changing)

- Marker syntax (regex / charset)
- Hook script structural change (parser, output envelope, what reads
  `task.json.status`)
- Tier resolution (`common.tasks.resolve_tier`, `TIER_ARTIFACTS`), the
  breadcrumb key chain, or the header format
- `workflow.md` update semantics in `arbor update`
- New `task.json.status` writer (any path that mutates the field)
- Breadcrumb body that changes the contract (e.g. removing a `[required ·
  once]` enforcement line — flag in PR description)
- New lifecycle event added to `run_task_hooks`
- Reachability changes (e.g. wiring a new status transition that makes
  `completed` reachable)

Cross-reference: `cli/backend/quality-guidelines.md` "Routing Fixes: Audit
ALL Entry Paths" — that audit pattern is what this contract enforces for
the breadcrumb subsystem.
