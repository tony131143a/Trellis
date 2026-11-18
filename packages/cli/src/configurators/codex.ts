import {
  collectSkillTemplates,
  resolveBundledSkills,
  resolveSkills,
} from "./shared.js";

/** One file map drives init, update, ownership tracking, and uninstall. */
export function collectCodexTemplates(): Map<string, string> {
  return collectSkillTemplates(
    ".agents/skills",
    resolveSkills(),
    resolveBundledSkills(),
  );
}
