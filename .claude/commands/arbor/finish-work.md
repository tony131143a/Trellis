# Finish Work

Wrap up the current session: check where the task stands with the driver, make sure nothing of this task is left uncommitted, archive tasks that are merged, and record the session journal. Code is committed by the roles on the task branch and merged by the user; nothing is committed to the main branch here except archive and journal bookkeeping.

## Step 1: Survey current state

```bash
python3 ./.arbor/scripts/get_context.py --mode record
python3 ./.arbor/scripts/arbor.py status
```

This prints:

- **My active tasks** — review whether any besides the current one are actually done (PR merged, AC met) and should be archived this round.
- **Git status** — quick visual on what's dirty.
- **Recent commits** — you'll need their hashes in Step 4 for `--commit`.
- **Driver state** of the current task (`BUILD` … `FINISH`, `DONE`, `STOP`) and what it waits for.

If `--mode record` surfaces other completed tasks not tied to the current session, surface them to the user with a one-shot confirmation: "These N tasks look done — archive them too in this round? [y/N]". Default is no.

Then run the spec freshness lint:

```bash
python3 ./.arbor/scripts/spec.py lint
```

This is advisory: report its findings to the user in one line (stale, broken, or unlisted spec docs) and continue — it never blocks this command.

## Step 2: Sanity check — uncommitted task work

Check both the task worktree (its path is `worktree_path` in `task.json`) and this checkout:

```bash
git -C <task worktree> status --porcelain
git status --porcelain
```

Ignore paths under `.arbor/workspace/` in this checkout; `add_session.py` and `task.py archive` manage them.

- **Dirty paths in the task worktree** — they are this task's work (for example spec updates from step 3.1). Bail out with:
  > "The task worktree has uncommitted changes: `<list>`. Return to workflow step 3.1 to commit them on the task branch before running `/arbor:finish-work`."
- **Dirty paths in this checkout** that look like this task's work — the task's code belongs on its branch, not here; tell the user and stop.
- **Unrelated dirty paths** (another window's work) — report them once and continue.
- **Genuinely unsure** — ask the user once, then route per their answer.

## Step 3: Archive task(s)

- Driver state `DONE` (the user merged the PR): the driver has already removed the worktree, archived the task and written its journal entry. Nothing to archive.
- Driver state before `DONE`: do not archive. Tell the user what the task waits for (`arbor.py next` names it; usually the PR merge) and skip to Step 4.
- Tasks started with `task.py start --no-worktree`, or extra tasks the user confirmed in Step 1:
  ```bash
  python3 ./.arbor/scripts/task.py archive <task-name>
  ```
  Each archive produces a `chore(task): archive ...` commit via the script's auto-commit. For a parent task, archive the children first.

## Step 4: Record session journal

Skip when the driver already wrote the journal entry for this task's merge and the session did nothing else. Otherwise:

```bash
python3 ./.arbor/scripts/add_session.py \
  --title "Session Title" \
  --commit "hash1,hash2" \
  --summary "Brief summary"
```

Use the task's work-commit hashes (`git log --oneline <base>..<task branch>`, or the merge commit) for `--commit`. Do not include archive commit hashes. This produces a `chore: record journal` commit.
