/**
 * Shared utilities for platform configurators.
 *
 * Extracted here to avoid circular dependencies (index.ts imports configurators,
 * configurators cannot import from index.ts).
 */

import type { TemplateContext } from "../types/ai-tools.js";

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

/**
 * Resolve platform-specific placeholders in template content.
 *
 * When called without a context, only resolves {{PYTHON_CMD}} (legacy behavior
 * for settings.json, hooks.json, etc.).
 *
 * When called with a TemplateContext, additionally resolves:
 * - {{CMD_REF:name}}         → platform-specific command reference
 * - {{EXECUTOR_AI}}          → AI executor description
 * - {{USER_ACTION_LABEL}}    → user action label
 * - {{CLI_FLAG}}             → platform cli flag (e.g. "claude", "codex")
 * - {{#FLAG}}...{{/FLAG}}    → conditional include (when FLAG is true)
 * - {{^FLAG}}...{{/FLAG}}    → negated conditional (when FLAG is false)
 *
 * Supported conditional flags: AGENT_CAPABLE, HAS_HOOKS
 */
// Pre-compiled regexes for placeholder resolution
const RE_PYTHON_CMD = /\{\{PYTHON_CMD\}\}/g;
const RE_CMD_REF = /\{\{CMD_REF:([\w][\w-]*)\}\}/g;
const RE_EXECUTOR_AI = /\{\{EXECUTOR_AI\}\}/g;
const RE_USER_ACTION_LABEL = /\{\{USER_ACTION_LABEL\}\}/g;
const RE_CLI_FLAG = /\{\{CLI_FLAG\}\}/g;
const RE_BLANK_LINES = /\n{3,}/g;

const CONDITIONAL_FLAGS = ["AGENT_CAPABLE", "HAS_HOOKS"] as const;
const CONDITIONAL_REGEXES = Object.fromEntries(
  CONDITIONAL_FLAGS.map((flag) => [
    flag,
    {
      pos: new RegExp(
        `\\{\\{#${flag}\\}\\}([\\s\\S]*?)\\{\\{/${flag}\\}\\}`,
        "g",
      ),
      neg: new RegExp(
        `\\{\\{\\^${flag}\\}\\}([\\s\\S]*?)\\{\\{/${flag}\\}\\}`,
        "g",
      ),
    },
  ]),
) as Record<(typeof CONDITIONAL_FLAGS)[number], { pos: RegExp; neg: RegExp }>;

export function resolvePlaceholders(
  content: string,
  context?: TemplateContext,
): string {
  let result = replacePythonCommandLiterals(
    content.replace(RE_PYTHON_CMD, getPythonCommandForPlatform()),
  );

  if (!context) return result;

  // Simple substitutions
  result = result.replace(
    RE_CMD_REF,
    (_match, name: string) => `${context.cmdRefPrefix}${name}`,
  );
  result = result.replace(RE_EXECUTOR_AI, context.executorAI);
  result = result.replace(RE_USER_ACTION_LABEL, context.userActionLabel);
  result = result.replace(RE_CLI_FLAG, context.cliFlag);

  // Conditional blocks
  const flagValues: Record<(typeof CONDITIONAL_FLAGS)[number], boolean> = {
    AGENT_CAPABLE: context.agentCapable,
    HAS_HOOKS: context.hasHooks,
  };

  for (const flag of CONDITIONAL_FLAGS) {
    const value = flagValues[flag];
    const { pos, neg } = CONDITIONAL_REGEXES[flag];
    // Reset lastIndex for global regexes reused across calls
    pos.lastIndex = 0;
    neg.lastIndex = 0;
    result = result.replace(pos, value ? "$1" : "");
    result = result.replace(neg, value ? "" : "$1");
  }

  // Clean up blank lines left by removed conditional blocks
  result = result.replace(RE_BLANK_LINES, "\n\n");

  return result;
}

// ---------------------------------------------------------------------------
// Template wrapping utilities
// ---------------------------------------------------------------------------

/** Skill description registry — maps template name to auto-trigger description. */
const SKILL_DESCRIPTIONS: Record<string, string> = {
  arbor:
    "Drive a task that is too large for one context or splits into parallel parts: freeze a contract with the user, split the work into nodes that Orca workers implement in their own worktrees, react to results, review, finish. Use for multi-file features, refactors and cross-repository work; not for a change you can make and verify yourself.",
  "update-spec":
    "Captures executable contracts and coding conventions into .arbor/spec/ documents. Use when learning something valuable from debugging, implementing, or discussion that should be preserved for future sessions.",
};

/**
 * Wrap resolved template content with YAML frontmatter for skill format.
 * Used by platforms that use SKILL.md (Codex, Kiro, Qoder, etc.).
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
 * Used by "both" platforms for the auto-triggered skills.
 */
export function resolveSkills(ctx: TemplateContext): ResolvedTemplate[] {
  return getSkillTemplates().map((tmpl) => ({
    name: `arbor-${tmpl.name}`,
    content: wrapWithSkillFrontmatter(
      `arbor-${tmpl.name}`,
      resolvePlaceholders(tmpl.content, ctx),
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
export function resolveBundledSkills(
  ctx: TemplateContext,
): ResolvedSkillFile[] {
  return getBundledSkillTemplates().flatMap((skill) =>
    skill.files.map((file) => ({
      relativePath: `${skill.name}/${file.relativePath}`,
      content: resolvePlaceholders(file.content, ctx),
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
