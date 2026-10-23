import { AI_TOOLS } from "../types/ai-tools.js";
import {
  getSettingsTemplate,
  getStatuslineHook,
} from "../templates/claude/index.js";
import {
  resolvePlaceholders,
  resolveCommands,
  resolveSkills,
  resolveBundledSkills,
  collectSkillTemplates,
  collectSharedHooks,
  writeTemplateMap,
  type PlatformConfigureOptions,
} from "./shared.js";

/**
 * Inject the opt-in `statusLine` block into the settings.json template.
 * Runs BEFORE resolvePlaceholders so `{{PYTHON_CMD}}` resolves through the
 * normal path. The flag-off path never calls this — default output stays
 * byte-identical.
 *
 * Mirrors `preserveExistingClaudeStatusLine` (update.ts) exactly: parse →
 * assign (key lands at the END of the object) → stringify(null, 2) + "\n".
 * Byte-parity matters: `arbor update` re-derives the expected settings.json
 * via that preserve step, so any divergence (e.g. a different key position)
 * makes update flag a phantom settings.json change on every fresh opted-in
 * project.
 */
function injectStatusLine(content: string): string {
  const settings = JSON.parse(content) as Record<string, unknown>;
  settings.statusLine = {
    type: "command",
    command: "{{PYTHON_CMD}} .claude/hooks/statusline.py",
  };
  return `${JSON.stringify(settings, null, 2)}\n`;
}

/**
 * The Claude Code file set — written at init and diffed by `arbor update`.
 * - settings.json from the platform template directory
 * - hooks/ from shared-hooks/ (unified with other platforms)
 * - commands/arbor/ — continue + finish-work as slash commands
 * - skills/arbor-{name}/SKILL.md — auto-triggered skills from `common/skills/`
 *
 * The opt-in statusline is deliberately absent — see `configureClaude`.
 */
export function collectClaudeTemplates(): Map<string, string> {
  const ctx = AI_TOOLS["claude-code"].templateContext;
  const files = new Map<string, string>();

  // Map keys are logical paths used as cross-platform hash keys downstream.
  // Always POSIX, regardless of host OS.
  const settings = getSettingsTemplate();
  files.set(
    `.claude/${settings.targetPath}`,
    resolvePlaceholders(settings.content),
  );

  for (const cmd of resolveCommands(ctx)) {
    files.set(`.claude/commands/arbor/${cmd.name}.md`, cmd.content);
  }
  for (const [filePath, content] of collectSkillTemplates(
    ".claude/skills",
    resolveSkills(ctx),
    resolveBundledSkills(ctx),
  )) {
    files.set(filePath, content);
  }
  for (const [k, v] of collectSharedHooks(".claude/hooks", "claude")) {
    files.set(k, v);
  }

  return files;
}

/**
 * Configure Claude Code by writing `collectClaudeTemplates`, plus the opt-in
 * statusline (`arbor init --with-statusline`) when requested.
 *
 * The statusline is a post-processor over the map rather than part of it:
 * `collectTemplates` has no parameter for a per-init flag, and a statusline
 * entry there would make `arbor update` force-install the hook on every
 * project that opted out (locked by regression.test.ts). It adds one file and
 * replaces one entry; it does not restate the file set.
 */
export async function configureClaude(
  cwd: string,
  options?: PlatformConfigureOptions,
): Promise<void> {
  const files = collectClaudeTemplates();

  if (options?.withStatusline === true) {
    const settings = getSettingsTemplate();
    files.set(
      `.claude/${settings.targetPath}`,
      resolvePlaceholders(injectStatusLine(settings.content)),
    );
    files.set(".claude/hooks/statusline.py", getStatuslineHook());
  }

  await writeTemplateMap(cwd, files);
}
