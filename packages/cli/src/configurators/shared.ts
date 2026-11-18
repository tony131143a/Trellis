/**
 * Shared utilities for platform configurators.
 *
 * Extracted here to avoid circular dependencies (index.ts imports configurators,
 * configurators cannot import from index.ts).
 */

/**
 * Per-platform configure options threaded from `arbor init` flags.
 * Defined here (not in index.ts) so configurators can reference it without
 * a circular import.
 */
export interface PlatformConfigureOptions {
  /**
   * Claude Code only: install the opt-in Arbor statusLine
   * (`arbor init --with-statusline`). Off by default — see
   * `configureClaude` in `claude.ts`.
   */
  withStatusline?: boolean;
}

/**
 * Module-level resolved Python command, set by the init flow after probing.
 *
 * Windows commonly has Python under one of: `python`, `python3`, `py -3` —
 * which one works varies by installer (python.org / Microsoft Store / py
 * launcher). `init.ts` detects which is available, then calls
 * `setResolvedPythonCommand` so all subsequent template / configurator writes
 * use the resolved value instead of the platform default.
 *
 * If unset (e.g. unit tests bypass init), `getPythonCommandForPlatform` falls
 * back to the static platform default (`python` on Windows, `python3`
 * elsewhere) — preserving legacy behavior.
 */
let resolvedPythonCommand: string | null = null;

export function setResolvedPythonCommand(cmd: string): void {
  const trimmed = cmd.trim();
  resolvedPythonCommand = trimmed || null;
}

/** Test helper — clear the resolved cache between unit tests. */
export function resetResolvedPythonCommand(): void {
  resolvedPythonCommand = null;
}

/**
 * Get the Python command for the host platform.
 *
 * Returns the resolved command if `setResolvedPythonCommand` has been called;
 * otherwise the static platform default — Windows: `python`, others:
 * `python3`. Pass an explicit `platform` arg only for unit tests (it bypasses
 * the resolved cache).
 */
export function getPythonCommandForPlatform(
  platform?: NodeJS.Platform,
): string {
  if (platform === undefined && resolvedPythonCommand) {
    return resolvedPythonCommand;
  }
  const target = platform ?? process.platform;
  return target === "win32" ? "python" : "python3";
}

/**
 * Replace literal `python3` with the resolved Python command, excluding
 * shebang lines.
 *
 * Applied at init/update write time so that all file types (including .py,
 * .md, .toml, .json) get the correct command for the host platform without
 * template-level changes.
 *
 * No-op when the resolved command is `python3` (the template default).
 * Idempotent: running it twice produces the same result.
 */
export function replacePythonCommandLiterals(content: string): string {
  const target = getPythonCommandForPlatform();
  if (target === "python3") return content;
  return content
    .split("\n")
    .map((line) =>
      line.startsWith("#!") ? line : line.replaceAll("python3", target),
    )
    .join("\n");
}

const RE_PYTHON_CMD = /\{\{PYTHON_CMD\}\}/g;

/**
 * Resolve the `{{PYTHON_CMD}}` placeholder in template content, then apply
 * {@link replacePythonCommandLiterals}.
 */
export function resolvePlaceholders(content: string): string {
  return replacePythonCommandLiterals(
    content.replace(RE_PYTHON_CMD, getPythonCommandForPlatform()),
  );
}

// ---------------------------------------------------------------------------
// Template wrapping utilities
// ---------------------------------------------------------------------------

/** Skill description registry — maps template name to auto-trigger description. */
const SKILL_DESCRIPTIONS: Record<string, string> = {
  arbor:
    "Drive a task that is too large for one context or splits into parallel parts: freeze a contract with the user, split the work into nodes that Orca workers implement in their own worktrees, react to results, review, finish. Use for multi-file features, refactors and cross-repository work; not for a change you can make and verify yourself.",
  "update-spec":
    "Decides whether something learned belongs in .arbor/spec/ and, when it does, records it as a short rule that holds across features. Use after a task, bug fix or review surfaced a convention, a module boundary or a recurring mistake, when a spec doc disagrees with the code, or when asked to update, trim or re-verify spec docs. Not for documenting how a single feature works.",
};

/**
 * Wrap resolved template content with YAML frontmatter for skill format.
 * Claude Code and Codex both install skills as SKILL.md.
 */
