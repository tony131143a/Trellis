/**
 * StarFactory templates
 *
 * StarFactory is a Claude Code-compatible fork, but its **project-level**
 * config dir is `.starFactory/` (a live probe showed `.claude/` at project
 * level is ignored entirely, while `.starFactory/settings.json` hooks fire and
 * `.starFactory/{commands,skills,agents}/` load).
 *
 * Directory structure:
 *   star/
 *   ├── agents/         # Sub-agent definitions (Claude-compatible frontmatter)
 *   └── settings.json   # Hook configuration (SessionStart / UserPromptSubmit /
 *                       # PreToolUse Agent|Task)
 *
 * Default hooks come from shared-hooks/ (unified with other platforms); only
 * the settings.json wiring and the opt-in surface live here.
 */

import {
  createTemplateReader,
  type AgentTemplate,
  type HookTemplate,
} from "../template-utils.js";

const { listMdAgents, getSettings } = createTemplateReader(import.meta.url);

/** Trellis agent prompts (trellis-implement, trellis-check, trellis-research). */
export function getAllAgents(): AgentTemplate[] {
  return listMdAgents();
}

/** `.starFactory/settings.json` — hook wiring for the shared hook scripts. */
export function getSettingsTemplate(): HookTemplate {
  return getSettings();
}
