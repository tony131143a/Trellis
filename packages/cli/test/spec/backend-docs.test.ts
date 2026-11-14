import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../../../..");
const driverDocPath = ".arbor/spec/cli/backend/driver.md";
const driverScript = path.join(
  repoRoot,
  "packages/cli/src/templates/arbor/scripts/arbor.py",
);

function readRepoFile(rel: string): string {
  return fs.readFileSync(path.resolve(repoRoot, rel), "utf-8");
}

/** The subcommands the argparse parser of arbor.py defines (`--help` calls no Orca). */
function parserCommands(): string[] {
  const result = spawnSync("python3", [driverScript, "--help"], {
    cwd: path.dirname(driverScript),
    encoding: "utf-8",
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    timeout: 30_000,
  });
  expect(result.error, "arbor.py --help must execute").toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  const choices = /\{([a-z,-]+)\}/.exec(result.stdout);
  if (!choices) throw new Error("arbor.py --help lists no subcommands");
  return choices[1].split(",");
}

describe("spec documentation", () => {
  it("AC-5: spec lint reports no errors", () => {
    const result = spawnSync("python3", [".arbor/scripts/spec.py", "lint"], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    expect(result.error, "spec lint must execute successfully").toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/spec lint: \d+ docs,/);
    const errors = result.stdout
      .split(/\r?\n/)
      .filter((line) => line.startsWith("ERROR"));
    expect(errors).toEqual([]);
  });

  describe("driver.md", () => {
    it("exists with a metadata block whose sources exist", () => {
      const doc = readRepoFile(driverDocPath);
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(doc);
      if (!frontmatter) throw new Error("driver.md has no frontmatter");
      const block = frontmatter[1];
      expect(block).toMatch(/^last_verified: \d{4}-\d{2}-\d{2}\r?$/m);
      const sources = [...block.matchAll(/^[ \t]+-\s+(.+?)\s*$/gm)].map(
        (m) => m[1],
      );
      expect(sources.length).toBeGreaterThan(0);
      for (const source of sources) {
        // A glob must at least have an existing literal directory prefix; spec lint checks matches.
        const literal = source.includes("*")
          ? source.slice(0, source.indexOf("*"))
          : source;
        const exists = fs.existsSync(path.resolve(repoRoot, literal));
        expect(exists, `source does not exist: ${source}`).toBe(true);
      }
    });

    it("is linked from the backend index", () => {
      expect(readRepoFile(".arbor/spec/cli/backend/index.md")).toContain(
        "(./driver.md)",
      );
    });

    it("documents exactly the commands arbor.py defines", () => {
      const doc = readRepoFile(driverDocPath);
      const section = /^## 4\. Commands\r?\n([\s\S]*?)^## /m.exec(doc);
      if (!section)
        throw new Error("driver.md has no '## 4. Commands' section");
      const documented = [...section[1].matchAll(/^\| `([a-z-]+)[ `]/gm)].map(
        (m) => m[1],
      );
      expect(new Set(documented)).toEqual(new Set(parserCommands()));
    });

    it("names the task.json schema the driver writes", () => {
      const repos = readRepoFile(
        "packages/cli/src/templates/arbor/scripts/common/driver/repos.py",
      );
      const schema = /^SCHEMA = (\d+)$/m.exec(repos)?.[1];
      expect(schema, "SCHEMA constant in repos.py").toBeDefined();
      expect(readRepoFile(driverDocPath)).toContain(`schema: ${schema}`);
    });
  });
});
