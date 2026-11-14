import { AI_TOOLS } from "../types/ai-tools.js";
import {
  collectSkillTemplates,
  resolveBundledSkills,
  resolveSkills,
} from "./shared.js";

/** One file map drives init, update, ownership tracking, and uninstall. */
export function collectCodexTemplates(): Map<string, string> {
  const ctx = AI_TOOLS.codex.templateContext;
  return collectSkillTemplates(
    ".agents/skills",
    resolveSkills(ctx),
    resolveBundledSkills(ctx),
  );
}
