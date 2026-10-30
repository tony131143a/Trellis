/**
 * Integration tests for the v2 driver path of the per-turn and SessionStart
 * hooks: with an active task they run `.arbor/scripts/arbor.py next --json`
 * and show only its one-line `summary` (plus `needs`); when the driver is
 * absent, fails, or prints something unusable they fall back silently to the
 * static text (workflow.md breadcrumb / static Next-Action).
 *
 * `arbor.py` is a stub written into the temp repo, so these tests pin the
 * hook side of the `next --json` contract without depending on the driver.
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
const SHARED_HOOKS = path.resolve(
  __dirname,
  "../../src/templates/shared-hooks",
);
const TASK = "10-30-foo";
const SESSION_ID = "driver-session";
const CONTEXT_KEY = `claude_${SESSION_ID}`;
const SUMMARY = "BUILD wave 1: write brief for role test, then `arbor run`";

function hasPython(): boolean {
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function cleanEnv(tmp: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("ARBOR_") || key.startsWith("STARFACTORY_")) continue;
    env[key] = value;
  }
  return { ...env, CLAUDE_PROJECT_DIR: tmp };
}

describe.skipIf(!hasPython())("hooks read `arbor.py next --json`", () => {
  let tmp: string;
  let marker: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "arbor-next-hook-"));
    marker = path.join(tmp, "arbor-next-called");
    fs.cpSync(TEMPLATE_SCRIPTS, path.join(tmp, ".arbor", "scripts"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(tmp, ".arbor", "workflow.md"),
      [
        "# Workflow",
        "",
        "## Phase Index",
        "",
        "[workflow-state:no_task]",
        "NO_TASK_BODY",
        "[/workflow-state:no_task]",
        "",
        "[workflow-state:in_progress]",
        "FALLBACK_BODY",
        "[/workflow-state:in_progress]",
        "",
        "## Phase 1: Plan",
        "",
      ].join("\n"),
    );
    const taskDir = path.join(tmp, ".arbor", "tasks", TASK);
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(
      path.join(taskDir, "task.json"),
      JSON.stringify({
        id: TASK,
        title: "Foo",
        status: "in_progress",
        meta: { tier: "light" },
      }),
    );
    fs.writeFileSync(path.join(taskDir, "contract.md"), "# Foo\n\n## Goal\n\nFoo.\n");
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function activate(): void {
    const sessions = path.join(tmp, ".arbor", ".runtime", "sessions");
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(
      path.join(sessions, `${CONTEXT_KEY}.json`),
      JSON.stringify({ current_task: `.arbor/tasks/${TASK}`, platform: "claude" }),
    );
  }

  /** Stub driver: records that it ran (with its argv and context id), then runs `body`. */
  function writeStub(body: string): void {
    fs.writeFileSync(
      path.join(tmp, ".arbor", "scripts", "arbor.py"),
      [
        "import json, os, sys",
        `with open(${JSON.stringify(marker)}, "w") as f:`,
        '    f.write(json.dumps({"argv": sys.argv[1:], "ctx": os.environ.get("ARBOR_CONTEXT_ID")}))',
        body,
        "",
      ].join("\n"),
    );
  }

  function writeJsonStub(payload: Record<string, unknown>): void {
    writeStub(`print(json.dumps(json.loads(${JSON.stringify(JSON.stringify(payload))})))`);
  }

  function runHook(script: string, extra: Record<string, unknown> = {}): string {
    const r = spawnSync("python3", [path.join(SHARED_HOOKS, script)], {
      cwd: tmp,
      encoding: "utf-8",
      input: JSON.stringify({ cwd: tmp, session_id: SESSION_ID, ...extra }),
      env: cleanEnv(tmp),
    });
    expect(r.status, r.stderr).toBe(0);
    return r.stdout;
  }

  function breadcrumb(): string {
    const out = runHook("inject-workflow-state.py", {
      hook_event_name: "UserPromptSubmit",
      prompt: "go on",
    });
    const parsed = JSON.parse(out) as {
      hookSpecificOutput: { additionalContext: string };
    };
    return parsed.hookSpecificOutput.additionalContext;
  }

  function sessionStartStatus(): string {
    const out = runHook("session-start.py", { hook_event_name: "SessionStart" });
    const ctx = (JSON.parse(out) as { hookSpecificOutput: { additionalContext: string } })
      .hookSpecificOutput.additionalContext;
    const match = /<task-status>([\s\S]*?)<\/task-status>/.exec(ctx);
    if (!match) throw new Error("task-status block missing");
    return match[1];
  }

  function stubCall(): { argv: string[]; ctx: string | null } {
    return JSON.parse(fs.readFileSync(marker, "utf-8")) as {
      argv: string[];
      ctx: string | null;
    };
  }

  it("injects only the driver's one-line summary plus needs", () => {
    activate();
    writeJsonStub({ task: TASK, state: "BUILD", needs: "brief", role: "test", summary: SUMMARY });
    const ctx = breadcrumb();
    expect(ctx).toBe(
      [
        "<workflow-state>",
        `Task: ${TASK} (in_progress) · Tier: light`,
        `Next (needs=brief): ${SUMMARY}`,
        "</workflow-state>",
      ].join("\n"),
    );
    expect(ctx).not.toContain("FALLBACK_BODY");
    expect(ctx).not.toContain('"role"');
  });

  it("runs `next --json` with this session's context id", () => {
    activate();
    writeJsonStub({ task: TASK, state: "GATE", needs: "run", summary: "GATE: run the gate" });
    breadcrumb();
    expect(stubCall()).toEqual({ argv: ["next", "--json"], ctx: CONTEXT_KEY });
  });

  it("collapses a multi-line summary onto one line", () => {
    activate();
    writeJsonStub({ task: TASK, state: "STOP", needs: "human", summary: "STOP (BUDGET):\n  review cap reached" });
    expect(breadcrumb()).toContain("Next (needs=human): STOP (BUDGET): review cap reached\n");
  });

  /** The template tree ships the real arbor.py; these cases want none at all. */
  function removeDriver(): void {
    fs.rmSync(path.join(tmp, ".arbor", "scripts", "arbor.py"), { force: true });
  }

  it("falls back to the workflow.md block when arbor.py is absent", () => {
    activate();
    removeDriver();
    const ctx = breadcrumb();
    expect(ctx).toContain("FALLBACK_BODY");
    expect(ctx).not.toContain("Next (needs=");
  });

  it("falls back silently when the driver exits non-zero", () => {
    activate();
    writeStub('print(json.dumps({"task": "x", "state": "BUILD", "needs": "brief", "summary": "s"}))\nsys.exit(1)');
    const ctx = breadcrumb();
    expect(ctx).toContain("FALLBACK_BODY");
    expect(fs.existsSync(marker)).toBe(true);
  });

  it("falls back silently on unusable output", () => {
    activate();
    for (const body of [
      'print("not json")',
      'print(json.dumps(["a"]))',
      'print(json.dumps({"task": "x", "state": "BUILD", "needs": "brief"}))',
      'print(json.dumps({"task": "x", "state": "BUILD", "needs": "", "summary": "s"}))',
      'print(json.dumps({"task": "x", "state": "BUILD", "needs": "brief", "summary": "  "}))',
      'sys.stderr.write("boom")\nraise SystemExit(3)',
    ]) {
      writeStub(body);
      const ctx = breadcrumb();
      expect(ctx, body).toContain("FALLBACK_BODY");
      expect(ctx, body).not.toContain("Next (needs=");
    }
  });

  it("does not call the driver without an active task", () => {
    writeJsonStub({ task: TASK, state: "BUILD", needs: "brief", summary: SUMMARY });
    const ctx = breadcrumb();
    expect(ctx).toContain("NO_TASK_BODY");
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("session-start puts the driver summary into Next-Action", () => {
    activate();
    writeJsonStub({ task: TASK, state: "BUILD", needs: "brief", summary: SUMMARY });
    const status = sessionStartStatus();
    expect(status).toContain("Status: IN_PROGRESS");
    expect(status).toContain(`Next-Action: ${SUMMARY} (needs=brief).`);
    expect(status).toContain("Present: contract.md");
    expect(stubCall().ctx).toBe(CONTEXT_KEY);
  });

  it("session-start falls back to the static driver hint without arbor.py", () => {
    activate();
    removeDriver();
    const status = sessionStartStatus();
    expect(status).toContain("Next-Action: Run `python3 ./.arbor/scripts/arbor.py next`");
    expect(status).not.toContain("prd.md");
  });
});
