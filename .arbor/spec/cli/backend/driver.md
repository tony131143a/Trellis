---
sources:
  - packages/cli/src/templates/arbor/scripts/arbor.py
  - packages/cli/src/templates/arbor/scripts/common/driver/*.py
  - packages/cli/src/templates/arbor/scripts/common/contract.py
  - packages/cli/src/templates/arbor/scripts/common/worktree.py
  - packages/cli/test/scripts/driver-helpers.ts
last_verified: 2026-11-13
---
# `arbor.py` Task Driver (Code Spec)

Executable contract of `.arbor/scripts/arbor.py` and `common/driver/*.py`. A task is a
contract the user approves plus a plan that is a directory of node files; every node
runs as one Orca worker. Python 3.9, stdlib only. Conventions shared with the other
scripts are in [script-conventions.md](./script-conventions.md).

## 1. Files and who writes them

| File | Writer | Note |
|------|--------|------|
| `.arbor/tasks/<MM-DD-slug>/task.json` | driver only | schema 3, via `common/io.py:write_json`, saved after every transition |
| `.../contract.md` | main agent + user | hash recorded by `start` |
| `.../nodes/<id>.md` | main agent (and `review`) | the plan |
| `.../reports/<id>[.rN].md` | the worker | emptied by the driver before each start |
| `.arbor/.runtime/specs/<task>/<id>[.rN].md` | driver | the worker's whole prompt |
| `.arbor/.runtime/workers/<task>/<id>[.rN].json` | driver (`orca.store`) | request record: Orca ids, agent, spec/report path, `request_id`, `failed_starts` |

Tasks live in the control repo's main checkout (`find_main`: first directory above the cwd
holding `.arbor/`, resolved with `main_checkout`), never in a worktree.

## 2. `task.json` (schema 3)

Any command on a `task.json` without `schema: 3` fails with
`<task> was started by arbor < 1.0: finish it with that version` (`repos.load_data`).

```text
schema, name, title, created, status: planning | active | done | abandoned,
default_repo, contract_hash, approved, orca_run, ended, abandon_reason,
review: {heads: {repo: sha}, at} | null,
reviewers: {node id: {repo, head}},          # nodes written by `review`
rounds, allowance: {rounds, nodes}, stopped: null | "rounds" | "max_nodes",
cleanup: {done: [steps], archive: path},
repos: {key: {root, branch, worktree, base, base_ref, merge_target, head,
              baseline: {sha, checks: {id: {passed, failed_tests, skipped}}} | null,
              gate: {sha, green, failing: [ids], notes, at} | null, merged, merge_commit}},
nodes: {id: {seq, status: pending | invalid | running | merged | done | failed | cancelled,
             attempt, title, repo, tier, paths, after, checks,
             file_hash, changed_noted, worktree, branch, base, tree, request, agent,
             started, ended, merged_sha, reason, attention, start_error, failed_starts}}
```

- Repo key: `.` (the control repo) or a `packages.<name>` entry with `git: true`
  (`repos.repo_keys`). `default_repo` comes from `new --repo`; default `default_package`
  when that is a git package, else `.`.
- `repos[key]` exists once the first writer node of that repo starts. `head` is the
  integration HEAD the driver last put there (the base, then each merge sha).
- Writers have `paths`; a node without `paths` is read-only (`plan.is_writer`).

## 3. Node files (`common/driver/plan.py`)

```text
---
title: ...          repo: <key>        paths: [glob, ...]   after: [id, ...]
tier: write | light | explore | review | <executors.<default>.agents name>   checks: [AC-1]
---
<brief: free text>
```

- Id = file stem, `[a-z0-9][a-z0-9-]{0,39}`. Lists: `[a, b]`, `a, b`, or `- item` lines;
  `# ...` after whitespace is a comment. Unknown or duplicate keys are an error. Defaults:
  `repo` = the task's `default_repo`, `tier` = `write`.
- A node is `invalid` (reason stored, never started, other nodes unaffected) when: bad id
  or frontmatter, unknown repo or tier, a `checks` id that is not an `auto` row of the
  contract's Verification map or whose row runs in another repo, a path that is absolute
  or contains `..`, an unknown `after` id, or a dependency cycle. Fixing the file
  revalidates it on the next `sync`.
- Pending and invalid nodes are re-read on every `sync`; a pending node whose file is gone
  is dropped. When a start is first attempted the driver freezes `file_hash`; a later edit
  is reported once (`node X changed after it started; ignored`) and ignored, and the node
  is kept even if its file is deleted. `retry` clears the freeze.
- `paths` are repo-relative globs (`contract.path_matches`, `**` supported); overlap is
  `contract.paths_overlap` (literal-prefix test).
- Read-only nodes: no worktree, branch or setup, never merged, no overlap rule; they count
  toward `max_parallel` and `max_nodes`.

## 4. Commands

`python3 .arbor/scripts/arbor.py [--task <name>] <command>`. Exit 0 ok, 1 refused or error
(`refused: ...` or `error: ...` on stderr), 2 usage (argparse). Without `--task` the default
task is the only non-archived one with schema 3 and status `planning` or `active`; none or
several is an error naming them. `--task` also finds archived tasks.

| Command | Contract |
|---------|----------|
| `new "<title>" [--slug s] [--repo key]` | Creates `<MM-DD>-<slug>` (slug derived from the title, cut to 40 chars; `--slug` matches `[a-z0-9][a-z0-9-]{0,59}`) with `contract.md` from `contract.default_contract_content`, empty `nodes/` and `reports/`, `task.json` status `planning`. Refuses an existing directory or unknown repo. |
| `start [--reapprove]` | Planning only. Refuses unless `validate_contract` passes (every criterion has a map row, every `auto` row a command), every map `repo` exists, and `orca.ensure_projects` succeeds for `.`, the default repo and every map repo: it compares resolved paths with `orca repo list` and runs `orca repo add --path <root>` for a missing one (prints `added <root> to Orca`; a refused add refuses the start). `sync` does the same for the repos of the nodes it is about to start (event `added <root> to Orca`; a failure is the nodes' `start_error`). Records `contract_hash`, `approved`, status `active`. Creates no worktree and no Orca Run. `--reapprove` on an active task runs `validate_contract` again and re-records the hash. An `auto` row whose first word (after `VAR=value` assignments) is no shell word, path or program on PATH is not a command (`contract.not_a_command`). |
| `sync [--wait [DURATION]] [--json]` | Section 5. |
| `review` | Section 6. |
| `review --pass` | Section 6. |
| `finish` | Section 6. |
| `status [--json] [--all]` | No lock, no Orca call. Lists nodes, repos (HEAD, gate, merged), review, and the `next:` line; `--json` prints the `sync --json` object; `--all` prints one line per task. |
| `cancel <id>` | pending, invalid, failed become `cancelled`. A running node is cancelled only when `orca.stop` proves the worker stopped, else refused. The worktree stays and is named. |
| `retry <id> [--force]` | A failed or cancelled node becomes pending with `attempt + 1`; refused without `--force` once the node has run twice. The old worktree is removed (not forced, branch deleted); when Orca refuses it stays and is noted. |
| `rejudge <id>` | A failed writer whose worktree exists is set running and judged again (section 5, step 4) on that worktree; good, it is merged. For a judgment that was wrong, or commits fixed by hand. |
| `resume` | Clears `stopped` and adds 1 to `allowance.nodes` (`max_nodes`) or `allowance.rounds` (a task stopped by an older driver). |
| `abandon [--reason R]` | Stops running workers (a worker Orca cannot prove stopped is noted), status `abandoned`. Removes nothing; prints the integration and node worktrees left behind. |

## 5. `sync` (`common/driver/sync.py`)

Each pass, in order (`sync_pass`):

1. **Plan**: `plan.update` reads `nodes/*.md`. In `planning` an unparsable contract is
   tolerated (read-only nodes still run); in `active` it is an error. (`rounds` counts
   reviews: `review` increments it when it writes reviewer nodes.)
2. **Mail**: `orca orchestration check --run <orca_run>`; failure ignored; each message is
   printed as `orca mail: <type> from <sender>: <subject>: <body>` (keys `messages`, `mail`
   or `items`).
3. **Observe** every running node through `orca.observe`:
   `running` nothing; `waiting` attention `waiting for a person (<what>)`; `unstopped`
   attention with the reason; `idle` (a finished turn with no `worker_done`, after 60 s):
   settled when the work is evidently complete (writer: commits beyond `base` and a clean
   worktree; reader: non-empty report) and `orca.stop` proves the stop, otherwise attention
   with the `orca orchestration send --to dispatch:<id> ...` hint; `done` or `failed`:
   settled. A `running` worker with nothing to show (writer: no commit and a clean
   worktree; reader: empty report) 10 minutes after its start whose `worker-read` answers
   `fallbackReason: session_not_reported` (the agent never began) is stopped and settled as
   `the worker did not start: ...`. An Orca error on one node is a note, not a failure.
4. **Judge** each settled node (Orca's outcome is not trusted):
   writer: no commit beyond `base` fails `no commits`; unclean tree `uncommitted changes`;
   files changed in `base..HEAD` outside `paths` `outside its paths: ...`; each `checks`
   id is run (`gate.run_check`) in the node worktree, red (after `gate.compare` with the
   repo's baseline) fails `checks red: AC-1`. A check that restates the gate (below) is
   skipped: the gate runs it after the merge.
   Reader: empty report fails `no report`; in the repo's integration worktree a changed
   `git status --porcelain` or HEAD fails `left changes in <path>` (a main checkout is not
   checked). Reader success sets `done`. A failed node keeps its worktree; its report's
   first 5 lines are printed.
5. **Merge** good writers in `seq` order under the task lock:
   `worktree.merge_no_ff(<integration worktree>, <node branch>, "merge <task>/<node>")`.
   Conflict fails the node `merge conflict: files` (the merge is aborted). Success sets
   `merged`, `merged_sha`, `repos[repo].head`, then the node worktree and branch are removed
   (not forced; a refusal is a note). A branch already merged is recognised, so a crash
   between merge and save is recovered by the next `sync`.
6. **Start** ready nodes (`plan.ready`): pending, every `after` node `merged` or `done`
   (a failed, cancelled, invalid or missing dependency gives attention `blocked by <dep>`),
   fewer than `max_parallel` running, no overlapping writer of the same repo running or
   chosen (first `seq` wins), and writers only when the task is `active`. Budgets, checked
   only when something is ready: nodes in the task `> max_nodes + 10 * allowance.nodes`
   sets `stopped: max_nodes`. (Reviews are bounded by `review_rounds`, section 6.)
   Then: create the Orca Run if `orca_run` is empty (`orca.create_run`; failure is the event
   `no node started: ...`), create missing integration branches (section 8), and start the
   chosen nodes in parallel threads with no lock held (`start_one`): writer: node worktree
   plus `worktree.setup` (failure fails the node `worktree.setup failed`, worktree removed
   with `force`); reader: the repo's integration worktree if the task has one, else the
   repo's main checkout, recording `base` and `tree`. Then the spec file, the request record
   and `orca.start`. A failed start leaves the node pending with `start_error` and
   `failed_starts`; the next `sync` retries on the same Orca Task; the third failure fails
   the node `start failed 3 times: ...`.
7. **Gate**: only when nothing is running, nothing was started in this pass, and some node
   is `merged` or `done`: for each repo whose integration HEAD differs from `gate.sha`,
   `gate.run_gate(<repo gate.commands>, <contract limited to that repo's map rows>, <integration worktree>)`.
   Checks are `GATE-1..n` first, then every `auto` row with a command; all run, each in its
   own process group with a 30-minute limit (a timeout kills the group). An `auto` row whose
   command is only the repo's gate commands joined by `&&` (`gate.gate_parts`: exact text,
   spacing aside) is not run: it takes their result (`same_as`; it blocks when one of them
   blocks). `start` and `--reapprove` print `note: AC-n restates the gate of <repo> ...`. `gate.compare`
   with the repo's `baseline`: a check red at the base too blocks only with a failed test id
   (pytest `FAILED`/`ERROR` summary lines) the base did not have, or when no ids can be read;
   more skips than at the base are noted. Green means nothing blocks. Stored as
   `gate: {sha, green, failing (blocking), notes, at}`. Then `drift`: when `base_ref` is
   `<remote>/<branch>`, `git fetch` it (60 s, failure ignored) and print how many commits it
   moved past the integration HEAD and the files `git merge-tree` reports conflicting.
   `finish` prints the same note under each merge command.
8. **Report**: events, then `contract.md changed since it was approved: get it re-approved,
   then arbor.py start --reapprove` when the hash differs, then exactly one `next:` line.
   `--json` prints `{task, status, events, nodes, repos, contract_changed, next: {kind, text}}`.

`--wait [DURATION]` (`30s`, `90m`, `2h`, seconds; default `executors.<default>.timeout`, else
60 min) first runs the **baseline**: for each repo without `baseline` whose integration HEAD
is still its base, the repo's gate commands only (no map rows) are stored as `baseline`
(HEAD already moved: `null`); a red baseline is an event asking to tell the user. Then it
polls `orca.observe` of the running nodes every 10 s without any lock until one is
no longer `running` or (checked once a minute) a worker evidently never started, then does
a normal pass. The gate result and `review.heads` are tied to HEAD shas, so any merge makes them stale
without further bookkeeping.

### `next:` kinds (`next_step`, first match wins)

| kind | Text starts with | When |
|------|------------------|------|
| `done` / `abandoned` | `the task is ...` | terminal status |
| `stopped` | `ask the user:` | budget used up; `arbor.py resume` grants more |
| `decide` | `decide:` | failed or invalid nodes, attention items, nodes with `start_error`; each lists `retry <id> \| cancel <id> \| edit or add nodes` |
| `inline` | `inline:` | a running read-only node is `inline` (its agent is the main agent): lists each node's brief and report path; the main agent runs it in its own sub-agent and the report file settles it |
| `wait` | `wait:` | a node is running: run `arbor.py sync --wait` in the background |
| `contract` | `contract:` | status `planning`: fill and get the contract approved, then `start` |
| `plan` | `plan:` | no pending, running, merged or done node |
| `sync` | `sync:` | pending nodes, or a repo whose HEAD has no gate result yet |
| `fix` | `fix:` | a gate is red at the current HEAD; add fix nodes naming the failing check |
| `finish` | `finish:` | `review.heads` equals the current HEADs |
| `review` | `review:` | gates green, review missing or stale: either `arbor.py review` starts one reviewer per repo, or (when every repo has a `done` reviewer node at its HEAD) read the report paths, then `review --pass`; with no reviewer round left (`rounds_left`: `review_rounds + allowance.rounds - rounds`) `review: no reviewer round left ...` names `git diff <last reviewed head, else base>..<head>` per repo for the main agent to read itself |

## 6. `review`, `review --pass`, `finish` (`common/driver/finish.py`)

**Gate preconditions** (`gate_problems`, shared): every repo with an integration branch has
a gate result at its current HEAD and it is green; auto rows whose repo never had a writer
node are reported as unchecked (when the task has any repo).

- `review`: status `active`, no pending or running node, gates as above. For every repo whose
  HEAD is neither in `review.heads` nor covered by a live reviewer node it writes
  `nodes/review-<n>[-<k>].md` (`k` only when several repos): read-only, `title: Review <repo> <base7>..<head7>`,
  `repo`, `tier: review` when `executors.<default>.agents.review` exists (else `tier: write`, never `explore`), brief =
  `prompt.review_brief` (contract path, worktree, `git diff <base>..<head>`, the `GATE-n` and
  `auto` checks already green). Records `reviewers[id] = {repo, head}` and increments `rounds`; notes when the review agent is the write agent. Prints `next: arbor.py sync`. Refused with `no reviewer round left` when `rounds_left` is 0 (`executors.<default>.review_rounds`, default 1; 0 = no reviewer nodes).
- `review --pass`: status `active`, no node `pending`, `running`, `failed` or `invalid`,
  contract hash unchanged, gates as above. Records `review = {heads, at}`.
- `finish`, first run: status `active`; no node `pending`, `running`, `invalid` or `failed`;
  contract unchanged; gates as above; `review.heads` equals the current HEADs. Per repo
  `merged` is true when the integration HEAD equals its base or is an ancestor of
  `merge_target` (`merge_commit` is the first-parent merge that brought it in). If any repo
  is unmerged it prints the `manual` Verification-map rows and
  `git -C <root> merge --no-ff <branch>` (with `merge_target` checked out) and exits 0.
  The driver never merges into the target itself.
- `finish`, cleanup (reached when all are merged, and on every rerun once `cleanup.done` is
  non-empty): each step is appended to `cleanup.done` before the next. `leftovers`: remove
  worktrees of failed, cancelled and merged writer nodes (not forced; branches deleted only
  for merged ones; a refusal prints `leftover: ...` and does not block). `repo:<key>`: remove
  the integration worktree (not forced) and delete its branch; a refusal aborts with exit 1.
  `archive`: move the task directory to `archive/<YYYY-MM>/<task>`, delete
  `.arbor/.runtime/{specs,workers,sync}/<task>`, status `done`.
  Then (`tail`, also on every later `finish` of a done task): commit only the path move in the
  control repo (`git commit --only -- <old> <new> --no-verify`, message `chore(task): archive <task>`),
  skipped with a note when `session_auto_commit` is false or the control checkout is detached
  or mid merge/rebase; write the journal entry by running `add_session.py` as a subprocess
  with `--idempotency-key arbor-finish-<task>`; its failure is a note.

## 7. Locks (`common/driver/lock.py`)

- **Task lock** `<task dir>/.lock`: `os.mkdir` is the atomic acquire; a `pid` file names the
  owner; a lock whose pid is dead (or has no pid for 5 s) is taken over; re-entrant inside one
  process; waits 30 s then `LockTimeout`; the directory carries a `.gitignore` of `*`.
  `Task.edit()` holds it around reload, change and save; `merge` holds it around the git
  merge. Never hold it while waiting for Orca, running checks or running a gate.
- **Sync guard**: `sync` takes the same lock primitive on `.arbor/.runtime/sync/<task>` with
  `timeout=0`. When another live `sync` holds it the command prints `another sync is running`
  and exits 0. Other commands do not take the guard.

## 8. Repos, branches, Orca

- **Per-repo settings** (`repos.settings`): `.` uses the top-level `gate.commands`,
  `worktree.setup`, `worktree.branch_prefix`; a package repo uses the same keys under
  `packages.<name>.execution` (that section replaces, not merges with, the control config,
  `execution.frozen_execution`) plus `execution.base_ref` and `execution.merge_target`.
- **Integration branch** (`create_integration`): one per (task, repo), created when the first
  writer of that repo starts. Branch `<prefix><task>`, Orca workspace `<task>`, parent = the
  repo's main checkout, cut from `base_ref` resolved to a commit (no fetch) or the main
  checkout's HEAD. `merge_target` is the configured one or the branch checked out in the main
  checkout then; a detached checkout without `merge_target` fails the repo's writers' starts.
  A failing `worktree.setup` removes the new worktree (forced) and fails the same way.
- **Node branch**: `<prefix><task>--<id>` (attempt n > 1: `--<id>--r<n>`), workspace
  `<task>-<id>` (`-r<n>`), parent = the integration worktree, cut from its HEAD at start.
  `add_worktree` takes over a worktree that already has the branch checked out at the start
  point with a clean tree (left by an interrupted start) and deletes a leftover branch at the
  start point that has no worktree; either one with work on it is refused, never removed.
  It fails when Orca answered with a different branch (it suffixes taken names) and removes
  what it just made.
- **Executor** (`executor.py`): `executors.default` names the entry; it must be `type: orca`
  with `command` and `agents.write` (or the older `agent`). `agents.<tier>` is an agent id or
  `{agent, model, effort}` (`effort` needs `model`: Orca takes `--effort` only with `--model`;
  `worker-start` gets `--model` and `--effort` when set); the older `tiers.<name>.agent` still
  works. Optional `timeout`, `max_parallel`, `max_nodes` (default 30), `review_rounds` (default 1), `keep_open`; any other
  key is an `ExecutorError` (an older driver must not misread a newer config). A node that
  names no tier gets `explore` when it is read-only (no `paths`) and `agents.explore` exists,
  else `write`. `main` (optional) is the agent of the session that runs the driver; unset, `executor.main_agent()` is `claude` when `CLAUDECODE` is set, else unknown; `none` disables. A read-only node whose agent is the main agent is `inline`: `start_one` records `inline: true` and `spec` and starts no Orca worker (`orca.stop` is a no-op), `observe` settles it when its report is non-empty, `judge` is unchanged, `wait` ignores it. Writers never inline. `agent_for(tier)` / `options_for(tier)` return the `write` entry for `write` and
  for `explore`, `review`, `light` when they are not configured, and `agent_for` raises
  `ExecutorError` for any other unknown tier.
- **Orca calls** (`orca.call` runs `<command> <args> --json`, 60 s unless noted; a missing
  binary is an `ExecutorError`): `repo list` (`start`); `worktree create` and `worktree rm`
  (`worktree.py`, 120 s); `orchestration run-create --objective "arbor <task>"`;
  `worker-start` (300 s; `--spec "Read <spec file> and do exactly what it says; ..."` — one
  line, since a long typed prompt can stall an agent's input box —, `--task-title "<task> <node>"`, `--run`,
  `--worktree path:<dir>`, `--agent`, `--retry-request <id>`, `--keep-open` when set; the
  retry form uses `--task <id> --retry-of <dispatch>` after `worker-release`; `consumer_fenced`
  triggers `run-use --id <run>` and one new request); `worker-stop --dispatch`;
  `worker-show --dispatch --full`; `worker-read --dispatch --limit 1` (the start check);
  `orchestration check --run` (mail). Nothing else.
- **Driver copy**: `arbor.py`, before importing `common`, finds the main checkout
  (`git rev-parse --git-common-dir`) and, when its own `.arbor/scripts` is another
  checkout's (a linked worktree carries the scripts of the commit it was cut from),
  `execv`s the main checkout's `arbor.py` (note on stderr; `ARBOR_OWN_SCRIPTS=1` disables).
- **Git output**: `git.run_git` passes `-c core.quotePath=false`, so non-ASCII paths are
  printed as they are and match node globs.
- **Worker spec** (`prompt.worker_spec`): first line `Arbor node: <task>/<node>`, then the
  contract path, `Paths you own` (or the read-only sentence), `Checks that must pass`, the
  report path, rules, and `Brief`. Writers must commit inside their paths and send
  `worker_done` with `--report-path`; read-only workers change and commit nothing.

## 9. Tests

- `test/scripts/arbor1-{plan,sync,finish,polyrepo}.integration.test.ts` drive the real
  scripts in a temp control repo built by `setupProject` in `test/scripts/driver-helpers.ts`.
- **The Orca CLI is always the fake** from that file (`fakeOrca` writes `fake_orca.py` and sets
  `executors.<default>.command` to it); it logs calls in `<tmp>/orca/calls.jsonl` and `work()`
  plays the worker. Tests must never reach the real `orca`: the shipped config template says
  `command: orca`, so a fixture that runs `start`, `sync`, `review` or `finish` without the
  fake would call the real CLI and create real workspaces. Run the suite with a failing
  `orca` shim first on `PATH` when in doubt.
- The suite skips itself when `python3` is missing (`hasPython`).
