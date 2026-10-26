---
sources:
  - packages/cli/src/templates/arbor/scripts/dispatch.py
  - packages/cli/src/cli/index.ts
last_verified: 2026-10-25
---
# `dispatch.py` / `arbor dispatch`

Terminal dispatch of the implement / check / research roles to codeg
assistants through `codeg-cli`, for sessions without the codeg MCP tools. The
prompt contract (header protocol, context order, resolution order) is in
[dispatch.md](./dispatch.md); this doc is the command surface.

---

## 1. Scope / Trigger

- `packages/cli/src/templates/arbor/scripts/dispatch.py`, shipped to
  `.arbor/scripts/dispatch.py` (registered in `templates/arbor/index.ts`
  `getAllScripts()`, so init copies it and update hashes it).
- `arbor dispatch ...` in `packages/cli/src/cli/index.ts`: finds the nearest
  ancestor holding `.arbor/`, runs `<python> <root>/.arbor/scripts/dispatch.py
  <args...>` with inherited stdio from the caller's cwd, and exits with its
  status. Python is `ARBOR_PYTHON_CMD`, else `python` on Windows and
  `python3` elsewhere. The startup update notice is suppressed for
  `dispatch` so `--json` output stays clean.

## 2. Signatures

```text
dispatch.py run --role R [--target T] [--task DIR] [--workspace WT] [--finish]
                [-p/--prompt TEXT | --prompt-file F | stdin]
                [--detach] [--wait] [--worktree[=NAME]]
                [--standalone] [--data-dir DIR] [--url URL]
                [--dry-run] [--print-prompt]
dispatch.py wait RUN... [-o OUT] [--timeout DUR] [--url URL]
dispatch.py resolve --role R [--target T] [--json]
dispatch.py target [get | set <T> | clear]
dispatch.py print-context --role R [--task DIR] [--finish] [--workspace WT]
                          [--target T] [-p TEXT | --prompt-file F | stdin]
dispatch.py codeg-setup [--target T] [--install] [--db PATH] [--codeg-cli PATH]
```

`run` argv handed to codeg-cli (global options before `run`):

```text
<codeg-cli> [--standalone] [--data-dir DIR] [--url URL] run
  -A <dispatch.targets.<target>.<role>> -w <workspace or repo root>
  --permissions <dispatch.permissions> --timeout <dispatch.timeout>
  --title "arbor <role> <task dir name or ->" [--worktree | --worktree=NAME]
  (--detach | -o .arbor/.runtime/dispatch/<stamp>.result.md) -p -
```

The prompt goes on stdin. `<codeg-cli>` is `dispatch.codeg_cli`, else
`$CODEG_CLI`, else `codeg-cli` on PATH, else
`/Applications/codeg.app/Contents/MacOS/codeg-cli` (macOS).

## 3. Contracts

- **One assembler.** `run` and `print-context` turn the flags into a header
  block (`Active task:` absolute, `Role:` with `[finish]`, `Target:`,
  `Workspace:`), prepend it to the brief, and run that text through the
  hook's own steps: `parse_dispatch_header` -> `resolve_task_dir` ->
  `build_dispatch_prompt`. `print-context` output therefore byte-equals the
  hook's `updatedInput.task` for the same header and brief.
- **Header lines in the brief** fill in what the flags leave unset (task,
  target, workspace, `[finish]`); `--role` always wins.
- **Task**: `--task` (bare name, repo-relative, or absolute; contained via
  `resolve_task_ref`), else the session pointer (`ARBOR_CONTEXT_ID` or the
  single-session fallback). implement / check without a task exit 2.
- **Target**: `--target` or `Target:` in the brief, else
  `resolve_dispatch_target`. `run` always writes the effective `Target:` line;
  `print-context` writes it only when given, as the hook would see it.
- **Runtime files** (`.arbor/.runtime/`, gitignored): `dispatch/<stamp>.md`
  (prompt, created exclusively; `<YYYYmmdd-HHMMSS>-<role>` plus `-2`, `-3` on
  collision), `dispatch/<stamp>.result.md` (`-o`), `dispatch/<stamp>.run`
  (`--detach` run id), `dispatch-target`, `codeg-assistants/<target>-<role>.md`,
  `codeg-assistants.json`, `codeg-db-backups/codeg.db.<timestamp>`.
  `--dry-run` and `--print-prompt` write nothing.
- **Foreground is the default**; `--wait` only matters with `--detach`.
- **`wait`** loops `codeg-cli result RUN --wait <chunk>s -o <out>` (chunks of
  at most 600 s) until the run ends or `--timeout` (default
  `dispatch.timeout`) runs out; exit 6 means keep waiting, exit 4 is reported
  as codeg unreachable. `<out>` defaults to the `<stamp>.result.md` whose
  `.run` file holds that id (prefix match), else `dispatch/<RUN>.result.md`.
  Several runs are waited in order; the first non-zero code is returned.
