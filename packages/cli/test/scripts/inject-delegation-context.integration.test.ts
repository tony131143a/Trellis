/**
 * Integration tests for `shared-hooks/inject-delegation-context.py`, the
 * PreToolUse hook on codeg `delegate_to_agent`.
 *
 * The hook inlines Arbor task context into `tool_input.task` through
 * `.arbor/scripts/common/dispatch_context.py`. Scripts are stamped into a
 * fresh temp project and the hook runs under the real `python3`
 * interpreter with a Claude Code-shaped PreToolUse payload on stdin.
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
  "../../src/templates/shared-hooks/inject-delegation-context.py",
);
const TOOL_NAME = "mcp__codeg-mcp__delegate_to_agent";
const MARKER = "<!-- arbor-hook-injected -->";
const TASK = "10-24-foo";
const TASK_REL = `.arbor/tasks/${TASK}`;

function hasPython(): boolean {
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Host env without anything that would leak a real session or platform. */
function cleanEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      key.startsWith("ARBOR_") ||
      key.startsWith("CLAUDE") ||
      key.startsWith("STARFACTORY")
    ) {
      continue;
    }
    env[key] = value;
  }
  return { ...env, ...overrides };
}

interface HookResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

interface HookOutput {
  hookSpecificOutput: {
    hookEventName: string;
    permissionDecision: string;
    permissionDecisionReason: string;
    updatedInput: Record<string, unknown> & { task: string };
  };
}

