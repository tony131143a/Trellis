---
sources:
  - packages/cli/src/configurators/shared.ts
  - packages/cli/src/configurators/index.ts
  - packages/cli/src/configurators/claude.ts
  - packages/cli/src/configurators/codex.ts
  - packages/cli/src/templates/common/index.ts
last_verified: 2026-11-13
---
# Configurator Shared Helpers

How `packages/cli/src/configurators/shared.ts` is structured: what it exports, what each helper guarantees, and when a platform configurator should reach for shared logic vs. write its own.

For per-platform integration mechanics (which files each platform installs), see `platform-integration.md`. This spec only covers the cross-cutting helpers.

---

## Overview

`configurators/shared.ts` exists to keep the per-platform configurators — one `configurators/<platform>.ts` per entry in `AI_TOOLS`, currently `claude.ts` (Claude Code) and `codex.ts` (Codex) — from independently re-implementing the same byte-for-byte rendering and write logic. Drift between configurators reliably becomes a bug:

- If two platforms render `{{PYTHON_CMD}}` differently, `arbor update`'s template-hash compare reports a phantom diff after every install.
- If a platform's file set is described in two places, the two descriptions disagree and `arbor update` silently stops managing whichever file only one of them names (see "Template maps" below).

A helper belongs in `shared.ts` when (a) two or more configurators need the same behavior **or** (b) a single configurator needs the helper in **both** the init write path and the update collect path — putting it in shared.ts forces both to call the same code.

