import { describe, expect, it } from "vitest";
import {
  scriptsInit,
  commonInit,
  commonPaths,
  commonDeveloper,
  commonGitContext,
  commonTaskQueue,
  commonTaskUtils,
  commonActiveTask,
  getDeveloperScript,
  initDeveloperScript,
  taskScript,
  getContextScript,
  addSessionScript,
  workflowMdTemplate,
  gitignoreTemplate,
  getAllScripts,
  getAllAgents,
  implementAgentTemplate,
  AGENT_ROLES,
  configYamlTemplate,
} from "../../src/templates/arbor/index.js";

// =============================================================================
// Template Constants — module-level string exports
// =============================================================================

describe("arbor template constants", () => {
  const allTemplates = {
    scriptsInit,
    commonInit,
    commonPaths,
    commonDeveloper,
    commonGitContext,
    commonTaskQueue,
    commonTaskUtils,
    commonActiveTask,
      getDeveloperScript,
    initDeveloperScript,
    taskScript,
    getContextScript,
    addSessionScript,
    workflowMdTemplate,
    gitignoreTemplate,
  };

  function inProgressBreadcrumb(): string {
    const inProgressMatch = /\[workflow-state:in_progress\]([\s\S]*?)\[\/workflow-state:in_progress\]/.exec(
      workflowMdTemplate,
    );
    if (!inProgressMatch) {
      throw new Error("in_progress breadcrumb block must exist in workflow.md");
    }
    return inProgressMatch[1];
  }

  function workflowStateBreadcrumb(status: string): string {
    const match = new RegExp(
      `\\[workflow-state:${status}\\]([\\s\\S]*?)\\[/workflow-state:${status}\\]`,
    ).exec(workflowMdTemplate);
    if (!match) {
      throw new Error(`${status} breadcrumb block must exist in workflow.md`);
    }
    return match[1];
  }

  function stepSection(step: string): string {
    const pattern = new RegExp(
      `#### ${step.replace(".", "\\.")}[^\\n]*\\n([\\s\\S]*?)(?=\\n#### |\\n### |$)`,
    );
    const match = pattern.exec(workflowMdTemplate);
    if (!match) {
      throw new Error(`workflow.md step ${step} must exist`);
    }
    return match[1];
  }

  it("all templates are non-empty strings", () => {
    for (const [name, content] of Object.entries(allTemplates)) {
      expect(content.length, `${name} should be non-empty`).toBeGreaterThan(0);
    }
  });

  it("Python scripts contain valid Python syntax indicators", () => {
    // scriptsInit (__init__.py) only has docstrings, so use scripts with actual code
    const pyScripts = [
      commonInit,
      commonPaths,
      commonActiveTask,
      getDeveloperScript,
      taskScript,
    ];
    for (const script of pyScripts) {
      expect(
        script.includes("import") ||
        script.includes("def ") ||
        script.includes("class ") ||
        script.includes("#"),
      ).toBe(true);
    }
  });

  it("scriptsInit is a Python docstring module", () => {
    expect(scriptsInit).toContain('"""');
  });

  it("workflowMdTemplate is markdown", () => {
    expect(workflowMdTemplate).toContain("#");
  });

  it("[workflow-create-description] every task.py create template passes --description", () => {
    // task.py create exits 1 without a non-empty --description; an agent
    // copying a [required] step template verbatim must not hit that.
    const templates = workflowMdTemplate.match(/task\.py create "[^\n`]*/g) ?? [];
    expect(templates.length).toBeGreaterThanOrEqual(4);
    for (const line of templates) {
      expect(line).toContain("--description");
    }
  });

  it("workflow.md in_progress breadcrumbs self-exempt dispatched sub-agents", () => {
    for (const key of ["in_progress", "in_progress-parallel"]) {
      const block = workflowStateBreadcrumb(key);
      expect(block).toContain("Sub-agent self-exemption");
      expect(block).toContain("Active task:");
      expect(block).toContain("dispatched sub-agent");
      expect(block).not.toMatch(/Task\/Agent tool, NOT Skill/);
    }
    expect(inProgressBreadcrumb()).toContain("main session only");
  });

  it("workflow.md has no platform branch blocks or inline breadcrumbs", () => {
    expect(workflowMdTemplate).not.toMatch(/^\[\/?[A-Za-z][^\]\n]*,[^\]\n]*\]\s*$/m);
    expect(workflowMdTemplate).not.toContain("workflow-state:planning-inline");
    expect(workflowMdTemplate).not.toContain("workflow-state:in_progress-inline");
  });

  it("workflow.md documents Dispatch and the parallel variant", () => {
    expect(workflowMdTemplate).toContain("### Dispatch");
    expect(workflowMdTemplate).toContain("delegate_to_agent");
    expect(workflowMdTemplate).toContain("dispatch.py run --role");
    for (const n of [0, 1, 2, 3, 4, 5]) {
      expect(workflowMdTemplate).toContain(`#### 2P.${n} `);
    }
    for (const n of [1, 2, 3, 4, 5]) {
      expect(workflowMdTemplate).toContain(`#### 2F.${n} `);
    }
    expect(workflowMdTemplate).toContain("execution parallel");
    expect(workflowMdTemplate).toContain("dispatch.py snapshot");
    expect(workflowMdTemplate).not.toContain("check [finish]");
  });

  it("[required · once] steps appear in their phase breadcrumbs", () => {
    const planning = workflowStateBreadcrumb("planning");
    expect(planning).toContain("1.3");
    expect(planning).toContain("task.py start");
    for (const key of ["in_progress", "in_progress-parallel"]) {
      const block = workflowStateBreadcrumb(key);
      expect(block).toContain("3.3");
      expect(block).toContain("3.4");
      expect(block).toContain("2F");
    }
    const serial = workflowStateBreadcrumb("in_progress");
    for (const step of ["2F.1", "2F.2", "2F.5"]) {
      expect(serial).toContain(step);
    }
  });

  it("workflow.md documents parent child task tree responsibilities", () => {
    expect(workflowMdTemplate).toContain("### Parent / Child Task Trees");
    expect(workflowMdTemplate).toContain(
      "several independently verifiable deliverables",
    );
    expect(workflowMdTemplate).toContain(
      "Parent/child structure is not a dependency system",
    );
    expect(workflowMdTemplate).toContain("--parent <parent-dir>");
    expect(workflowMdTemplate).toContain("task.py add-subtask <parent> <child>");
    expect(workflowMdTemplate).toContain(
      "start the child that owns the next independently verifiable deliverable",
    );
  });

  it("workflow.md step 1.1 includes parent child split guidance", () => {
    const step = stepSection("1.1");
    expect(step).toContain("When considering a parent/child split");
    expect(step).toContain("Parent tasks own source requirements");
    expect(step).toContain("Child tasks own actual deliverables");
    expect(step).toContain(
      "Parent/child structure is not a dependency system",
    );
    expect(step).toContain("Do not start the parent unless");
  });

  it("workflow.md planning breadcrumbs mention parent child split guidance", () => {
    const planning = workflowStateBreadcrumb("planning");
    for (const block of [planning]) {
      expect(block).toContain("Multi-deliverable scope");
      expect(block).toContain("parent task plus independently verifiable child tasks");
      expect(block).toContain("not implied by tree position");
    }
  });

  it("workflow.md ships a task_error breadcrumb that repairs the existing task", () => {
    const taskError = workflowStateBreadcrumb("task_error");
    expect(taskError).toContain("Do not create or activate another task");
    expect(taskError).toContain("repair its task.json");
    expect(taskError).toContain("valid JSON object with a non-empty status");
  });

  it("gitignoreTemplate contains ignore patterns", () => {
    expect(gitignoreTemplate).toContain(".developer");
    expect(gitignoreTemplate).toContain("__pycache__");
  });
});

