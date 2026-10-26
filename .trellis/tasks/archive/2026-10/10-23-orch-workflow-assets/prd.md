# Orchestrated workflow assets

Parent: `.trellis/tasks/10-23-orchestrated-workflow` (R4 / R6 / R9 prompt side; design §5). Runs in parallel with `10-23-orch-engine-port`; `10-23-orch-install` depends on both.

## Goal

Ship the prompt-side assets of the bundled `orchestrated` workflow: the workflow text, a host-neutral Conductor prompt, three new agent cards, and the brief templates the engine renders — English, with no spark-harness specifics, and without touching the bundled cards other workflows use.

## Sources (spark-harness, read-only)

- `/Users/xktang/person-resources/project/spark-harness/.trellis/workflow.md` — `[workflow-state:orchestrating]` block (~116-120) and its orchestration-mode Phase 2 (written on top of the channel-driven variant, so not copyable as is).
- `/Users/xktang/person-resources/project/spark-harness/.trellis/orchestrator/conductor.md`, `briefs/*.md`, `design.md` §15 (contract), `orch.py` (argparse = the real command surface).
- `/Users/xktang/person-resources/project/spark-harness/.trellis/agents/{check,check-verify,simplify,implement}.md` — `check.md` is the finder, `implement.md` carries an appended "Orchestration Mode" section.

## Files (worktree `/Users/xktang/person-resources/project/my/Trellis.worktrees/orchestrated-workflow`)

| File | Content |
|---|---|
| `packages/cli/src/templates/trellis/workflow-orchestrated.md` (new) | Start from bundled `templates/trellis/workflow.md` (native). Keep every `[workflow-state:*]` block, the `## Phase Index`, and all `#### X.Y` step headings; Phase 2 becomes orchestration mode (Conductor loop through `.trellis/orchestrator/orch.py`); add a `[workflow-state:orchestrating]` block. Planning stays native, plus how a parent task enters orchestration. |
| `packages/cli/src/templates/trellis/orchestrator/conductor.md` | Already copied from spark. Generalize: host-neutral, generic examples instead of `go test` / Chinese commit conventions. |
| `packages/cli/src/templates/trellis/orchestrator/briefs/*.md` | Already copied from spark. Remove spark wording. Move the spark `implement.md` "Orchestration Mode" protocol into `briefs/implement.md`, `fix.md`, `resolve.md`. Keep each brief's `$placeholder` set exactly as it is now (the engine renders them; verify with a before/after diff of `\$[A-Za-z_]+` names per file). |
| `packages/cli/src/templates/trellis/agents/review-finder.md` (new) | From spark `check.md`: report-only, JSON output, every finding has `failure_scenario`. |
| `packages/cli/src/templates/trellis/agents/review-verify.md` (new) | From spark `check-verify.md`: adversarial verify, `CONFIRMED / PLAUSIBLE / REJECTED` with evidence. |
| `packages/cli/src/templates/trellis/agents/simplify.md` (new) | From spark `simplify.md`. |
| `packages/cli/test/templates/orchestrated-assets.test.ts` (new) | Assertions below. |

Card frontmatter follows bundled `agents/research.md`: `name` equal to the file stem, `description`, `provider: claude`, then the commented `# provider: star` / `# model:` lines. Card names must match what the engine dispatches: `implement`, `research`, `review-finder`, `review-verify`, `simplify`.

## Requirements

- English only; no spark names, Go/make commands, machine paths or CJK text in any of these files.
- Bundled `agents/check.md`, `agents/implement.md`, `agents/research.md` and `workflow.md` are byte-for-byte unchanged (AC9).
- Do not register anything in `templates/trellis/index.ts` or the workflow resolver (that is `orch-install`).
- Command names, flags and stages quoted in `workflow-orchestrated.md` / `conductor.md` match `orchestrator/orch.py` argparse (the engine is being generalized in parallel; command surface and flags do not change).
- `[workflow-state:orchestrating]` follows `.trellis/spec/cli/backend/workflow-state-contract.md` (block format, size limits, per-turn content); register nothing in that spec here (`orch-spec-docs` does).

## Acceptance Criteria

- [ ] `orchestrated-assets.test.ts`: workflow-orchestrated.md has every `[workflow-state:*]` block native has plus `orchestrating`, the same `#### X.Y` step headings and `## Phase Index`; each new card parses with `name` = file stem and a `provider`; brief `$placeholder` sets equal a fixture snapshot of the current ones.
- [ ] Existing `test/templates/trellis.test.ts` passes; bundled files listed above unchanged (`git diff --quiet` on them).
- [ ] CJK / spark scan over the new and edited files is empty.
- [ ] `pnpm --filter @mindfoldhq/trellis typecheck`, `lint`, and the two template test files pass.

## Out of scope

Engine code (`orch-engine-port`); install/remove/update (`orch-install`); spec docs (`orch-spec-docs`).
