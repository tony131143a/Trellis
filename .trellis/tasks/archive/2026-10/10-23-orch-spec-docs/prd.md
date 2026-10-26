# Orchestration specs and bundled docs

Parent: `.trellis/tasks/10-23-orchestrated-workflow` (R9 / R10; AC10; design §7). Depends on `10-23-orch-engine-port`, `10-23-orch-workflow-assets`, `10-23-orch-install` (the specs describe their merged behavior). Paths are in the worktree `/Users/xktang/person-resources/project/my/Trellis.worktrees/orchestrated-workflow`.

## Goal

Specs describe the orchestrated workflow as shipped, so future changes to the engine, the workflow-state statuses or the install path have a contract to check against; the bundled skills tell AI agents in user projects that the workflow exists and how to use it.

## Requirements

1. **Orchestration contract spec** (new, `.trellis/spec/cli/backend/orchestration-contract.md`, routed from `.trellis/spec/cli/backend/index.md`): rewritten from the spark contract (`/Users/xktang/person-resources/project/spark-harness/.trellis/orchestrator/design.md` §15) to match the generalized engine — roles, commands and stages, ledger (`orchestration.json`) schema and `LIVE_STAGES`, child pipeline, decision kinds, budget (min of engine setting and channel budget), tracked vs untracked `.trellis`, trellis CLI resolution, guard / inject behavior and the Claude-Code-only constraint layer, card names, what the engine never commits. Generic wording; no spark names.
2. **`workflow-state-contract.md`**: add `orch.py start/finish/abort` to the status writer table (~257-275) and delete the "No other writer exists" assertion (~273); add `orchestrating` to the reachability matrix (~298-309: reachable only with the orchestrated workflow) and the hook reachability matrix (~338+) if it applies; check the consumers (~391-393) and the mandatory-trigger list.
3. **`commands-workflow.md`**: second bundled workflow `orchestrated`, the selection signal (engine hash), install / remove / refuse-while-live / `--force`, update behavior, budget raise. **`commands-update.md`**: `preserveExistingWorkerGuardConfig` and the orchestrated template selection.
4. **Bundled skills** (`packages/cli/src/templates/common/bundled-skills/`): `trellis-channel/references/workflows.md` and the trellis-meta workflow / agents / hooks references (`references/local-architecture/workflow.md`, `references/platform-files/agents.md`, `references/platform-files/hooks-and-settings.md` as relevant) mention the orchestrated workflow, its cards and hooks. If the repo keeps checked copies of these skills under `.claude/skills/` in sync with the bundled ones (check scripts / tests before editing), update them the same way. The `marketplace` submodule and `docs-site` are out of scope.
5. Every statement is checked against the merged code with file:line anchors for the key contracts.

## Acceptance Criteria

- [ ] The new spec exists, is routed from `index.md`, and its anchors spot-check against the code.
- [ ] `workflow-state-contract.md` registers the `orchestrating` writer and reachability; the "No other writer exists" line is gone.
- [ ] `commands-workflow.md`, `commands-update.md` and the bundled skill references describe orchestrated.
- [ ] `pnpm --filter @mindfoldhq/trellis test` passes for any doc/template tests touching these files (bundled skill tests, spec lint if present).