A helper does **not** belong in `shared.ts` when it encodes platform-specific formatting (e.g. Claude Code's statusline settings injection). Those stay in the per-platform configurator.

---

## Public helper roster

### Python command resolution

`configurators/shared.ts:setResolvedPythonCommand` — called once by `commands/init.ts` after probing the host (`python` / `python3` / `py -3`). All subsequent renders pick up the resolved value.

`configurators/shared.ts:resetResolvedPythonCommand` — test helper. Unit tests that exercise rendering without going through init must call this in `beforeEach`/`afterEach` to avoid leaking module state between cases.

`configurators/shared.ts:getPythonCommandForPlatform` — returns the resolved command if init has run; otherwise the static default (`python` on Windows, `python3` elsewhere). The optional `platform` arg exists solely for unit tests; production callers must not pass it (passing it bypasses the resolved cache).

`configurators/shared.ts:replacePythonCommandLiterals` — line-wise replace of literal `python3` with the resolved command, **excluding shebang lines** (`#!`). Idempotent; no-op when the resolved command is `python3`. Applied to whole template maps so even raw `.py` and `.md` content (templates that don't go through `resolvePlaceholders`) gets the right command on Windows. Configurators do not call it per file: `renderTemplateMap` applies it to every entry of a map, and both paths funnel through that one call — `writeTemplateMap` on init, `collectPlatformTemplates` on update.

### Placeholder substitution

`configurators/shared.ts:resolvePlaceholders` — the standard renderer. Resolves `{{PYTHON_CMD}}`, `{{CMD_REF:name}}`, `{{EXECUTOR_AI}}`, `{{USER_ACTION_LABEL}}`, `{{CLI_FLAG}}`, plus conditional blocks `{{#FLAG}}…{{/FLAG}}` / `{{^FLAG}}…{{/FLAG}}` for `AGENT_CAPABLE` and `HAS_HOOKS`. Cleans up consecutive blank lines left by removed conditionals. Without a `TemplateContext` it only resolves `{{PYTHON_CMD}}` (used for `settings.json`).

### Template wrapping

`configurators/shared.ts:wrapWithSkillFrontmatter` — prefixes a resolved skill body with `---\nname: <name>\ndescription: "<desc>"\n---\n\n`. Description comes from the module-private `SKILL_DESCRIPTIONS` registry (entries `arbor` and `update-spec`), keyed by the bare skill name (the `arbor-` prefix is stripped before lookup). Throws when the description is missing — this is intentional: a skill that ships without a description fails the AI auto-trigger matcher silently in production, so we fail loudly at init.

### High-level template resolvers

These are the canonical entry points for configurators. Use them; do **not** stitch `getSkillTemplates() + resolvePlaceholders + wrapWithSkillFrontmatter` by hand in a configurator — that is how drift creeps in.

`configurators/shared.ts:resolveSkills` — returns `ResolvedTemplate[]` (`{ name, content }`): every single-file skill under `templates/common/skills/` (today only `update-spec`) as `arbor-<name>`, wrapped with skill frontmatter and rendered with the platform `TemplateContext`. The caller passes the result to `collectSkillTemplates`, which places it at `<skillsRoot>/arbor-<name>/SKILL.md`.

`configurators/shared.ts:resolveBundledSkills` — resolves multi-file built-in skills (everything under `templates/common/bundled-skills/`, today `arbor-spec-bootstrap`) into `ResolvedSkillFile[]`. Each entry has a POSIX-relative path under the skill name (e.g. `arbor-spec-bootstrap/references/spec-writing.md`). Bundled `SKILL.md` already owns its frontmatter — this helper does **not** wrap it. Pass the result to `collectSkillTemplates()` as its third argument; omitting it drops every bundled skill from that platform.

### Map builders

These build the `Map<relPath, content>` that a `collect<Platform>Templates()` returns. See "Template maps" below for why that map is the only place a platform's file set may be written down.

`configurators/shared.ts:collectSkillTemplates(skillsRoot, skills, bundledSkills?)` — single-file skills as `<skillsRoot>/<name>/SKILL.md`, plus any bundled skill files at their relative paths under `<skillsRoot>/`. Claude Code passes `.claude/skills`, Codex `.agents/skills`.

`configurators/shared.ts:renderTemplateMap(files)` — applies `replacePythonCommandLiterals` to every value of a map. The one place the Windows rewrite runs for platform files; `writeTemplateMap` and `collectPlatformTemplates` both go through it, which is what makes their bytes equal by construction rather than by discipline.

`configurators/shared.ts:writeTemplateMap(cwd, files)` — renders through `renderTemplateMap`, then writes every entry under `cwd`, creating parent directories. Map keys are split on `/`, which is why keys must be POSIX — the guide's `toPosix`-at-the-boundary rule is load-bearing for the write path, not just the hash dictionary. Idempotent.

---

## Template maps — a platform's file set, described once

### 1. Scope / Trigger

A platform used to be described twice: `configure<Platform>()` wrote its files to disk and `collectTemplates` returned the same set as a map for `arbor update` to diff. Two descriptions of one thing disagree eventually, and a one-sided edit ships silently — in upstream Trellis, a configurator wrote a skill file with no matching `collectTemplates` entry, so upgraders' `arbor update` deleted the old skill dir and never regenerated the new one.

There is now exactly one description. This section is the contract for it, and it is a *code-spec* trigger on two counts: the per-category write helpers that let a configurator enumerate files a second time were deleted, and the init/update agreement is a cross-layer contract enforced by a test rather than by types.

### 2. Signatures

```typescript
// configurators/<platform>.ts — the required export, one per platform
export function collect<Platform>Templates(): Map<string, string>;

// configurators/<platform>.ts — only when a residual exists (1 platform: claude-code)
export function configure<Platform>(
  cwd: string,
  options?: PlatformConfigureOptions,
): Promise<void>;

// configurators/index.ts — registry entry shape
interface PlatformFunctions {
  configure: (cwd: string, options?: PlatformConfigureOptions) => Promise<void>;
  collectTemplates?: () => Map<string, string>;
}

// configurators/index.ts — derives `configure` from the map
function fromTemplates(
  collectTemplates: () => Map<string, string>,
): PlatformFunctions;

// configurators/shared.ts — the render and write halves
export function renderTemplateMap(files: Map<string, string>): Map<string, string>;
export function writeTemplateMap(cwd: string, files: Map<string, string>): Promise<void>;

// configurators/index.ts — the two consumers
export function configurePlatform(platformId: AITool, cwd: string, options?: PlatformConfigureOptions): Promise<void>;
export function collectPlatformTemplates(platformId: AITool): Map<string, string> | undefined;
```

### 3. Contracts

**Map key** — a POSIX relative path from the project root, root prefix included (`.claude/settings.json`, `.agents/skills/arbor-update-spec/SKILL.md`). Never absolute, never backslashed: `writeTemplateMap` splits on `/` to build the target path, and the same string is the hash key in `.template-hashes.json`, so a Windows-shaped key would produce a different manifest on Windows than on macOS. A configurator that builds keys from `path.join` must pass them through `toPosix` first (`utils/posix.ts`) — see `guides/cross-platform-thinking-guide.md` → "Logical key vs filesystem path".

**Map value** — the file's final content *before* the `python3` → `python` rewrite. Do not call `replacePythonCommandLiterals` per entry; `renderTemplateMap` does it for the whole map on both paths.

**`collectTemplates` purity** — it takes no `cwd`, and that is deliberate: it cannot read or write the project, so `arbor update` gets the same answer whatever the project looks like. It may read bundled templates off the package's own directory.

**`configure` derivation** — `fromTemplates(collect…)` gives `configure = (cwd) => writeTemplateMap(cwd, collect…())`. Codex uses it; Claude Code spells out both fields because of its residual.

**Residual** — the only reason to spell out both fields. A residual is work that cannot be expressed in the `collectTemplates` map. It must not restate the file list. One exists:

| Platform | Residual | Why a map can't carry it |
|---|---|---|
| `claude-code` | `--with-statusline` adds `.claude/hooks/statusline.py` and replaces the `settings.json` entry (`configureClaude` in `claude.ts`) | Per-init flag; `collectTemplates` has no parameter, and an entry there would force-install the statusline on projects that opted out |

**Nothing else may decide what a platform installs.** No second directory walk, no additional write inside `configure`, no "and also copy this one file" in `commands/init.ts`. Migrations still name specific paths — that is their job (deleting or renaming files a *previous* version installed) and it is a different question from what the current version installs. Tests may assert specific paths; they must not be the source of them.

### 4. Validation & Error Matrix

Every row is a build failure, not a runtime one. All live in `test/configurators/platforms.test.ts` unless noted.

| Condition | Failure |
|---|---|
| `configure` writes a path `collectTemplates` doesn't hold | "configurePlatform writes no file collectTemplates does not describe, for every platform" — unless the path is in `CONFIGURE_ONLY_PATHS` |
| `collectTemplates` holds a path `configure` doesn't write | "configurePlatform writes collected templates byte-for-byte for every platform" |
| Contents differ between the two | same test, byte compare |
| Contents differ only under `setResolvedPythonCommand("python")` | "configurePlatform and collectTemplates agree under Windows python rendering" — the case a macOS/Linux run cannot see, because the rewrite is a no-op there |
| `configure` creates an empty directory | "created empty directories not named in `CONFIGURE_ONLY_EMPTY_DIRS`" |
| Running `configure` twice changes any byte | "`<id>` is not idempotent" |
| Registry entry omits `collectTemplates` | No failure. `collectPlatformTemplates` returns `undefined`, `arbor update` skips the platform, and `getConfiguredPlatforms` can never detect it. Silent, which is why every platform has one today |

Two exemption constants exist in the test file, each with a comment:

- `CONFIGURE_ONLY_PATHS = {".claude/hooks/statusline.py"}` — opt-in only, kept out of `collectTemplates` on purpose and separately locked by `regression.test.ts` "[statusline-opt-in] statusline.py is not in claude's collected templates". **Known, deliberately unfixed consequence**: init records the file in `.template-hashes.json`, then `pruneOrphanManifestKeys` drops it as an orphan (it is in neither `collectTemplates` nor a migration), so an opted-in user's statusline is frozen after their first `arbor update` and left behind by `arbor uninstall`.
- `CONFIGURE_ONLY_EMPTY_DIRS = {}` — currently empty; add a platform entry only if a configurator must create a directory with no file in it.

### 5. Good / Base / Bad Cases

- **Good** — a new platform ships `collect<Platform>Templates()` and one `fromTemplates(...)` line in `PLATFORM_FUNCTIONS`. `configure` is derived; `arbor update` tracks every file from the first release; nothing can drift because there is nothing to drift from. `codex.ts` is this case.
- **Base** — a platform needs a residual. It exports both, `configure` starts from `collect…()`, applies the residual on top, and makes one `writeTemplateMap` call, with a comment naming what the map cannot express. `configureClaude` is the only example today: it takes `collectClaudeTemplates()`, swaps in the statusline `settings.json` and adds `statusline.py` when opted in, then writes once.
- **Bad** — `configure` opens its own `writeFile` for "just one more file" that every install gets. It is now invisible to `arbor update`: never hash-tracked, never updated, never uninstalled. This is the upstream skill-file bug verbatim, and the reverse assertion exists to catch exactly it.

### 6. Tests Required

When you add or change a platform's file set:

1. `test/configurators/platforms.test.ts` — the whole-registry assertions in §4 cover it automatically; they derive the platform list from `PLATFORM_IDS`, so a new platform is covered the moment it is registered. **Do not add a per-platform copy of them.**
2. Content assertions for what the platform emits (which skills, correct frontmatter): `test/configurators/platforms.test.ts` (per-platform cases such as "configurePlatform('codex') installs the kept skills and nothing under .codex/") and `test/templates/claude.test.ts`.
3. If the change adds a residual, add a test that exercises it directly — assertion point is the residual's own effect (a file is present / a settings key is set), never the file set, which the registry-wide tests already own.
4. If a path must be exempt from the parity oracle, add it to `CONFIGURE_ONLY_PATHS` or `CONFIGURE_ONLY_EMPTY_DIRS` **with a comment stating why and what the consequence is**. A silently weakened assertion is how the two-description bug survived three releases.

### 7. Wrong vs Correct

#### Wrong

```typescript
// configurators/foo.ts
export async function configureFoo(cwd: string): Promise<void> {
  for (const skill of resolveSkills(ctx)) {
    await writeFile(path.join(cwd, ".foo/skills", skill.name, "SKILL.md"), skill.content);
  }
  await writeFile(path.join(cwd, ".foo/config.json"), getConfig());
}

export function collectFooTemplates(): Map<string, string> {
  return collectSkillTemplates(".foo/skills", resolveSkills(ctx));
  // config.json described nowhere
}
```

The file set is written down twice. `config.json` is on disk but untracked, so `arbor update` will never update it and `arbor uninstall` will leave it behind.

#### Correct

```typescript
// configurators/foo.ts — the only description
export function collectFooTemplates(): Map<string, string> {
  const files = collectSkillTemplates(
    ".foo/skills",
    resolveSkills(ctx),
    resolveBundledSkills(ctx),
  );
  files.set(".foo/config.json", resolvePlaceholders(getConfig()));
  return files;
}

// configurators/index.ts
foo: fromTemplates(collectFooTemplates),
```

No `configureFoo` at all. If Foo later needs a residual, it grows a `configureFoo` that starts from `collectFooTemplates()` and writes through `writeTemplateMap` — it never re-lists the files.

---

## Placeholder substitution semantics

Resolution happens **at template-write time** (`arbor init`, `arbor update`). There are no runtime placeholders — by the time a skill or settings file is written to disk, every `{{…}}` is gone.

### Substitution table

| Placeholder | Source | Resolved by | Notes |
|-------------|--------|-------------|-------|
| `{{PYTHON_CMD}}` | `getPythonCommandForPlatform()` | `resolvePlaceholders`, `replacePythonCommandLiterals` (line-wise, applied additionally on every write) | Init resolves once after probing host; tests must `resetResolvedPythonCommand()` |
| `{{CMD_REF:name}}` | `ctx.cmdRefPrefix` | `resolvePlaceholders` | Per-platform reference prefix: `/arbor:` (Claude Code), `$` (Codex) |
| `{{EXECUTOR_AI}}` | `ctx.executorAI` | `resolvePlaceholders` | Description of the AI executor for prompt prose |
| `{{USER_ACTION_LABEL}}` | `ctx.userActionLabel` | `resolvePlaceholders` | `Slash commands` (Claude Code), `Skills` (Codex) |
| `{{CLI_FLAG}}` | `ctx.cliFlag` | `resolvePlaceholders` | `claude` or `codex`, used in `--platform` examples |
| `{{#AGENT_CAPABLE}}…{{/AGENT_CAPABLE}}` | `ctx.agentCapable` | `resolvePlaceholders` | Block kept iff true |
| `{{^AGENT_CAPABLE}}…{{/AGENT_CAPABLE}}` | `ctx.agentCapable` | `resolvePlaceholders` | Block kept iff false |
| `{{#HAS_HOOKS}}…{{/HAS_HOOKS}}` | `ctx.hasHooks` | `resolvePlaceholders` | Block kept iff true |
| `{{^HAS_HOOKS}}…{{/HAS_HOOKS}}` | `ctx.hasHooks` | `resolvePlaceholders` | Block kept iff false |

The shipped templates use only `{{PYTHON_CMD}}` today (`templates/common/skills/update-spec.md`, `templates/claude/skills/arbor.md`); the other placeholders are supported by the renderer and covered by `test/configurators/shared.test.ts`.

Adding a new placeholder requires two changes — the regex constant at the top of `shared.ts` and a substitution in `resolvePlaceholders`.

### Conditional block cleanup

After conditional blocks are stripped, `resolvePlaceholders` runs `RE_BLANK_LINES = /\n{3,}/g` → `\n\n` to collapse the empty regions that removed blocks leave behind. This means templates can use `{{#FLAG}}…{{/FLAG}}` separated from surrounding prose by blank lines without producing 5-line gaps when the flag is false.

---

## Cross-configurator invariants

Configurators must respect these. They are not enforced by types; tests in `test/configurators/` and `test/regression.test.ts` catch most violations.

- **A platform's file set is described once.** `collect<Platform>Templates()` is that description; `configure` writes it. See "Template maps" above for the full contract, the permitted residual, and the parity oracle that enforces it in both directions.
- **`replacePythonCommandLiterals` runs once per map, in `renderTemplateMap`.** Both `writeTemplateMap` (init) and `collectPlatformTemplates` (update) go through it, so the rewrite cannot land on one path only. A configurator that calls it per entry is duplicating work — the rewrite is idempotent, so the duplicate is harmless but pointless.
- **Skill descriptions live in `SKILL_DESCRIPTIONS`.** Adding a single-file skill requires adding the description here; `wrapWithSkillFrontmatter` throws at init if the description is missing.
- **Bundled skills already own frontmatter.** `wrapWithSkillFrontmatter` must not be applied to `resolveBundledSkills` output. `collectSkillTemplates` takes bundled files as a separate third argument for this reason.

---

## Boundaries

`configurators/shared.ts` does not:

- **Encode platform-specific layout.** Where each platform writes (`.claude/`, `.agents/skills/`) is decided by the per-platform configurator. Shared helpers take a root argument and don't compute it.
- **Read user input.** Init prompts, `--user`, `--force` flags, project-type detection — all in `commands/init.ts`.
- **Touch the network.** No template fetching; no version probing. Everything operates on bundled templates loaded from `templates/common/index.ts`.
- **Mutate the registry.** `types/ai-tools.ts:AI_TOOLS` is read-only from this file. Adding a platform updates the registry first, then the configurator file consumes it.
- **Decide capability flags.** `agentCapable` / `hasHooks` come from the `templateContext` of each `AI_TOOLS` entry in `types/ai-tools.ts`; shared helpers only read them.
- **Touch user-owned content.** `.arbor/spec/`, `.arbor/.developer`, `.arbor/tasks/`, `.arbor/workspace/` belong to the project, not to configurators.
- **Cache anything other than the resolved Python command.** The single piece of module state (`resolvedPythonCommand`) exists because init runs once and configurators are called repeatedly afterward. Anything else with cross-call lifetime belongs at the `commands/init.ts` call site, not here.

---

## Common pitfalls

### Adding platform-specific behavior to `shared.ts`

Wrong:

```typescript
// In shared.ts
export function injectClaudeStatusLine(content: string): string {
  // Claude-only settings.json formatting
}
```

Correct: that logic belongs in `configurators/claude.ts` (it lives there today as the private `injectStatusLine`). Only promote helpers to `shared.ts` when a second configurator needs them.

### Re-listing a platform's files inside `configure`

Wrong:

```typescript
export async function configureFoo(cwd: string): Promise<void> {
  await writeTemplateMap(cwd, collectFooTemplates());
  // "just one more file"
  await writeFile(path.join(cwd, ".foo/extra.json"), getExtra());
}
```

Correct: put `.foo/extra.json` in `collectFooTemplates()` and delete the extra write. A residual expresses something a `Map<path, content>` cannot (today: a per-init opt-in) — it never adds a file every install gets. See "Template maps" above; the parity oracle in `test/configurators/platforms.test.ts` fails on this exact shape.

### Forgetting `replacePythonCommandLiterals` in a write outside a template map

Platform configurators can't hit this any more — everything they emit goes through `renderTemplateMap`. It still applies to writers that don't produce a platform map: `configurators/workflow.ts` and the root-file writers in `commands/init.ts`.

Wrong:

```typescript
// configurators/workflow.ts — writing .arbor/ content directly
await writeFile(
  path.join(cwd, PATHS.WORKSPACE, "index.md"),
  agentProgressIndexContent,
);
```

Correct (what `createWorkflowStructure` does):

```typescript
await writeFile(
  path.join(cwd, PATHS.WORKSPACE, "index.md"),
  replacePythonCommandLiterals(agentProgressIndexContent),
);
```

If init writes `python3` but the host is Windows where `python3` doesn't exist, the command silently fails at runtime. The rewrite is idempotent, so calling it on content that will also pass through `renderTemplateMap` is harmless.

### Missing skill description

Wrong: adding a new skill template under `templates/common/skills/foo.md` without registering its description.

Correct: edit `SKILL_DESCRIPTIONS` in `configurators/shared.ts` to add the new entry. The throw in `wrapWithSkillFrontmatter` is the safety net that prevents shipping a skill the AI matcher can never trigger; the parity tests in `test/configurators/platforms.test.ts` call every platform's collector, so a missing description fails the suite.

### Reading `process.platform` directly inside a configurator helper

Wrong:

```typescript
// In a per-platform configurator
const pythonCmd = process.platform === "win32" ? "python" : "python3";
```

Correct:

```typescript
const pythonCmd = getPythonCommandForPlatform();
```

`process.platform` ignores the resolved-cache that init populates. On a Windows host where init resolved to `py -3`, the wrong form writes `python` literally and fails at runtime.

### Caching at module scope

Wrong: adding a second module-level `let` in `shared.ts` to memoize anything other than the resolved Python command.

Correct: configurators are called from `configurators/index.ts:configurePlatform` and `configurators/index.ts:collectPlatformTemplates`. Pass derived values through arguments. The only module state in this file is `resolvedPythonCommand`, and that exists because init runs in a separate process boundary from the configurator-driven test runs that exercise rendering without init.

---

## Test conventions

Most behavior here is covered by:

- `test/configurators/shared.test.ts` — `replacePythonCommandLiterals`, `getPythonCommandForPlatform`, `resolvePlaceholders` (simple substitutions, conditional blocks, blank-line cleanup, `{{CLI_FLAG}}`).
- `test/configurators/index.test.ts` — registry-derived helpers, bundled-skill tracking, POSIX map keys.
- `test/configurators/platforms.test.ts` — the whole-registry `configure` ⟷ `collectTemplates` parity oracle (both directions, both rendering modes, empty dirs, idempotency) plus per-platform content checks.
- `test/regression.test.ts` — historical issue gates, including the opt-in statusline staying out of Claude's collected templates.

When adding a new helper to `shared.ts`:

1. Add a unit test in `test/configurators/shared.test.ts` exercising the contract directly (input → output, error cases, idempotency).
2. If the helper produces map entries, nothing extra is needed for init/update parity — the oracle in `platforms.test.ts` already covers every platform in both directions. Add a regression test only for behavior the oracle cannot see, e.g. content that is correct on both paths but wrong.
3. If the helper changes the rendered output of an existing template, run `pnpm test` and visually confirm the diff in the platform integration tests; failure usually points at a missing transform on one side of the init/update pair.

When removing a helper:

- Delete uses in every configurator first (`grep -r "helperName" packages/cli/src/configurators/`), then remove from `shared.ts`. Removing from `shared.ts` first leaves stale call sites that compile if the import survives — TypeScript only catches the bare reference, not a removed export with the same name accidentally re-introduced later.
- Run `pnpm typecheck` after removal, then `pnpm test` — type errors usually appear before test failures here because every configurator imports `shared.ts` directly.
