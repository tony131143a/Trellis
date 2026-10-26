---
sources:
  - packages/cli/src/types/ai-tools.ts
  - packages/cli/src/configurators/index.ts
  - packages/cli/src/configurators/shared.ts
  - packages/cli/src/configurators/claude.ts
  - packages/cli/src/configurators/star.ts
  - packages/cli/src/templates/shared-hooks/index.ts
  - packages/cli/src/templates/claude/settings.json
  - packages/cli/src/templates/star/settings.json
last_verified: 2026-10-23
---
# Platform Integration Guide

How Arbor integrates with its two main-agent platforms, Claude Code (`.claude/`) and StarFactory (`.starFactory/`), and the contracts shared by their hooks, commands and skills. `PLATFORM_IDS` in `configurators/index.ts` is the list that counts. Sub-agent roles (implement / check / research) are not platform features: they run as codeg assistants, see `dispatch.md`.

---

## Architecture

Platform support uses a **centralized registry pattern**:

- **Data registry**: `src/types/ai-tools.ts` — `AI_TOOLS` record with all platform metadata (`claude-code`, `star`)
- **Function registry**: `src/configurators/index.ts` — `PLATFORM_FUNCTIONS`, one entry per platform. It holds no per-platform logic
- **Shared configurator utilities**: `src/configurators/shared.ts` — renderers (`resolvePlaceholders()`), resolvers (`resolveCommands()`, `resolveSkills()`, `resolveBundledSkills()`), map builders (`collectSkillTemplates()`, `collectSharedHooks()`), and the render/write pair (`renderTemplateMap()`, `writeTemplateMap()`). See `configurator-shared.md`
- **Shared template utilities**: `src/templates/template-utils.ts` — `createTemplateReader()` factory
- **Shared hooks**: `src/templates/shared-hooks/` — platform-independent Python hook scripts (session-start, inject-workflow-state, inject-delegation-context, guard-builtin-agent, inject-shell-session-context) written to the platform hook directory according to `SHARED_HOOKS_BY_PLATFORM`. Claude Code `statusLine` is not installed by default (`arbor init --with-statusline` opts in).
- **Common templates**: `src/templates/common/` — single source of truth for commands (`start`, `continue`, `finish-work`, `dispatch-target`), single-file workflow skills (before-dev, brainstorm, check, break-loop, update-spec), and multi-file bundled skills (arbor-meta, arbor-spec-bootstrap), with `{{placeholder}}` resolution per platform
- **Shared utilities**: `src/utils/compare-versions.ts` — `compareVersions()` with full prerelease support
- **Derived helpers**: `ALL_MANAGED_DIRS`, `getConfiguredPlatforms()`, etc. — consumed by update, init, hash tracking

All lists (backup dirs, template dirs, platform detection, cleanup whitelist) are **derived from the registry automatically**. No scattered hardcoded lists.

---

## The two platforms

| | Claude Code | StarFactory |
| --- | --- | --- |
| Registry id / CLI flag | `claude-code` / `--claude` | `star` / `--star` |
| Config dir | `.claude/` | `.starFactory/` |
| Template dir | `src/templates/claude/` (`settings.json`, `hooks/statusline.py`) | `src/templates/star/` (`settings.json`) |
| Configurator | `configurators/claude.ts` (spells out `configure` and `collectTemplates` because of the opt-in statusline) | `configurators/star.ts` (plain `fromTemplates`) |
| Shared hooks | session-start, inject-workflow-state, inject-delegation-context, guard-builtin-agent | the same four plus inject-shell-session-context |
| Command format | `/arbor:xxx`, Markdown under `commands/arbor/` | same, under `.starFactory/commands/arbor/` |

StarFactory is a Claude Code-compatible fork. Its **project-level** config directory is `.starFactory/`; `.claude/` at project level is ignored, and it does not read the shared `.agents/skills/` root. StarFactory exports no session id into its shell children, which is why it alone gets the shell-ticket hook.

`collectClaudeTemplates()` / `collectStarTemplates()` are the single description of each file set: `arbor init` writes the map and `arbor update` diffs it, so the two cannot disagree. The shape to copy for any new configurator is `configurators/star.ts`.

**Required commands/skills**: both platforms receive everything from `src/templates/common/`:

| Type    | Name          | Purpose                                                    |
| ------- | ------------- | ---------------------------------------------------------- |
| Command | `start`       | Session initialization (filtered out when the platform has a SessionStart hook, as both do) |
| Command | `continue`    | Resume the current task at the right phase                 |
| Command | `finish-work` | Pre-commit checklist and archive                           |
| Command | `dispatch-target` | Switch the default dispatch target (`star`, `pi`, `clear`) |
| Skill   | `before-dev`  | Read development guidelines (auto-discovers package specs) |
| Skill   | `brainstorm`  | Requirements discovery                                     |
| Skill   | `check`       | Check code quality (auto-discovers relevant specs)         |
| Skill   | `break-loop`  | Post-debug analysis                                        |
| Skill   | `update-spec` | Update code-spec docs                                      |

> **Rule**: a new command or single-file workflow skill goes into `src/templates/common/commands/` or `src/templates/common/skills/`; both platforms pick it up through `resolveCommands()` / `resolveSkills()`. Never edit a platform-specific copy.


---

## Bundled built-in skills

Multi-file skills with references/assets live under `src/templates/common/bundled-skills/<skill-name>/` and are installed through the same platform skill roots as workflow skills.

#### Scenario: Multi-file bundled skills

##### 1. Scope / Trigger

Use bundled skills when a built-in skill needs files beyond `SKILL.md`, such as `references/`, examples, or assets. Do not flatten large reference trees into `src/templates/common/skills/*.md`; single-file workflow skills stay there, while multi-file built-ins use `src/templates/common/bundled-skills/<skill-name>/`.

##### 2. Signatures

| Helper                                                    | Contract                                                                                               |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `getBundledSkillTemplates()`                              | Recursively reads `bundled-skills/*/` and returns POSIX relative file paths under each skill directory |
| `resolveBundledSkills(ctx)`                               | Resolves placeholders without adding frontmatter; bundled `SKILL.md` already owns frontmatter          |
| `collectSkillTemplates(skillRoot, skills, bundledSkills)` | Returns single-file workflow skills **and** bundled skill files as map entries under `skillRoot`       |

##### 3. Contracts

- Bundled skill source path: `src/templates/common/bundled-skills/<skill-name>/`.
- Bundled skill target path: `<platform-skill-root>/<skill-name>/<relative-file>`.
- `SKILL.md` inside a bundled skill owns its own YAML frontmatter; `wrapWithSkillFrontmatter()` must not be applied to bundled files.
- Relative file paths returned from the common template reader are POSIX-style, stable, and relative to the skill directory.
- `collectTemplates()` is the single description; `configure` writes it. Bundled skill files are covered by that guarantee automatically.

##### 4. Validation & Error Matrix

| Condition                                                            | Expected behavior                                                         |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Bundled skill directory is missing                                   | Return no bundled skills; single-file workflow skill generation continues |
| Bundled skill has nested references                                  | Preserve the nested relative path under every platform skill root         |
| Bundled `SKILL.md` contains placeholders                             | Resolve placeholders with the platform `TemplateContext`                  |
| Platform omits `bundledSkills` from its `collectSkillTemplates()` call | That platform silently ships none of them. The parity oracle cannot see this — both paths agree, they just agree on the wrong set — so `test/templates/<platform>.test.ts` has to assert one bundled file by name |
| Bundled file path uses OS-specific separators                        | Normalize to POSIX relative paths before adding to template maps          |

##### 5. Good/Base/Bad Cases

- Good: `arbor-meta` installs as `<platform-skill-root>/arbor-meta/SKILL.md` plus `references/**`, and `collectPlatformTemplates(platform)` returns the same files.
- Base: no bundled skills exist; existing `resolveSkills()` / `resolveAllAsSkills()` behavior remains unchanged.
- Bad: platform-specific configurators copy `arbor-meta` manually, creating a second installer that update hash tracking can miss.

##### 6. Tests Required

