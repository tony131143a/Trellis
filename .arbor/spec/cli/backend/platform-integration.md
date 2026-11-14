---
sources:
  - packages/cli/src/types/ai-tools.ts
  - packages/cli/src/configurators/index.ts
  - packages/cli/src/configurators/shared.ts
  - packages/cli/src/configurators/claude.ts
  - packages/cli/src/configurators/codex.ts
  - packages/cli/src/templates/common/index.ts
  - packages/cli/src/templates/claude/index.ts
  - packages/cli/src/templates/claude/settings.json
  - packages/cli/src/templates/claude/hooks/statusline.py
  - packages/cli/src/templates/arbor/scripts/common/__init__.py
  - packages/cli/src/commands/init.ts
  - packages/cli/src/cli/index.ts
  - packages/cli/src/utils/retired-platforms.ts
last_verified: 2026-11-13
---
# Platform Integration Guide

Arbor supports Claude Code (`.claude/`) and Codex (`.agents/skills/` only). `PLATFORM_IDS` is authoritative. Task execution runs through the driver `arbor.py` and Orca workers, see `driver.md`; no native platform agent profiles, hooks or commands are installed.

---

## Architecture

Platform support uses a **centralized registry pattern**:

- **Data registry**: `src/types/ai-tools.ts` — `AI_TOOLS` record with all platform metadata (`claude-code`, `codex`)
- **Function registry**: `src/configurators/index.ts` — `PLATFORM_FUNCTIONS`, one entry per platform. It holds no per-platform logic
- **Shared configurator utilities**: `src/configurators/shared.ts` — renderers (`resolvePlaceholders()`), resolvers (`resolveSkills()`, `resolveBundledSkills()`), the map builder `collectSkillTemplates()`, and the render/write pair (`renderTemplateMap()`, `writeTemplateMap()`). See `configurator-shared.md`
- **Common templates**: `src/templates/common/` — single source of truth for what both platforms install: the single-file skill `skills/update-spec.md` and the multi-file bundled skill `bundled-skills/arbor-spec-bootstrap/`, with `{{placeholder}}` resolution per platform
- **Claude-only templates**: `src/templates/claude/` — `settings.json`, the body of the main-agent skill `skills/arbor.md`, and the opt-in `hooks/statusline.py`
- **Shared utilities**: `src/utils/compare-versions.ts` — `compareVersions()` with full prerelease support
- **Derived helpers**: `ALL_MANAGED_DIRS`, `getConfiguredPlatforms()`, etc. — consumed by update, init, uninstall, hash tracking

All lists (backup dirs, platform detection, cleanup whitelist) are **derived from the registry automatically**. No scattered hardcoded lists.

---

## The two platforms

| | Claude Code | Codex |
|---|---|---|
| Registry id / CLI flag | `claude-code` / `--claude` | `codex` / `--codex` |
| Skills root | `.claude/skills/` | `.agents/skills/` (`supportsAgentSkills: true`) |
| Skills installed | `arbor/`, `arbor-update-spec/`, `arbor-spec-bootstrap/**` | `arbor-update-spec/`, `arbor-spec-bootstrap/**` |
| Settings | `.claude/settings.json` (`env` + `enabledPlugins`, no hooks) | none |
| Opt-in | `--with-statusline` or the interactive init prompt (`maybePromptStatuslineOptIn`): `.claude/hooks/statusline.py` + a `statusLine` key in `settings.json` | none |
| Root file | managed block in `CLAUDE.md` (`createRootFiles` in init, `collectTemplateFiles` in update) | none (`AGENTS.md` is created by every init when absent) |

`collectClaudeTemplates()` and `collectCodexTemplates()` each describe the exact init/update file set. Codex installs nothing under `.codex/` (asserted in `test/configurators/platforms.test.ts`), so users keep their own `config.toml`; `.codex` stays the registry `configDir` and therefore a managed path.

