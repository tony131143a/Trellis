import { AI_TOOLS } from "../types/ai-tools.js";
import { getHooksConfig } from "../templates/codex/index.js";
import {
  collectSharedHooks,
  collectSkillTemplates,
  resolveBundledSkills,
  resolveCommands,
  resolvePlaceholders,
  resolveSkills,
  wrapWithSkillFrontmatter,
} from "./shared.js";

/** One file map drives init, update, ownership tracking, and uninstall. */
export function collectCodexTemplates(): Map<string, string> {
  const ctx = AI_TOOLS.codex.templateContext;
  const commands = resolveCommands(ctx).map((command) => ({
    name: `arbor-${command.name}`,
    content: wrapWithSkillFrontmatter(`arbor-${command.name}`, command.content),
  }));
  const files = collectSkillTemplates(
    ".agents/skills",
    [...commands, ...resolveSkills(ctx)],
    resolveBundledSkills(ctx),
  );
  files.set(".codex/hooks.json", resolvePlaceholders(getHooksConfig()));
  for (const [name, content] of collectSharedHooks(".codex/hooks", "codex")) {
    files.set(name, content);
  }
  return files;
}
