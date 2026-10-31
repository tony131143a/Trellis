import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { collectClaudeTemplates } from "../../src/configurators/claude.js";
import { collectCodexTemplates } from "../../src/configurators/codex.js";

import { CONTRACT, TASK, git, hasPython, setupFixture, writeFile, type Fixture } from "./v2-driver-helpers";

const T = ["--task", `.arbor/tasks/${TASK}`];
const EXPLORE = "## Explore Results\n\n### Conclusion\ncanary ok\n";

it("Claude Code commands and Codex skills both require the same codeg MCP protocol", () => {
  const entries = [
    collectClaudeTemplates().get(".claude/commands/arbor/workflow.md"),
    collectClaudeTemplates().get(".claude/commands/arbor/continue.md"),
    collectCodexTemplates().get(".agents/skills/arbor-workflow/SKILL.md"),
    collectCodexTemplates().get(".agents/skills/arbor-continue/SKILL.md"),
  ];
  for (const content of entries) {
    expect(content).toContain("delegate_to_agent");
    expect(content).toContain("get_delegation_status");
    expect(content).toContain("arbor.py bind --request");
    expect(content).toContain("arbor.py collect --request");
  }
});

describe.skipIf(!hasPython())("codeg MCP handoff", { timeout: 90_000 }, () => {
  let f: Fixture;
  afterEach(() => f?.cleanup());

  function configure(start = false, target = "    assistant_ids:\n      explore: 2\n      test: 4\n", contract?: string) {
    f = setupFixture({ start, contract });
    writeFile(f.repo, ".arbor/config.yaml", `executors:\n  default: codeg\n  codeg:\n    type: codeg-mcp\n    assistant: arbor-{role}\n    timeout: 90m\n${target}`);
  }

  function prepare() {
    f.brief("d-001", "Inspect the parser without editing product files.");
    const r = f.run(...T, "run", "--role", "explore");
    expect(r.status, r.stdout + r.stderr).toBe(0);
    return JSON.parse(r.stdout);
  }

  function bind(request: string) {
    const r = f.run("bind", "--request", request, "--task-id", "codeg-task-1");
    expect(r.status, r.stdout + r.stderr).toBe(0);
  }

  function collect(request: string, report: object) {
    const file = path.join(f.tmp, "mcp-result.json");
    fs.writeFileSync(file, JSON.stringify(report));
    return f.run("collect", "--request", request, "--result", file);
  }

  it("prepares a full prompt, persists across processes, binds and accepts a terminal MCP report once", () => {
    configure();
    const head = git(f.repo, "rev-parse", "HEAD");
    const p = prepare();
    expect(p).toMatchObject({ needs: "delegation", dispatch: "d-001", mcp: { tool: "delegate_to_agent", arguments: { assistant_id: 2, working_dir: f.repo } } });
    expect(p.mcp.arguments.task).toContain(`Active task: ${f.taskDir}\nRole: explore\nDispatch: d-001`);
    expect(p.mcp.arguments.task).toContain("Inspect the parser");
    expect(path.isAbsolute(p.result_path)).toBe(true);
    expect(p.result_path.startsWith(f.repo + path.sep)).toBe(false);
    expect(fs.existsSync(path.join(f.tmp, "received"))).toBe(false);
    expect(JSON.parse(f.run(...T, "next", "--json").stdout)).toMatchObject({ needs: "delegation", dispatch: "d-001" });
    bind(p.request_path);
    const again = JSON.parse(f.run(...T, "run", "--role", "explore").stdout);
    expect(again).toMatchObject({ task_id: "codeg-task-1", mcp: null });
    const report = { tasks: [{ task_id: "codeg-task-1", status: "completed", text: EXPLORE, child_conversation_id: 42 }] };
    const r = collect(p.request_path, { structuredContent: report });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(f.taskJson().dispatches).toMatchObject([{ id: "d-001", status: "ok", phase: "CONTRACT" }]);
    expect(f.taskJson().mcp_pending).toEqual({});
    expect(f.results()[0]).toMatchObject({ executor: "codeg", status: "ok", dispatch: "d-001" });
    expect(git(f.repo, "rev-parse", "HEAD")).toBe(head);
    expect(collect(p.request_path, report).status).toBe(1);
  });

  it("refuses unbound, wrong, running, unknown and truncated reports without advancing", () => {
    configure();
    const p = prepare();
    const terminal = { task_id: "codeg-task-1", status: "completed", text: EXPLORE };
    expect(collect(p.request_path, terminal).stderr).toContain("bind the codeg task_id");
    bind(p.request_path);
    expect(f.run("bind", "--request", p.request_path, "--task-id", "other").status).toBe(1);
    for (const report of [
      { ...terminal, task_id: "other" },
      { ...terminal, status: "running" },
      { ...terminal, status: "unknown" },
      { ...terminal, truncated: true },
      { ...terminal, text: "" },
    ]) expect(collect(p.request_path, report).status).toBe(1);
    expect(f.taskJson().dispatches[0].status).toBe("running");
    expect(f.taskJson().mcp_pending["d-001"]).toBe(p.request_path);
  });

  it("collects planning for A while B creates task files and commits on the shared main branch", () => {
    configure();
    const p = prepare();
    bind(p.request_path);
    writeFile(f.repo, ".arbor/tasks/task-b/task.json", '{"status":"planning"}\n');
    writeFile(f.repo, "b.txt", "B's work\n");
    git(f.repo, "add", "b.txt");
    git(f.repo, "commit", "-qm", "implement(task-b): work\n\nArbor-Dispatch: d-001");
    const bHead = git(f.repo, "rev-parse", "HEAD");
    const r = collect(p.request_path, { task_id: "codeg-task-1", status: "completed", text: EXPLORE });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(f.taskJson().dispatches[0]).toMatchObject({ status: "ok", phase: "CONTRACT" });
    expect(git(f.repo, "rev-parse", "HEAD")).toBe(bHead);
    expect(fs.existsSync(path.join(f.repo, ".arbor/tasks/task-b/task.json"))).toBe(true);
  });

  it("collects A after B edits its own worktree, merges, updates remote refs and cleans up", () => {
    configure(true);
    f.brief("d-001");
    const p = JSON.parse(f.run("run").stdout);
    bind(p.request_path);
    const b = path.join(f.tmp, "task-b");
    git(f.repo, "worktree", "add", "-qb", "feature/task-b", b);
    writeFile(b, "b.txt", "B's work\n");
    git(b, "add", "b.txt");
    git(b, "commit", "-qm", "implement(task-b): work\n\nArbor-Dispatch: d-001");
    git(f.repo, "merge", "--no-ff", "-qm", "Merge B", "feature/task-b");
    git(f.repo, "update-ref", "refs/remotes/origin/main", "HEAD");
    git(f.repo, "worktree", "remove", b);
    git(f.repo, "branch", "-d", "feature/task-b");
    const mainHead = git(f.repo, "rev-parse", "HEAD");

    writeFile(f.wt, "tests/ac1.sh", "test -f src/feature.txt\n");
    git(f.wt, "add", "tests/ac1.sh");
    git(f.wt, "commit", "-qm", `test(${TASK}): red\n\nArbor-Dispatch: d-001`);
    const r = collect(p.request_path, { task_id: "codeg-task-1", status: "completed", text: "## Tests Written\n" });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(f.next()).toMatchObject({ state: "BUILD", role: "implement" });
    expect(git(f.repo, "rev-parse", "HEAD")).toBe(mainHead);
    expect(fs.readFileSync(path.join(f.repo, "b.txt"), "utf8")).toBe("B's work\n");
    expect(fs.existsSync(path.join(f.wt, "b.txt"))).toBe(false);
  });

  it.each([false, true])("planning canary checks its task boundary (current task changed: %s)", (ownTask) => {
    configure();
    const prepared = f.run(...T, "canary");
    expect(prepared.status, prepared.stdout + prepared.stderr).toBe(0);
    const p = JSON.parse(prepared.stdout);
    bind(p.request_path);
    if (ownTask) {
      writeFile(f.taskDir, "research/unexpected.md", "canary must not write here\n");
    } else {
      writeFile(f.repo, ".arbor/tasks/task-b/task.json", '{"status":"planning"}\n');
      writeFile(f.repo, "b.txt", "B's work\n");
      git(f.repo, "add", "b.txt");
      git(f.repo, "commit", "-qm", "implement(task-b): work\n\nArbor-Dispatch: d-001");
    }
    const r = collect(p.request_path, { task_id: "codeg-task-1", status: "completed", text: EXPLORE });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(f.taskJson().mcp_pending).toEqual({});
    if (ownTask) expect(r.stderr).toContain("worktree changes observed");
  });

  it("accepts failure/cancel terminal reports as failed dispatches and retains their diagnostics", () => {
    configure();
    const p = prepare();
    bind(p.request_path);
    const r = collect(p.request_path, { tasks: [{ task_id: "codeg-task-1", status: "canceled", message: "user canceled" }] });
    expect(r.status).toBe(1);
    expect(f.taskJson().dispatches[0].status).toBe("fail");
    expect(fs.readFileSync(path.join(f.taskDir, "reports/d-001.md"), "utf-8")).toContain("user canceled");
    expect(f.taskJson().mcp_pending).toEqual({});
  });

  it("keeps writer commit, capability and red-check validation in the driver", () => {
    configure(true);
    f.brief("d-001");
    const p = JSON.parse(f.run("run").stdout);
    expect(p.mcp.arguments).toMatchObject({ assistant_id: 4, working_dir: f.wt });
    bind(p.request_path);
    const prompt = path.join(f.tmp, "prompt.md");
    fs.writeFileSync(prompt, p.mcp.arguments.task);
    f.plan({ "d-001": { write: [{ path: "tests/ac1.sh", content: "test -f src/feature.txt\n" }] } });
    const child = spawnSync("python3", [path.join(f.tmp, "fake_exec.py"), "test", prompt, f.wt, TASK, "d-001"], { encoding: "utf-8" });
    expect(child.status, child.stderr).toBe(0);
    const r = collect(p.request_path, { task_id: "codeg-task-1", status: "completed", text: child.stdout });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(f.next()).toMatchObject({ state: "BUILD", role: "implement", dispatch: "d-002" });
    expect(f.taskJson().dispatches[0]).toMatchObject({ status: "ok", role: "test" });
    expect(git(f.wt, "status", "--porcelain")).toBe("");
  });

  it("preserves a writer without a commit and records its stray files for judgment", () => {
    configure(true);
    f.brief("d-001");
    const p = JSON.parse(f.run("run").stdout);
    bind(p.request_path);
    writeFile(f.wt, "wrong.txt", "stray");
    const r = collect(p.request_path, { task_id: "codeg-task-1", status: "completed", text: "## Tests Written\n" });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(f.taskJson().dispatches[0].status).toBe("ok");
    expect(f.taskJson().dispatches[0].observations.join("\n")).toContain("produced no new commit");
    expect(fs.readFileSync(path.join(f.wt, "wrong.txt"), "utf-8")).toBe("stray");
  });

  it("supports a no-task canary and resolves portable assistant names without a local id", () => {
    configure(false, "");
    const r = f.run("canary");
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const p = JSON.parse(r.stdout);
    expect(p.mcp).toMatchObject({ target: { assistant_name: "arbor-explore" }, arguments: { working_dir: f.repo } });
    expect(p.mcp.arguments.assistant_id).toBeUndefined();
    expect(JSON.parse(f.run("next", "--json").stdout)).toMatchObject({ needs: "delegation", dispatch: p.dispatch });
    bind(p.request_path);
    const done = collect(p.request_path, { content: [{ type: "text", text: JSON.stringify({ tasks: [{ task_id: "codeg-task-1", status: "completed", text: EXPLORE }] }) }] });
    expect(done.status, done.stdout + done.stderr).toBe(0);
    expect(f.results()[0]).toMatchObject({ dispatch: "canary", status: "ok" });
  });

  it("records setup failure without a task id and allows a new dispatch", () => {
    configure();
    const p = prepare();
    const done = collect(p.request_path, { structuredContent: { status: "failed", error_code: "spawn_failed", message: "agent unavailable" } });
    expect(done.status).toBe(1);
    expect(f.taskJson().mcp_pending).toEqual({});
    expect(JSON.parse(f.run(...T, "next", "--json").stdout)).toMatchObject({ dispatch: "d-002" });
  });

  it("blocks task start and state overrides until the delegated task has been collected", () => {
    configure();
    prepare();
    const start = spawnSync("python3", [".arbor/scripts/task.py", "start", TASK], { cwd: f.repo, encoding: "utf-8" });
    expect(start.status).toBe(1);
    expect(start.stdout).toContain("collect pending MCP delegations");
    f.cleanup();
    configure(true);
    f.brief("d-001");
    expect(f.run("run").status).toBe(0);
    expect(f.run("override", "--to", "GATE", "--reason", "test").stderr).toContain("MCP dispatch is pending");
    expect(f.run("gate").stderr).toContain("MCP dispatch is pending");
  });

  it("retains partition dispatches after prepare exits and permits independent MCP fan-out", () => {
    const contract = CONTRACT + "\n## Partitions\n\n- a: src/**\n- b: tests/**\n\n## Waves\n\n- 1: [a, b]\n";
    configure(true, "", contract);
    expect(f.run("run").status).toBe(0);
    f.brief("d-001");
    f.brief("d-002");
    const a = f.run("run", "--partition", "a");
    expect(a.status, a.stdout + a.stderr).toBe(0);
    const p = JSON.parse(a.stdout);
    expect(p.mcp.arguments.working_dir).toBe(path.join(f.tmp, "proj-wt", `${TASK}-a`));
    expect(JSON.parse(f.run("next", "--json", "--partition", "a").stdout)).toMatchObject({ needs: "delegation", dispatch: "d-001" });
    const b = f.run("run", "--partition", "b");
    expect(b.status, b.stdout + b.stderr).toBe(0);
    expect(f.taskJson().partitions.a.running).toMatchObject({ dispatch: "d-001", external: true });
    expect(Object.keys(f.taskJson().mcp_pending)).toEqual(["d-001", "d-002"]);
  });

  it("autopilot exposes the MCP request and stops until the host collects it", () => {
    configure(true);
    f.brief("d-001");
    const r = f.run("run", "--autopilot");
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("hand off to codeg MCP");
    expect(r.stdout).toContain('"needs": "delegation"');
    expect(f.next()).toMatchObject({ needs: "delegation", dispatch: "d-001" });
  });
});
