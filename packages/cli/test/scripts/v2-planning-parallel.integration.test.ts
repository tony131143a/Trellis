import { afterEach, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { SESSION, TASK, git, hasPython, setupFixture, writeFile, type Fixture } from "./v2-driver-helpers";

const T = ["--task", `.arbor/tasks/${TASK}`];
const EXPLORE = "## Explore Results\nIndependent evidence.\n";
const ARCHITECT = "## Architect: latency\nIndependent design.\n";

describe.skipIf(!hasPython())("parallel planning angles", { timeout: 90_000 }, () => {
  let f: Fixture;
  afterEach(() => f?.cleanup());

  function setup(limit = 3, start = false) {
    f = setupFixture({ start });
    writeFile(f.repo, ".arbor/config.yaml", `executors:\n  default: codeg\n  codeg:\n    type: codeg-mcp\n    assistant: arbor-{role}\n    max_parallel: ${limit}\n    assistant_ids:\n      explore: 2\n      architect: 3\n      review: 6\n`);
  }
  function prepare(id: string, role = "explore") {
    f.brief(id, `Independent ${role} angle ${id}`);
    const result = f.run("--task", f.taskDir, "run", "--role", role, "--dispatch", id);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    return JSON.parse(result.stdout) as { request_path: string; dispatch: string; mcp: { arguments: { task: string } } };
  }
  function collect(request: string, id: string, role = "explore") {
    expect(f.run("bind", "--request", request, "--task-id", id).status).toBe(0);
    const file = path.join(f.tmp, `${id}.json`);
    fs.writeFileSync(file, JSON.stringify({ task_id: id, status: "completed", text: role === "architect" ? ARCHITECT : EXPLORE }));
    const result = f.run("collect", "--request", request, "--result", file);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    return file;
  }
  function asyncRun(id: string, role = "explore") {
    return asyncDriver([...T, "run", "--role", role, "--dispatch", id]);
  }
  function asyncDriver(args: string[]) {
    const child = spawn("python3", [path.join(f.repo, ".arbor/scripts/arbor.py"), ...args], {
      cwd: f.repo, env: { ...process.env, ...SESSION }, stdio: ["ignore", "pipe", "pipe"],
    });
    return new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
      let out = "", err = "";
      child.stdout.on("data", (data: Buffer) => { out += data.toString(); });
      child.stderr.on("data", (data: Buffer) => { err += data.toString(); });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, out, err }));
    });
  }

  it("fans out mixed explore/architect angles and collects out of order without count limits", () => {
    setup(3);
    const before = git(f.repo, "rev-parse", "HEAD");
    const a = prepare("d-001"), b = prepare("d-002", "architect"), c = prepare("d-003");
    for (const p of [a, b, c]) expect(p.mcp.arguments.task).toContain(`/research/${p.dispatch}-`);
    const pending = JSON.parse(f.run(...T, "next", "--json").stdout);
    expect(pending.pending_delegations.map((d: { dispatch: string }) => d.dispatch)).toEqual(["d-001", "d-002", "d-003"]);
    const more = JSON.parse(f.run(...T, "next", "--role", "architect", "--json").stdout);
    expect(more).toMatchObject({ needs: "brief", dispatch: "d-004" });
    expect(more.max_parallel).toBeUndefined();
    f.brief("d-004");
    expect(f.run(...T, "run", "--role", "review", "--dispatch", "d-004").status).toBe(1);
    const start = spawnSync("python3", [".arbor/scripts/task.py", "start", TASK], { cwd: f.repo, env: { ...process.env, ...SESSION }, encoding: "utf8" });
    expect(start.status).toBe(1);
    expect(start.stdout).toContain("collect pending MCP");
    collect(c.request_path, "three");
    expect(JSON.parse(f.run(...T, "next", "--role", "architect", "--json").stdout)).toMatchObject({ needs: "brief", dispatch: "d-004" });
    // More than the former full-tier five-research budget, with two older readers still pending.
    for (let n = 4; n <= 8; n++) {
      const p = prepare(`d-${String(n).padStart(3, "0")}`, n % 2 ? "explore" : "architect");
      collect(p.request_path, `angle-${n}`, n % 2 ? "explore" : "architect");
    }
    collect(b.request_path, "two", "architect");
    const result = collect(a.request_path, "one");
    expect(f.taskJson().dispatches).toHaveLength(8);
    expect(f.taskJson().dispatches.map((d: { status: string }) => d.status)).toEqual(Array(8).fill("ok"));
    expect(f.taskJson().mcp_pending).toEqual({});
    expect(git(f.repo, "rev-parse", "HEAD")).toBe(before);
    expect(f.run("collect", "--request", a.request_path, "--result", result).status).toBe(1);
  });

  it("ignores max_parallel for research while keeping dispatch replay idempotent", () => {
    setup(1);
    const a = prepare("d-001");
    expect(f.run("bind", "--request", a.request_path, "--task-id", "bound-one").status).toBe(0);
    const replay = f.run(...T, "run", "--role", "explore", "--dispatch", "d-001");
    expect(JSON.parse(replay.stdout)).toMatchObject({ task_id: "bound-one", mcp: null, request_path: a.request_path });
    expect(f.run(...T, "run", "--role", "architect", "--dispatch", "d-001").status).toBe(1);
    for (let n = 2; n <= 6; n++) prepare(`d-00${n}`, "architect");
    expect(Object.keys(f.taskJson().mcp_pending)).toHaveLength(6);
    expect(f.run(...T, "run", "--role", "explore", "--dispatch", "../escape").status).toBe(1);
    expect(JSON.parse(f.run(...T, "next", "--role", "explore", "--json").stdout)).toMatchObject({ needs: "brief", dispatch: "d-007" });
  });

  it("allocates simultaneous explicit ids under the task lock without overwriting requests or metadata", async () => {
    setup(1);
    for (const id of ["d-001", "d-002", "d-003"]) f.brief(id);
    const results = await Promise.all([asyncRun("d-003", "architect"), asyncRun("d-001"), asyncRun("d-002")]);
    for (const r of results) expect(r.code, r.out + r.err).toBe(0);
    const requests = results.map(r => JSON.parse(r.out) as { request_path: string; dispatch: string });
    expect(new Set(requests.map(r => r.request_path)).size).toBe(3);
    expect(Object.keys(f.taskJson().mcp_pending).sort()).toEqual(["d-001", "d-002", "d-003"]);
    for (const r of requests) expect(fs.readFileSync(r.request_path, "utf8")).toContain(`Dispatch: ${r.dispatch}`);
    expect(JSON.parse(f.run(...T, "next", "--role", "explore", "--json").stdout).dispatch).toBe("d-004");
  });

  it("two retries of the same id prepare exactly one MCP request", async () => {
    setup(3); f.brief("d-001");
    const results = await Promise.all([asyncRun("d-001"), asyncRun("d-001")]);
    for (const r of results) expect(r.code, r.out + r.err).toBe(0);
    expect(JSON.parse(results[0].out).request_path).toBe(JSON.parse(results[1].out).request_path);
    expect(f.taskJson().dispatches).toHaveLength(1);
  });

  it("does not inject an unfinished sibling's output into another architecture perspective", () => {
    setup(3);
    const a = prepare("d-001");
    writeFile(f.taskDir, "research/d-001-partial.md", "UNFINISHED_SIBLING_EVIDENCE");
    writeFile(f.taskDir, "research/previous.md", "COMPLETED_PREVIOUS_EVIDENCE");
    const b = prepare("d-002", "architect");
    expect(b.mcp.arguments.task).not.toContain("UNFINISHED_SIBLING_EVIDENCE");
    expect(b.mcp.arguments.task).toContain("COMPLETED_PREVIOUS_EVIDENCE");
    collect(a.request_path, "completed");
    const c = prepare("d-003", "architect");
    expect(c.mcp.arguments.task).toContain("UNFINISHED_SIBLING_EVIDENCE");
    expect(fs.readFileSync(path.join(f.taskDir, "research/d-001-partial.md"), "utf8")).toBe("UNFINISHED_SIBLING_EVIDENCE");
  });

  it("also supports parallel replanning in a started task's CONTRACT state", () => {
    setup(3, true);
    expect(f.run("override", "--to", "CONTRACT", "--reason", "replan").status).toBe(0);
    const a = prepare("d-001"), b = prepare("d-002", "architect");
    expect(f.run("resume").status).toBe(1);
    collect(b.request_path, "design", "architect");
    collect(a.request_path, "facts");
    expect(f.taskJson()).toMatchObject({ state: "CONTRACT", mcp_pending: {} });
    expect(f.run("resume").status).toBe(0);
    expect(f.taskJson().state).toBe("BUILD");
  });

  it("command readers run outside the lock and finish without losing sibling records", async () => {
    f = setupFixture({ start: false });
    f.brief("d-001"); f.brief("d-002");
    f.plan({ "d-001": { sleep: 1.5, reply: EXPLORE }, "d-002": { sleep: 0.8, reply: ARCHITECT } });
    const one = asyncRun("d-001"), two = asyncRun("d-002", "architect");
    try {
      const deadline = Date.now() + 5000;
      while ((!fs.existsSync(path.join(f.tmp, "received/d-001.md")) || !fs.existsSync(path.join(f.tmp, "received/d-002.md"))) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      expect(f.taskJson().dispatches.filter((d: { status: string }) => d.status === "running")).toHaveLength(2);
      const start = spawnSync("python3", [".arbor/scripts/task.py", "start", TASK], { cwd: f.repo, env: { ...process.env, ...SESSION }, encoding: "utf8" });
      expect(start.status).toBe(1);
      expect(start.stdout).toContain("finish running planning commands");
    } finally {
      const results = await Promise.all([one, two]);
      for (const r of results) expect(r.code, r.out + r.err).toBe(0);
    }
    expect(f.taskJson().dispatches.map((d: { status: string }) => d.status)).toEqual(["ok", "ok"]);
    expect(f.results()).toHaveLength(2);
  });
  it("collects multiple MCP reports concurrently without dropping a sibling result", async () => {
    setup(3);
    const requests = [prepare("d-001"), prepare("d-002", "architect"), prepare("d-003")];
    const commands = requests.map((p, i) => {
      const id = `reader-${i}`;
      expect(f.run("bind", "--request", p.request_path, "--task-id", id).status).toBe(0);
      const file = path.join(f.tmp, `${id}.json`);
      fs.writeFileSync(file, JSON.stringify({ task_id: id, status: "completed", text: i === 1 ? ARCHITECT : EXPLORE }));
      writeFile(f.taskDir, `research/${p.dispatch}-findings.md`, `Independent output ${i}`);
      return ["collect", "--request", p.request_path, "--result", file];
    });
    const results = await Promise.all(commands.reverse().map(asyncDriver));
    for (const r of results) expect(r.code, r.out + r.err).toBe(0);
    expect(f.taskJson().mcp_pending).toEqual({});
    expect(f.taskJson().dispatches.map((d: { status: string }) => d.status)).toEqual(["ok", "ok", "ok"]);
    expect(new Set(f.results().map((r: { dispatch: string }) => r.dispatch)).size).toBe(3);
    for (const [i, p] of requests.entries()) {
      expect(fs.readFileSync(path.join(f.taskDir, `research/${p.dispatch}-findings.md`), "utf8")).toBe(`Independent output ${i}`);
      expect(fs.existsSync(path.join(f.taskDir, `reports/${p.dispatch}.md`))).toBe(true);
    }
  });

  it("canceling one reader does not cancel siblings or import partial output", () => {
    setup(2);
    const a = prepare("d-001"); prepare("d-002", "architect");
    writeFile(f.taskDir, "research/d-001-aborted.md", "ABORTED_DRAFT");
    expect(f.run("bind", "--request", a.request_path, "--task-id", "canceled-reader").status).toBe(0);
    const file = path.join(f.tmp, "cancel.json");
    fs.writeFileSync(file, JSON.stringify({ task_id: "canceled-reader", status: "canceled", message: "cancel only this angle" }));
    expect(f.run("collect", "--request", a.request_path, "--result", file).status).toBe(1);
    expect(Object.keys(f.taskJson().mcp_pending)).toEqual(["d-002"]);
    expect(f.taskJson().dispatches[0].status).toBe("fail");
    const c = prepare("d-003", "architect");
    expect(c.mcp.arguments.task).not.toContain("ABORTED_DRAFT");
    expect(f.taskJson().stop).toBeUndefined();
  });

});
