# Bundled Skills

Bundled skills are multi-file built-in skills shipped inside the Arbor CLI package. They are written automatically into each platform's skill root by `arbor init` and kept in sync by `arbor update`. They are part of Arbor itself, not third-party content.

A bundled skill is a directory under `packages/cli/src/templates/common/bundled-skills/<skill>/` that contains its own `SKILL.md` (with YAML frontmatter) plus optional `references/` files. The whole tree is copied as-is, so references stay lazy-loadable.

## Bundled Skills Today

| Skill | Purpose |
| --- | --- |
| `arbor-meta` | This skill: how the local Arbor architecture works and how to customize it. |
| `arbor-spec-bootstrap` | Single-agent workflow for creating or refreshing `.arbor/spec/` from the real codebase (optional GitNexus / ABCoder integration). |

## Where They Land

| Platform | Bundled skill root |
| --- | --- |
| Claude Code | `.claude/skills/<skill>/` |
| StarFactory | `.starFactory/skills/<skill>/` |

`resolveBundledSkills(ctx)` in `configurators/shared.ts` reads every directory returned by `getBundledSkillTemplates()` (`templates/common/index.ts`), resolves placeholders such as `python3`, and returns flat `{relativePath, content}` entries. Each platform collector (`configurators/claude.ts`, `configurators/star.ts`) folds them into its template map via `collectSkillTemplates`. `arbor init` writes that map; `arbor update` diffs it against `.arbor/.template-hashes.json`.

Other template sources in `templates/common/`: `skills/` (workflow skills), `commands/` (slash commands written to `commands/arbor/`).

## Local Overrides

There is no `.arbor/skills/` mechanism. Overrides are platform-rooted:

- Editing a file inside `.claude/skills/arbor-meta/` works until the next `arbor update`, which flags it as modified by the user and offers overwrite, keep, or `.new`.
- To override on both platforms, edit both `.claude/skills/<name>/` and `.starFactory/skills/<name>/`.
- To add behavior, create a skill under a different folder name (for example `.claude/skills/my-custom-meta/`); Arbor never touches it.
- To remove a bundled skill, delete its directory in each skill root; `arbor update` treats deletion as a user modification and does not re-create it unless forced.
- There is no flag to disable all bundled skills.

## Adding A New Bundled Skill (Arbor Source Contributors)

1. Create `templates/common/bundled-skills/<name>/SKILL.md` with `name:` and a single-line quoted `description:` that states user-intent triggers.
2. Put long content in `references/` and index it from `SKILL.md`.
3. Use placeholders where needed; they are resolved per platform.
4. No dispatch wiring is required: `listDirectories("bundled-skills")` discovers the directory.
5. Verify with a fresh temp project that `arbor init` writes `.claude/skills/<name>/SKILL.md` and `.starFactory/skills/<name>/SKILL.md`.

## Rules

- `templates/common/bundled-skills/` is the single source of truth for which bundled skills exist.
- Keep team-private rules out of bundled skills; use `.arbor/spec/` or a project-local skill.
- Do not couple a bundled skill to a CLI command without stating the dependency in its description and references.
