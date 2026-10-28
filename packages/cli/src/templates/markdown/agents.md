<!-- ARBOR:START -->
# Arbor Instructions

**First decide which agent you are.**

1. **Dispatched sub-agent**: your first prompt begins with `Active task: <path>` and `Role: explore|architect|implement|review|verify|fix|simplify` (optional `Mode: self-check|candidates|sweep` for review, `Diff: <file>` for review/verify/fix/simplify).
   Do that role directly, using the context already inlined in the prompt (marker `<!-- arbor-hook-injected -->`). If the marker is missing, read `<task>/implement.jsonl` (architect, implement) or `<task>/check.jsonl` (review, verify, fix, simplify) and every file it lists, then `prd.md`, `design.md`, `implement.md`, and the `Diff:` file if given, from the **absolute** task path given (it points into the main checkout even when you work in a worktree). Never dispatch, never commit/push/merge, never run `task.py start/current/finish`, never write under `.arbor/` (explore and architect may write only `<task>/research/*.md`; nobody edits `.arbor/spec/`). Report in the format your role instructions define.
2. **Main agent**: anything else. Follow `.arbor/workflow.md`; specs in `.arbor/spec/`; tasks in `.arbor/tasks/`; journals in `.arbor/workspace/`. The seven roles are performed by codeg assistants inside an Arbor task (the no-task quick path, at most 2 files with a known cause and no design choice, is the only exception: there you edit directly). Tiers quick (no task) / light / standard / full decide which roles take part and how long the review chain is; stored in `task.json.meta.tier` (`task.py create --tier`), inferred from artifacts when absent; see the Tiers table in `.arbor/workflow.md`. Use `delegate_to_agent` when available, else `python3 ./.arbor/scripts/dispatch.py run --role <role>`. Every dispatch task text starts with `Active task: <absolute task dir>` then `Role: <role>` (plus `Mode:` / `Diff:` where the role takes them). Never use a built-in sub-agent tool for these roles. Only the main agent commits. Prefer `/arbor:finish-work`, `/arbor:continue`, `/arbor:workflow <target>` when available.

Managed by Arbor. Edits outside this block are preserved; edits inside may be overwritten by `arbor update`.
<!-- ARBOR:END -->