- Init integration test proving both Claude Code and StarFactory write `arbor-meta/SKILL.md` plus one reference file.
- Configurator test proving configured files are byte-for-byte equal to `collectPlatformTemplates()` for both platforms.
- Regression test proving `.arbor/.template-hashes.json` includes bundled skill reference files after init.
- Release smoke test when a changelog or docs page claims the skill is
  bundled: build the CLI, verify the skill appears in `npm pack --dry-run
--json` under `dist/templates/common/bundled-skills/<skill>/`, then run the
  built binary in a fresh temp repository and confirm both generated skill
  files and `.arbor/.template-hashes.json` contain the skill paths.

##### 7. Wrong vs Correct

Wrong:

```typescript
files.set(".claude/skills/arbor-meta/SKILL.md", metaSkillContent);
```

Correct:

```typescript
for (const [filePath, content] of collectSkillTemplates(
  skillRoot,
  resolveSkills(ctx),
  resolveBundledSkills(ctx),
)) {
  files.set(filePath, content);
}
```

**Rule**: Do not add a parallel installer for built-in multi-file skills. Every bundled file reaches disk through the platform's one template map, so `.arbor/.template-hashes.json` tracks it automatically. The failure this rule still guards is the quiet one: forgetting the third argument, which ships zero bundled skills on that platform with no test failure. Cover it with one reference file by name (for example `arbor-meta/references/core/template-pipeline.md`) in `test/templates/<platform>.test.ts`.

**Release rule**: A bundled skill is not release-ready until it has passed the
source, dist, generated-files, and update-tracking chain:
`src/templates/common/bundled-skills/<skill>/` ->
`dist/templates/common/bundled-skills/<skill>/` -> platform skill roots after
built-binary `arbor init` -> `.arbor/.template-hashes.json` -> built-binary
`arbor update --dry-run` with no pending changes.

## Python scripts (independent runtime)

Python scripts run in user projects at runtime and cannot import from the TS registry. They carry no per-platform adapter: platform identity reaches them only through hook payloads and `ARBOR_CONTEXT_ID`.

The shipped script tree (`packages/cli/src/templates/arbor/scripts/`) and Arbor's own dogfood copy (`.arbor/scripts/`) must stay byte-identical. This is build-enforced, see `script-conventions.md` → "Two script trees, one content".

`task.py create` always seeds empty `implement.jsonl` / `check.jsonl` (every Arbor project dispatches to codeg assistants), see `task_store.py`.


## Active Task Resolution

Current-task state is session/window scoped. New hook, statusline and script consumers must call the shared resolver path:

| Runtime                         | Resolver surface                                                                                      |
| ------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Python hooks/statusline/scripts | `.arbor/scripts/common/active_task.py`                                                              |
| Existing Python callers         | `common.paths.get_current_task()` / `get_current_task_abs()` / `get_current_task_source()`            |

Do not add direct `.arbor/.current-task` reads in hooks, statusline scripts or context injection. Direct reads reintroduce multi-window task pollution.

Context-key precedence, as implemented in `active_task.py:resolve_context_key`:

1. `ARBOR_CONTEXT_ID` environment override for subprocesses.
2. From the hook payload: `session_id`, `sessionId`, or `sessionID`.
3. From the hook payload: `conversation_id` / `conversationId` / `conversationID`.
4. From the hook payload: `transcript_path` / `transcriptPath` / `transcript` when non-empty.
5. A platform-native session environment variable, only for names that have actually been verified to exist and only for the detected platform (`_iter_env_keys` filters by platform name). Today that is `CLAUDE_CODE_SESSION_ID` for Claude Code; StarFactory has no verified name.
6. A short-lived shell ticket, checked **last** and **not** gated on platform name. See "Shell-ticket bridge" below.

The env table lives at the top of `active_task.py`. Do not add a name by analogy with a neighbour: a 2026-08-05 audit found most pattern-guessed names had never existed. The provenance convention is in `script-conventions.md` → "Session env var names carry their provenance", and it binds this file too.

`task.py start <task>` has no hook stdin when run as a normal shell command. It can write session-local state only when a context key is available through `ARBOR_CONTEXT_ID` or a verified platform environment variable. Claude Code is special: SessionStart provides `CLAUDE_ENV_FILE`, so the shared hook persists `export ARBOR_CONTEXT_ID=<context-key>` there for later Bash tool calls in the same conversation. StarFactory has no such bridge and uses the shell ticket. Without any of these signals, `task.py start` must fail with a clear session identity hint and must not write `.arbor/.current-task`.

Dispatched sub-agents have no `ARBOR_CONTEXT_ID` by design and never call `task.py start/current/finish` (see `dispatch.md`).

### Shell-ticket bridge

The premise: StarFactory exports no session id into its shell tool's child process, but its hooks receive that id on stdin. So a hook registered on `PreToolUse` with matcher `Bash` writes a short-lived ticket, and `task.py` reads it back.

`inject-shell-session-context.py` is that writer. It is declared for `star` only in `SHARED_HOOKS_BY_PLATFORM`. The ticket directory is `.arbor/.runtime/shell-tickets/`.

