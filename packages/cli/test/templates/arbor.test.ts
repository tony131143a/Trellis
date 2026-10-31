import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
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

  it("workflow.md in_progress fallback self-exempts dispatched sub-agents", () => {
    const block = inProgressBreadcrumb();
    expect(block).toContain("Sub-agent self-exemption");
    expect(block).toContain("Active task:");
    expect(block).toContain("dispatched sub-agent");
    expect(block).toContain("main session only");
    expect(block).toContain("arbor.py next");
  });

  it("workflow.md has no platform branch blocks or inline breadcrumbs", () => {
    expect(workflowMdTemplate).not.toMatch(/^\[\/?[A-Za-z][^\]\n]*,[^\]\n]*\]\s*$/m);
    expect(workflowMdTemplate).not.toContain("workflow-state:planning-inline");
    expect(workflowMdTemplate).not.toContain("workflow-state:in_progress-inline");
  });

  it("workflow.md documents the driver, the dispatch header and the roles", () => {
    expect(workflowMdTemplate).toContain("### Driver");
    for (const cmd of ["next", "run", "gate", "decide", "canary", "override", "status | resume | abandon"]) {
      expect(workflowMdTemplate).toContain(`arbor.py ${cmd}`);
    }
    for (const line of ["Active task:", "Role:", "Mode:", "Range:", "Dispatch: d-NNN"]) {
      expect(workflowMdTemplate).toContain(line);
    }
    expect(workflowMdTemplate).toContain("Arbor-Dispatch: d-NNN");
    expect(workflowMdTemplate).toContain("<role>(<task-dir-name>): <summary>");
    for (const role of AGENT_ROLES) {
      expect(workflowMdTemplate).toContain(`| \`${role}\` |`);
    }
  });

  it("workflow.md drops v1 dispatch machinery and describes codeg MCP handoffs", () => {
    for (const gone of [
      "dispatch.py",
      "Diff:",
      "Target:",
      "Workspace:",
      "prd.md",
      "implement.md",
      "meta.execution",
      "#### 2P.",
      "#### 2F.",
    ]) {
      expect(workflowMdTemplate, `workflow.md must not mention ${gone}`).not.toContain(gone);
    }
    expect(workflowMdTemplate).toContain("delegate_to_agent");
    expect(workflowMdTemplate).toContain("arbor.py collect --request");
    expect(workflowMdTemplate).toContain("Claude Code and Codex both use this same MCP flow");
    expect(workflowMdTemplate).not.toContain("codeg-cli run -A");
  });

  it("workflow.md ships the reference tables", () => {
    for (const heading of [
      "### State Machine",
      "### Tiers",
      "### Verification Ladder",
      "### Human Gates",
      "### Request Triage",
      "### Task Artifacts",
      "### Roles",
    ]) {
      expect(workflowMdTemplate).toContain(heading);
    }
    for (const state of ["INTAKE", "CONTRACT", "BUILD", "GATE", "REVIEW", "POLISH", "FINISH", "STOP"]) {
      expect(workflowMdTemplate).toContain(`| ${state} |`);
    }
    for (const section of [
      "## Goal",
      "## Scope",
      "## Acceptance criteria",
      "## Verification map",
      "## Interface pins",
      "## Test paths",
      "## Partitions",
      "## Waves",
    ]) {
      expect(workflowMdTemplate).toContain(`\`${section}\``);
    }
    expect(workflowMdTemplate).not.toMatch(/\|\s*quick\s*\|/);
  });

  /** `#### X.Y Title \`[required · once(; scope)]\`` step ids. */
  function requiredOnceSteps(): string[] {
    const re = /^#### (\S+) [^\n]*`\[required · once(?:; [^\]`]+)?\]`/gm;
    return [...workflowMdTemplate.matchAll(re)].map((m) => m[1]);
  }

  it("[required · once] planning steps appear in the planning breadcrumb", () => {
    const steps = requiredOnceSteps();
    expect(steps).toEqual(["1.0", "1.2", "1.4", "1.5", "1.6", "1.7", "3.1", "3.3", "3.4"]);
    expect(workflowStateBreadcrumb("no_task")).toContain("1.0");
    for (const step of steps.filter((s) => s.startsWith("1.") && s !== "1.0")) {
      expect(
        workflowStateBreadcrumb("planning"),
        `${step} must be enforced in the planning block`,
      ).toContain(step);
    }
    expect(workflowStateBreadcrumb("planning")).toContain("task.py start");
  });

  it("workflow.md ships exactly the v2 block set with no nested or dangling tags", () => {
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
      "completed",
    ]);
    // A prose line that ends in a tag token would open a block for the parser.
    expect(workflowMdTemplate).not.toMatch(
      /^[^[\n][^\n]*\[\/?workflow-state:[A-Za-z0-9_-]+\]\s*$/m,
    );
  });

  it("workflow.md step bodies carry the v2 mechanics", () => {
    expect(stepSection("1.0")).toContain("--tier");
    expect(stepSection("1.1")).toContain("soft cap");
    expect(stepSection("1.2")).toContain("one numbered list");
    expect(stepSection("1.3")).toContain("Verification map");
    expect(stepSection("1.4")).toContain("waves.md");
    expect(stepSection("1.5")).toContain("task.py seed-context");
    expect(stepSection("1.6")).toContain("Mode: plan");
    expect(stepSection("1.7")).toContain("task.py start");
    expect(stepSection("2.1")).toContain("arbor.py next");
    expect(stepSection("2.2")).toContain("brief_path");
    expect(stepSection("2.2")).toContain("`Angles:`");
    expect(stepSection("2.2")).toContain("`A, B, Acceptance`");
    expect(stepSection("2.4")).toContain("decide impl|tests|contract");
    expect(stepSection("2.6")).toContain("PLAUSIBLE");
    expect(stepSection("2.6")).toContain("Mode: sweep");
    expect(stepSection("3.3")).toContain("--no-ff");
    expect(workflowStateBreadcrumb("no_task")).toContain("Simple");
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

  it("workflow.md planning breadcrumbs mention parent child split guidance", () => {
    const planning = workflowStateBreadcrumb("planning");
    expect(planning).toContain("Multi-deliverable scope");
    expect(planning).toContain("parent task plus independently verifiable child tasks");
    expect(planning).toContain("not implied by tree position");
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
  it("updates every Python script installed by init with the shipped content", () => {
    const root = path.resolve(__dirname, "../../src/templates/arbor/scripts");
    const scripts = getAllScripts();
    const files = fs.readdirSync(root, { recursive: true }).map(String)
      .filter((file) => file.endsWith(".py"));
    expect([...scripts.keys()].sort()).toEqual(files.map((file) => file.split(path.sep).join("/")).sort());
    for (const file of files) {
      expect(scripts.get(file.split(path.sep).join("/"))).toBe(fs.readFileSync(path.join(root, file), "utf8"));
    }
  });
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
  it("ships exactly the eight role agents", () => {
    expect([...getAllAgents().keys()].sort()).toEqual(
      [...AGENT_ROLES].map((role) => `${role}.md`).sort(),
    );
    expect(AGENT_ROLES).toEqual([
      "explore",
      "architect",
      "test",
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

// =============================================================================
// config.yaml — executors / gate sections (v2: replace `dispatch:`)
// =============================================================================

describe("configYamlTemplate: executors and gate", () => {
  const scriptsDir = path.resolve(__dirname, "../../src/templates/arbor/scripts");

  function parseTemplate(): Record<string, unknown> {
    const out = execFileSync(
      "python3",
      [
        "-c",
        "import json, sys; sys.path.insert(0, sys.argv[1]); " +
          "from common.arbor_config import parse_simple_yaml; " +
          "print(json.dumps(parse_simple_yaml(sys.stdin.read())))",
        scriptsDir,
      ],
      { input: configYamlTemplate, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    return JSON.parse(out) as Record<string, unknown>;
  }

  it("ships executors + gate instead of the dispatch section", () => {
    expect(configYamlTemplate).not.toMatch(/^dispatch:/m);
    expect(configYamlTemplate).not.toMatch(/default_target|codeg-setup|ARBOR_DISPATCH_TARGET/);
    const parsed = parseTemplate();
    expect(parsed.executors).toEqual({
      default: "codeg",
      codeg: {
        type: "codeg-mcp",
        assistant: "arbor-{role}",
        timeout: "90m",
        max_parallel: "3",
      },
    });
    expect(parsed.gate).toEqual({ commands: [] });
    expect(parsed.worktree).toEqual({ root: "../{repo}-wt", setup: "" });
    expect(parsed.test_paths).toEqual(["packages/*/test/**", "**/*.test.ts"]);
    expect(parsed).not.toHaveProperty("dispatch");
  });

  it("parses the template without parser warnings", () => {
    const r = spawnSync(
      "python3",
      [
        "-c",
        "import sys; sys.path.insert(0, sys.argv[1]); " +
          "from common.arbor_config import parse_simple_yaml; parse_simple_yaml(sys.stdin.read())",
        scriptsDir,
      ],
      { input: configYamlTemplate, encoding: "utf-8" },
    );
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
  });

  it("documents the other executors only as comments", () => {
    expect(configYamlTemplate).toContain('#     command: "claude -p < {prompt}"');
    expect(configYamlTemplate).toContain('#     command: "codex exec --cd {worktree} --sandbox workspace-write - < {prompt}"');
  });
});
