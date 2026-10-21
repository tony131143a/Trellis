import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadAgent } from "../../src/commands/channel/agent-loader.js";

function writeCard(cwd: string, name: string, frontmatter: string[]): void {
  const dir = path.join(cwd, ".trellis", "agents");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${name}.md`),
    ["---", `name: ${name}`, ...frontmatter, "---", "", "Body"].join("\n"),
  );
}

describe("agent-loader provider frontmatter", () => {
  let cwd: string;

  beforeEach(() => {
    // realpath: on macOS os.tmpdir() is a symlink (/var -> /private/var) and
    // findAgentFile compares realpaths against path.resolve(cwd, ".trellis/agents").
    cwd = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), "trellis-agent-loader-"),
    );
  });

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("accepts provider: star", () => {
    writeCard(cwd, "implement", ["provider: star"]);
    expect(loadAgent("implement", cwd).provider).toBe("star");
  });

  it("normalizes provider case", () => {
    writeCard(cwd, "implement", ["provider: STAR"]);
    expect(loadAgent("implement", cwd).provider).toBe("star");
  });

  it("drops providers that are not in the adapter registry", () => {
    writeCard(cwd, "implement", ["provider: gemini"]);
    expect(loadAgent("implement", cwd).provider).toBeUndefined();
  });

  it("ignores commented-out provider/model hint lines", () => {
    // The bundled implement/check cards ship `# provider: star` / `# model:`
    // hints; a YAML comment must not change the effective provider or model.
    writeCard(cwd, "implement", [
      "provider: claude",
      "# provider: star          # StarFactory worker",
      "# model: <provider model id>",
    ]);
    const agent = loadAgent("implement", cwd);
    expect(agent.provider).toBe("claude");
    expect(agent.model).toBeUndefined();
  });

  it("reads model: alongside provider:", () => {
    writeCard(cwd, "check", ["provider: star", "model: star-model-x"]);
    const agent = loadAgent("check", cwd);
    expect(agent.provider).toBe("star");
    expect(agent.model).toBe("star-model-x");
  });
});
