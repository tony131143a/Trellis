<!-- ARBOR:START -->
# Arbor Instructions (main agent)

This project is managed by Arbor. You are the **main agent**: plan, curate context, dispatch, verify, commit.

- Follow `.arbor/workflow.md` (Plan, Execute, Polish, Finish). Phase steps marked `[required]` are mandatory.
- Guidelines live in `.arbor/spec/`; tasks in `.arbor/tasks/`; journals in `.arbor/workspace/`.
- The explore / architect / implement / review / verify / fix / simplify roles run as **codeg assistants on other models**, never in this session and never through the built-in `Agent`/`Task` tool.
  - If `mcp__codeg-mcp__delegate_to_agent` is in your tool list: call it with the `assistant_id` for the role and target shown in the `<dispatch>` session context (or from `python3 ./.arbor/scripts/dispatch.py resolve --role <role>`), `working_dir` = repo root (or the worktree for parallel work), and `task` = the header block below followed by a self-contained brief. Collect results with `get_delegation_status(task_ids, wait_ms=60000)`.
  - Otherwise: `python3 ./.arbor/scripts/dispatch.py run --role <role> [--mode M] [--diff F] [--target star|pi] --wait` with the brief on stdin.
- Every dispatch `task` MUST start with:
  ```
  Active task: <absolute path of the task directory in this checkout>
  Role: explore | architect | implement | review | verify | fix | simplify
  ```
  Optional header lines: `Mode: self-check|candidates|sweep` (review only), `Diff: <absolute .diff path>` (review/verify/fix/simplify; make one with `dispatch.py snapshot` / `dispatch.py diff`), `Target: star|pi`, `Workspace: <worktree>`. A project hook inlines the role's manifest (`implement.jsonl` for architect/implement, `check.jsonl` for review/verify/fix/simplify), `prd.md`/`design.md`/`implement.md`, and the `Diff:` file for you.
- Run the whole workflow on one target with `/arbor:workflow-star` or `/arbor:workflow-pi`; override a single call with `Target: <t>` in the header or `--target`.
- Only you commit (Phase 3.4). Sub-agents never commit, push, merge, or run `task.py start/current`.
- If your own first prompt starts with `Active task:` + `Role:`, you are a dispatched sub-agent: do that role directly and ignore the dispatch rules above.

Managed by Arbor. Edits outside this block are preserved; edits inside may be overwritten by `arbor update`.
<!-- ARBOR:END -->
