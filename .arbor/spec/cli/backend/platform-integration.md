---
sources:
  - packages/cli/src/types/ai-tools.ts
  - packages/cli/src/configurators/index.ts
  - packages/cli/src/configurators/claude.ts
  - packages/cli/src/configurators/codex.ts
  - packages/cli/src/templates/common/index.ts
  - packages/cli/src/utils/managed-removal.ts
  - packages/cli/src/utils/retired-platforms.ts
last_verified: 2026-11-18
---
# Platform Integration

Arbor supports Claude Code and Codex; `PLATFORM_IDS` is authoritative. Task execution runs
through the driver `arbor.py` and Orca workers (see [driver.md](./driver.md)); no native
platform agent profiles, hooks or commands are installed.

## Architecture

- **Data registry**: `src/types/ai-tools.ts` (`AI_TOOLS`), all platform metadata.
- **Function registry**: `src/configurators/index.ts` (`PLATFORM_FUNCTIONS`), one entry per
  platform, no per-platform logic.
- **Shared configurator helpers**: `src/configurators/shared.ts`, see
  [configurator-shared.md](./configurator-shared.md).
- **Common templates**: `src/templates/common/`, the single source of what both platforms install.
- **Claude-only templates**: `src/templates/claude/`.

Backup dirs, platform detection and the cleanup whitelist are derived from the registry; no
scattered hardcoded lists. The only static declarations are the CLI flags in `src/cli/index.ts`
and the matching `InitOptions` fields in `src/commands/init.ts` (`_AssertCliFlagsInOptions`).

## The two platforms

| | Claude Code | Codex |
|---|---|---|
| Registry id / CLI flag | `claude-code` / `--claude` | `codex` / `--codex` |
| Skills root | `.claude/skills/` | `.agents/skills/` |
| Skills | `arbor`, `arbor-update-spec`, `arbor-spec-bootstrap` | `arbor-update-spec`, `arbor-spec-bootstrap` |
| Other files | `.claude/settings.json` (no hooks); managed block in `CLAUDE.md`; opt-in `.claude/hooks/statusline.py` | none |

- Codex installs nothing under `.codex/`, so users keep their own config; `.codex` stays a managed path.
- The skill `arbor` is Claude Code only (`templates/claude/skills/arbor.md`).
- In `AGENTS.md` / `CLAUDE.md` Arbor owns only the `<!-- ARBOR:START -->`…`<!-- ARBOR:END -->`
  block (`utils/managed-paths.ts`); text outside it is the user's.
- Retired platforms are not in the registry: their former paths are cleanup-only entries in
  `utils/retired-platforms.ts:RETIRED_PLATFORM_PATHS`.

## Rules

- A skill both platforms receive lives in `src/templates/common/skills/` (single file) or
  `src/templates/common/bundled-skills/<name>/` (multi-file); edit it there, never in a
  platform directory.
- No parallel installer for a bundled skill: every bundled file reaches disk through the
  platform's one template map. A platform that omits the bundled argument ships none of them
  with no parity failure; the by-name assertion in `test/configurators/index.test.ts` guards it.
- Register a platform as `fromTemplates(collect<Platform>Templates)` in `PLATFORM_FUNCTIONS`;
  a registry entry without `collectTemplates` compiles, and `update` then never tracks it.
- A platform is detected from the template hash manifest, never from directory existence: it
  counts only when the manifest holds a path its current `collectTemplates()` declares under
  one of its managed paths (`getConfiguredPlatforms`). Keep both filters.
- A platform file that also holds user content needs a `StructuredFileSpec` row in
  `utils/managed-removal.ts:buildStructuredFileSpecs`; without it uninstall deletes the whole file.
- A key injected into a generated JSON file at init and preserved at update must serialize
  byte-identically on both paths; tests assert byte-identity, not deep-equality.
- A new init-time trigger is wired into both the main dispatch of `init()` and `handleReinit`;
  tests cover the default path without `force: true`, which bypasses `handleReinit`.
- Python scripts cannot import the TS registry and carry no per-platform adapter. An entry
  script gets UTF-8 stdio on Windows by importing `common`; a standalone one (`statusline.py`)
  does it inline. See [script-conventions.md](./script-conventions.md).
