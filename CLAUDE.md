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

This project is managed by Arbor. You are the **main agent**: plan, curate context, dispatch, verify, commit.

- Follow `.arbor/workflow.md` (Plan, Execute, Polish, Finish). Phase steps marked `[required]` are mandatory.
- Guidelines live in `.arbor/spec/`; tasks in `.arbor/tasks/`; journals in `.arbor/workspace/`.
- The explore / architect / implement / review / verify / fix / simplify roles run as **codeg assistants on other models**, never in this session and never through the built-in `Agent`/`Task` tool.
  - If `mcp__codeg-mcp__delegate_to_agent` is in your tool list: call it with the `assistant_id` for the role and target shown in the `<dispatch>` session context (or from `python3 ./.arbor/scripts/dispatch.py resolve --role <role>`), `working_dir` = repo root (or the worktree for parallel work), and `task` = the header block below followed by a self-contained brief. Collect results with `get_delegation_status(task_ids, wait_ms=60000)`.
  - Otherwise: `python3 ./.arbor/scripts/dispatch.py run --role <role> [--mode M] [--diff F] [--target star|pi|codex] --wait` with the brief on stdin.
- Every dispatch `task` MUST start with:
  ```
  Active task: <absolute path of the task directory in this checkout>
  Role: explore | architect | implement | review | verify | fix | simplify
  ```
  Optional header lines: `Mode: self-check|candidates|sweep` (review only), `Diff: <absolute .diff path>` (review/verify/fix/simplify; make one with `dispatch.py snapshot` / `dispatch.py diff`), `Target: star|pi|codex`, `Workspace: <worktree>`. A project hook inlines the role's manifest (`implement.jsonl` for architect/implement, `check.jsonl` for review/verify/fix/simplify), `prd.md`/`design.md`/`implement.md`, and the `Diff:` file for you.
- Run the whole workflow on one target with `/arbor:workflow-star` or `/arbor:workflow-pi`; override a single call with `Target: <t>` in the header or `--target`.
- Only you commit (Phase 3.4). Sub-agents never commit, push, merge, or run `task.py start/current`.
- If your own first prompt starts with `Active task:` + `Role:`, you are a dispatched sub-agent: do that role directly and ignore the dispatch rules above.

Managed by Arbor. Edits outside this block are preserved; edits inside may be overwritten by `arbor update`.
<!-- ARBOR:END -->
