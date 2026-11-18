import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  scriptsInit,
  commonInit,
  commonPaths,
  commonDeveloper,
  getDeveloperScript,
  initDeveloperScript,
  arborScript,
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
    getDeveloperScript,
    initDeveloperScript,
    arborScript,
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
      getDeveloperScript,
      arborScript,
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
    expect(scripts.has("common/driver/sync.py")).toBe(true);
    expect(scripts.has("arbor.py")).toBe(true);
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
    expect(scripts.get("arbor.py")).toBe(arborScript);
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

  it("shows the optional agents of each kind of work and max_nodes, commented out", () => {
    for (const line of [
      "    # max_nodes: 30",
      "      # explore: omp",
      "      # review:",
      "      #   model: opus",
      "      #   effort: high",
      "      # light: omp",
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
        agents: { write: "codex" },
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

// =============================================================================
// config.yaml — every documented key has a reader
// =============================================================================

describe("config.yaml keys", () => {
  const scriptsDir = path.resolve(
    __dirname,
    "../../src/templates/arbor/scripts",
  );
  const repoRoot = path.resolve(__dirname, "../../../..");

  // The template with its commented-out example keys switched on.
  const exampleConfig = configYamlTemplate
    .split("\n")
    .map((line) =>
      line.replace(/^(\s*)# ?(\s*(?:[a-z_]+:(?: \S+)?|- ".*"))$/, "$1$2"),
    )
    .join("\n");

  function parse(yaml: string): Record<string, unknown> {
    const out = execFileSync(
      "python3",
      [
        "-c",
        "import json, sys; sys.path.insert(0, sys.argv[1]); " +
          "from common.arbor_config import parse_simple_yaml; " +
          "print(json.dumps(parse_simple_yaml(sys.stdin.read())))",
        scriptsDir,
      ],
      { input: yaml, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    return JSON.parse(out) as Record<string, unknown>;
  }

  // Children of these are names the user picks (packages, executors, tiers);
  // executors.default is the one key among them.
  const namedBy = new Set(["packages", "executors", "agents"]);

  function keyNames(node: unknown, parent: string, out: Set<string>): void {
    if (node === null || typeof node !== "object" || Array.isArray(node)) {
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (!namedBy.has(parent) || key === "default") out.add(key);
      keyNames(value, namedBy.has(parent) ? "" : key, out);
    }
  }

  it("the template documents only keys a script reads", () => {
    const sources = [...getAllScripts().values()].join("\n");
    const keys = new Set<string>();
    keyNames(parse(exampleConfig), "", keys);
    expect(keys).toContain("merge_target"); // commented examples are covered
    const unread = [...keys].filter(
      (key) => !sources.includes(`"${key}"`) && !sources.includes(`'${key}'`),
    );
    expect(unread).toEqual([]);
  });

  it("this repository's .arbor/config.yaml has only template sections and resolves", () => {
    const out = execFileSync(
      "python3",
      [
        "-c",
        "import json, sys; sys.path.insert(0, sys.argv[1]); " +
          "from pathlib import Path; " +
          "from common.arbor_config import read_arbor_config; " +
          "from common.driver.executor import resolve_executor; " +
          "config = read_arbor_config(Path(sys.argv[2])); " +
          "resolve_executor(config); print(json.dumps(sorted(config)))",
        scriptsDir,
        repoRoot,
      ],
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    const sections = Object.keys(parse(exampleConfig));
    const extra = (JSON.parse(out) as string[]).filter(
      (key) => !sections.includes(key),
    );
    expect(extra).toEqual([]);
  });
});