// =============================================================================
// getAllScripts — pure function assembling pre-loaded strings
// =============================================================================

describe("getAllScripts", () => {
  it("returns a Map", () => {
    const scripts = getAllScripts();
    expect(scripts).toBeInstanceOf(Map);
  });

  it("contains expected script entries", () => {
    const scripts = getAllScripts();
    expect(scripts.has("__init__.py")).toBe(true);
    expect(scripts.has("common/__init__.py")).toBe(true);
    expect(scripts.has("common/paths.py")).toBe(true);
    expect(scripts.has("common/active_task.py")).toBe(true);
    expect(scripts.has("task.py")).toBe(true);
    expect(scripts.has("get_developer.py")).toBe(true);
  });

  it("has at least one entry", () => {
    const scripts = getAllScripts();
    expect(scripts.size).toBeGreaterThan(0);
  });

  it("all values are non-empty strings", () => {
    const scripts = getAllScripts();
    for (const [key, value] of scripts) {
      expect(value.length, `${key} should be non-empty`).toBeGreaterThan(0);
    }
  });

  it("values match the exported constants", () => {
    const scripts = getAllScripts();
    expect(scripts.get("__init__.py")).toBe(scriptsInit);
    expect(scripts.get("common/__init__.py")).toBe(commonInit);
    expect(scripts.get("task.py")).toBe(taskScript);
  });

  it("does not contain multi_agent entries", () => {
    const scripts = getAllScripts();
    for (const [key] of scripts) {
      expect(key, `${key} should not be a multi_agent script`).not.toContain("multi_agent");
    }
  });
});

