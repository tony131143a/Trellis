/**
 * Integration tests for `shared-hooks/sync-delegation.py`, the PostToolUse
 * hook on the codeg MCP tools `delegate_to_agent` / `get_delegation_status`.
 *
 * After `delegate_to_agent` it binds the returned task_id to the driver's
 * pending request; after a terminal `get_delegation_status` it saves the
 * response and collects it, replacing the manual `arbor.py bind` / `collect`.
 * Runs under the real `python3` interpreter against the v2 driver fixture.
 */

import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { TASK, hasPython, setupFixture, writeFile, type Fixture } from "./v2-driver-helpers";

const HOOK_PATH = path.resolve(__dirname, "../../src/templates/shared-hooks/sync-delegation.py");
const T = ["--task", `.arbor/tasks/${TASK}`];
const EXPLORE = "## Explore Results\n\n### Conclusion\ncanary ok\n";

interface Prepared { request_path: string; dispatch: string; prompt_path: string; mcp: { arguments: Record<string, unknown> } }

function cleanEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("ARBOR_")) continue;
    env[key] = value;
  }
  return { ...env, ...overrides };
}

function runHook(
  payload: Record<string, unknown>,
  options: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
): { status: number | null; context: string | null; stderr: string } {
  const r = spawnSync("python3", [HOOK_PATH], {
    cwd: options.cwd ?? os.tmpdir(),
    encoding: "utf-8",
    input: JSON.stringify({ session_id: "sync-session", hook_event_name: "PostToolUse", ...payload }),
    env: cleanEnv(options.env),
  });
  if (r.error) throw r.error;
  const context = r.stdout.trim()
    ? (JSON.parse(r.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } })
    : null;
  if (context) expect(context.hookSpecificOutput.hookEventName).toBe("PostToolUse");
  return { status: r.status, context: context?.hookSpecificOutput.additionalContext ?? null, stderr: r.stderr };
}

const delegateReply = (taskId: string) => ({
  content: [{ type: "text", text: `Delegation successful. task_id=${taskId}. Call get_delegation_status with this id.` }],
  isError: false,
  structuredContent: { task_id: taskId, status: "running", child_conversation_id: 42, agent_type: "claude" },
});
const statusReply = (tasks: object[]) => ({
  content: [{ type: "text", text: JSON.stringify({ tasks }) }],
  isError: false,
  structuredContent: { tasks },
});

