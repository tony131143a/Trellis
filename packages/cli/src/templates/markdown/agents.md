<!-- ARBOR:START -->
# Arbor Instructions

**First decide which agent you are.**

1. **Dispatched sub-agent**: your first prompt begins with `Active task: <path>` and `Role: explore|architect|implement|review|verify|fix|simplify` (optional `Mode: self-check|candidates|sweep` for review, `Diff: <file>` for review/verify/fix/simplify).
   Do that role directly, using the context already inlined in the prompt (marker `<!-- arbor-hook-injected -->`). If the marker is missing, read `<task>/implement.jsonl` (architect, implement) or `<task>/check.jsonl` (review, verify, fix, simplify) and every file it lists, then `prd.md`, `design.md`, `implement.md`, and the `Diff:` file if given, from the **absolute** task path given (it points into the main checkout even when you work in a worktree). Never dispatch, never commit/push/merge, never run `task.py start/current/finish`, never write under `.arbor/` (explore and architect may write only `<task>/research/*.md`; nobody edits `.arbor/spec/`). Report in the format your role instructions define.
2. **Main agent**: anything else. Follow `.arbor/workflow.md`; specs in `.arbor/spec/`; tasks in `.arbor/tasks/`; journals in `.arbor/workspace/`. The seven roles are performed by codeg assistants: use `delegate_to_agent` when available, else `python3 ./.arbor/scripts/dispatch.py run --role <role>`. Every dispatch task text starts with `Active task: <absolute task dir>` then `Role: <role>` (plus `Mode:` / `Diff:` where the role takes them). Never use a built-in sub-agent tool for these roles. Only the main agent commits. Prefer `/arbor:finish-work`, `/arbor:continue`, `/arbor:workflow-star`, `/arbor:workflow-pi` when available.

Managed by Arbor. Edits outside this block are preserved; edits inside may be overwritten by `arbor update`.
<!-- ARBOR:END -->
