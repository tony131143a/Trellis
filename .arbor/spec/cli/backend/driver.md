---
sources:
  - packages/cli/src/templates/arbor/scripts/arbor.py
  - packages/cli/src/templates/arbor/scripts/common/driver/repos.py
  - packages/cli/src/templates/arbor/scripts/common/driver/lock.py
  - packages/cli/src/templates/arbor/scripts/common/driver/orca.py
  - packages/cli/src/templates/arbor/scripts/common/driver/executor.py
  - packages/cli/src/templates/arbor/scripts/common/worktree.py
  - packages/cli/test/scripts/driver-helpers.ts
last_verified: 2026-11-16
---
# `arbor.py` Task Driver

A task is a contract the user approves plus a plan that is a directory of node files; every
node runs as one Orca worker. `.arbor/scripts/arbor.py` and `common/driver/*.py` drive it.
Python 3.9, stdlib only. Conventions shared with the other scripts are in
[script-conventions.md](./script-conventions.md).

## Files and who writes them

| File | Writer |
|------|--------|
| `.arbor/tasks/<MM-DD-slug>/task.json` | driver only, via `common/io.py:write_json`, saved after every transition |
| `.../contract.md` | main agent + user; its hash is recorded by `start` |
| `.../nodes/<id>.md` | main agent (and `review`): the plan |
| `.../reports/<id>[.rN].md` | the worker |
| `.arbor/.runtime/specs/<task>/<id>[.rN].md` | driver: the worker's whole prompt |
| `.arbor/.runtime/workers/<task>/<id>[.rN].json` | driver (`orca.store`): the request record |

- Tasks live in the control repo's main checkout (`find_main`), never in a worktree.
- Any command on a `task.json` without `schema: 3` fails (`repos.load_data`).
- Writers have `paths`; a node without `paths` is read-only (`plan.is_writer`).
- Writers must commit inside their paths; read-only workers change and commit nothing.

## Locks

- The task lock (`common/driver/lock.py`, `<task dir>/.lock`) is held by `Task.edit()` around
  reload, change and save, and by `merge` around the git merge. Never hold it while waiting
  for Orca, running checks or running a gate.
- `sync` also takes a guard on `.arbor/.runtime/sync/<task>` without waiting, so only one
  `sync` runs per task. Other commands do not take the guard.

## Repos, branches, worktrees

- A repo key is `.` (the control repo) or a `packages.<name>` entry with `git: true`
  (`repos.repo_keys`); each repo's settings come from `repos.settings`.
- One integration branch per (task, repo), cut from the repo's base when its first writer
  starts (`repos.create_integration`). Each writer gets its own node branch and worktree cut
  from the integration HEAD; the driver merges good writers into the integration worktree
  (`worktree.merge_no_ff`) and removes the node worktree.
- Read-only nodes get no worktree or branch and are never merged.
- Orca's outcome is not trusted: the driver judges each settled node itself.
- The driver never merges into the merge target itself; `finish` prints the merge command.
- `add_worktree` may take over or delete only a leftover with no work on it; one with work
  on it is refused, never removed.

## Orca and executors

- The driver reaches Orca only through `orca.call` (`common/driver/orca.py`).
- `executors.default` names the entry (`executor.py`); any unknown key is an `ExecutorError`,
  so an older driver does not misread a newer config.
- `arbor.py` runs from the main checkout: when its own `.arbor/scripts` is another checkout's,
  it `execv`s the main checkout's `arbor.py` (`ARBOR_OWN_SCRIPTS=1` disables).
- `git.run_git` passes `-c core.quotePath=false`, so non-ASCII paths match node globs.

## Tests

Tests must never reach the real `orca`: drive the scripts through `fakeOrca` in
`test/scripts/driver-helpers.ts`. The shipped config says `command: orca`, so a fixture that
runs `start`, `sync`, `review` or `finish` without the fake creates real workspaces.
