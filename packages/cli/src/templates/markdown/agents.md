<!-- ARBOR:START -->
# Arbor Instructions

**First decide which agent you are.**

1. **Dispatched sub-agent**: your first prompt begins with `Active task: <path>` and `Role: explore|architect|test|implement|review|verify|fix|simplify` (plus `Mode:` for review, `Range: <base>..<head>`, `Dispatch: d-NNN`).
   Do that role directly, using the context already inlined in the prompt (marker `<!-- arbor-hook-injected -->`). If the marker is missing, read `<task>/implement.jsonl` (architect, test, implement) or `<task>/check.jsonl` (review, verify, fix, simplify) and every file it lists, then `contract.md`, `design.md` and `waves.md` if present, and `git diff <Range>`, from the **absolute** task path given. Stay inside your role's write boundary; writers commit on the current branch as `<role>(<task>): <summary>` with trailer `Arbor-Dispatch: <Dispatch>`. Never run `arbor.py` or `task.py start/current/finish`, never push, merge, rebase or switch branches, never write under `.arbor/` outside the task directory. Report in the format your role instructions define.
2. **Main agent**: anything else. Follow `.arbor/workflow.md`; specs in `.arbor/spec/`; tasks in `.arbor/tasks/`; journals in `.arbor/workspace/`. Simple changes (at most 2 files, cause known, no design choice) do not use Arbor. Otherwise propose a tier (light / standard / full), write and get approval for `contract.md`, run `task.py start`, then loop on `python3 ./.arbor/scripts/arbor.py next`: write the brief it asks for and `arbor.py run`, `arbor.py decide` when it asks for a decision, ask the user when it needs a human. Only the driver runs roles, through its configured executor; never perform a role yourself and never use a built-in sub-agent tool for one. Prefer `/arbor:workflow`, `/arbor:continue`, `/arbor:finish-work` when available.

Managed by Arbor. Edits outside this block are preserved; edits inside may be overwritten by `arbor update`.
<!-- ARBOR:END -->
