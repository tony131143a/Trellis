import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("test Git subprocess isolation", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "arbor-git-isolation-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("prevents inherited global Trace2 configuration from reaching background listeners", () => {
    const trace = path.join(tmp, "events.jsonl");
    const config = path.join(tmp, "gitconfig");
    fs.writeFileSync(config, `[trace2]\n\teventTarget = ${JSON.stringify(trace)}\n`);
    const env = { ...process.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1" };

    // Prove this global configuration emits events without the test isolation.
    const controlEnv: NodeJS.ProcessEnv = { ...env };
    delete controlEnv.GIT_TRACE2_EVENT;
    const control = spawnSync("git", ["init", "-q", "-b", "main", "control-repo"], {
      cwd: tmp, encoding: "utf-8", env: controlEnv,
    });
    expect(control.status, control.stdout + control.stderr).toBe(0);
    expect(fs.readFileSync(trace, "utf-8")).toContain('"event":"version"');
    fs.unlinkSync(trace);

    // The setup's environment must propagate through child processes to Git.
    const isolated = spawnSync(process.execPath, ["-e", `
      require("node:child_process").execFileSync("git", ["init", "-q", "-b", "main", "isolated-repo"], { stdio: "pipe" });
    `], { cwd: tmp, encoding: "utf-8", env });
    expect(isolated.status, isolated.stdout + isolated.stderr).toBe(0);
    expect(fs.existsSync(trace)).toBe(false);
  });
});
