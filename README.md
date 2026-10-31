# Arbor

Arbor is a spec-driven AI engineering workflow for **Claude Code and Codex**. The v2 Python driver assembles task context, dispatches roles through a configured executor, records reports, Git observations and task state. The main agent judges procedural changes in context; executable quality checks remain enforced.

## Install and initialize

```bash
pnpm install
pnpm build
node packages/cli/bin/arbor.js init --codex --yes
# Or: init --claude --yes
```

Run init from the project that should receive Arbor. Adding `--codex` to an existing Arbor project installs the Codex layer. Existing model/provider/MCP settings in `.codex/config.toml` are not overwritten.

| Platform | Entry points | Project files |
|---|---|---|
| Claude Code | `/arbor:workflow`, `/arbor:continue`, `/arbor:finish-work` | `.claude/` |
| Codex | `$arbor-workflow`, `$arbor-continue`, `$arbor-finish-work` | `.agents/skills/`, `.codex/hooks.json`, `.codex/hooks/` |

Codex loads repo instructions from `AGENTS.md`. SessionStart and UserPromptSubmit hooks provide session context and the next workflow step. Project hooks require a trusted project and review of their definitions through `/hooks`. If automatic hooks are unavailable or not yet trusted, invoke `$arbor-start`. Current Codex enables hooks by default; older installations may require `[features] hooks = true` in their user configuration.

StarFactory is no longer an installable Arbor platform. Update can remove unchanged historical Arbor templates after backing them up; locally modified files remain available for review. Uninstall only processes tracked Arbor files and preserves unrelated user content.

## Roles and execution

Arbor ships eight role instructions under `.arbor/agents/`:

- `explore`: inspect code and gather evidence.
- `architect`: design a solution.
- `test`: write acceptance tests.
- `implement`: implement the requested behavior.
- `review`: inspect a commit range without edits.
- `verify`: check findings independently.
- `fix`: repair confirmed issues.
- `simplify`: simplify the implementation.

The driver includes each role's instructions, task context, brief and report requirements in its dispatch prompt. Roles run through the executor in `.arbor/config.yaml`; native Codex sub-agent definitions are not required.

The default executor uses codeg assistants named `arbor-<role>`:

```yaml
executors:
  default: codeg
  codeg:
    type: codeg-mcp
    assistant: "arbor-{role}"
    timeout: 90m
    max_parallel: 3
```

Create the eight named assistants in codeg with the corresponding `.arbor/agents/<role>.md` instructions and choose their underlying agent/options there. The host resolves each assistant from the codeg MCP roster; an optional `assistant_ids` mapping pins local ids.

With the `codeg-mcp` executor, `arbor.py run` returns `needs=delegation`. Call codeg MCP `delegate_to_agent` with the returned `mcp.arguments` (resolve the named assistant from the MCP roster if no id is configured), then immediately run `arbor.py bind --request <request_path> --task-id <returned task_id>`. Poll `get_delegation_status`, save its complete JSON response at the returned `result_path` outside the task worktree, and run `arbor.py collect --request <request_path> --result <file>` before proceeding. Resume/poll a bound task after interruptions; never start it again. If the configured timeout expires, cancel it through `cancel_delegation` and collect the terminal report. Claude Code and Codex both use this same MCP flow. Do not substitute `codeg-cli run` or native Agent/Task/spawn_agent.

A direct CLI executor can also consume the prepared prompt, for example:

```yaml
executors:
  default: codex
  codex:
    command: "codex exec --cd {worktree} --sandbox workspace-write - < {prompt}"
    timeout: 90m
```

For Claude Code, use `claude -p < {prompt}`. The executor already runs in the task worktree. Use permissions appropriate for the role, including access to shared Git metadata when writing commits in linked worktrees. Parent Arbor and host session identifiers are not inherited by the child session.

## Workflow and maintenance

Project workflow, specs, tasks and journals live under `.arbor/`. See `.arbor/workflow.md` for the v2 contract, worktree and verification flow. Small changes can be edited and checked directly; explicit user instructions take precedence over the default workflow.

```bash
python3 .arbor/scripts/arbor.py next --json
python3 .arbor/scripts/arbor.py status
arbor platforms --json
arbor update --dry-run
arbor update
arbor uninstall --dry-run
```

## Development

```bash
pnpm lint
pnpm typecheck
pnpm build
pnpm test
pnpm --filter @tony131143a/arbor lint:py
```

`packages/cli/src/templates/` is the source for installed project files. Every Python file under `.arbor/scripts/` must remain byte-identical to its counterpart under `packages/cli/src/templates/arbor/scripts/`.

## License

AGPL-3.0-or-later, inherited from Trellis (Copyright (C) 2026 Mindfold LLC). See `LICENSE`, `COPYRIGHT` and `NOTICE`.
