/**
 * Integration test for `arbor dispatch ...`, the passthrough to the project's
 * `.arbor/scripts/dispatch.py`. Spawns the real built CLI binary
 * (`bin/arbor.js`), like `platforms.integration.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI_BIN = path.resolve(HERE, "../../bin/arbor.js");
const TEMPLATE_SCRIPTS = path.resolve(
  HERE,
  "../../src/templates/arbor/scripts",
);

function hasPython(): boolean {
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function runCli(cwd: string, args: string[]) {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("ARBOR_") || key.startsWith("CODEG")) continue;
    env[key] = value;
  }
  return spawnSync(process.execPath, [CLI_BIN, ...args], {
    cwd,
    encoding: "utf-8",
    env,
  });
}

describe.skipIf(!hasPython())("arbor dispatch passthrough", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "arbor-dispatch-cli-")),
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("forwards --help, arguments and the exit code to dispatch.py", () => {
    fs.cpSync(TEMPLATE_SCRIPTS, path.join(tmpDir, ".arbor", "scripts"), {
      recursive: true,
    });
    const nested = path.join(tmpDir, "src", "deep");
    fs.mkdirSync(nested, { recursive: true });

    const help = runCli(nested, ["dispatch", "--help"]);
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain("usage: dispatch.py");
    expect(help.stdout).toContain("codeg-setup");

    const resolved = runCli(nested, [
      "dispatch",
      "resolve",
      "--role",
      "review",
      "--target",
      "pi",
      "--json",
    ]);
    expect(resolved.status, resolved.stderr).toBe(0);
    expect(JSON.parse(resolved.stdout)).toMatchObject({
      role: "review",
      target: "pi",
      assistant: "arbor-review-pi",
    });

    const bad = runCli(tmpDir, ["dispatch", "target", "set", "bogus"]);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain("unknown dispatch target 'bogus'");
  });

  it("fails clearly outside an Arbor project", () => {
    const r = runCli(tmpDir, ["dispatch", "--help"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("no .arbor/ found");
  });
});
