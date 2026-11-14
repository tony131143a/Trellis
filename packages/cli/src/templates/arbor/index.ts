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
export const commonConfig = readTemplate("scripts/common/config.py");
export const commonIo = readTemplate("scripts/common/io.py");
export const commonLog = readTemplate("scripts/common/log.py");
export const commonGit = readTemplate("scripts/common/git.py");
export const commonTypes = readTemplate("scripts/common/types.py");
export const commonArborConfig = readTemplate("scripts/common/arbor_config.py");
export const commonSafeCommit = readTemplate("scripts/common/safe_commit.py");
export const commonSpecMeta = readTemplate("scripts/common/spec_meta.py");
export const commonSpecLint = readTemplate("scripts/common/spec_lint.py");
export const commonSpecTrace = readTemplate("scripts/common/spec_trace.py");
export const commonContract = readTemplate("scripts/common/contract.py");
export const commonExecution = readTemplate("scripts/common/execution.py");
export const commonWorktree = readTemplate("scripts/common/worktree.py");
export const commonInvariants = readTemplate("scripts/common/invariants.py");
export const commonDriverInit = readTemplate(
  "scripts/common/driver/__init__.py",
);
export const commonDriverExecutor = readTemplate(
  "scripts/common/driver/executor.py",
);
export const commonDriverOrca = readTemplate("scripts/common/driver/orca.py");
export const commonDriverGate = readTemplate("scripts/common/driver/gate.py");
export const commonDriverLock = readTemplate("scripts/common/driver/lock.py");
export const commonDriverPlan = readTemplate("scripts/common/driver/plan.py");
export const commonDriverRepos = readTemplate("scripts/common/driver/repos.py");
export const commonDriverSync = readTemplate("scripts/common/driver/sync.py");
export const commonDriverFinish = readTemplate(
  "scripts/common/driver/finish.py",
);
export const commonDriverPrompt = readTemplate(
  "scripts/common/driver/prompt.py",
);

// Python scripts - main
export const getDeveloperScript = readTemplate("scripts/get_developer.py");
export const initDeveloperScript = readTemplate("scripts/init_developer.py");
export const addSessionScript = readTemplate("scripts/add_session.py");
export const specScript = readTemplate("scripts/spec.py");
export const arborScript = readTemplate("scripts/arbor.py");

// Configuration files
export const configYamlTemplate = readTemplate("config.yaml");
export const gitignoreTemplate = readTemplate("gitignore.txt");
export const gitattributesTemplate = readTemplate("gitattributes.txt");

/**
 * Get all script templates as a map of relative path to content
 */
export function getAllScripts(): Map<string, string> {
  return new Map<string, string>([
    ["__init__.py", scriptsInit],
    ["common/__init__.py", commonInit],
    ["common/paths.py", commonPaths],
    ["common/developer.py", commonDeveloper],
    ["common/config.py", commonConfig],
    ["common/io.py", commonIo],
    ["common/log.py", commonLog],
    ["common/git.py", commonGit],
    ["common/types.py", commonTypes],
    ["common/arbor_config.py", commonArborConfig],
    ["common/safe_commit.py", commonSafeCommit],
    ["common/spec_meta.py", commonSpecMeta],
    ["common/spec_lint.py", commonSpecLint],
    ["common/spec_trace.py", commonSpecTrace],
    ["common/contract.py", commonContract],
    ["common/execution.py", commonExecution],
    ["common/worktree.py", commonWorktree],
    ["common/invariants.py", commonInvariants],
    ["common/driver/__init__.py", commonDriverInit],
    ["common/driver/executor.py", commonDriverExecutor],
    ["common/driver/orca.py", commonDriverOrca],
    ["common/driver/gate.py", commonDriverGate],
    ["common/driver/lock.py", commonDriverLock],
    ["common/driver/plan.py", commonDriverPlan],
    ["common/driver/repos.py", commonDriverRepos],
    ["common/driver/sync.py", commonDriverSync],
    ["common/driver/finish.py", commonDriverFinish],
    ["common/driver/prompt.py", commonDriverPrompt],
    ["get_developer.py", getDeveloperScript],
    ["init_developer.py", initDeveloperScript],
    ["add_session.py", addSessionScript],
    ["spec.py", specScript],
    ["arbor.py", arborScript],
  ]);
}
