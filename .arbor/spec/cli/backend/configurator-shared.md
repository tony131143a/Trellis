---
sources:
  - packages/cli/src/configurators/shared.ts
  - packages/cli/src/configurators/index.ts
  - packages/cli/test/configurators/platforms.test.ts
last_verified: 2026-11-18
---
# Configurator Shared Helpers

`configurators/shared.ts` keeps the per-platform configurators (`configurators/claude.ts`,
`configurators/codex.ts`) from re-implementing the same rendering and write logic; drift
between configurators reliably becomes a bug. What each platform installs is in
[platform-integration.md](./platform-integration.md).

## What belongs in `shared.ts`

- A helper belongs there when two or more configurators need it, or when one configurator
  needs it in both the init write path and the update collect path.
- Platform-specific formatting (e.g. Claude Code's statusline injection) stays in the
  per-platform configurator.
- `shared.ts` does not decide where a platform writes, read user input, touch the network,
  mutate `types/ai-tools.ts:AI_TOOLS`, or touch user-owned content
  (`.arbor/spec/`, `.arbor/tasks/`, `.arbor/workspace/`, `.arbor/.developer`).
- Its only module state is `resolvedPythonCommand`; pass anything else through arguments.
  Tests that render without init call `resetResolvedPythonCommand`.

## Invariants

- **A platform's file set is described once.** `collect<Platform>Templates()` returns it as a
  map; `configure` writes that map (`fromTemplates` in `configurators/index.ts`). Nothing else
  decides what a platform installs: no second directory walk, no extra write in `configure` or
  `commands/init.ts`. A residual (work a map cannot express; today only Claude Code's
  opt-in statusline) never restates the file list. Enforced in both directions by the parity
  oracle in `test/configurators/platforms.test.ts`; an exempt path goes in
  `CONFIGURE_ONLY_PATHS` with a comment stating why and the consequence.
- **Map keys are POSIX paths relative to the project root.** The same string is the hash key
  in `.template-hashes.json`; build keys from `path.join` only through `toPosix`.
- **`collectTemplates` takes no `cwd`**, so `arbor update` gets the same answer whatever the
  project looks like.
- **Placeholders are resolved when a file is written** (`init`, `update`); no `{{…}}` reaches
  disk. `resolvePlaceholders` is the renderer.
- **`replacePythonCommandLiterals` runs once per map, in `renderTemplateMap`**, which both
  `writeTemplateMap` (init) and `collectPlatformTemplates` (update) go through. Writers outside
  a platform map (`configurators/workflow.ts`, root files in `commands/init.ts`) call it themselves.
- **Python command comes from `getPythonCommandForPlatform`**, never from `process.platform`.
- **Skill descriptions live in `SKILL_DESCRIPTIONS`.** `wrapWithSkillFrontmatter` throws when a
  single-file skill has none, so a skill the AI matcher can never trigger fails at init.
- **Bundled skills own their frontmatter.** `wrapWithSkillFrontmatter` is never applied to
  `resolveBundledSkills` output; `collectSkillTemplates` takes bundled files as its third argument.
- Configurators use `resolveSkills` / `resolveBundledSkills`; they do not stitch templates,
  placeholders and frontmatter by hand.

## Tests

The whole-registry assertions in `test/configurators/platforms.test.ts` derive the platform
list from `PLATFORM_IDS`; do not add a per-platform copy of them. A new `shared.ts` helper gets
a unit test in `test/configurators/shared.test.ts`.
