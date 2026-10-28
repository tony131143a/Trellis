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
    return workflowStateBreadcrumb("in_progress");
  }

  // Same shape as the parser in inject-workflow-state.py: the opening tag must
  // end its line, so the `[workflow-state:X] → ...` lines inside the contract
  // comment are not mistaken for a block start.
  function workflowStateBreadcrumb(status: string): string {
    const match = new RegExp(
      `\\[workflow-state:${status}\\]\\s*\\n([\\s\\S]*?)\\n\\s*\\[/workflow-state:${status}\\]`,
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

  const IN_PROGRESS_KEYS = [
    "in_progress",
    "in_progress-light",
    "in_progress-standard",
    "in_progress-full",
    "in_progress-parallel",
  ] as const;

  it("workflow.md in_progress breadcrumbs self-exempt dispatched sub-agents", () => {
    for (const key of IN_PROGRESS_KEYS) {
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

  const TIERS = ["light", "standard", "full"] as const;

  /** `#### X.Y Title \`[required · once(; scope)]\`` headings with their tier scope. */
  function requiredOnceSteps(): Array<{ step: string; tiers: string[] }> {
    const re = /^#### (\S+) [^\n]*`\[required · once(?:; ([^\]`]+))?\]`/gm;
    const out: Array<{ step: string; tiers: string[] }> = [];
    for (const m of workflowMdTemplate.matchAll(re)) {
      const tiers = m[2] ? m[2].split("/").map((t) => t.trim()) : [...TIERS];
      out.push({ step: m[1], tiers });
    }
    return out;
  }

  it("[required · once] steps appear in every breadcrumb block of their tier scope", () => {
    // The breadcrumb is the only per-turn channel: a required step that a
    // tier's block does not mention gets skipped silently in that tier.
    const steps = requiredOnceSteps();
    expect(steps.map((s) => s.step)).toEqual([
      "1.0", "1.3", "1.4", "2F.1", "2F.2", "2F.5", "3.3", "3.4",
    ]);
    for (const { step, tiers } of steps) {
      const keys =
        step === "1.0"
          ? ["no_task"]
          : step.startsWith("1.")
            ? ["planning"]
            : [
                ...tiers.map((t) => `in_progress-${t}`),
                ...(tiers.includes("full") ? ["in_progress-parallel"] : []),
              ];
      for (const key of keys) {
        expect(
          workflowStateBreadcrumb(key),
          `${step} must be enforced in [workflow-state:${key}]`,
        ).toContain(step);
      }
    }
    expect(workflowStateBreadcrumb("planning")).toContain("task.py start");
    for (const key of IN_PROGRESS_KEYS) {
      expect(workflowStateBreadcrumb(key)).toContain("3.4");
    }
  });

  it("tier breadcrumbs carry only their own tier's polish steps", () => {
    const light = workflowStateBreadcrumb("in_progress-light");
    for (const absent of ["2F.1", "2F.2", "Mode: candidates", "Mode: sweep"]) {
      expect(light, `light must not mention ${absent}`).not.toContain(absent);
    }
    expect(light).toContain("2F.5");
    const standard = workflowStateBreadcrumb("in_progress-standard");
    expect(standard).toContain("Mode: candidates");
    expect(standard).not.toContain("Mode: sweep");
    expect(workflowStateBreadcrumb("in_progress-full")).toContain("Mode: sweep");
    expect(workflowStateBreadcrumb("in_progress-parallel")).toContain("sweep");
    expect(workflowStateBreadcrumb("in_progress-parallel")).toContain("Tier full");
  });

  it("workflow.md ships exactly the tier block set with no nested or dangling tags", () => {
    // Same regex as inject-workflow-state.py (backreference on STATUS).
    const re = /\[workflow-state:([A-Za-z0-9_-]+)\]\s*\n([\s\S]*?)\n\s*\[\/workflow-state:\1\]/g;
    const names: string[] = [];
    for (const m of workflowMdTemplate.matchAll(re)) {
      names.push(m[1]);
      expect(m[2], `${m[1]} must not swallow another block`).not.toContain("[workflow-state:");
    }
    // `my-status` is the example block inside the Customizing section.
    expect(names.filter((n) => n !== "my-status")).toEqual([
      "no_task",
      "task_error",
      "planning",
      "in_progress",
      "in_progress-light",
      "in_progress-standard",
      "in_progress-full",
      "in_progress-parallel",
      "completed",
    ]);
    expect(names.some((n) => n.startsWith("planning-"))).toBe(false);
    // A prose line that ends in a tag token would open a block for the parser.
    expect(workflowMdTemplate).not.toMatch(
      /^[^\[\n][^\n]*\[\/?workflow-state:[A-Za-z0-9_-]+\]\s*$/m,
    );
  });

  it("workflow.md step bodies carry the tier mechanics", () => {
    expect(workflowMdTemplate).toContain("### Tiers");
    expect(workflowMdTemplate).not.toContain("300");
    expect(workflowMdTemplate).not.toMatch(/lightweight|complex task/i);
    const gate = stepSection("2.2");
    expect(gate).toContain("--name gate");
    expect(gate).toContain("Angles: A, B, C, D, E, Conventions, Acceptance, Cleanup-lite");
    expect(gate).toContain("Angles: A, B, Acceptance");
    expect(stepSection("1.0")).toContain("--tier");
    expect(stepSection("1.3")).toContain("task.py seed-context");
    expect(stepSection("1.4")).toContain("tier is not full");
    expect(stepSection("2F.1")).toContain("No separate review");
    expect(stepSection("2F.3")).toContain("PLAUSIBLE");
    expect(workflowStateBreadcrumb("no_task")).toContain("Quick");
    expect(workflowStateBreadcrumb("planning")).toContain("set-meta <task> tier");
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
