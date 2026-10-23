/**
 * StarFactory templates
 *
 * StarFactory is a Claude Code-compatible fork, but its **project-level**
 * config dir is `.starFactory/` (a live probe showed `.claude/` at project
 * level is ignored entirely, while `.starFactory/settings.json` hooks fire and
 * `.starFactory/{commands,skills}/` load).
 *
 * Directory structure:
 *   star/
 *   └── settings.json   # Hook configuration (SessionStart / UserPromptSubmit /
 *                       # PreToolUse Agent|Task)
 *
 * Default hooks come from shared-hooks/ (unified with other platforms); only
 * the settings.json wiring lives here.
 */

import { createTemplateReader, type HookTemplate } from "../template-utils.js";

const { getSettings } = createTemplateReader(import.meta.url);

/** `.starFactory/settings.json` — hook wiring for the shared hook scripts. */
export function getSettingsTemplate(): HookTemplate {
  return getSettings();
}
