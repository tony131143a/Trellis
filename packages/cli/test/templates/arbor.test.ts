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
  gitignoreTemplate,
  getAllScripts,
  configYamlTemplate,
} from "../../src/templates/arbor/index.js";
import { extractConfigSection } from "../../src/commands/update.js";
import { getAllMigrationVersions } from "../../src/migrations/index.js";

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
    gitignoreTemplate,
  };

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
    const files = fs
      .readdirSync(root, { recursive: true })
      .map(String)
      .filter((file) => file.endsWith(".py"));
    expect([...scripts.keys()].sort()).toEqual(
      files.map((file) => file.split(path.sep).join("/")).sort(),
    );
    for (const file of files) {
      expect(scripts.get(file.split(path.sep).join("/"))).toBe(
        fs.readFileSync(path.join(root, file), "utf8"),
      );
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
      expect(key, `${key} should not be a multi_agent script`).not.toContain(
        "multi_agent",
      );
    }
  });
});

// =============================================================================
// config.yaml — 1.0 shape
// =============================================================================

describe("configYamlTemplate: 1.0 sections", () => {
  it("drops the sections of removed concepts", () => {
    for (const removed of [
      "mandate:",
      "context_injection:",
      "prompt_injection:",
      "after_create:",
      "roles:",
      "task.py",
      "partition",
    ]) {
      expect(configYamlTemplate, removed).not.toContain(removed);
    }
  });

  it("shows the optional tiers and max_nodes keys, commented out", () => {
    for (const line of [
      "    # max_nodes: 30",
      "    # tiers:",
      "    #   light:",
      "    #   review:",
    ]) {
      expect(configYamlTemplate).toContain(`\n${line}`);
    }
  });

  // `arbor update` treats a section as present when the user's file contains
  // its sentinel anywhere, comments included. A sentinel quoted inside
  // another section would block the append on every upgraded project.
  it("mentions every configSectionsAdded sentinel only inside its own section", () => {
    const manifestsDir = path.resolve(
      __dirname,
      "../../src/migrations/manifests",
    );
    for (const version of getAllMigrationVersions()) {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(manifestsDir, `${version}.json`), "utf-8"),
      ) as {
        configSectionsAdded?: { sentinel: string; sectionHeading: string }[];
      };
      for (const entry of manifest.configSectionsAdded ?? []) {
        const section = extractConfigSection(
          configYamlTemplate,
          entry.sectionHeading,
        );
        const outside =
          section === null
            ? configYamlTemplate
            : configYamlTemplate.replace(section, "");
        expect(outside, `${version}: ${entry.sentinel}`).not.toContain(
          entry.sentinel,
        );
      }
    }
  });
});

// =============================================================================
// config.yaml — executors / gate sections (v2: replace `dispatch:`)
// =============================================================================

describe("configYamlTemplate: executors and gate", () => {
  const scriptsDir = path.resolve(
    __dirname,
    "../../src/templates/arbor/scripts",
  );

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
      {
        input: configYamlTemplate,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    return JSON.parse(out) as Record<string, unknown>;
  }

  it("ships executors + gate instead of the dispatch section", () => {
    expect(configYamlTemplate).not.toMatch(/^dispatch:/m);
    expect(configYamlTemplate).not.toMatch(
      /default_target|codeg-setup|ARBOR_DISPATCH_TARGET/,
    );
    const parsed = parseTemplate();
    expect(parsed.executors).toEqual({
      default: "orca",
      orca: {
        type: "orca",
        command: "orca",
        agent: "codex",
        timeout: "90m",
        max_parallel: "5",
        keep_open: "false",
      },
    });
    expect(parsed).not.toHaveProperty("conductor");
    expect(parsed.gate).toEqual({ commands: [] });
    // no `root`: Orca chooses where a worktree goes
    expect(parsed.worktree).toEqual({
      setup: "",
      branch_prefix: "arbor/",
    });
    expect(parsed).not.toHaveProperty("test_paths");
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

  it("ships only the Orca executor", () => {
    expect(configYamlTemplate).not.toContain("type: command");
    expect(configYamlTemplate).not.toContain("codeg");
    expect(configYamlTemplate).toContain("type: orca");
  });
});
