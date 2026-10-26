# Orchestrated workflow: install, remove, update

Parent: `.trellis/tasks/10-23-orchestrated-workflow` (R4 / R7 / R8, D3 / D4; AC4–AC6, AC9; design §6, §8). Depends on `10-23-orch-engine-port` and `10-23-orch-workflow-assets` (their files exist in the worktree). Code map: parent `research/install-mechanism.md` (all anchors below are relative to `packages/cli/`).

## Goal

Selecting the bundled `orchestrated` workflow installs everything it needs, switching away removes it, `trellis update` keeps it current, and a project that never selects it is byte-for-byte unaffected.

## Requirements

1. **Bundled entry**: `src/utils/workflow-resolver.ts` gets a second bundled virtual entry `orchestrated` (offline, `source: "bundled"`, listed right after `native`) whose content is `templates/trellis/workflow-orchestrated.md`. `applyHashContract` (`src/commands/workflow.ts:144-158`) keeps the workflow.md hash for both bundled ids.
2. **Selection signal**: "orchestrated is selected" ⇔ `.trellis/.template-hashes.json` has an entry for `.trellis/orchestrator/orch.py`. No new persisted state. A project whose engine has no hash (self-built copy) is never treated as selected and never touched.
3. **Install on selection** (`trellis init --workflow orchestrated`, `trellis workflow --template orchestrated`):
   - write the orchestrated workflow.md; install `.trellis/orchestrator/**` (engine `.py`, `briefs/`, `conductor.md`; never tests or `__pycache__`) and the cards `.trellis/agents/{review-finder,review-verify,simplify}.md`, all hash-recorded;
   - if Claude Code is configured, add to `.claude/settings.json` (same serialization as `injectStatusLine`, `src/configurators/claude.ts:52-59`): `PreToolUse` matcher `Bash|Edit|Write|MultiEdit|NotebookEdit|Agent|Task|mcp__.*` → `python3 "$CLAUDE_PROJECT_DIR/.trellis/orchestrator/guard.py"` (timeout 10); `SessionStart` → `… inject.py --event session-start` (timeout 15); `UserPromptSubmit` → `… inject.py --event prompt` (timeout 15). Use the platform's existing Python command placeholder convention if Claude templates have one, and keep existing Trellis hook entries intact;
   - without Claude Code configured: print that the constraint layer (guard / inject) only works on Claude Code;
   - D4: if `channel.worker_guard.max_live_workers` in `.trellis/config.yaml` is missing or equals 6, set it to 16 and print one line explaining why (about 3 children in parallel; adjust to machine memory). Any other value is left alone.
4. **Switch away** (to `native` or a marketplace workflow):
   - refuse when any task's `orchestration.json` has a stage in the engine's `LIVE_STAGES` (`orchestrator/ledger.py`), naming the parent and telling the user to finish/abort; `--force` overrides;
   - otherwise delete the engine files and three cards whose content still matches the recorded hash, drop those hashes, keep modified ones and list them; strip the settings.json hook entries that point into `.trellis/orchestrator/` (reuse `scrubHooksJson`, `src/utils/uninstall-scrubbers.ts:99+`). Budget is not lowered.
5. **Update** (`src/commands/update.ts`, `collectTemplateFiles` ~903): when selected, compare workflow.md against the orchestrated template, include the engine files and three cards, and render Claude settings.json with the hook entries so an unchanged project reports no settings change (pattern: `preserveExistingClaudeStatusLine`, `update.ts:706-742`). When not selected, nothing new is included. Add `preserveExistingWorkerGuardConfig` next to `preserveExistingRegistryConfig` (`update.ts:744-761`) so an existing `worker_guard` block survives the hash-matched auto-update; this step runs for every project (no-op when the value is the template default).
6. Bundled `agents/{check,implement,research}.md` and native `workflow.md` unchanged; re-init still ignores `--workflow` (`init.ts:1197-1210`, out of scope — document `trellis workflow --template` instead).

## Acceptance Criteria

- [ ] AC4: `trellis init --workflow orchestrated` with Claude Code → engine, three cards, the three hook entries and `max_live_workers: 16` present; `trellis workflow --template native` → engine and cards removed, hooks stripped; with a live `orchestration.json` the switch is refused and `--force` overrides.
- [ ] AC5: init without orchestrated produces the same file set, settings.json and config.yaml bytes as before this task (test asserts against the pre-change behavior).
- [ ] AC6: with orchestrated selected, `trellis update` on an unchanged project reports no change to settings.json, workflow.md or config.yaml; budget stays 16; a newer engine template is auto-updated; a user-modified engine file becomes a conflict, not an overwrite.
- [ ] Tests in the existing suites (`test/commands/workflow.integration.test.ts`, `update.integration.test.ts`, `init.integration.test.ts`, `test/configurators/platforms.test.ts`, `test/utils/workflow-resolver.test.ts`), following the statusLine cases.
- [ ] `pnpm --filter @mindfoldhq/trellis typecheck`, `lint`, `test` pass.

## Out of scope

The real-worker smoke run (AC8, parent-level step after this task); spec docs (`orch-spec-docs`); platforms other than Claude Code for hooks.
