/**
 * StarFactory configurator.
 *
 * StarFactory is a Claude Code-compatible fork whose **project-level** config
 * dir is `.starFactory/` (verified with star 1.0.49: `.claude/` at project
 * level is ignored, while `.starFactory/settings.json` SessionStart hooks fire
 * and `.starFactory/{commands,skills,agents}/` load).
 *
 * The file set mirrors Claude Code's, rooted at `.starFactory/`:
 * - `agents/*.md` + `settings.json` from the platform template directory
 * - `hooks/` from shared-hooks/ (unified with other platforms)
 * - `commands/trellis/` — start + finish-work as slash commands
 * - `skills/trellis-{name}/SKILL.md` — auto-triggered skills from `common/skills/`
 *
 * Unlike Claude Code there is no residual behavior (no `--with-statusline`),
 * so this is a plain `fromTemplates` platform — `configure` is derived from
 * `collectStarTemplates`.
 */

import { AI_TOOLS } from "../types/ai-tools.js";
import { getAllAgents, getSettingsTemplate } from "../templates/star/index.js";
import {
  resolvePlaceholders,
  resolveCommands,
  resolveSkills,
  resolveBundledSkills,
  collectSkillTemplates,
  collectSharedHooks,
} from "./shared.js";

/**
 * The StarFactory file set — written at init and diffed by `trellis update`.
 */
export function collectStarTemplates(): Map<string, string> {
  const ctx = AI_TOOLS.star.templateContext;
  const files = new Map<string, string>();

  for (const agent of getAllAgents()) {
    files.set(`.starFactory/agents/${agent.name}.md`, agent.content);
  }

  const settings = getSettingsTemplate();
  files.set(
    `.starFactory/${settings.targetPath}`,
    resolvePlaceholders(settings.content),
  );

  for (const cmd of resolveCommands(ctx)) {
    files.set(`.starFactory/commands/trellis/${cmd.name}.md`, cmd.content);
  }
  for (const [filePath, content] of collectSkillTemplates(
    ".starFactory/skills",
    resolveSkills(ctx),
    resolveBundledSkills(ctx),
  )) {
    files.set(filePath, content);
  }
  for (const [k, v] of collectSharedHooks(".starFactory/hooks", "star")) {
    files.set(k, v);
  }

  return files;
}