describe.skipIf(!hasPython())("inject-delegation-context.py", () => {
  let tmp: string;
  let taskDir: string;

  beforeEach(() => {
    tmp = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "arbor-delegation-test-")),
    );
    fs.cpSync(TEMPLATE_SCRIPTS, path.join(tmp, ".arbor", "scripts"), {
      recursive: true,
    });
    taskDir = path.join(tmp, ".arbor", "tasks", TASK);
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(
      path.join(taskDir, "task.json"),
      JSON.stringify({ id: TASK, title: TASK, status: "in_progress" }) + "\n",
    );
    fs.writeFileSync(path.join(taskDir, "prd.md"), "# PRD FOO CONTENT\n");
    fs.mkdirSync(path.join(tmp, ".arbor", "spec", "cli"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, ".arbor", "spec", "cli", "guide.md"),
      "SPEC GUIDE CONTENT\n",
    );
    fs.writeFileSync(
      path.join(taskDir, "implement.jsonl"),
      JSON.stringify({ file: ".arbor/spec/cli/guide.md", reason: "guide" }) +
        "\n",
    );
    fs.writeFileSync(
      path.join(taskDir, "check.jsonl"),
      JSON.stringify({ file: ".arbor/spec/cli/guide.md", reason: "guide" }) +
        "\n",
    );
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function runHook(
    toolInput: Record<string, unknown>,
    options: { toolName?: string; env?: NodeJS.ProcessEnv; extra?: object } = {},
  ): HookResult {
    const r = spawnSync("python3", [HOOK_PATH], {
      cwd: tmp,
      encoding: "utf-8",
      input: JSON.stringify({
        session_id: "delegation-session",
        cwd: tmp,
        hook_event_name: "PreToolUse",
        tool_name: options.toolName ?? TOOL_NAME,
        tool_input: toolInput,
        ...options.extra,
      }),
      env: cleanEnv(options.env),
    });
    if (r.error) throw r.error;
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  }

  function parse(result: HookResult): HookOutput["hookSpecificOutput"] {
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim(), result.stderr).not.toBe("");
    return (JSON.parse(result.stdout) as HookOutput).hookSpecificOutput;
  }

  it("injects implement context behind a normalised header when Role is given", () => {
    const out = parse(
      runHook({
        task: `Active task: ${TASK_REL}\nRole: implement\nTarget: pi\n\nBuild the widget.`,
        assistant_id: 12,
        working_dir: "/somewhere/else",
        agent_type: "pi",
      }),
    );
    expect(out.hookEventName).toBe("PreToolUse");
    expect(out.permissionDecision).toBe("allow");
    expect(out.permissionDecisionReason).toContain("implement");

    const task = out.updatedInput.task;
    expect(
      task.startsWith(
        `Active task: ${taskDir}\nRole: implement\nTarget: pi\n\n${MARKER}\n# Implement Agent Task`,
      ),
    ).toBe(true);
    expect(task).toContain("Arbor dispatch");
    expect(task).not.toContain("Multi-Agent Pipeline");
    expect(task).toContain("PRD FOO CONTENT");
    expect(task).toContain("SPEC GUIDE CONTENT");
    expect(task).toContain("## Your Task\n\nBuild the widget.");
  });

  it("only replaces `task` in updatedInput (assistant_id / working_dir / agent_type kept)", () => {
    const out = parse(
      runHook({
        task: `Active task: ${TASK_REL}\nRole: implement\n\nGo.`,
        assistant_id: 12,
        working_dir: "/somewhere/else",
        agent_type: "pi",
      }),
    );
    expect(out.updatedInput.assistant_id).toBe(12);
    expect(out.updatedInput.working_dir).toBe("/somewhere/else");
    expect(out.updatedInput.agent_type).toBe("pi");
    expect(Object.keys(out.updatedInput).sort()).toEqual([
      "agent_type",
      "assistant_id",
      "task",
      "working_dir",
    ]);
  });

  it("emits nothing without a Role header and without the codeg assistant registry", () => {
    const r = runHook({
      task: `Active task: ${TASK_REL}\n\nBuild the widget.`,
      assistant_id: 12,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("falls back to .arbor/.runtime/codeg-assistants.json for the role", () => {
    fs.mkdirSync(path.join(tmp, ".arbor", ".runtime"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, ".arbor", ".runtime", "codeg-assistants.json"),
      JSON.stringify({
        by_id: {
          "12": { role: "check", name: "arbor-check-pi" },
          "13": { role: "implement", name: "arbor-implement-pi" },
        },
      }),
    );
    const out = parse(
      runHook({
        task: `Active task: ${TASK_REL}\n\nReview the diff.`,
        assistant_id: 12,
      }),
    );
    expect(out.updatedInput.task).toContain(
      `Active task: ${taskDir}\nRole: check\n\n${MARKER}\n# Check Agent Task`,
    );

    // An id the registry does not know stays uninjected.
    const unknown = runHook({
      task: `Active task: ${TASK_REL}\n\nReview the diff.`,
      assistant_id: 99,
    });
    expect(unknown.stdout).toBe("");
  });

  it("normalises absolute and repo-relative Active task to the absolute task dir", () => {
    for (const ref of [taskDir, TASK_REL, `./${TASK_REL}`, TASK]) {
      const out = parse(
        runHook({ task: `Active task: ${ref}\nRole: implement\n\nGo.` }),
      );
      expect(out.updatedInput.task.split("\n")[0], ref).toBe(
        `Active task: ${taskDir}`,
      );
    }
  });

  it("refuses an Active task outside the repo instead of reading through it", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "arbor-outside-"));
    try {
      fs.writeFileSync(path.join(outside, "prd.md"), "OUTSIDE SECRET\n");
      const r = runHook({
        task: `Active task: ${outside}\nRole: implement\n\nGo.`,
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("no context injected");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses an Active task that is inside the repo but not under .arbor/tasks", () => {
    fs.writeFileSync(path.join(tmp, "prd.md"), "ROOT SECRET\n");
    for (const ref of [tmp, path.join(tmp, ".arbor"), path.join(tmp, ".arbor", "tasks")]) {
      const r = runHook({
        task: `Active task: ${ref}\nRole: implement\n\nGo.`,
      });
      expect(r.status).toBe(0);
      expect(r.stdout, ref).toBe("");
      expect(r.stderr).toContain("no context injected");
    }
  });

  it("uses the session active task when the header omits Active task", () => {
    fs.mkdirSync(path.join(tmp, ".arbor", ".runtime", "sessions"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(tmp, ".arbor", ".runtime", "sessions", "claude_delegation-session.json"),
      JSON.stringify({ current_task: TASK_REL, platform: "claude" }),
    );
    const out = parse(runHook({ task: "Role: implement\n\nGo." }));
    expect(out.updatedInput.task.split("\n")[0]).toBe(`Active task: ${taskDir}`);
  });

  it("skips implement with no resolvable task and says why on stderr", () => {
    const r = runHook({ task: "Role: implement\n\nGo." });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("no context injected");
  });

  it("is idempotent: a task that already carries the marker is left alone", () => {
    const first = parse(
      runHook({ task: `Active task: ${TASK_REL}\nRole: implement\n\nGo.` }),
    );
    const again = runHook({ task: first.updatedInput.task });
    expect(again.status).toBe(0);
    expect(again.stdout).toBe("");
  });

  it("routes `Role: check [finish]` to the finish prompt", () => {
    const out = parse(
      runHook({
        task: `Active task: ${TASK_REL}\nRole: check [finish]\n\nFinal pass.`,
      }),
    );
    expect(out.updatedInput.task).toContain(
      `Role: check [finish]\n\n${MARKER}\n# Finish Agent Task`,
    );
    expect(out.updatedInput.task).toContain("PRD FOO CONTENT");
  });

  it("treats [finish] in the body as the finish pass for check", () => {
    const out = parse(
      runHook({
        task: `Active task: ${TASK_REL}\nRole: check\n\n[finish] Final pass.`,
      }),
    );
    expect(out.updatedInput.task).toContain("# Finish Agent Task");
  });

  it("injects research without a task directory", () => {
    const out = parse(runHook({ task: "Role: research\n\nFind the parser." }));
    const task = out.updatedInput.task;
    expect(task.startsWith(`Role: research\n\n${MARKER}\n# Research Agent Task`)).toBe(
      true,
    );
    expect(task).toContain(".arbor/spec/");
    expect(task).toContain("Find the parser.");
  });

  it("preserves Workspace and Target header lines verbatim", () => {
    const out = parse(
      runHook({
        task: `Active task: ${TASK_REL}\nRole: implement\nTarget: star\nWorkspace: /abs/repo-wt/foo-a\n\nGo.`,
      }),
    );
    expect(out.updatedInput.task).toContain(
      `Active task: ${taskDir}\nRole: implement\nTarget: star\nWorkspace: /abs/repo-wt/foo-a\n\n${MARKER}`,
    );
  });

  it("degrades to index lines once the total context budget is exhausted", () => {
    fs.writeFileSync(
      path.join(tmp, ".arbor", "config.yaml"),
      ["context_injection:", "  max_total_bytes: 300"].join("\n") + "\n",
    );
    const entries: string[] = [];
    for (const name of ["a", "b", "c"]) {
      const rel = `.arbor/spec/cli/${name}.md`;
      fs.writeFileSync(path.join(tmp, rel), `${name.toUpperCase()}`.repeat(150));
      entries.push(JSON.stringify({ file: rel, reason: `ref ${name}` }));
    }
    fs.writeFileSync(path.join(taskDir, "implement.jsonl"), entries.join("\n") + "\n");

    const r = runHook({ task: `Active task: ${TASK_REL}\nRole: implement\n\nGo.` });
    const out = parse(r);
    expect(out.updatedInput.task).toContain(
      "[Arbor: not inlined (total context limit reached) — .arbor/spec/cli/",
    );
    expect(r.stderr).toContain("context budget reached");
  });

  it("honours dispatch.hook_decision: ask", () => {
    fs.writeFileSync(
      path.join(tmp, ".arbor", "config.yaml"),
      ["dispatch:", "  hook_decision: ask"].join("\n") + "\n",
    );
    const out = parse(
      runHook({ task: `Active task: ${TASK_REL}\nRole: implement\n\nGo.` }),
    );
    expect(out.permissionDecision).toBe("ask");
  });

  it("ignores other tools and honours the ARBOR_HOOKS kill switch", () => {
    const task = `Active task: ${TASK_REL}\nRole: implement\n\nGo.`;
    expect(runHook({ task }, { toolName: "Agent" }).stdout).toBe("");
    expect(
      runHook({ task }, { toolName: "mcp__codeg-mcp__get_delegation_status" })
        .stdout,
    ).toBe("");
    expect(runHook({ task }, { env: { ARBOR_HOOKS: "0" } }).stdout).toBe("");
    expect(runHook({ task }, { env: { ARBOR_DISABLE_HOOKS: "1" } }).stdout).toBe(
      "",
    );
    // The underscore spelling of the codeg server name matches too.
    expect(
      runHook({ task }, { toolName: "mcp__codeg_mcp__delegate_to_agent" })
        .stdout,
    ).toContain(MARKER);
  });
});