- **`target set`** validates against the configured targets, writes
  `.arbor/.runtime/dispatch-target`; `clear` removes it. Every form prints
  `<effective target> (source: <source>)`.
- **`resolve`** prints `role`, `target (source)`, `assistant`, `assistant_id`
  (from `codeg-assistants.json` `by_name`, else "unknown (run ... codeg-setup)");
  `--json` prints `{role, target, target_source, assistant, assistant_id,
  agent_type}` with `assistant_id: null` when unknown.
- **`codeg-setup`** renders every target x role (or `--target` only) from
  `.arbor/agents/<role>.md` plus a one-line note naming the assistant, role,
  target and agent type, and prints the manual codeg UI steps.
- **`codeg-setup --install`** (default DB
  `~/Library/Application Support/app.codeg/codeg.db`, macOS only; `--db`
  anywhere):
  - `PRAGMA table_info(assistant)` must equal the 15 columns `id uid name
    description avatar agent_type agent_options label_snapshot instructions
    enabled sort_order revision created_at updated_at deleted_at`, otherwise
    refuse, print the manual steps, exit 2, touch nothing.
  - Online backup first, then `BEGIN IMMEDIATE`; a live assistant with the
    same name (`COLLATE NOCASE`) and another uid aborts with ROLLBACK.
  - Upsert by `uuid5(NAMESPACE_URL, "arbor/<target>/<role>")`; updates set
    `enabled=1`, `deleted_at=NULL`, `revision=revision+1`.
  - `agent_type` from `dispatch.targets.<t>.agent_type`; `agent_options` =
    `{"config_values": {model, thought_level}}` for the keys the target sets
    (else `{}`); `label_snapshot` lists exactly those options (codeg rejects
    a value without a listed option).
  - Limits checked before writing: name 40 chars, description 200,
    instructions 20000.
- **Registry**: after either mode, `codeg-cli assistants --json` (array of
  `{id, name, agent, description}`) is mapped through `dispatch:` names to
  `codeg-assistants.json` (shape in [dispatch.md](./dispatch.md)). If codeg
  is unreachable the step is skipped with a message; after a successful
  `--install` the ids are read from the database instead.

## 4. Validation & Error Matrix

| Condition | Exit | Behavior |
| --- | --- | --- |
| Unknown `--role` / bad flags | 2 | argparse usage error |
| Unknown target (flag, brief, `target set`) | 2 | lists known targets |
| implement / check without a task, or `--task` not found | 2 | nothing written |
| `--finish` with a role other than check | 2 | |
| `--standalone` with `--detach` or `--url` | 2 | codeg-cli would refuse too |
| codeg-cli not found / not executable | 127 | |
| codeg-cli failed | its code | 3 timeout, 4 unreachable, 5 permission, 6 still running |
| `wait -o` with several runs, bad `--timeout` | 2 | |
| `--install` schema mismatch, DB missing, non-macOS without `--db` | 2 | manual steps printed instead |
| `--install` name clash | 1 | transaction rolled back |
| `.arbor/agents/<role>.md` missing | 1 | suggests `arbor update` |
| `arbor dispatch` outside a project / script missing | 1 | message on stderr |

## 5. Good / Base / Bad Cases

- **Good**: `python3 ./.arbor/scripts/dispatch.py run --role implement --task 10-24-foo --wait <<< "Implement step 1 of implement.md"`.
- **Base**: `run --role research --target pi -p "Summarize spec layout"` with no active task: no `Active task:` line, spec overview context only.
- **Bad**: `run --role research --standalone` without `--data-dir`: the throwaway server has no assistants, so codeg-cli fails with `unknown_assistant` (dispatch.py warns first).

## 6. Tests Required

`test/scripts/dispatch-py.integration.test.ts` (fake `codeg-cli` via
`dispatch.codeg_cli`; never the real binary or database):

- `print-context` byte-equals the hook for implement, `check --finish`, research (with and without task).
- `run --dry-run` argv; `run` argv + stdin + stored prompt/result; `--detach --wait` with an exit-6 retry; `wait` default output mapping; `--standalone --detach` refused.
- `resolve --json` before/after the registry; `target set/get/clear` and unknown target.
- `codeg-setup` print mode (three files, registry from `assistants --json`), unreachable codeg, `--install` idempotent upsert into a 15-column table, refusal on a different schema.

`test/commands/dispatch.integration.test.ts`: `arbor dispatch --help` /
argument / exit-code passthrough via the built bin, and the no-project error.
SessionStart ids: `test/scripts/dispatch-config.integration.test.ts`.

## 7. Wrong vs Correct

#### Wrong

```bash
# A second assembler that re-implements the hook's prompt format
codeg-cli run -A arbor-implement-pi -p "Active task: ...
Role: implement
Do X"
```

#### Correct

```bash
python3 ./.arbor/scripts/dispatch.py run --role implement --task 10-24-foo -p "Do X"
# or, to debug: diff <(python3 ./.arbor/scripts/dispatch.py print-context --role implement --task 10-24-foo -p "Do X") <hook output>
```