// =============================================================================
// getAllAgents — channel runtime agent definitions dispatched at init/update.
// agent-loader.ts loads `.arbor/agents/<name>.md` and requires `---` YAML
// frontmatter at the top with a flat `name: <name>` field. These tests pin the
// contract so a future template edit can't silently break channel spawn.
// =============================================================================

describe("getAllAgents", () => {
  it("ships exactly the seven role agents", () => {
    expect([...getAllAgents().keys()].sort()).toEqual(
      [...AGENT_ROLES].map((role) => `${role}.md`).sort(),
    );
    expect(AGENT_ROLES).toEqual([
      "explore",
      "architect",
      "implement",
      "review",
      "verify",
      "fix",
      "simplify",
    ]);
  });

  it("values match exported constants", () => {
    expect(getAllAgents().get("implement.md")).toBe(implementAgentTemplate);
  });

  it("no retired role agents", () => {
    for (const retired of ["check.md", "research.md"]) {
      expect(getAllAgents().has(retired)).toBe(false);
    }
  });

  it("assistant instructions have no frontmatter or provider/model fields", () => {
    for (const [file, content] of getAllAgents()) {
      expect(content.startsWith("---"), `${file} must not start with frontmatter`).toBe(false);
      expect(content, file).not.toContain("provider:");
      expect(content, file).toContain("Active task:");
      expect(content, file).toContain("arbor-hook-injected");
    }
  });
});

// =============================================================================
// config.yaml — context_injection section (issue #441)
// =============================================================================

describe("configYamlTemplate: context_injection section", () => {
  it("documents the context_injection block, fully commented out", () => {
    expect(configYamlTemplate).toContain("context_injection:");
    expect(configYamlTemplate).toContain("#   max_file_bytes: 32768");
    expect(configYamlTemplate).toContain("#   max_artifact_bytes: 65536");
    expect(configYamlTemplate).toContain("#   max_total_bytes: 131072");
    // Every context_injection line must be commented — the section ships
    // inert by default (matches the codex.dispatch_mode precedent).
    const lines = configYamlTemplate.split("\n");
    const start = lines.findIndex((l) => l.includes("context_injection:"));
    expect(start).toBeGreaterThan(-1);
    for (const line of lines.slice(start, start + 4)) {
      expect(line.trimStart().startsWith("#")).toBe(true);
    }
  });
});
