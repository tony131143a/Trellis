/**
 * AI Tool Types and Registry
 *
 * Defines supported AI coding tools and which command templates they can use.
 */

/**
 * Supported AI coding tools
 */
export type AITool = "claude-code" | "star";

/**
 * Template directory categories
 */
export type TemplateDir = "common" | "claude" | "star";

/**
 * CLI flag names for platform selection (e.g., --claude, --star)
 * Must match keys in InitOptions (src/commands/init.ts)
 */
export type CliFlag = "claude" | "star";

/**
 * Template context for placeholder resolution.
 * Controls how common templates are rendered per platform.
 */
export interface TemplateContext {
  /** Prefix for cross-referencing other commands/skills */
  cmdRefPrefix:
    | "/trellis:"
    | "/trellis-"
    | "$"
    | "/"
    | "/skill trellis-"
    | "/skill:trellis-"
    | "trellis-";
  /** Description of AI executor actions shown in role tables */
  executorAI:
    | "Bash scripts or Task calls"
    | "Bash scripts or tool calls"
    | "Bash scripts or Agent calls"
    | "Bash scripts or file reads";
  /** Label for user-invocable actions */
  userActionLabel:
    | "Slash commands"
    | "Skills"
    | "Workflows"
    | "Prompts"
    | "Commands";
  /** Platform supports spawning sub-agents with isolated context */
  agentCapable: boolean;
  /** Platform has hook system (SessionStart, PreToolUse) */
  hasHooks: boolean;
  /**
   * CLI flag value for this platform (e.g. "claude", "star").
   * Substituted into template commands via {{CLI_FLAG}} so rendered skill /
   * command files can pass `--platform <flag>` to scripts that need to know
   * the invoking platform, removing the need to re-detect at runtime.
   * Duplicates the top-level `AIToolConfig.cliFlag` for convenience — the
   * invariant is maintained in `AI_TOOLS` config blocks.
   */
  cliFlag: CliFlag;
}

/**
 * Configuration for an AI tool
 */
export interface AIToolConfig {
  /** Display name of the tool */
  name: string;
  /** Command template directory names to include */
  templateDirs: TemplateDir[];
  /** Config directory name in the project root (e.g., ".claude") */
  configDir: string;
  /**
   * Whether the platform supports the shared `.agents/skills/` layer
   * (agentskills.io open standard). When true, `.agents/skills` is added
   * to the platform's managed paths automatically.
   */
  supportsAgentSkills?: boolean;
  /** Additional managed paths beyond configDir */
  extraManagedPaths?: string[];
  /** CLI flag name for --flag options (e.g., "claude" for --claude) */
  cliFlag: CliFlag;
  /** Whether this tool is checked by default in interactive init prompt */
  defaultChecked: boolean;
  /** Whether this tool uses Python hooks (affects Windows encoding detection) */
  hasPythonHooks: boolean;
  /** Template context for placeholder resolution in common templates */
  templateContext: TemplateContext;
}

/**
 * Registry of all supported AI tools and their configurations.
 * This is the single source of truth for platform data.
 *
 * When adding a new platform, add an entry here and create:
 * 1. src/configurators/{platform}.ts — configure function
 * 2. src/templates/{platform}/ — template files
 * 3. Register in src/configurators/index.ts — PLATFORM_FUNCTIONS
 * 4. Add CLI flag in src/cli/index.ts
 * 5. Add to InitOptions in src/commands/init.ts
 */
export const AI_TOOLS: Record<AITool, AIToolConfig> = {
  "claude-code": {
    name: "Claude Code",
    templateDirs: ["common", "claude"],
    configDir: ".claude",
    cliFlag: "claude",
    defaultChecked: true,
    hasPythonHooks: true,
    templateContext: {
      cmdRefPrefix: "/trellis:",
      executorAI: "Bash scripts or Task calls",
      userActionLabel: "Slash commands",
      agentCapable: true,
      hasHooks: true,
      cliFlag: "claude",
    },
  },
  /**
   * StarFactory CLI — class-1 platform, verified against star 1.0.49.
   *
   * StarFactory is a Claude Code-compatible fork: its hook payloads carry
   * Claude's `session_id` / `transcript_path` / `hook_event_name` fields, its
   * settings keys match, and it consumes `.claude-plugin` marketplaces. The
   * user-level config dir is `~/.starFactory/` (mounted via
   * `CLAUDE_CONFIG_DIR`), but the **project-level** dir is `.starFactory/`:
   * a live probe showed `.starFactory/settings.json` SessionStart hooks fire
   * and `.starFactory/{commands,skills}/` load, while the same files
   * under `.claude/` are ignored entirely.
   *
   * - Skills: `.starFactory/skills/<name>/SKILL.md` (invocable as slash commands)
   * - Commands: `.starFactory/commands/trellis/*.md` -> `/trellis:<name>`
   * - Hooks: `.starFactory/hooks/` + `.starFactory/settings.json`
   *   (SessionStart / UserPromptSubmit / PreToolUse all verified to fire)
   *
   * supportsAgentSkills is false: a probe confirmed StarFactory does NOT read
   * the shared `.agents/skills/` root ("Unknown skill").
   */
  star: {
    name: "StarFactory",
    templateDirs: ["common", "star"],
    configDir: ".starFactory",
    cliFlag: "star",
    defaultChecked: false,
    hasPythonHooks: true,
    templateContext: {
      cmdRefPrefix: "/trellis:",
      executorAI: "Bash scripts or Task calls",
      userActionLabel: "Slash commands",
      agentCapable: true,
      hasHooks: true,
      cliFlag: "star",
    },
  },
};

/**
 * Get the configuration for a specific AI tool
 */
export function getToolConfig(tool: AITool): AIToolConfig {
  return AI_TOOLS[tool];
}

/**
 * Get all managed paths for a specific tool.
 */
export function getManagedPaths(tool: AITool): string[] {
  const config = AI_TOOLS[tool];
  const paths = [config.configDir];
  if (config.supportsAgentSkills) {
    paths.push(".agents/skills");
  }
  if (config.extraManagedPaths) {
    paths.push(...config.extraManagedPaths);
  }
  return paths;
}

/**
 * Get template directories for a specific tool
 */
export function getTemplateDirs(tool: AITool): TemplateDir[] {
  return AI_TOOLS[tool].templateDirs;
}