The skill `arbor` is Claude Code only: its body is `templates/claude/skills/arbor.md` and the root `CLAUDE.md` block loads it by that exact name.

Retired platforms are not in the registry. Their former paths are cleanup-only entries in `src/utils/retired-platforms.ts` (`RETIRED_PLATFORM_PATHS`): `pruneOrphanManifestKeys` keeps them as known manifest keys and `update.ts` adds their top-level directories to `BACKUP_DIRS`.

> **Rule**: a skill that both platforms receive goes into `src/templates/common/skills/` (single file) or `src/templates/common/bundled-skills/<name>/` (multi-file); both platforms pick it up through `resolveSkills()` / `resolveBundledSkills()`. A single-file skill also needs its description in `SKILL_DESCRIPTIONS` (`shared.ts`).

---

## Bundled built-in skills

Multi-file skills with references/assets live under `src/templates/common/bundled-skills/<skill-name>/` and are installed through the same platform skill roots as the single-file skills. Today there is one: `arbor-spec-bootstrap`.

#### Scenario: Multi-file bundled skills

##### 1. Scope / Trigger

Use bundled skills when a built-in skill needs files beyond `SKILL.md`, such as `references/`, examples, or assets. Do not flatten large reference trees into `src/templates/common/skills/*.md`; single-file skills stay there, while multi-file built-ins use `src/templates/common/bundled-skills/<skill-name>/`.

##### 2. Signatures

| Helper                                                    | Contract                                                                                               |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `getBundledSkillTemplates()`                              | Recursively reads `bundled-skills/*/` and returns POSIX relative file paths under each skill directory |
| `resolveBundledSkills(ctx)`                               | Resolves placeholders without adding frontmatter; bundled `SKILL.md` already owns frontmatter          |
| `collectSkillTemplates(skillRoot, skills, bundledSkills)` | Returns single-file skills **and** bundled skill files as map entries under `skillRoot`                |

##### 3. Contracts

- Bundled skill source path: `src/templates/common/bundled-skills/<skill-name>/`.
- Bundled skill target path: `<platform-skill-root>/<skill-name>/<relative-file>`.
- `SKILL.md` inside a bundled skill owns its own YAML frontmatter; `wrapWithSkillFrontmatter()` must not be applied to bundled files.
- Relative file paths returned from the common template reader are POSIX-style, stable, and relative to the skill directory.
- `collectTemplates()` is the single description; `configure` writes it. Bundled skill files are covered by that guarantee automatically.

##### 4. Validation & Error Matrix

| Condition                                                            | Expected behavior                                                         |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Bundled skill directory is missing                                   | Return no bundled skills; single-file skill generation continues          |
| Bundled skill has nested references                                  | Preserve the nested relative path under every platform skill root         |
| Bundled `SKILL.md` contains placeholders                             | Resolve placeholders with the platform `TemplateContext`                  |
| Platform omits `bundledSkills` from its `collectSkillTemplates()` call | That platform silently ships none of them. The parity oracle cannot see this — both paths agree, they just agree on the wrong set — so a test has to assert one bundled file by name |
| Bundled file path uses OS-specific separators                        | Normalize to POSIX relative paths before adding to template maps          |

##### 5. Good/Base/Bad Cases

- Good: `arbor-spec-bootstrap` installs as `<platform-skill-root>/arbor-spec-bootstrap/SKILL.md` plus `references/**`, and `collectPlatformTemplates(platform)` returns the same files.
- Base: no bundled skills exist; `resolveSkills()` behavior remains unchanged.
- Bad: a platform configurator copies `arbor-spec-bootstrap` manually, creating a second installer that update hash tracking can miss.

##### 6. Tests Required

