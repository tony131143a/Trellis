# The Driver: arbor.py

In Arbor the eight roles (`explore`, `architect`, `test`, `implement`, `review`, `verify`, `fix`, `simplify`) are not platform sub-agents. One script, `.arbor/scripts/arbor.py`, runs them. It owns three things: the task's state table, its counters, and validation (of replies, commits and git invariants). The main agent owns judgment: the tier proposal, the contract, briefs, red-gate classification, finding dedup, PLAUSIBLE trade-offs and spec updates. Role instruction text lives in `.arbor/agents/<role>.md` (plain markdown, no frontmatter).

## Commands

```bash
python3 ./.arbor/scripts/arbor.py next [--json]               # the single next step
python3 ./.arbor/scripts/arbor.py run [--dispatch d-NNN]      # execute the pending dispatch (in GATE: the gate)
python3 ./.arbor/scripts/arbor.py run --role explore|architect|review [--mode plan] [--dispatch d-NNN]   # CONTRACT phase, before task.py start
python3 ./.arbor/scripts/arbor.py gate                        # GATE level 0; prints the failing AC ids
python3 ./.arbor/scripts/arbor.py decide <choice> --reason "…"   # impl | tests | contract · fix | skip
python3 ./.arbor/scripts/arbor.py canary [--role <role>]      # read-only probe of the executor and the reply format
python3 ./.arbor/scripts/arbor.py override --reason "…" (--to STATE[/step] | --role <role> [--mode M])   # one step off the state table; recorded in the scorecard
python3 ./.arbor/scripts/arbor.py status | resume | abandon [--reason "…"]
python3 ./.arbor/scripts/arbor.py prompt --dispatch d-NNN --print   # the assembled prompt, rebuilt
```

