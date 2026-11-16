import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../../../..");
const driverDocPath = ".arbor/spec/cli/backend/driver.md";

function readRepoFile(rel: string): string {
  return fs.readFileSync(path.resolve(repoRoot, rel), "utf-8");
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
  });
});
