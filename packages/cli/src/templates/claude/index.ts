/**
 * Claude Code templates
 *
 * Directory structure:
 *   claude/
 *   ├── hooks/          # Claude-only opt-in hooks (statusline.py)
 *   ├── skills/arbor.md # Body of the main-agent skill `arbor` (Claude only)
 *   └── settings.json   # Settings configuration
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function readTemplate(relativePath: string): string {
  return readFileSync(join(__dirname, relativePath), "utf-8");
}

export const settingsTemplate = readTemplate("settings.json");

/** Body of the skill `arbor`; the frontmatter comes from SKILL_DESCRIPTIONS. */
export const arborSkillTemplate = readTemplate("skills/arbor.md");

export interface SettingsTemplate {
  targetPath: string;
  content: string;
}

export function getSettingsTemplate(): SettingsTemplate {
  return {
    targetPath: "settings.json",
    content: settingsTemplate,
  };
}

/**
 * Opt-in statusLine hook, installed only via `arbor init --with-statusline`.
 *
 * Lives under claude/hooks/ (not shared-hooks/) because `statusLine` is a
 * Claude-only event, and is intentionally NOT part of `collectTemplates` —
 * `arbor update` must never force-install it on opted-out projects.
 */
export function getStatuslineHook(): string {
  return readTemplate("hooks/statusline.py");
}