export function wrapWithSkillFrontmatter(
  name: string,
  content: string,
): string {
  // Look up description by base name (without arbor- prefix)
  const baseName = name.replace(/^arbor-/, "");
  const description = SKILL_DESCRIPTIONS[baseName];
  if (!description) {
    throw new Error(
      `Missing skill description for "${baseName}". Add it to SKILL_DESCRIPTIONS in shared.ts.`,
    );
  }
  return `---\nname: ${name}\ndescription: "${description}"\n---\n\n${content}`;
}

// ---------------------------------------------------------------------------
// Shared configurator helpers
// ---------------------------------------------------------------------------

import path from "node:path";
import { ensureDir, writeFile } from "../utils/file-writer.js";
import {
  getBundledSkillTemplates,
  getSkillTemplates,
} from "../templates/common/index.js";

/** A resolved template ready to be written to disk. */
export interface ResolvedTemplate {
  name: string;
  content: string;
}

/** A resolved file inside a multi-file skill directory. */
export interface ResolvedSkillFile {
  /** POSIX path relative to the skills root, e.g. "arbor-meta/SKILL.md" */
  relativePath: string;
  content: string;
}

/**
 * Resolve the auto-triggered skill templates from `common/skills/` with arbor- prefix + SKILL.md frontmatter.
 */
export function resolveSkills(): ResolvedTemplate[] {
  return getSkillTemplates().map((tmpl) => ({
    name: `arbor-${tmpl.name}`,
    content: wrapWithSkillFrontmatter(
      `arbor-${tmpl.name}`,
      resolvePlaceholders(tmpl.content),
    ),
  }));
}

/**
 * Resolve multi-file built-in skills.
 *
 * Unlike workflow skills, bundled skills already contain their own SKILL.md
 * frontmatter and may include references/assets. They are still rendered
 * through placeholder resolution so init and update get byte-identical output.
 */
export function resolveBundledSkills(): ResolvedSkillFile[] {
  return getBundledSkillTemplates().flatMap((skill) =>
    skill.files.map((file) => ({
      relativePath: `${skill.name}/${file.relativePath}`,
      content: resolvePlaceholders(file.content),
    })),
  );
}

// ---------------------------------------------------------------------------
// Shared collectors
// ---------------------------------------------------------------------------

/** Collect skill files under a target root for update hash tracking. */
export function collectSkillTemplates(
  skillsRoot: string,
  skills: readonly { name: string; content: string }[],
  bundledSkills: readonly ResolvedSkillFile[] = [],
): Map<string, string> {
  const files = new Map<string, string>();
  for (const skill of skills) {
    files.set(`${skillsRoot}/${skill.name}/SKILL.md`, skill.content);
  }
  for (const skillFile of bundledSkills) {
    files.set(`${skillsRoot}/${skillFile.relativePath}`, skillFile.content);
  }
  return files;
}

// ---------------------------------------------------------------------------
// Template maps — a platform's file set, described once
//
// `collect<Platform>Templates()` returns `Map<relPath, content>`: the single
// description of what a platform installs. `arbor update` diffs that map and
// `configure` writes it through `writeTemplateMap`. Nothing else enumerates a
// platform's files — two descriptions that disagree is how `arbor update`
// silently stops managing a file (manifests/0.5.7.json).
// ---------------------------------------------------------------------------

/** Apply the python3 → python rewrite to every entry of a template map. */
export function renderTemplateMap(
  files: Map<string, string>,
): Map<string, string> {
  const rendered = new Map<string, string>();
  for (const [relPath, content] of files) {
    rendered.set(relPath, replacePythonCommandLiterals(content));
  }
  return rendered;
}

/**
 * Write a collected template map into `cwd`.
 *
 * Renders through {@link renderTemplateMap} first — the same rewrite
 * `collectPlatformTemplates` applies on the update path — so a file's
 * init-time bytes and its update-time expected bytes cannot drift.
 */
export async function writeTemplateMap(
  cwd: string,
  files: Map<string, string>,
): Promise<void> {
  for (const [relPath, content] of renderTemplateMap(files)) {
    const absPath = path.join(cwd, ...relPath.split("/"));
    ensureDir(path.dirname(absPath));
    await writeFile(absPath, content);
  }
}
