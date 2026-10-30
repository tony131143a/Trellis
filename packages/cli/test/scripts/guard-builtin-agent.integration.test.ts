/**
 * Integration tests for `shared-hooks/guard-builtin-agent.py`, the PreToolUse
 * guard on the host's built-in `Agent` / `Task` tool.
 *
 * Arbor roles run only through the driver (`arbor.py run`); the guard denies a
 * built-in Agent call that is recognisably an Arbor role dispatch and stays
 * silent otherwise.
 * Runs under the real `python3` interpreter against a stamped temp project.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEMPLATE_SCRIPTS = path.resolve(
  __dirname,
  "../../src/templates/arbor/scripts",
);
const HOOK_PATH = path.resolve(
  __dirname,
  "../../src/templates/shared-hooks/guard-builtin-agent.py",
);

function hasPython(): boolean {
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function cleanEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("ARBOR_")) continue;
    env[key] = value;
  }
  return { ...env, ...overrides };
}

describe.skipIf(!hasPython())("guard-builtin-agent.py", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "arbor-guard-test-"));
    fs.cpSync(TEMPLATE_SCRIPTS, path.join(tmp, ".arbor", "scripts"), {
      recursive: true,
    });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function runGuard(
    toolInput: Record<string, unknown>,
    options: { toolName?: string; env?: NodeJS.ProcessEnv; cwd?: string } = {},
  ): { status: number | null; stdout: string; stderr: string } {
    const cwd = options.cwd ?? tmp;
    const r = spawnSync("python3", [HOOK_PATH], {
      cwd,
      encoding: "utf-8",
      input: JSON.stringify({
        session_id: "guard-session",
        cwd,
        hook_event_name: "PreToolUse",
        tool_name: options.toolName ?? "Agent",
        tool_input: toolInput,
      }),
      env: cleanEnv(options.env),
    });
    if (r.error) throw r.error;
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  }

  function expectDeny(result: { status: number | null; stdout: string; stderr: string }): void {
    expect(result.status, result.stderr).toBe(0);
    const out = JSON.parse(result.stdout) as {
      hookSpecificOutput: {
        hookEventName: string;
        permissionDecision: string;
        permissionDecisionReason: string;
      };
    };
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    const reason = out.hookSpecificOutput.permissionDecisionReason;
    expect(reason).toContain("arbor.py next");
    expect(reason).toContain("arbor.py run");
    expect(reason).not.toContain("delegate_to_agent");
    expect(reason).not.toContain("dispatch.py");
    expect(reason).not.toMatch(/codeg|target/i);
  }

  it("denies a prompt that starts with `Active task:`", () => {
    expectDeny(
      runGuard({
        subagent_type: "general-purpose",
        prompt: "Active task: .arbor/tasks/10-24-foo\n\nImplement it.",
      }),
    );
  });

  it("denies a `Role: <arbor role>` header on Agent and Task", () => {
    for (const role of [
      "explore",
      "architect",
      "test",
      "implement",
      "review",
      "verify",
      "fix",
      "simplify",
    ]) {
      expectDeny(runGuard({ prompt: `Role: ${role}\n\nDo it.` }));
    }
    expectDeny(
      runGuard({ prompt: "Role: implement\n\nDo it." }, { toolName: "Task" }),
    );
  });

  it("denies an `arbor-` subagent_type", () => {
    expectDeny(runGuard({ subagent_type: "arbor-implement", prompt: "go" }));
    expectDeny(runGuard({ subagentType: "arbor-check", prompt: "go" }));
  });

  it("stays silent for ordinary Agent calls", () => {
    for (const toolInput of [
      { subagent_type: "Explore", prompt: "Find the config parser." },
      // A role word deep in the body is prose, not a header.
      { prompt: `${"context ".repeat(80)}\nRole: implement` },
      { prompt: "Role: reviewer\n\nLook around." },
      // Retired role names are no longer Arbor headers.
      { prompt: "Role: check\n\nLook around." },
      { prompt: "Role: research\n\nLook around." },
    ]) {
      const r = runGuard(toolInput);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
    }
  });

  it("stays silent for other tools", () => {
    const r = runGuard(
      { prompt: "Active task: .arbor/tasks/x" },
      { toolName: "mcp__codeg-mcp__delegate_to_agent" },
    );
    expect(r.stdout).toBe("");
  });

  it("ignores the retired dispatch.guard_builtin_agent switch", () => {
    fs.writeFileSync(
      path.join(tmp, ".arbor", "config.yaml"),
      ["dispatch:", "  guard_builtin_agent: false"].join("\n") + "\n",
    );
    expectDeny(runGuard({ prompt: "Role: implement\n\nDo it." }));
  });

  it("stays silent outside an Arbor project and under the kill switch", () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "arbor-guard-bare-"));
    try {
      expect(
        runGuard({ prompt: "Role: implement\n\nDo it." }, { cwd: bare }).stdout,
      ).toBe("");
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
    expect(
      runGuard(
        { prompt: "Role: implement\n\nDo it." },
        { env: { ARBOR_HOOKS: "0" } },
      ).stdout,
    ).toBe("");
  });
});
