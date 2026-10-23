/**
 * Arbor workflow templates
 *
 * These are GENERIC templates for user projects.
 * Do NOT use Arbor project's own .arbor/ directory (which may be customized).
 *
 * Directory structure:
 *   arbor/
 *   ├── scripts/
 *   │   ├── __init__.py
 *   │   ├── common/           # Shared utilities (Python)
 *   │   └── *.py              # Main scripts (Python)
 *   ├── agents/                # Channel runtime agent definitions
 *   │   └── *.md               # Loaded by `arbor channel spawn --agent <name>`
 *   ├── scripts-shell-archive/ # Archived shell scripts (for reference)
 *   ├── workflow.md           # Workflow guide
 *   ├── config.yaml            # Arbor configuration
 *   ├── gitignore.txt         # .gitignore content
 *   └── gitattributes.txt     # project-root .gitattributes content
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function readTemplate(relativePath: string): string {
  return readFileSync(join(__dirname, relativePath), "utf-8");
}

// Python scripts - package init
export const scriptsInit = readTemplate("scripts/__init__.py");

// Python scripts - common
export const commonInit = readTemplate("scripts/common/__init__.py");
export const commonPaths = readTemplate("scripts/common/paths.py");
export const commonDeveloper = readTemplate("scripts/common/developer.py");
export const commonGitContext = readTemplate("scripts/common/git_context.py");
export const commonTaskQueue = readTemplate("scripts/common/task_queue.py");
export const commonTaskUtils = readTemplate("scripts/common/task_utils.py");
export const commonActiveTask = readTemplate("scripts/common/active_task.py");
export const commonConfig = readTemplate("scripts/common/config.py");
export const commonIo = readTemplate("scripts/common/io.py");
export const commonLog = readTemplate("scripts/common/log.py");
export const commonGit = readTemplate("scripts/common/git.py");
export const commonTypes = readTemplate("scripts/common/types.py");
export const commonTasks = readTemplate("scripts/common/tasks.py");
export const commonTaskContext = readTemplate("scripts/common/task_context.py");
export const commonTaskStore = readTemplate("scripts/common/task_store.py");
export const commonSessionContext = readTemplate(
  "scripts/common/session_context.py",
);
export const commonPackagesContext = readTemplate(
  "scripts/common/packages_context.py",
);
export const commonWorkflowPhase = readTemplate(
  "scripts/common/workflow_phase.py",
);
export const commonArborConfig = readTemplate(
  "scripts/common/arbor_config.py",
);
export const commonSafeCommit = readTemplate("scripts/common/safe_commit.py");
export const commonSpecMeta = readTemplate("scripts/common/spec_meta.py");
export const commonSpecLint = readTemplate("scripts/common/spec_lint.py");
export const commonSpecTrace = readTemplate("scripts/common/spec_trace.py");
export const commonDispatchContext = readTemplate(
  "scripts/common/dispatch_context.py",
);

// Python scripts - main
export const getDeveloperScript = readTemplate("scripts/get_developer.py");
export const initDeveloperScript = readTemplate("scripts/init_developer.py");
export const taskScript = readTemplate("scripts/task.py");
export const getContextScript = readTemplate("scripts/get_context.py");
export const addSessionScript = readTemplate("scripts/add_session.py");
export const specScript = readTemplate("scripts/spec.py");

// Configuration files
export const workflowMdTemplate = readTemplate("workflow.md");
export const configYamlTemplate = readTemplate("config.yaml");
export const gitignoreTemplate = readTemplate("gitignore.txt");
export const gitattributesTemplate = readTemplate("gitattributes.txt");

// Channel runtime agent definitions (loaded by
// `packages/cli/src/commands/channel/agent-loader.ts` from `.arbor/agents/`).
// These are platform-agnostic Arbor runtime files dispatched at `arbor init`
// and refreshed by `arbor update`.
export const implementAgentTemplate = readTemplate("agents/implement.md");
export const checkAgentTemplate = readTemplate("agents/check.md");
export const researchAgentTemplate = readTemplate("agents/research.md");

/**
 * Get all script templates as a map of relative path to content
 */
export function getAllScripts(): Map<string, string> {
  const scripts = new Map<string, string>();

  // Package init
  scripts.set("__init__.py", scriptsInit);

  // Common
  scripts.set("common/__init__.py", commonInit);
  scripts.set("common/paths.py", commonPaths);
  scripts.set("common/developer.py", commonDeveloper);
  scripts.set("common/git_context.py", commonGitContext);
  scripts.set("common/task_queue.py", commonTaskQueue);
  scripts.set("common/task_utils.py", commonTaskUtils);
  scripts.set("common/active_task.py", commonActiveTask);
  scripts.set("common/config.py", commonConfig);
  scripts.set("common/io.py", commonIo);
  scripts.set("common/log.py", commonLog);
  scripts.set("common/git.py", commonGit);
  scripts.set("common/types.py", commonTypes);
  scripts.set("common/tasks.py", commonTasks);
  scripts.set("common/task_context.py", commonTaskContext);
  scripts.set("common/task_store.py", commonTaskStore);
  scripts.set("common/session_context.py", commonSessionContext);
  scripts.set("common/packages_context.py", commonPackagesContext);
  scripts.set("common/workflow_phase.py", commonWorkflowPhase);
  scripts.set("common/arbor_config.py", commonArborConfig);
  scripts.set("common/safe_commit.py", commonSafeCommit);
  scripts.set("common/spec_meta.py", commonSpecMeta);
  scripts.set("common/spec_lint.py", commonSpecLint);
  scripts.set("common/spec_trace.py", commonSpecTrace);
  scripts.set("common/dispatch_context.py", commonDispatchContext);

  // Main
  scripts.set("get_developer.py", getDeveloperScript);
  scripts.set("init_developer.py", initDeveloperScript);
  scripts.set("task.py", taskScript);
  scripts.set("get_context.py", getContextScript);
  scripts.set("add_session.py", addSessionScript);
  scripts.set("spec.py", specScript);

  return scripts;
}

/**
 * Get all channel runtime agent definitions as a map of relative path
 * (under `.arbor/agents/`) to content.
 *
 * Consumed by `arbor init` (to dispatch on first install) and by
 * `arbor update` (to backfill missing files and surface conflicts on edited
 * ones via the standard hash machinery).
 */
export function getAllAgents(): Map<string, string> {
  const agents = new Map<string, string>();
  agents.set("implement.md", implementAgentTemplate);
  agents.set("check.md", checkAgentTemplate);
  agents.set("research.md", researchAgentTemplate);
  return agents;
}