The full contract (payload shape, the four acceptance conditions, and the install-directory rule that decides the ticket's context key) is in `script-conventions.md` → "Shell-ticket bridge". Getting the context key wrong makes `task.py start` write a session file no hook ever reads, which half-works behind the single-session fallback and breaks silently with two windows open.

Hook, statusline or script output that mentions an active task should include the source (`session` or `session:<key>`) so cross-window mistakes are visible while debugging.


---

## Declaring a shared hook is half the wiring

### 1. Scope / Trigger

Infra wiring: a hook script only runs if two independent things agree — the
distribution table that puts the file on disk, and the platform's own hook
config (`settings.json`) that invokes it. Those cannot be derived from one another. A script on disk that nothing invokes is
indistinguishable from success: the file is there, the test that checks the
file is there passes, and the feature does nothing.

### 2. Signatures

```typescript
// templates/shared-hooks/index.ts — the distribution half
export const SHARED_HOOKS_BY_PLATFORM: Record<
  SharedHookPlatform,
  readonly SharedHookName[]
>;

// configurators/shared.ts — reads that table into the platform's map
export function collectSharedHooks(
  hooksPath: string,
  platform: SharedHookPlatform,
): Map<string, string>;
```

The invocation half has no shared signature — it is a literal inside each
platform's own `settings.json` template.

### 3. Contracts

- `SharedHookPlatform` is the string union `"claude" | "star"`, so an unknown platform cannot be passed to `collectSharedHooks`.
- Declaring `"inject-shell-session-context.py"` for a platform obliges its
  config template to invoke `hooks/inject-shell-session-context.py` on
  the `PreToolUse` event with matcher `Bash`.
- The reverse also binds: a config that invokes a shared hook the platform does
  not declare points at a path that will never exist on disk.
- The hooks path passed to `collectSharedHooks` must be the same directory the
  config template references. There is no cross-check on that string beyond the
  substring match below, so a typo in one of the two shows up as a build
  failure, not a runtime one.

### 4. Validation & Error Matrix

Both directions are asserted in `test/templates/shared-hooks.test.ts`.
"Registration" means a non-`.md` file in the platform's template map contains
the substring `hooks/<hook-name>` — markdown is excluded because reference
tables name the file without invoking it.

| Condition | Failure |
| --- | --- |
| Platform declares the hook, no config template invokes it | "`<platform>` declares … but no `<platform>` config template invokes it — the script would be installed and never run" |
| Config template invokes it, platform does not declare it | "`<platform>` invokes … but does not declare it — the config points at a script that is never installed" |
| The filter stops matching anything (renamed hook, changed path shape) | `expect(declaring.length).toBeGreaterThan(0)` fails first, so the suite cannot pass vacuously |
| Platform in `SHARED_HOOKS_BY_PLATFORM` matches no `AI_TOOLS` cliFlag | `registrationsOf` throws |
| Platform collects no templates | `registrationsOf` throws — its config cannot be checked |

### 5. Good / Base / Bad Cases

- **Good** — a platform gains a hook: add it to the table *and* add the invocation to its `settings.json` template, in the same change. The test proves both halves landed.
- **Base** — Claude Code deliberately does **not** declare `inject-shell-session-context.py`: it exports `CLAUDE_ENV_FILE` and a session env var, so the ticket bridge is unnecessary.
- **Bad** — declaring the hook and "wiring it later". The file ships, `arbor update` starts managing it, users see it in their repo, and nothing calls it. This is precisely the state the test now makes unreachable.

### 6. Tests Required

- Both direction assertions above, derived from `SHARED_HOOKS_BY_PLATFORM` — never from a hard-coded platform list.
- A non-vacuity assertion on the filter itself. Without it, renaming the hook turns every other assertion into a no-op that still passes.
- Per-platform registration tests for hooks whose config shape is unusual (for example the `Bash`-matcher ticket hook on `star`).

### 7. Wrong vs Correct

#### Wrong

```typescript
// shared-hooks/index.ts
star: ["session-start.py", "inject-shell-session-context.py"],
```

with `templates/star/settings.json` unchanged. `.starFactory/hooks/inject-shell-session-context.py` is written, hash-tracked, and never executed.

#### Correct

```typescript
// shared-hooks/index.ts
star: ["session-start.py", "inject-shell-session-context.py"],
```

```jsonc
// templates/star/settings.json — the other half
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "{{PYTHON_CMD}} .starFactory/hooks/inject-shell-session-context.py" }
        ]
      }
    ]
  }
}
```


---

## What You DON'T Need to Update

These are **automatically derived** from the registry:

| Previously hardcoded                          | Now derived from                                                       |
| --------------------------------------------- | ---------------------------------------------------------------------- |
| `BACKUP_DIRS` in update.ts                    | `ALL_MANAGED_DIRS` from `configurators/index.ts`                       |
| `TEMPLATE_DIRS` in template-hash.ts           | `ALL_MANAGED_DIRS` from `configurators/index.ts`                       |
| `getConfiguredPlatforms()` in update.ts       | `getConfiguredPlatforms()` from `configurators/index.ts`               |
| `cleanupEmptyDirs()` whitelist in update.ts   | `isManagedPath()` / `isManagedRootDir()` from `configurators/index.ts` |
| `collectTemplateFiles()` if/else in update.ts | `collectPlatformTemplates()` dispatch loop                             |
| `TOOLS[]` in init.ts                          | `getInitToolChoices()` from `configurators/index.ts`                   |
| Configurator dispatch in init.ts              | `configurePlatform()` from `configurators/index.ts`                    |
| Windows Python detection in init.ts           | `getPlatformsWithPythonHooks()` from `configurators/index.ts`          |

Static declarations that are **not** derivable: the `--claude` / `--star` options in `src/cli/index.ts` and the matching `InitOptions` fields in `src/commands/init.ts` (a compile-time assertion `_AssertCliFlagsInOptions` catches a missing field).


---

## Planning Artifact and JSONL Context Contract

### Scope / Trigger

Task planning is artifact-driven:

- `prd.md` is created by `task.py create` and stores requirements, constraints, and acceptance criteria.
- `design.md` is required for complex tasks and stores technical design, boundaries, data flow, contracts, and tradeoffs.
- `implement.md` is required for complex tasks and stores execution order, checklist, validation commands, and rollback points.
- `implement.jsonl` / `check.jsonl` are spec and research manifests for implement/check context. They do not replace `implement.md`.

Lightweight tasks may be PRD-only. Complex tasks must have `prd.md`, `design.md`, and `implement.md` before `task.py start` moves the task into implementation.

### Lifecycle

1. **Create** — `task.py create` writes `task.json` with `status = planning`, creates the default `prd.md`, and creates empty `implement.jsonl` / `check.jsonl`. Curation instructions are printed to the console, never written into the files.
2. **Plan** — AI updates `prd.md`. If the task is complex, AI also writes `design.md` and `implement.md`; if sub-agent/spec context is needed, AI curates jsonl entries.
3. **Review / start** — the user reviews the planning artifacts. `task.py start` is valid when the task's artifact gate is satisfied.
4. **Consume** — the dispatch hook and `dispatch.py` (one shared assembler, `common/dispatch_context.py`) read context in the same order: jsonl entries, `prd.md`, `design.md` if present, `implement.md` if present.

### Signatures

**Placeholder row schema** (`{"_example": "..."}`) — written by Arbor versions before this contract change. `task.py validate` rejects it, matching PR preflight, which treats it as unresolved scaffolding. Remediation: delete the line, or replace it with a curated row.

**Curated row schema** (written by AI):

```json
{ "file": "<repo-relative-path>", "reason": "<one-line rationale>" }
```

Optional `type: "directory"` is supported for directory entries. Consumers ignore any other fields.

### Contracts

| Contract                  | Enforcer                                        | Behavior                                                                           |
| ------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------- |
| Task creation             | `task_store.py`                                 | Always creates default `prd.md`; never auto-creates `design.md` or `implement.md`. |
| Lightweight planning gate | workflow-state / SessionStart / continue        | PRD-only is valid when the task is clearly small.                                  |
| Complex planning gate     | workflow-state / SessionStart / continue        | Requires `prd.md`, `design.md`, and `implement.md` before `task.py start`.         |
| Non-entry detection       | Every jsonl consumer                            | Row without a `file` key is treated as non-entry and skipped.                      |
| Empty-file tolerance      | dispatch hook / `dispatch.py`                   | Missing or empty jsonl is tolerated; task artifacts still load.                    |
| Context order             | dispatch hook / `dispatch.py`                   | jsonl entries → `prd.md` → `design.md` if present → `implement.md` if present.     |
| Archived self-references  | `task_context.py` validation                    | Preserve JSONL bytes. For an archived task, remap only exact `.arbor/tasks/<same-task-name>/...` references into that archive copy. Other paths retain repo-root resolution. |

### Validation & Error Matrix

| Condition                                              | Behavior                                                                                              | Exit / Surface          |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | ----------------------- |
| `implement.jsonl` is empty (freshly created)           | `cmd_validate` reports 0 errors; `cmd_list_context` prints "(no curated entries yet)"                 | Exit 0                  |
| `implement.jsonl` holds a legacy `{"_example": …}` row | `cmd_validate` prints "Placeholder \`_example\` row …" with file, line, and remediation                | Exit 1                  |
| `implement.jsonl` entry points at non-existent file    | `cmd_validate` prints "File not found: …" per row                                                     | Exit 1                  |
| Archived self-reference exists in the archive copy     | Resolve inside `.arbor/tasks/archive/<year-month>/<same-task-name>/`; do not rewrite the manifest        | Exit 0                  |
| Archived self-reference is absent from the archive copy | Report it missing even if an active task with the same name has recreated the path                         | Exit 1                  |
| Archived self-reference traverses or follows a symlink outside the archive | Reject it as missing; never fall back to the historical active-task path                    | Exit 1                  |
| Lightweight task has only `prd.md`                     | Valid planning state; SessionStart / continue can ask for start review                                | No error                |
| Complex task is missing `design.md` or `implement.md`  | Stay in planning; ask user to complete missing planning artifacts                                     | Hook / command guidance |
| jsonl is missing                                       | Context readers fall back to task artifacts and warn where applicable                                 | No create failure       |

### Good / Base / Bad Cases

- **Good**: complex task has `prd.md`, `design.md`, `implement.md`, and curated jsonl manifests. Context consumers load jsonl entries first, then all three artifacts.
- **Good (archived)**: a moved task keeps its JSONL byte-for-byte; validation binds exact historical self-references to files or directories inside its archive copy while unrelated repository paths still resolve from the repository root.
- **Base**: lightweight task has only `prd.md`. SessionStart / continue treats this as a valid planning state and may ask for start review.
- **Bad**: complex task has only `prd.md` plus seed-only jsonl. SessionStart / continue must keep the task in planning; it must not treat jsonl file existence as implementation readiness.
- **Bad (archived)**: validation resolves a historical self-reference through a recreated active task, or accepts `..` / a symlink that escapes the archived task directory.

### Wrong vs Correct

#### Wrong

```python
def is_ready(task_dir: Path) -> bool:
    return (task_dir / "prd.md").is_file() and (task_dir / "implement.jsonl").is_file()
```

File existence alone cannot distinguish a lightweight PRD-only task from an incomplete complex task, and a seed-only jsonl manifest is not curated context.

#### Correct

```python
def planning_next_action(task_dir: Path, is_complex: bool, inline_mode: bool) -> str:
    if not (task_dir / "prd.md").is_file():
        return "write-prd"
    if is_complex and (
        not (task_dir / "design.md").is_file()
        or not (task_dir / "implement.md").is_file()
    ):
        return "complete-complex-artifacts"
    if not inline_mode and not has_curated_jsonl(task_dir):
        return "curate-jsonl"
    return "review-before-start"
```

The route depends on task intent, artifact presence, and execution mode. Missing optional artifacts are skipped for lightweight tasks, but complex tasks cannot enter implementation until their planning artifacts are complete.

For archived validation, resolving every JSONL path as `repo_root / file_path`
is wrong because a preserved self-reference points at the task's former active
location. Resolve only the exact same-task prefix against the archived task
directory, require its canonical target to stay within that directory, and
leave every unrelated path on normal repository-root resolution.

### Tests Required

- **Create behavior**: `task.py create` creates default `prd.md` and empty jsonl, and prints the curation instructions to the console.
- **Consumer tolerance**: `inject-delegation-context.py` skips rows without a `file` key and still injects task artifacts.
- **Validate placeholder**: `task.py validate` passes for empty jsonl and fails with a remediation message for a legacy `{"_example": …}` row, in both active and archived tasks.
- **Validate archive binding**: cover archived self files and directories, unrelated paths, a missing archive copy with a recreated active task, traversal, symlink escape, and unchanged active-task behavior.
- **List-context empty**: `task.py list-context` prints "(no curated entries yet)" for an uncurated jsonl.
- **Artifact gates**: workflow-state, SessionStart, and continue distinguish PRD-only lightweight tasks from complex tasks that still need `design.md` / `implement.md`.
## Context Injection Limits Contract (`context_injection`)

### 1. Scope / Trigger

The dispatch context assembler caps how much task context is inlined into a
dispatched assistant's prompt. It lives in `common/dispatch_context.py` and is
shared by the PreToolUse hook (`shared-hooks/inject-delegation-context.py`) and
`dispatch.py`, so a change to injection formatting, caps, binary detection or
config keys lands once and applies to both paths.

### 2. Signatures

- Python: `common.config.get_context_injection_limits() -> dict[str, int]`,
  `truncate_utf8(data: bytes, cap: int) -> bytes`,
  `_is_binary_content(data: bytes) -> bool`

### 3. Contracts

`.arbor/config.yaml` section (ships commented in the template; defaults live in code):

```yaml
context_injection:
  max_file_bytes: 32768        # per implement.jsonl / check.jsonl referenced file
  max_artifact_bytes: 65536    # per task artifact (prd.md / design.md / implement.md)
  max_total_bytes: 131072      # whole payload; overflow degrades to index lines
```

- `0` disables that limit; negative / non-int → default + stderr warning.
- Notice strings (byte-frozen):
  - truncation: `\n[Arbor: truncated at {cap} bytes — read {path} for the full content]`
  - degradation: `[Arbor: not inlined (total context limit reached) — {path} ({size} bytes): {reason}]`
  - binary reference: `[Arbor: not inlined (binary file) — {path} ({size} bytes): {reason}]`
- Artifact reasons: `Requirements document` / `Technical design document` / `Execution plan document`.
- Accounting: `=== path ===` headers and notices count toward `max_total_bytes`.
  Processing order unchanged: jsonl entries first, then prd → design → implement.md.
- Truncation is UTF-8-safe: back off over continuation bytes; drop an incomplete lead byte.
- JSONL-referenced files are classified from bytes, not extensions. A NUL byte
  or invalid UTF-8 marks the file as binary. Binary bytes are never decoded or
  inlined, including when `max_file_bytes` and `max_total_bytes` are `0`; only
  the binary-reference notice counts toward the total budget.
- `task.py validate` emits non-blocking hygiene warnings (yellow, exit code unchanged):
  code-file extension outside `.arbor/spec/`, `docs/`, `docs-site/`, or the task's
  own dir; and entries larger than `max_file_bytes`.

### 4. Validation & Error Matrix

- unreadable referenced file → skipped (pre-existing behavior, unchanged)
- file > `max_file_bytes` → truncated + truncation notice
- artifact > `max_artifact_bytes` → truncated + truncation notice
- next block would exceed `max_total_bytes` → index line instead of content
- referenced file contains NUL or invalid UTF-8 → binary-reference notice only
- invalid config value → default for that key + stderr warning, never a crash

### 5. Good/Base/Bad Cases

- Good: curated spec files of a few KB — output byte-identical to pre-cap behavior.
- Base: one 2 MiB file → ≤32 KiB inlined + notice; total payload ≤128 KiB.
- Binary: PNG or invalid UTF-8 with unlimited caps → path/size/reason notice,
  with no `=== path ===` block and no decoded bytes.
- Bad (guarded): setting values via env vars or CLI flags — not supported; config.yaml only.

### 6. Tests Required

- Python: `packages/cli/test/scripts/context-injection-limits.integration.test.ts`
  (probe-spawned; fixture matrix: at-cap / 1-over / UTF-8 straddle 2-byte & 3-byte /
  3-file total overflow / `0` disable / config override / golden under-cap / validate warnings).
- Template: `arbor.test.ts` asserts config.yaml's `context_injection` section exists and is fully commented.

### 7. Wrong vs Correct

#### Wrong

Change a notice string, binary predicate, or cap semantics without updating the tests; infer binary content from the extension; or account only file bodies (not
headers/notices) toward the total budget.

#### Correct

Treat the notice strings, byte-based binary predicate, key names, ordering, and
accounting rules above as a frozen contract; change them together with the
regression suite in the same commit.

## Parent / Child Task Tree Contract

### Scope / Trigger

Use parent/child task trees when a request contains multiple deliverables that can be planned, implemented, checked, and archived independently. The hierarchy is for work structure and review scope, not for dependency scheduling.

### Signatures

```bash
python3 ./.arbor/scripts/task.py create "<title>" --description "<one-line summary>" --slug <name> --parent <parent-dir>
python3 ./.arbor/scripts/task.py add-subtask <parent-dir> <child-dir>
python3 ./.arbor/scripts/task.py remove-subtask <parent-dir> <child-dir>
```

### Contracts

| Contract              | Enforcer                                      | Behavior                                                                                                                          |
| --------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| New child creation    | `task_store.py`                               | `create --parent` writes the child's `parent` field and appends the child directory name to the parent's `children` list.         |
| Existing task link    | `task_store.py`                               | `add-subtask` links two existing active tasks; the child must not already have a different parent.                                |
| Unlink                | `task_store.py`                               | `remove-subtask` removes the child from the parent's `children` and clears the child's `parent`.                                  |
| Parent responsibility | workflow / skills                             | Parent task owns source requirements, task map, cross-child acceptance, and final integration review.                             |
| Child responsibility  | workflow / skills                             | Child task owns one independently verifiable deliverable, including its own dependencies and acceptance criteria.                 |
| Archive progress      | `script-conventions.md` / `children_progress` | Parent `children` is historical. Archiving a child does not prune it from the parent; missing active children count as completed. |

### Good / Base / Bad Cases

- **Good**: parent task records the overall requirement set and lists child deliverables; each child has its own PRD and any ordering dependency is written in that child's planning artifacts.
- **Base**: a single lightweight task uses no parent/child structure.
- **Bad**: parent task is started as a generic "manager" implementation task while child tasks are the only real deliverables.
- **Bad**: one child depends on another but the dependency is only implied by the parent/child tree. The child artifact must state the dependency explicitly.

### Tests Required

- Workflow template guidance must mention when to use parent/child task trees and where dependency ordering belongs.
- Task system references must match the archive invariant in `script-conventions.md`.

---


## Workflow Step Detail Loading

`.arbor/workflow.md` contains per-phase step detail under `#### X.X` headings. A step may carry per-platform variants demarcated by `[Platform Name, ...]` … `[/Platform Name, ...]` marker blocks; today `workflow.md` ships none, but the filter is retained.

Load step detail on demand (both commands and hooks use this):

```bash
python3 ./.arbor/scripts/get_context.py --mode phase                                   # Phase Index (no --step)
python3 ./.arbor/scripts/get_context.py --mode phase --step 1.1                        # Step 1.1 (all platforms)
python3 ./.arbor/scripts/get_context.py --mode phase --step 1.2 --platform claude      # Step 1.2, filtered for one platform
```

Platform markers are filtered by matching `[...]` block membership against the given platform name (case-insensitive; accepts `claude-code` and `Claude Code`). Lines outside any marker block are always kept.

---

## Windows Encoding Fix

All hook scripts that output to stdout must include the Windows encoding fix, including any hook that prints JSON payloads with `ensure_ascii=False`.

When a hook can resolve the Arbor project directory before printing, prefer
the shared helper from `.arbor/scripts/common/__init__.py`:

```python
def configure_project_encoding(project_dir: Path) -> None:
    scripts_dir = project_dir / ".arbor" / "scripts"
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))

    try:
        from common import configure_encoding  # type: ignore[import-not-found]

        configure_encoding()
    except Exception:
        pass
```

Call it after resolving `project_dir` and before `json.dumps(...,
ensure_ascii=False)` is printed.

For standalone hooks that cannot safely import `.arbor/scripts/common`, use
the local fallback pattern:

```python
# IMPORTANT: Force stdout to use UTF-8 on Windows
# This fixes UnicodeEncodeError when outputting non-ASCII characters
if sys.platform == "win32":
    import io as _io
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
    elif hasattr(sys.stdout, "detach"):
        sys.stdout = _io.TextIOWrapper(sys.stdout.detach(), encoding="utf-8", errors="replace")  # type: ignore[union-attr]
```

### Tests Required

- Regression coverage must assert every shipped Python hook template contains:
  - `from common import configure_encoding` (or the local `sys.platform == "win32"` fallback)
  - `configure_encoding()` before printing JSON
  - `ensure_ascii=False` at the JSON output boundary


---

## SessionStart Hook: additionalContext Size Constraint

### Adaptive First-Reply Notice

#### 1. Scope / Trigger

Arbor uses a one-shot visible acknowledgment as proof that otherwise-hidden
SessionStart context loaded. This contract applies to the shared Python hook `shared-hooks/session-start.py`, used by Claude Code and StarFactory.

The acknowledgment is an instruction inside the existing context string, not a
new payload field or host UI feature.

#### 2. Signatures

| Implementation | Injection signature | Adaptive notice? |
| --- | --- | ---: |
| `shared-hooks/session-start.py` | `hookSpecificOutput.additionalContext` | Yes |

The **update-hint rider** (see below) lives in the same hook and nowhere else.

#### 3. Contracts

- Put `<first-reply-notice>` near the top of model-visible startup context,
  before current-state or other orientation blocks.
- On the first visible assistant reply, briefly acknowledge that Arbor
  SessionStart context loaded, then continue directly with the user's request.
- Choose the acknowledgment language in this exact order:
  1. the language of the user's current request, meaning the user message that
     triggered the first visible reply;
  2. if that request has no clear natural language, an explicitly established
     project communication language;
  3. if neither provides a language, the language-neutral fallback exactly
     `Arbor SessionStart ✓`.
- The acknowledgment must not alter the language used for the remainder of the
  response.
- Emit the acknowledgment only once per session. Do not repeat it on later
  assistant replies.
- Do not infer a fallback language from operating-system locale, source files,
  README frequency, commit history, or other repository content.
- Keep hook payload keys, compact context content, event timing, and
  per-session deduplication unchanged.
- **The Arbor update reminder rides this block, and only this block.** When
  `get_update_hint()` returns a hint, exactly one line is inserted between the
  notice head and tail: `Also relay this Arbor maintenance notice on its own
  line in that same reply: {update_hint}`. When it returns `None` the notice is
  **byte-identical** to the plain `FIRST_REPLY_NOTICE` constant — no empty
  block, no placeholder line, nothing to diff. See "SessionStart update
  reminder" below.

#### 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| First request has a clear natural language | Acknowledgment uses that request language; the rest of the response keeps its intended language |
| Request has no clear natural language and project instructions explicitly establish a communication language | Acknowledgment uses the explicit project language |
| Neither request nor project instructions provide a language | Acknowledgment is exactly `Arbor SessionStart ✓` |
| Later assistant reply in the same session | No repeated acknowledgment |
| Shared hook output | Existing payload keys and `SessionStart` event name remain unchanged |

#### 5. Good / Base / Bad Cases

- **Good:** an English request receives a brief English proof-of-load sentence,
  then the requested work continues in English.
- **Base:** a code-only request in a project that explicitly establishes Japanese
  as its communication language receives a brief Japanese acknowledgment.
- **Fallback:** a request and project with no language signal receive
  `Arbor SessionStart ✓`, then processing continues directly.
- **Bad:** the notice says `say once in Chinese`, requires `exactly one short
  Chinese sentence`, includes a fixed Chinese acknowledgment, or causes the
  remainder of an otherwise non-Chinese response to switch languages.

#### 6. Tests Required

- Execute the shared hook template; assert exact payload shape, normal
  compact context blocks, the adaptive priority, neutral fallback, one-shot
  rule, and absence of fixed Chinese wording.
- Validate the injected instruction contract deterministically. Do not attempt
  to test an LLM's actual language classification in template tests.

#### 7. Wrong vs Correct

```text
# Wrong: fixed language steers the conversation
<first-reply-notice>Say once in Chinese that Arbor loaded.</first-reply-notice>

# Correct: request language -> explicit project language -> neutral fallback
<first-reply-notice>
Use the language of the user message that triggered this reply. If it has no
clear natural language, use an explicitly established project communication
language. Otherwise output exactly `Arbor SessionStart ✓`. Continue directly
without altering the language of the remainder of the response. Emit once.
</first-reply-notice>
```

### SessionStart update reminder

#### 1. Scope / Trigger

Cross-layer contract change: a Python module's private helper became public and
gained a second caller in a different layer (the shared hook), and that caller
changes user-visible output. The reminder previously existed only on the
`get_context.py` text-mode path, so hook-driven platforms, Claude Code
included, never saw it. This repo ran ten versions behind before anyone
noticed.

#### 2. Signatures

```python
# .arbor/scripts/common/session_context.py
def get_update_hint(repo_root: Path, context_key: str | None = None) -> str | None

# .arbor/scripts/common/session_context.py (private)
def _update_marker_path(repo_root: Path, context_key: str | None = None) -> Path

# shared-hooks/session-start.py (private)
def _resolve_update_hint(arbor_dir: Path, context_key: str | None) -> str | None

# shared-hooks/session-start.py (private)
def _build_first_reply_notice(update_hint: str | None) -> str
```

#### 3. Contracts

- `get_update_hint` returns `"Arbor update available: {current} -> {latest}, run arbor update"` or `None`. It is public because two layers call it; do not re-privatize.
- `context_key` is **passed in, not re-resolved**. The hook already read the session id from hook stdin; that is more reliable than `session_context`'s environment-only fallback chain. Shell entry points pass nothing and keep the old behavior.
- The once-per-session marker is `.arbor/.runtime/update-check-{safe_key}.marker`, where `safe_key` is the sanitized context key truncated to 160 chars. With no context key it falls back to `TERM_SESSION_ID`, then `ppid-{n}`. **That fallback is why the key must be threaded through**: `TERM_SESSION_ID` identifies a terminal *window*, so the marker would mute the reminder for every later session opened in the same window.
- The marker is written before the version comparison, not after, so a probe that finds no update still costs one `arbor --version` per session rather than one per turn.
- The whole path is best-effort. A missing scripts dir, an import error, or any exception while probing versions leaves the payload untouched (`session-start.py` catches bare `Exception` on purpose).
- Scope is the shared hook only.

#### 4. Validation & Error Matrix

| Condition | Behavior |
| --- | --- |
| Marker already exists for this context key | `None` — no version probe at all |
| No project version readable | `None` |
| Version probe fails, hangs, or the CLI is absent | `None`, marker **not** written, so the next session retries |
| Current version ≥ latest | Marker written, `None` returned |
| Current version < latest | Marker written, hint returned |
| Hint is `None` | Notice is byte-identical to `FIRST_REPLY_NOTICE` |
| Scripts dir missing / import fails | `None`; SessionStart context still emitted normally |

#### 5. Good / Base / Bad Cases

- **Good:** a session on an outdated install gets one extra line inside `<first-reply-notice>`, the model relays it on its own line in the first reply, and no later turn repeats it.
- **Base:** an up-to-date install produces the unchanged notice, byte for byte. This is the property to assert — it is what proves the feature is invisible when it has nothing to say.
- **Bad:** the reminder is added as a separate context block. It then lives where `<first-reply-notice>` does not — model context nobody reads — which is the exact failure this change fixed.

#### 6. Tests Required

- `regression.test.ts` `[session-update-hint]`: assert the hint line appears between head and tail when a newer version is available. Assertion point is the rendered payload string, not `get_update_hint`'s return value.
- Assert byte-identity of the notice against `FIRST_REPLY_NOTICE` when no hint exists.
- Assert a failing or hanging `arbor` CLI leaves the payload untouched **and** leaves the check for the next session (covered by "[session-update-hint] a failing or hanging arbor CLI stays silent and leaves the check for the next session").
- Assert the marker filename derives from the passed context key, not from `TERM_SESSION_ID`, when both are present.

#### 7. Wrong vs Correct

##### Wrong

```python
# A second, always-present block
blocks.append(f"<arbor-update>{get_update_hint(repo_root)}</arbor-update>")
```

Two problems: it emits an empty block when there is no hint (so every payload differs from the previous release's bytes), and it lands in a channel the model reads but never speaks.

##### Correct

```python
notice = _build_first_reply_notice(_resolve_update_hint(arbor_dir, context_key))
```

One line inside the block that is already contracted to become spoken output; identical bytes to the plain constant when there is nothing to say.

### Output Schema

`shared-hooks/session-start.py` emits the Claude Code SessionStart shape, which StarFactory (a Claude Code fork) also reads:

```python
{
    "hookSpecificOutput": {
        "hookEventName": "SessionStart",
        "additionalContext": context_text,
    },
}
```

The same nested `hookSpecificOutput` convention applies to `inject-delegation-context.py` (`updatedInput`).

### Constraint

Claude Code truncates `hookSpecificOutput.additionalContext` at **~20 KB**. When exceeded, only a ~2 KB preview is shown and the full payload is written to a fallback file (`tool-results/hook-*-additionalContext.txt`). AI agents do **not** proactively read the fallback file, so any content past the preview is effectively invisible.

### Size Budget (measured on Arbor dev repo)

| Block                |       Size | Notes                                                                                                                                 |
| -------------------- | ---------: | ------------------------------------------------------------------------------------------------------------------------------------- |
| `<session-context>`  |     0.1 KB | Fixed                                                                                                                                 |
| `<current-state>`    |     0.3 KB | Compact developer/git/task state                                                                                                      |
| `<arbor-workflow>` |     4.4 KB | Compact Phase Index after stripping workflow-state blocks, comments and platform markers; detailed phase bodies are loaded on demand |
| `<guidelines>`       |     0.5 KB | Context order + spec index paths only                                                                                                 |
| `<ready>`            |     0.1 KB | Fixed                                                                                                                                 |
| **Total**            | **6.0 KB** | **Under 20 KB ✓**                                                                                                                     |

Historical note: pre-workflow-rewrite (v0.4.0-beta.10) the payload included a 16 KB `<instructions>` block (start.md content). Later iterations injected a large `<workflow>` block. Current SessionStart uses `<arbor-workflow>` with a compact Phase Index and leaves detailed steps to `/arbor:continue` / phase-context loading.

### Guidelines: Paths-only

Before: every `.arbor/spec/*/index.md` was inlined in `<guidelines>` (10 KB+
on this repo). Main agents rarely need every index at SessionStart, and
dispatched assistants receive their specific spec / research context through
`implement.jsonl` / `check.jsonl`.

Now: `<guidelines>` contains only the artifact read order and available spec
index paths, including `.arbor/spec/guides/index.md`. Agents read the relevant
index on demand after the task and phase are known.

### Task Status Guidance

`SessionStart` reports task status and artifact presence, but it does not
approve implementation. Planning tasks stay behind the review gate: lightweight
tasks may be PRD-only, while complex tasks need `prd.md`, `design.md`, and
`implement.md` before `task.py start`.

For `in_progress` tasks, `SessionStart` points the AI to the per-turn
`<workflow-state>` block and restates the implementation/check context order.
Dispatch behavior belongs to workflow-state, skills and `.arbor/agents/*.md`, not to a large SessionStart instruction block.

### Design Decision: Inject Orientation, Not References

**Context**: earlier SessionStart payloads injected full `workflow.md`, full
`get_context.py` output, and sometimes command-sized instruction blocks. Large
repositories crossed host truncation thresholds, leaving the AI with a preview
instead of the actual workflow guidance.

**Decision**: SessionStart now injects only compact orientation:

1. compact current state (developer, git summary, active task, journal, spec
   index count)
2. compact `<arbor-workflow>` Phase Index
3. artifact read order and spec index paths
4. current `<task-status>`

Detailed workflow steps, task artifacts, and spec content are loaded on demand
through `/arbor:continue`, `get_context.py --mode phase --step <X.Y>`, skills,
or dispatch context injection.

**Rule**: When adding content to SessionStart, prefer paths and one-action
orientation over inline reference text. Keep the measured total comfortably
below host truncation limits.

---

## Workflow State Injection: Per-Turn Breadcrumb

### Problem

`SessionStart` only fires once per session. In long conversations, Claude's context compression can push the SessionStart message out of recent context, and the AI forgets the active Arbor task — resulting in workflow drift (skips `check`, forgets to `update-spec`, doesn't return to `finish` after user interruptions).

### Solution: `UserPromptSubmit` hook injecting per-turn breadcrumb

A lightweight hook (`shared-hooks/inject-workflow-state.py`) fires on **every user prompt**, emitting a short `<workflow-state>` block reminding the AI of the active task + expected flow. Keep the payload compact and directive; it is injected every turn.

### Skip keyword (`prompt_injection.skip_keyword`, #427)

A user prompt containing the skip keyword (default `no-arbor`) mutes the per-turn
breadcrumb for that turn only — the hook exits 0 with empty stdout before any task
resolution or file reads. Contract:

- Match rule (frozen): case-insensitive `(?<![\w-])<keyword>(?![\w-])` —
  `no-arborfoo`/`foo-no-arbor` do not match; `path/no-arbor.md` does (accepted
  false-positive).
- Config: `.arbor/config.yaml` → `prompt_injection.skip_keyword`
  (ships commented; default in code via `common.config.get_prompt_injection_config()`;
  quoted `""` explicitly disables the hatch).
- Scope: per-turn breadcrumb ONLY. `session-start.py`, `inject-delegation-context.py`,
  and `inject-shell-session-context.py` must never gain keyword handling.
- Dogfood copy to keep patched region-identically: `.claude/hooks/inject-workflow-state.py`
  (and the shipped `shared-hooks/` original).

### Single Source of Truth: `workflow.md` Tag Blocks

Breadcrumb text lives in `workflow.md` as `[workflow-state:STATUS]...[/workflow-state:STATUS]` blocks (same tag style as `[Platform, ...]` marker blocks). Users who fork the Arbor workflow edit **only the markdown**; the hook script stays untouched.

```markdown
[workflow-state:in_progress]
Flow: dispatch implement → dispatch check → arbor-update-spec → finish
Next required action: inspect conversation history + git status, then execute the next uncompleted step in that sequence.
Do NOT edit code in the main session; dispatch the implement role to a codeg assistant and dispatch the check role before reporting completion.
[/workflow-state:in_progress]
```

STATUS matches `task.json.status`. Built-in: `planning` / `in_progress` / `completed`. Custom statuses (including hyphenated like `in-review`) are recognized — STATUS regex is `[A-Za-z0-9_-]+`.

### Fallback Strategy (hook never crashes)

1. `workflow.md` missing → hardcoded defaults for 3 built-in statuses
2. Tag block missing for a status → same hardcoded default
3. Status unknown (no tag, no default) → generic `"Refer to workflow.md for current step."`
4. No session active task → emit `no_task` pseudo-status breadcrumb instead of silent-exit. Header is `Status: no_task`; body nudges AI to load `arbor-brainstorm` + `task.py create` for multi-step work (or answer directly for trivial asks).

### Design Principle: Per-Turn Hooks Must Not Silent-Exit on "Nothing to Say"

A hook whose job is to **re-ground the AI every turn** should always emit _something_. Silent-exit looks cheaper but defeats the whole purpose — the turn where there's "nothing" is often the most important one (e.g. user switches topics, hops into a fresh subject without an active task).

**Wrong** — hook exits silently when no session active task exists:

```python
task = get_active_task(root)
if task is None:
    return 0  # nothing to inject; goodbye
```

Net effect on a "no task" session: AI sees the Next-Action only at SessionStart; after 20 turns of context compression, the guidance is gone and AI forgets to use `arbor-brainstorm` for new multi-step requests.

**Correct** — treat "no task" as its own pseudo-status with a dedicated breadcrumb template:

```python
task = get_active_task(root)
if task is None:
    breadcrumb = build_breadcrumb(task_id=None, status="no_task", templates=...)
else:
    breadcrumb = build_breadcrumb(*task, templates=...)
```

The same rule applies to every other hook that's positioned as "repeated reminder": if the hook isn't emitting, the reminder loop is broken. The only legitimate silent-exit case is when **the hook doesn't own this codebase at all** (e.g. `.arbor/` not found → definitely not a Arbor project → OK to no-op).

### Platform Support

| Platform | Event | Config file | Notes |
| --- | --- | --- | --- |
| Claude Code | `UserPromptSubmit` | `.claude/settings.json` | Shared `inject-workflow-state.py`, distributed via `SHARED_HOOKS_BY_PLATFORM.claude` |
| StarFactory | `UserPromptSubmit` | `.starFactory/settings.json` | Same shared hook, via `SHARED_HOOKS_BY_PLATFORM.star` |

### CWD Robustness

The hook uses `find_arbor_root()` to walk up from CWD until it finds `.arbor/`, so it works when the terminal is in a subdirectory (monorepo package, etc.) or when sub-agent spawn inherits a drifted CWD.

### Why No State Machine / No Extra `task.json` Fields

After first-principles analysis (historical task:
`.arbor/tasks/archive/2026-04/04-17-workflow-enforcement-v2/prd.md`), we
dropped the original design's `current_phase` string / `phase_history` /
`checkpoints` / 7 new `task.py` commands / skill tail blocks. The core insight:
**workflow.md Phase 1.0/1.1/... is documentation layering, not runtime state**.
The existing `task.json.status` (`planning` / `in_progress` / `completed`) is
sufficient to express task lifecycle; sub-phase position is inferred by the AI
from conversation history + git state.

This keeps state minimal, avoids the "task.json drifts from filesystem reality" class of bugs, and is trivially customizable — users modify one markdown file, not Python/TypeScript.

---

## Bootstrap & Joiner Task Auto-Generation

`arbor init` generates a first-session task based on checkout state. Three branches dispatch off two filesystem flags:

| `.arbor/` exists? | `.arbor/.developer` exists? | Meaning                                                           | Task generated                           |
| ------------------- | ----------------------------- | ----------------------------------------------------------------- | ---------------------------------------- |
| no                  | n/a                           | First-time `init` on this project                                 | `00-bootstrap-guidelines` (creator flow) |
| yes                 | no                            | Fresh clone / per-checkout first-init (new machine, new teammate) | `00-join-<slug>` (joiner flow)           |
| yes                 | yes                           | Same dev re-running init                                          | none (no-op)                             |

### Design Decision: `.developer` File Is the Per-Checkout Signal

**Context**: we need a signal for "this checkout has never been init'd by this developer before" to trigger joiner onboarding.

**Options Considered**:

1. `.arbor/workspace/<name>/` directory existence — ❌ this dir is committed to git, so a fresh clone already has it
2. A registry file listing onboarded developers — ❌ needs migration + bookkeeping, over-engineered for single-user checkouts
3. `.arbor/.developer` file existence — ✅ **chosen**

**Decision**: Use `.arbor/.developer` (gitignored) as the per-checkout onboarding signal.

**Why**: `.arbor/.developer` is declared in `.arbor/.gitignore` (template `gitignore.txt`), so it is never committed. A fresh clone has an empty `.developer` slot by construction; the first `init` writes it. Subsequent same-machine re-inits see the file and no-op.

**Consequence (accepted)**: Same developer on two machines (laptop A + laptop B) gets a joiner task on laptop B. This is fine — it's a chance to re-read the spec, and archiving is one command.

**Anti-pattern**: Do not use `.arbor/workspace/<name>/` existence as "this developer already onboarded" — that directory is the journal archive and belongs to git.

### Gotcha: Joiner Dispatch Must Be Wired in Two Places

`arbor init` has two code paths that both reach the end of initialization but through different branches of `init()`. Any new init-time trigger (joiner onboarding, future first-session tasks, etc.) must be registered in **both**:

**Path 1 — Main dispatch** (`src/commands/init.ts`, near the end of `init()`):

- Reached only when `!isFirstInit` is false **OR** `options.force` / `options.skipExisting` is set
- Fires from the block that runs after `createWorkflowStructure` + `init_developer.py`

**Path 2 — Re-init fast path** (`handleReinit`, inside `doAddDeveloper` branch):

- Reached when `.arbor/` already exists AND user runs default `arbor init --user <name>` (no `--force`, no `--skip-existing`)
- `init()` short-circuits via `if (!isFirstInit && !options.force && !options.skipExisting) { await handleReinit(...); return; }` — main dispatch is **never executed**

Both paths must capture the pre-existing `.developer` state **before** running `init_developer.py` (which writes the file), then use that snapshot to decide whether joiner generation applies.

```typescript
// Path 1 (init end) — snapshot at init() start
const hadDeveloperFileAtStart = fs.existsSync(developerFilePath);
// ... later, after init_developer.py:
if (!isFirstInit && !hadDeveloperFileAtStart) {
  createJoinerOnboardingTask(cwd, developerName);
}

// Path 2 (handleReinit) — snapshot just before init_developer.py
const hadDeveloperFileBefore = fs.existsSync(developerFilePath);
execSync(`${pythonCmd} ${initDeveloperScript} "${devName}"`, { ... });
if (!hadDeveloperFileBefore) {
  createJoinerOnboardingTask(cwd, devName);
}
```

**Test coverage requirement**: integration tests must cover BOTH paths. The quick way to detect regressions is to run `init` without `force: true` and assert joiner-task creation — tests that all pass `{ force: true }` will miss Path 2 bugs entirely.


---

## Common Mistakes

### Forgot to add entry to PLATFORM_FUNCTIONS

**Symptom**: `arbor init` configures the platform, but `arbor update` doesn't track its template files, and `getConfiguredPlatforms` never detects the platform.

**Cause**: `collectTemplates` is optional on `PlatformFunctions`, so a registry entry that omits it compiles and fails silently.

**Fix**: Register with `{platform}: fromTemplates(collect{Platform}Templates)` in `src/configurators/index.ts`. That form cannot omit `collectTemplates`, it *is* `collectTemplates`.

### Missing CLI flag or InitOptions field

**Symptom**: `arbor init --{platform}` doesn't work.

**Fix**: Add `--{platform}` option in `src/cli/index.ts` and `{platform}?: boolean` in `InitOptions` in `src/commands/init.ts`. These are static declarations that cannot be derived from the registry.
### Template placeholder not resolved in collectTemplates

**Symptom**: `arbor update` auto-updates platform files on every run, even when nothing changed. The update summary shows hooks/settings as "changed".

**Cause**: `collect{Platform}Templates()` puts a raw template into the map without calling `resolvePlaceholders()`, so `{{PYTHON_CMD}}` survives into the written file and into the update comparison.

**Fix**: Call `resolvePlaceholders()` at the point the entry is added to the map, e.g. `files.set(".starFactory/settings.json", resolvePlaceholders(settings.content))`. Because the map is now the single description, the placeholder resolves identically on both paths by construction — there is no second site to keep in sync.

Note this is *only* about `{{…}}` placeholders. The separate `python3` → `python` literal rewrite is applied centrally by `renderTemplateMap` on both paths, so that half of this bug class is structurally closed.
### Init-time settings.json key injection serialized differently from update's preservation

**Symptom**: On a freshly initialized project that used an opt-in feature (e.g., `--with-statusline`), the very first `arbor update` reports `.claude/settings.json` as "Template updated (will auto-update)", rewrites it, and leaves a spurious backup — with zero actual changes.

**Cause**: Init injected the key at a hand-picked position in the template (e.g., `statusLine` "between `env` and `hooks`"), but update's preservation step (`preserveExistingClaudeStatusLine()` in `update.ts`) re-adds preserved keys via plain `parse → assign → stringify`, which appends at the end. The two serializations differ byte-wise, so the content comparison flags a false change.

**Fix**: The init-time injection must mirror the update-time preservation routine byte-for-byte (same parse → assign → stringify, same indent). Pinned by a regression test asserting `settings.json` byte-identity across `update --force` on a fresh opted-in project.

**Rule**: A feature that both (a) injects a key into a generated JSON file at init and (b) preserves that key during update must produce identical serialization on both paths — key order is part of the contract. Assert byte-identity (not deep-equality) in tests; deep-equal comparisons cannot catch key-order drift.
### Template listed in update but not created by init

**Symptom**: `arbor update` always detects a "new file" to add, even on a freshly initialized project with the same version.

**Cause**: `collectTemplateFiles()` in `update.ts` lists a file that `createSpecTemplates()` / `createWorkflowStructure()` in init never creates. The two template lists are out of sync.

**Fix**: Ensure every file listed in `collectTemplateFiles()` is actually created during `init`. If a file is project-specific (not a user template), do not include it in the update template list.
### Project-type-conditional content not gated in init or update

**Symptom**: Pure backend project gets empty frontend spec templates after `arbor init`. After user deletes the unwanted `spec/frontend/` dir, `arbor update` recreates it.

**Cause (init)**: `createSpecTemplates()` in `workflow.ts` received `projectType` but ignored it (parameter named `_projectType`). All project types got both backend and frontend spec dirs.

**Cause (update)**: `collectTemplateFiles()` in `update.ts` unconditionally included all backend + frontend spec files in the template map, without checking whether `spec/backend/` or `spec/frontend/` actually existed on disk.

**Fix (init)**: Use `projectType` to conditionally create spec dirs:

- `"backend"` → guides + backend only
- `"frontend"` → guides + frontend only
- `"fullstack"` / `"unknown"` → guides + both

**Fix (update)**: Wrap backend/frontend spec file blocks in `fs.existsSync()` checks (same pattern as `getConfiguredPlatforms()` for platform dirs).

**Rule**: When init creates content conditionally based on project type, update must check for directory existence before including files in its template map. The two paths must agree.
### Updated command/skill content in a platform template instead of common/

**Symptom**: After updating a command in one platform's template, the other platform still uses old content.

**Cause**: Command and skill content lives in `src/templates/common/` as the single source of truth. Editing platform-specific copies creates drift.

**Fix**: Always edit templates in `src/templates/common/commands/` or `src/templates/common/skills/`. Both platforms derive their content from there via `resolveCommands()` / `resolveSkills()`.

### Forgot to use shared hooks

**Symptom**: A platform's hooks directory contains duplicated Python scripts instead of the shared ones.

**Cause**: A hook script was copied from another platform's template directory instead of calling `collectSharedHooks(hooksDir, platform)` from `shared.ts`.

**Fix**: Add the platform to `SHARED_HOOKS_BY_PLATFORM` with the hooks it can actually invoke, then use `collectSharedHooks()`.

**Prevention**: Declaring the platform in the table is only half the wiring, see "Declaring a shared hook is half the wiring" above.

### Hardcoded JSONL fallback paths

**Symptom**: Agent definitions reference JSONL files that don't exist (e.g., `debug.jsonl`, `plan.jsonl`).

**Cause**: Only `implement.jsonl` and `check.jsonl` exist as task JSONL files. Definitions were copied from older versions that referenced removed JSONL types.

**Fix**: Ensure `.arbor/agents/*.md` and the templates only reference `implement.jsonl` and `check.jsonl`.

### `__pycache__` in template hooks directory causes EISDIR crash

**Symptom**: Tests fail with `EISDIR: illegal operation on a directory, read` when listing hook files under `src/templates/`.

**Cause**: Running a Python hook locally (e.g., `python3 session-start.py` for testing) creates `__pycache__/` inside `src/templates/shared-hooks/` or `src/templates/claude/hooks/`. `listFiles("hooks")` returns `__pycache__` as an entry, then `readFileSync("hooks/__pycache__")` fails because it's a directory.

**Fix**: `find packages/cli/src/templates -name __pycache__ -type d -exec rm -rf {} +`. Consider adding `__pycache__` to `.gitignore` or filtering directories in `listFiles()`.

**Prevention**: Don't run Python hooks directly from `src/templates/` during development. Use `/tmp` copies or the installed project copy instead.
### Added an init-time trigger but forgot the `handleReinit` fast path

**Symptom**: The trigger works when users pass `--force` / `--skip-existing` / run init on an empty dir, but the default `arbor init --user <name>` on an existing checkout silently does nothing. Integration tests pass.

**Cause**: `init()` at `src/commands/init.ts` early-returns into `handleReinit` when `.arbor/` already exists and neither `--force` nor `--skip-existing` is set. Main dispatch at the end of `init()` is never reached. If the new trigger is only wired into main dispatch, the most common real-user path is uncovered.

**Fix**: Wire the trigger into BOTH (a) the main-dispatch block near the end of `init()` AND (b) `handleReinit`'s `doAddDeveloper` / `doAddPlatforms` branch, whichever is relevant. Capture any pre-init filesystem state (e.g., `.developer` existence) in each path separately, before scripts that mutate it run.

**Prevention**: Integration tests must cover the default path WITHOUT `force: true`. Any test using `force: true` bypasses `handleReinit` and is not testing real-user behavior. See "Bootstrap & Joiner Task Auto-Generation" above for the canonical two-point wiring pattern.

---

## Arbor dispatch hooks (current mechanism)

Claude Code and StarFactory register two PreToolUse hooks (see `templates/claude/settings.json` and `templates/star/settings.json`):

| Hook | Matcher | Timeout | Behavior |
|---|---|---|---|
| `inject-delegation-context.py` | `^mcp__codeg[-_]mcp__delegate_to_agent$` | 30 | Inlines task context into `tool_input.task`, marked `<!-- arbor-hook-injected -->`. Role resolution: `Role:` header line, then `.arbor/.runtime/codeg-assistants.json` `by_id[assistant_id].role`, else no-op. Task: `Active task:` header, else the session active task. Output is `updatedInput` with only `task` replaced. Prompt assembly is shared with `dispatch.py` via `common/dispatch_context.py`. |
| `guard-builtin-agent.py` | `^(Agent\|Task)$` | 10 | Denies the built-in Agent/Task tool when the call is an Arbor role dispatch (prompt carries `Active task:` / `Role:`, or `subagent_type` starts with `arbor-`), unless `dispatch.guard_builtin_agent` is false. Other calls pass through. |

SessionStart (`session-start.py`) adds the `<dispatch>` section with the resolved assistant ids; UserPromptSubmit (`inject-workflow-state.py`) emits the per-turn breadcrumb. The dispatch contract itself is in `dispatch.md`.
