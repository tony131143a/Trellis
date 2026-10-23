# Provenance: Arbor is a derivative of Trellis

Arbor forked [mindfold-ai/Trellis](https://github.com/mindfold-ai/Trellis) at
commit `8c792c38` (branch `main`, 2026-10-23) under AGPL-3.0-or-later. The
legal record lives in `LICENSE`, `COPYRIGHT` and `NOTICE`; this document
records *how* the rename was performed so future readers can map upstream
documentation, issues and commits onto Arbor identifiers.

## Rename table

Applied in this order to every tracked text file (excluding `LICENSE`,
`COPYRIGHT`, `NOTICE`, `pnpm-lock.yaml`, `.arbor/workspace/**`,
`.arbor/tasks/archive/**`). Lines pointing at upstream URLs
(`mindfold-ai/trellis`, `trytrellis.app`, Discord, shields.io, npm
`@mindfoldhq`) were left untouched and reviewed by hand.

| # | Upstream (Trellis) | Arbor | Notes |
| --- | --- | --- | --- |
| 1 | `@mindfoldhq/trellis-core` | *(removed)* | Asserted absent from code files; `packages/core` was deleted before the rename |
| 2 | `@mindfoldhq/trellis` | `@tony131143a/arbor` | npm name; not published, install via `pnpm build && npm link` |
| 3 | `<!-- TRELLIS:START -->` / `<!-- TRELLIS:END -->` | `<!-- ARBOR:START -->` / `<!-- ARBOR:END -->` | Managed-block markers in AGENTS.md / CLAUDE.md |
| 4 | `TRELLIS_<NAME>` | `ARBOR_<NAME>` | All environment variables (`ARBOR_CONTEXT_ID`, `ARBOR_HOOKS`, `ARBOR_DISABLE_HOOKS`, ...) |
| 5 | `.trellis` | `.arbor` | Project directory; `PATHS.WORKFLOW` and `paths.DIR_WORKFLOW` |
| 6 | `/trellis:` | `/arbor:` | Slash-command namespace |
| 7 | `trellis-hook-injected` | `arbor-hook-injected` | Injection marker comment |
| 8 | `<trellis-workflow>` | `<arbor-workflow>` | Breadcrumb tag |
| 9 | `trellis-<slug>` | `arbor-<slug>` | Skill names (`arbor-meta`, `arbor-spec-bootstrap`, ...) and hook ids |
| 10 | `trellis_config` | `arbor_config` | Python module `scripts/common/arbor_config.py` |
| 11 | `Trellis` / `TRELLIS` / `trellis` | `Arbor` / `ARBOR` / `arbor` | Case-sensitive, no word boundary (covers identifiers such as `getArborTemplatePath`, `find_arbor_root`) |

Tracked paths containing `trellis` were moved with `git mv` (deepest first),
e.g. `packages/cli/src/templates/trellis/` → `templates/arbor/`,
`bin/trellis.js` → `bin/arbor.js`, `.trellis/` → `.arbor/`.

## Removed before the rename

- `packages/core` (`@mindfoldhq/trellis-core`), `docs-site` and `marketplace`
  submodules.
- CLI commands `channel`, `mem`, `ablate`/`restore`, `upgrade`, `workflow`;
  remote spec-template registry (`giget`), release/publish scripts, migration
  manifests older than `0.1.0`.
- 21 main-agent platforms; only `claude-code` and `star` remain.
- Platform-native sub-agent definitions (`.claude/agents/*.md`,
  `.starFactory/agents/*.md`); replaced by dispatch to codeg assistants.

## What still says "Trellis"

- `LICENSE`, `COPYRIGHT`, `NOTICE`, the README provenance section and this file.
- Upstream history under `.arbor/tasks/` and `.arbor/workspace/` (content left
  as written; only paths were moved).

A regression test (`test/regression.test.ts`, "shipped templates carry no
upstream Trellis identifiers") fails if any file under
`packages/cli/src/templates/` reintroduces the upstream name.