Every command takes `--task <dir>` before the command name (default: the session's active task). Exit codes: 0 ok, 1 refused / failed dispatch / red gate, 2 usage error.

`next --json` always has `task`, `state`, `needs` (`brief | run | decide | human | done`) and `summary`; it adds `tier`, `wave`, `partition`, `role`, `mode`, `range`, `dispatch`, `brief_path`, `decision` (`kind`, `options`, `failing`), `human` (`kind`: `approve_contract | plausible | stop | merge`) and `touched_files` when they apply. On a task that is not started yet it returns `state: CONTRACT`, `needs: human` with `human.kind: approve_contract`, plus `dispatch` (the next id), `brief_path` and `contract_roles` (`explore`, `architect`, `review`). The SessionStart and per-turn hooks show only `summary` and `needs`.

## State Machine

`CONTRACT → BUILD → GATE → REVIEW → POLISH (standard / full) → FINISH → DONE`, with `STOP` reachable from any state. `task.py start` enters BUILD after the human approves the contract. BUILD runs `test` (red, checked by the driver) then `implement`; GATE runs `gate.commands` plus every `auto` Verification-map command; REVIEW runs one `review` `Mode: self-check` over `base..HEAD` and re-reviews fixes over `last_reviewed..HEAD`; POLISH runs `simplify`, N candidate reviews, a mechanical prefilter, `verify` (at most 8 per run), and for full a `sweep`. Suggested budgets: REVIEW light 2 rounds, standard / full 1; POLISH 2. Counters and boundary observations are advisory; the main agent decides retries or stopping. No procedural check automatically creates STOP. Only the driver changes `task.json` `state`, `counters`, `dispatches`, `last_reviewed` and `stop`.

## CONTRACT-Phase Dispatch

Before `task.py start` there is no state table, worktree or Range, but the contract still needs research and a plan review. `arbor.py run --role explore|architect|review [--mode plan] [--dispatch d-NNN]` covers that:

- The main agent writes the brief body at `<task>/briefs/<id>.md`, where `<id>` and the path come from `next --json` (`dispatch`, `brief_path`). `--dispatch` must match that id when given. A missing or empty brief is refused.
- `--mode plan` goes with `review` only and is its default.
- The role runs in the main checkout, with header `Active task`, `Role`, `Mode` (review) and `Dispatch`, and no `Range:`. Nothing is committed.
- Write boundary: `explore` and `architect` may write only `<task>/research/`; `review` writes nothing. Unexpected changes are observations for the main agent. The driver preserves the files and HEAD, without reset, checkout or clean.
- Each run is recorded in `task.json` `dispatches` (`phase: "CONTRACT"`; review adds `verdict` and `findings`), in `<task>/reports/<id>.md`, and as a `results.jsonl` row with state `CONTRACT`.
- `task.py start` keeps those records and commits the task directory, briefs, reports and research included. Dispatch ids continue: after pre-start d-001 and d-002, the first BUILD dispatch is d-003.
- On a started task `run --role` is refused; an extra role goes through `override --role`.
- With no task at all (INTAKE) only `--role explore` works: the brief comes on stdin, the reply goes to stdout, and no task directory is touched; the prompt is kept as `.arbor/.runtime/prompts/intake-<timestamp>.md`.

## Header Protocol

The driver starts every role prompt with:

```text
Active task: <absolute path of .arbor/tasks/<task> inside the task worktree; the main checkout before start>
Role: explore | architect | test | implement | review | verify | fix | simplify
Mode: self-check | candidates | sweep | plan   (review only)
Range: <base>..<head>                          (roles that read or write a diff)
Dispatch: d-NNN
```

The older `Diff:`, `Target:` and `Workspace:` lines are gone. After the header comes the injected context, assembled by `common/dispatch_context.py`: the files listed in `implement.jsonl` (`architect`, `test`, `implement`) or `check.jsonl` (`review`, `verify`, `fix`, `simplify`), then `contract.md` (legacy `prd.md`), `design.md`, `waves.md` (legacy `implement.md`), then `git diff <Range>` run in the task worktree, marked `<!-- arbor-hook-injected -->`; `explore` gets the spec overview plus the contract and the research file list. Size caps come from `context_injection:` in `.arbor/config.yaml`. Last comes the main agent's brief, which is `tasks/<task>/briefs/d-NNN.md`. The assembled prompt is not committed: it is written to `.arbor/.runtime/prompts/<task>/d-NNN.md` in the main checkout, and `arbor.py prompt --dispatch d-NNN --print` rebuilds it. The reply plus the driver's verdict goes to `tasks/<task>/reports/d-NNN.md`; the driver commits the brief and the report on the task branch.

## Executors

`executors:` in `.arbor/config.yaml` decides how a role runs:

```yaml
executors:
  default: codeg
  codeg:
    type: codeg-mcp
    assistant: "arbor-{role}"
    timeout: 90m
    max_parallel: 3
```

With the `codeg-mcp` executor, `arbor.py run` returns `needs=delegation`. Call codeg MCP `delegate_to_agent` with the returned `mcp.arguments` (resolve the named assistant from the MCP roster if no id is configured), then immediately run `arbor.py bind --request <request_path> --task-id <returned task_id>`. Poll `get_delegation_status`, save its complete JSON response at the returned `result_path` outside the task worktree, and run `arbor.py collect --request <request_path> --result <file>` before proceeding. Resume/poll a bound task after interruptions; never start it again. If the configured timeout expires, cancel it through `cancel_delegation` and collect the terminal report. Claude Code and Codex both use this same MCP flow. Do not substitute `codeg-cli run` or native Agent/Task/spawn_agent.

Model, effort and permissions belong to the selected codeg assistant. `arbor.py canary` uses the same prepare/bind/collect flow. CLI executors remain available only when explicitly configured with `command`; their shell-quoted placeholders are `{role}`, `{prompt}`, `{worktree}`, `{task}`, `{dispatch}`. `run --autopilot` stops at MCP handoffs; the host handles delegation and resumes the driver afterwards.

## Invariants And Commit Format

After every dispatch the driver checks, with git:

| Who | Check |
| --- | --- |
| readers (`explore`, `architect`, `review`, `verify`) | worktree clean except the task's `research/`; HEAD unmoved |
| writers (`test`, `implement`, `fix`, `simplify`) | only their own branch moved, at least one new commit, no merge commits, every commit well-formed |
| `test` | changed files ⊆ test paths |
| `implement` / `simplify` / `fix` | changed files ∩ test paths = ∅ (fix: regression tests listed in its report are allowed) |
| everyone | remote refs and other local branches unmoved; `.arbor/` changes only under `tasks/<task>/` |
| contract | hash drift is recorded for contextual judgment, not an execution/collection gate |

Boundary and commit-format observations are retained for main-agent judgment without automatic failure, STOP or rollback. Role instructions recommend commits like:

```text
<role>(<task-dir-name>): <summary>

<optional body>

Arbor-Dispatch: d-NNN
```

Ambiguous reports are retained with status `judgment`, never silently counted as PASS. In a started task, `next` asks the main agent to `decide retry --reason ...` or `decide accept --report <interpretation> --reason ...`. The original report remains intact and the interpretation is recorded separately. Missing commits are advisory. Actual executor failures remain failures.

## Git Model

`task.py start` creates branch `arbor/<task>` and worktree `<worktree.root>/<task>` (default root `../<repo>-wt`), runs `worktree.setup` once, moves the task directory there and commits it. Partition branches for multi-partition waves are `arbor/<task>--<partition>` in worktrees `<root>/<task>-<partition>`, merged back with `--no-ff`. The task branch reaches the main branch through a PR the human merges with `--no-ff`. `.arbor/.runtime/` (sessions, `prompts/`, `results.jsonl`) stays in the main checkout.

## Guard Hook And Sub-Agent Exemption

`guard-builtin-agent.py` (PreToolUse, matcher `^(Agent|Task)$`, timeout 10) denies the built-in Agent/Task tool when the prompt carries an Arbor header or the `subagent_type` starts with `arbor-`, so roles cannot silently run outside the driver. A session whose first prompt starts with `Active task:` plus `Role:` is a dispatched role: it does its role, never runs `arbor.py` or `task.py start/current/finish`, never pushes, merges or rebases, and has no `ARBOR_CONTEXT_ID`.

## Measurement

Every dispatch appends one line to `.arbor/.runtime/results.jsonl` (`task`, `dispatch`, `role`, `mode`, `state`, `wave`, `partition`, `executor`, timings, `exit_code`, `status`, `commit`, `violations`). FINISH writes `scorecard.md` into the task directory: dispatches per role, GATE / REVIEW / POLISH rounds, findings per rung, AC automation rate, overrides and violations.

## Debugging

- `arbor.py status`: state, counters, last dispatches, STOP reason.
- `arbor.py prompt --dispatch d-NNN --print`: exactly what a role received.
- `arbor.py canary --role review`: is the executor reachable and is the reply shaped right.
- `.arbor/.runtime/results.jsonl`: per-dispatch exit code, status and violations.
- Observed boundary changes: inspect the retained files and raw report in context; no branch reset has occurred. Use the ordinary next step or a reasoned override. Legacy STOP records require explicit resume/override after inspecting evidence.