describe.skipIf(!hasPython())("sync-delegation.py", { timeout: 90_000 }, () => {
  let f: Fixture;
  afterEach(() => f?.cleanup());

  function configure() {
    f = setupFixture({ start: false });
    writeFile(f.repo, ".arbor/config.yaml",
      "executors:\n  default: codeg\n  codeg:\n    type: codeg-mcp\n    assistant: arbor-{role}\n    assistant_ids:\n      explore: 2\n");
  }
  function prepare(id: string): Prepared {
    f.brief(id, `Inspect the parser (${id}).`);
    const r = f.run(...T, "run", "--role", "explore", "--dispatch", id);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    return JSON.parse(r.stdout) as Prepared;
  }
  const record = (p: Prepared) => JSON.parse(fs.readFileSync(p.request_path, "utf-8"));

  it("binds after delegate_to_agent, ignores a running status, collects the terminal report once", () => {
    configure();
    const p = prepare("d-001");
    expect(record(p).task_id).toBeNull();

    // cwd is outside the project: the `Prompt:` pointer in the task text names the main checkout.
    const bound = runHook({
      cwd: os.tmpdir(), tool_name: "mcp__codeg-mcp__delegate_to_agent",
      tool_input: p.mcp.arguments, tool_response: delegateReply("codeg-task-1"),
    });
    expect(bound.status, bound.stderr).toBe(0);
    expect(bound.context).toContain("bound d-001 to codeg task_id codeg-task-1");
    expect(bound.context).toContain('task_ids ["codeg-task-1"]');
    expect(record(p)).toMatchObject({ status: "pending", task_id: "codeg-task-1" });

    const running = runHook({
      cwd: f.repo, tool_name: "mcp__codeg-mcp__get_delegation_status",
      tool_input: { task_ids: ["codeg-task-1"], wait_ms: 1000 },
      tool_response: statusReply([{ task_id: "codeg-task-1", status: "running", message: "Running." }]),
    });
    expect(running.status, running.stderr).toBe(0);
    expect(running.context).toBeNull();
    expect(record(p).status).toBe("pending");

    const terminal = statusReply([{ task_id: "codeg-task-1", status: "completed", text: EXPLORE, child_conversation_id: 42 }]);
    const done = runHook({
      cwd: f.repo, tool_name: "mcp__codeg-mcp__get_delegation_status",
      tool_input: { task_ids: ["codeg-task-1"], wait_ms: 1000 }, tool_response: terminal,
    });
    expect(done.status, done.stderr).toBe(0);
    expect(done.context).toContain("collected d-001 (completed)");
    expect(done.context).toContain("arbor.py next");
    expect(record(p).status).not.toBe("pending");
    const saved = p.request_path.replace(/\.json$/, ".result.json");
    expect(JSON.parse(fs.readFileSync(saved, "utf-8"))).toEqual(terminal);
    const task = f.taskJson();
    expect(task.mcp_pending).toEqual({});
    expect(task.dispatches).toMatchObject([{ id: "d-001", status: "ok", phase: "CONTRACT" }]);
    expect(JSON.parse(f.run(...T, "next", "--json").stdout).needs).not.toBe("delegation");

    // Nothing pending is bound to that id any more: the same report is not collected twice.
    const again = runHook({
      cwd: f.repo, tool_name: "mcp__codeg-mcp__get_delegation_status",
      tool_input: { task_ids: ["codeg-task-1"] }, tool_response: terminal,
    });
    expect(again.status).toBe(0);
    expect(again.context).toBeNull();
  });

  it("accepts the content-block list some hosts pass as tool_response and matches the request by task text", () => {
    configure();
    const a = prepare("d-001");
    const b = prepare("d-002");
    const bound = runHook({
      cwd: f.repo, tool_name: "mcp__codeg__delegate_to_agent",
      tool_input: b.mcp.arguments,
      tool_response: [{ type: "text", text: "Delegation successful. task_id=codeg-task-2. Poll it." }],
    });
    expect(bound.status, bound.stderr).toBe(0);
    expect(bound.context).toContain("bound d-002 to codeg task_id codeg-task-2");
    expect(record(b).task_id).toBe("codeg-task-2");
    expect(record(a).task_id).toBeNull();
  });

  it("reports a refused collection instead of hiding it, and leaves the request pending", () => {
    configure();
    const p = prepare("d-001");
    runHook({ cwd: f.repo, tool_name: "mcp__codeg-mcp__delegate_to_agent", tool_input: p.mcp.arguments, tool_response: delegateReply("codeg-task-1") });
    const truncated = statusReply([{ task_id: "codeg-task-1", status: "completed", text: "partial", truncated: true }]);
    const r = runHook({
      cwd: f.repo, tool_name: "mcp__codeg-mcp__get_delegation_status",
      tool_input: { task_ids: ["codeg-task-1"] }, tool_response: truncated,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.context).toContain("d-001 (completed) was not collected");
    expect(r.context).toContain("truncated");
    expect(record(p)).toMatchObject({ status: "pending", task_id: "codeg-task-1" });
  });

  it("stays silent for other tools, unknown task text, or ARBOR_HOOKS=0", () => {
    configure();
    const p = prepare("d-001");
    const other = runHook({ cwd: f.repo, tool_name: "mcp__codeg-mcp__cancel_delegation", tool_input: { task_id: "x" }, tool_response: {} });
    expect(other).toMatchObject({ status: 0, context: null });
    const unknown = runHook({
      cwd: f.repo, tool_name: "mcp__codeg-mcp__delegate_to_agent",
      tool_input: { task: "Active task: elsewhere\nRole: explore\n", working_dir: f.repo }, tool_response: delegateReply("codeg-task-9"),
    });
    expect(unknown).toMatchObject({ status: 0, context: null });
    const disabled = runHook(
      { cwd: f.repo, tool_name: "mcp__codeg-mcp__delegate_to_agent", tool_input: p.mcp.arguments, tool_response: delegateReply("codeg-task-1") },
      { env: { ARBOR_HOOKS: "0" } },
    );
    expect(disabled).toMatchObject({ status: 0, context: null });
    expect(record(p).task_id).toBeNull();
  });
});
