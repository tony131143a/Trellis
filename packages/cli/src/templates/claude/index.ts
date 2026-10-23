/**
 * Claude Code templates
 *
 * Directory structure:
 *   claude/
 *   ├── hooks/          # Claude-only opt-in hooks (statusline.py)
 *   └── settings.json   # Settings configuration
 *
 * Default hooks come from shared-hooks/ (unified with other platforms).
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
 * Opt-in statusLine hook, installed only via `trellis init --with-statusline`.
 *
 * Lives under claude/hooks/ (not shared-hooks/) because `statusLine` is a
 * Claude-only event, and is intentionally NOT part of `collectTemplates` —
 * `trellis update` must never force-install it on opted-out projects.
 */
export function getStatuslineHook(): string {
  return readTemplate("hooks/statusline.py");
}
