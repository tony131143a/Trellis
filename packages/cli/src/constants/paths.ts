/**
 * Path constants for Arbor workflow structure
 *
 * Change these values to rename directories across the entire project.
 * All paths should be relative to the project root.
 */

// Directory names (can be renamed)
export const DIR_NAMES = {
  /** Root workflow directory */
  WORKFLOW: ".arbor",
  /** Workspace directory (under .arbor/) - developer work areas */
  WORKSPACE: "workspace",
  /** Tasks directory (under .arbor/) - unified task storage */
  TASKS: "tasks",
  /** Spec/guidelines directory (under .arbor/) */
  SPEC: "spec",
  /** Scripts directory (under .arbor/) */
  SCRIPTS: "scripts",
} as const;

// File names
export const FILE_NAMES = {
  /** Root agent instructions file */
  AGENTS: "AGENTS.md",
  /** Claude Code root instructions file (managed block only) */
  CLAUDE: "CLAUDE.md",
} as const;

// Constructed paths (relative to project root)
export const PATHS = {
  /** .arbor/workspace/ */
  WORKSPACE: `${DIR_NAMES.WORKFLOW}/${DIR_NAMES.WORKSPACE}`,
  /** .arbor/tasks/ */
  TASKS: `${DIR_NAMES.WORKFLOW}/${DIR_NAMES.TASKS}`,
  /** .arbor/spec/ */
  SPEC: `${DIR_NAMES.WORKFLOW}/${DIR_NAMES.SPEC}`,
  /** .arbor/scripts/ */
  SCRIPTS: `${DIR_NAMES.WORKFLOW}/${DIR_NAMES.SCRIPTS}`,
} as const;