- `test/configurators/index.test.ts` "tracks bundled built-in skill files for every skill-writing platform": asserts `arbor-spec-bootstrap/SKILL.md` and `arbor-spec-bootstrap/references/spec-writing.md` under each platform's skill root.
- `test/configurators/platforms.test.ts`: configured files are byte-for-byte equal to `collectPlatformTemplates()` for every platform.
- `test/commands/init.integration.test.ts`: init writes the skill `SKILL.md` files for Claude Code and Codex.
- Release smoke test when a changelog or docs page claims the skill is
  bundled: build the CLI, verify the skill appears in `npm pack --dry-run
--json` under `dist/templates/common/bundled-skills/<skill>/`, then run the
  built binary in a fresh temp repository and confirm both generated skill
  files and `.arbor/.template-hashes.json` contain the skill paths.

##### 7. Wrong vs Correct

Wrong:

```typescript
files.set(".claude/skills/arbor-spec-bootstrap/SKILL.md", bootstrapSkillContent);
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

**Rule**: Do not add a parallel installer for built-in multi-file skills. Every bundled file reaches disk through the platform's one template map, so `.arbor/.template-hashes.json` tracks it automatically. The failure this rule still guards is the quiet one: forgetting the third argument, which ships zero bundled skills on that platform with no parity failure. The by-name assertion in `test/configurators/index.test.ts` covers it.

**Release rule**: A bundled skill is not release-ready until it has passed the
source, dist, generated-files, and update-tracking chain:
`src/templates/common/bundled-skills/<skill>/` ->
`dist/templates/common/bundled-skills/<skill>/` -> platform skill roots after
built-binary `arbor init` -> `.arbor/.template-hashes.json` -> built-binary
`arbor update --dry-run` with no pending changes.

---

## Python scripts (independent runtime)

Python scripts run in user projects at runtime and cannot import from the TS registry. They carry no per-platform adapter.

The shipped script tree (`packages/cli/src/templates/arbor/scripts/`) and Arbor's own dogfood copy (`.arbor/scripts/`) must stay byte-identical. This is build-enforced, see `script-conventions.md` → "Two script trees, one content".

---

## What You DON'T Need to Update

These are **automatically derived** from the registry:

| Previously hardcoded                          | Now derived from                                                       |
| --------------------------------------------- | ---------------------------------------------------------------------- |
| `BACKUP_DIRS` in update.ts                    | `ALL_MANAGED_DIRS` from `configurators/index.ts`                       |
| `getConfiguredPlatforms()` in update.ts       | `getConfiguredPlatforms()` from `configurators/index.ts`               |
| `cleanupEmptyDirs()` whitelist (`utils/managed-paths.ts`) | `isManagedPath()` / `isManagedRootDir()` from `configurators/index.ts` |
| `collectTemplateFiles()` if/else in update.ts | `collectPlatformTemplates()` dispatch loop                             |
| `TOOLS[]` in init.ts                          | `getInitToolChoices()` from `configurators/index.ts`                   |
| Configurator dispatch in init.ts              | `configurePlatform()` from `configurators/index.ts`                    |
| Windows Python detection in init.ts           | `getPlatformsWithPythonHooks()` from `configurators/index.ts`          |

Static declarations that are **not** derivable: the `--claude` / `--codex` options in `src/cli/index.ts` and the matching `InitOptions` fields in `src/commands/init.ts` (a compile-time assertion `_AssertCliFlagsInOptions` catches a missing field).

---

## Windows Encoding

Entry scripts get UTF-8 stdio on Windows by importing anything from the `common` package: `.arbor/scripts/common/__init__.py` reconfigures `stdout` / `stderr` / `stdin` to `encoding="utf-8", errors="replace"` at import time when `sys.platform == "win32"`, and exposes `configure_encoding()` for an explicit call. A new entry script that imports `common.*` needs nothing more.

A standalone script that cannot import `common` must do it inline. The opt-in `templates/claude/hooks/statusline.py` is the example: it reconfigures `stdin` to UTF-8 unconditionally (hook hosts send UTF-8 JSON) and `stdout` / `stderr` under `sys.platform == "win32"`.

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

**Symptom**: `arbor update` auto-updates platform files on every run, even when nothing changed. The update summary shows settings as "changed".

**Cause**: `collect{Platform}Templates()` puts a raw template into the map without calling `resolvePlaceholders()`, so `{{PYTHON_CMD}}` survives into the written file and into the update comparison.

**Fix**: Call `resolvePlaceholders()` at the point the entry is added to the map, e.g. `files.set(".claude/settings.json", resolvePlaceholders(settings.content))`. Because the map is the single description, the placeholder resolves identically on both paths by construction — there is no second site to keep in sync.

Note this is *only* about `{{…}}` placeholders. The separate `python3` → `python` literal rewrite is applied centrally by `renderTemplateMap` on both paths, so that half of this bug class is structurally closed.

### Init-time settings.json key injection serialized differently from update's preservation

**Symptom**: On a freshly initialized project that used an opt-in feature (e.g., `--with-statusline`), the very first `arbor update` reports `.claude/settings.json` as "Template updated (will auto-update)", rewrites it, and leaves a spurious backup — with zero actual changes.

**Cause**: Init injected the key at a hand-picked position in the template, but update's preservation step (`preserveExistingClaudeStatusLine()` in `update.ts`) re-adds preserved keys via plain `parse → assign → stringify`, which appends at the end. The two serializations differ byte-wise, so the content comparison flags a false change.

**Fix**: The init-time injection (`injectStatusLine` in `claude.ts`) must mirror the update-time preservation routine byte-for-byte (same parse → assign → stringify, same indent). Pinned by `test/commands/update.integration.test.ts`, which asserts `settings.json` byte-identity across `update --force` on a fresh opted-in project.

**Rule**: A feature that both (a) injects a key into a generated JSON file at init and (b) preserves that key during update must produce identical serialization on both paths — key order is part of the contract. Assert byte-identity (not deep-equality) in tests; deep-equal comparisons cannot catch key-order drift.

### Template listed in update but not created by init

**Symptom**: `arbor update` always detects a "new file" to add, even on a freshly initialized project with the same version.

**Cause**: `collectTemplateFiles()` in `update.ts` lists a file that init (`createWorkflowStructure()`, `createRootFiles()`, `configurePlatform()`) never creates. The two template lists are out of sync.

**Fix**: Ensure every file listed in `collectTemplateFiles()` is actually created during `init`. If a file is project-specific (not a user template), do not include it in the update template list.

### Edited a skill in a platform template instead of common/

**Symptom**: After updating a skill for one platform, the other platform still uses old content.

**Cause**: Skills both platforms receive live in `src/templates/common/` as the single source of truth. Copying one into a platform directory creates drift.

**Fix**: Edit `src/templates/common/skills/` or `src/templates/common/bundled-skills/`. Both platforms derive their content from there via `resolveSkills()` / `resolveBundledSkills()`. The only platform-specific skill is `templates/claude/skills/arbor.md`, which is Claude Code only by design.

### Added an init-time trigger but forgot the `handleReinit` fast path

**Symptom**: The trigger works when users pass `--force` / `--skip-existing` / run init on an empty dir, but the default `arbor init --user <name>` on an existing checkout silently does nothing. Integration tests pass.

**Cause**: `init()` at `src/commands/init.ts` early-returns into `handleReinit` when `.arbor/` already exists and neither `--force` nor `--skip-existing` is set. Main dispatch at the end of `init()` is never reached. If the new trigger is only wired into main dispatch, the most common real-user path is uncovered.

**Fix**: Wire the trigger into BOTH (a) the main-dispatch block near the end of `init()` AND (b) `handleReinit`'s `doAddDeveloper` / `doAddPlatforms` branch, whichever is relevant. Capture any pre-init filesystem state (e.g., `.developer` existence) in each path separately, before scripts that mutate it run.

**Prevention**: Integration tests must cover the default path WITHOUT `force: true`. Any test using `force: true` bypasses `handleReinit` and is not testing real-user behavior.
