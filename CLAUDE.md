# CLAUDE.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

<!-- ARBOR:START -->
# Arbor Instructions (main agent)

This project is managed by Arbor. You are the **main agent**: propose the tier, write the contract, curate context, write briefs, make the judgment calls the driver asks for.

- Follow `.arbor/workflow.md` (Plan, Drive, Finish). Phase steps marked `[required]` are mandatory.
- Guidelines live in `.arbor/spec/`; tasks in `.arbor/tasks/`; journals in `.arbor/workspace/`.
- Simple changes (at most 2 files, cause known, no design choice) do not use Arbor: edit directly. Anything larger: `/arbor:workflow <request>` → propose a tier (light / standard / full) with a one-line reason → the user agrees → `task.py create --tier <t>`.
- Contract first: explore → one question list → `contract.md` (+ `design.md`; full: 3 architect perspectives → `waves.md`) → `task.py seed-context` → structural validation → standard / full: one review `Mode: plan` → the user approves the contract → `task.py start <task>` (freezes it, creates the task worktree and branch). Before start, explore / architect / review run as `arbor.py run --role <role> [--mode plan]` once the brief sits at the `brief_path` from `arbor.py next --json`: in the main checkout, read-only except `research/`, no commit.
- Then loop on `python3 ./.arbor/scripts/arbor.py next`: `needs=brief` → write the brief at the path it names for the role it names, then `arbor.py run`; `needs=decide` → `arbor.py decide <choice> --reason "…"`; `needs=human` → ask the user (contract re-approval, PLAUSIBLE findings, merge); `done` → finish. The driver owns state, counters, the gate and validation.
- The driver prepares roles and records results; the main agent judges procedural observations and report interpretation (explore / architect / test / implement / review / verify / fix / simplify). With the `codeg-mcp` executor, `arbor.py run` returns `needs=delegation`. Call codeg MCP `delegate_to_agent` with the returned `mcp.arguments` (resolve the named assistant from the MCP roster if no id is configured), then immediately run `arbor.py bind --request <request_path> --task-id <returned task_id>`. Poll `get_delegation_status`, save its complete JSON response at the returned `result_path` outside the task worktree, and run `arbor.py collect --request <request_path> --result <file>` before proceeding. Resume/poll a bound task after interruptions; never start it again. If the configured timeout expires, cancel it through `cancel_delegation` and collect the terminal report. Claude Code and Codex both use this same MCP flow. Do not substitute `codeg-cli run` or native Agent/Task/spawn_agent.
- The driver starts every role prompt with this header; you never type it:
  ```
  Active task: <absolute path of .arbor/tasks/<task> inside the task worktree>
  Role: explore | architect | test | implement | review | verify | fix | simplify
  Mode: self-check | candidates | sweep | plan   (review only)
  Range: <base>..<head>
  Dispatch: d-NNN
  ```
- Writers commit on the task branch as `<role>(<task>): <summary>` with trailer `Arbor-Dispatch: d-NNN`; nobody pushes; the user merges the PR with `--no-ff`.
- If your own first prompt starts with `Active task:` + `Role:`, you are a dispatched sub-agent: do that role directly and ignore the rules above.

Managed by Arbor. Edits outside this block are preserved; edits inside may be overwritten by `arbor update`.
<!-- ARBOR:END -->
