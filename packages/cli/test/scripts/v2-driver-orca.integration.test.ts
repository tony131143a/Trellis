/**
 * The Orca worker protocol: `arbor.py run` prepares a request and starts its
 * worker with `orca orchestration worker-start` (the only executor kind);
 * `arbor.py sync` reads the worker's state with `worker-show`, takes the reply
 * from the reply file, validates the writer's commit, the task boundary and
 * the reply, and advances the task.
 */

import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { collectClaudeTemplates } from "../../src/configurators/claude.js";
import { collectCodexTemplates } from "../../src/configurators/codex.js";

import {
  CONTRACT,
  IMPLEMENTED,
  TASK,
  git,
  hasPython,
  orcaCalls,
  orcaState,
  setOrcaState,
  setupFixture,
  writeFile,
  type Fixture,
  type Json,
} from "./v2-driver-helpers";

const T = ["--task", `.arbor/tasks/${TASK}`];
const EXPLORE = "## Explore Results\n\n### Conclusion\nparser ok\n";

it("Claude Code commands and Codex skills both describe the same Orca worker protocol", () => {
  const entries = [
    collectClaudeTemplates().get(".claude/commands/arbor/workflow.md"),
    collectClaudeTemplates().get(".claude/commands/arbor/continue.md"),
    collectCodexTemplates().get(".agents/skills/arbor-workflow/SKILL.md"),
    collectCodexTemplates().get(".agents/skills/arbor-continue/SKILL.md"),
  ];
  for (const content of entries) {
    expect(content).toContain("arbor.py sync");
    expect(content).toContain("Orca");
    expect(content).not.toContain("delegate_to_agent");
    expect(content).not.toContain("codeg");
  }
});

describe.skipIf(!hasPython())("Orca workers", { timeout: 90_000 }, () => {
  let f: Fixture;
  afterEach(() => f?.cleanup());

  function configure(start = false, extra = "", contract?: string) {
    f = setupFixture({ start, contract });
    writeFile(
      f.repo,
      ".arbor/config.yaml",
      `executors:\n  default: orca\n  orca:\n    type: orca\n    command: "python3 ${path.join(f.tmp, "fake_orca.py")}"\n    agent: codex\n    timeout: 90m\n${extra}`,
    );
  }

  /** CONTRACT phase: brief d-001 and start its explore worker. */
  function prepare(): Json {
    f.brief("d-001", "Inspect the parser without editing product files.");
    const r = f.run(...T, "run", "--role", "explore");
    expect(r.status, r.stdout + r.stderr).toBe(0);
    return JSON.parse(r.stdout);
  }

  /** The `worker-start` calls the driver made, as flag maps. */
  function starts(): Record<string, string>[] {
    return orcaCalls(f)
      .filter((argv) => argv[1] === "worker-start")
      .map((argv) => {
        const flags: Record<string, string> = {};
        for (let i = 2; i < argv.length; i++)
          if (argv[i].startsWith("--"))
            flags[argv[i]] = argv[i + 1]?.startsWith("--")
              ? ""
              : (argv[i + 1] ?? "");
        return flags;
      });
  }

  /** Settle a worker in the fake Orca (with its reply), then sync. */
  function settle(
    p: Json,
    status: "completed" | "failed",
    reply?: string,
    lastReport?: string,
    args: string[] = T,
  ) {
    if (reply !== undefined) fs.writeFileSync(p.reply_path, reply);
    setOrcaState(f, p.orca_dispatch, {
      dispatch: { id: p.orca_dispatch, status },
      lastReport,
    });
    return f.run(...args, "sync");
  }

  it("starts a worker from a spec that points at the prompt and the reply file, persists across processes and collects it once", () => {
    configure();
    const head = git(f.repo, "rev-parse", "HEAD");
    const p = prepare();
    expect(p).toMatchObject({
      needs: "worker",
      dispatch: "d-001",
      role: "explore",
      orca_dispatch: "orca-d-001",
    });
    const [start] = starts();
    expect(start).toMatchObject({
      "--worktree": `path:${f.repo}`,
      "--agent": "codex",
      "--task-title": `${TASK} d-001 explore`,
    });
    expect(start["--keep-open"]).toBeUndefined();
    const spec = fs.readFileSync(start["--spec-file"], "utf-8");
    expect(spec).toContain(
      `Active task: ${f.taskDir}\nRole: explore\nDispatch: d-001`,
    );
    expect(spec).toContain(`Prompt: ${p.prompt_path}`);
    expect(spec).toContain(`Report: ${p.reply_path}`);
    expect(spec).toContain("worker_done");
    expect(spec).not.toContain("Inspect the parser");
    expect(fs.readFileSync(p.prompt_path, "utf-8")).toContain(
      "Inspect the parser",
    );
    expect(p.reply_path).toBe(
      path.join(f.repo, ".arbor/.runtime/replies", TASK, "d-001.md"),
    );
    expect(fs.readFileSync(p.reply_path, "utf-8")).toBe("");
    expect(JSON.parse(f.run(...T, "next", "--json").stdout)).toMatchObject({
      needs: "worker",
      dispatch: "d-001",
      orca_dispatch: "orca-d-001",
    });

    // a second run of the same dispatch reports the running worker, it starts nothing
    const again = JSON.parse(f.run(...T, "run", "--role", "explore").stdout);
    expect(again).toMatchObject({ orca_dispatch: "orca-d-001" });
    expect(starts()).toHaveLength(1);

    const running = f.run(...T, "sync");
    expect(running.status, running.stdout + running.stderr).toBe(0);
    expect(running.stdout).toContain(
      "d-001 explore: running (orca dispatch orca-d-001)",
    );
    expect(f.taskJson().dispatches[0].status).toBe("running");

    const r = settle(p, "completed", EXPLORE);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("d-001 explore: ok");
    expect(f.taskJson().dispatches).toMatchObject([
      { id: "d-001", status: "ok", phase: "CONTRACT" },
    ]);
    expect(f.taskJson().workers).toEqual({});
    expect(f.results()[0]).toMatchObject({
      executor: "orca",
      status: "ok",
      dispatch: "d-001",
    });
    expect(JSON.parse(fs.readFileSync(p.request_path, "utf-8"))).toMatchObject({
      status: "collected",
      orca: { dispatch_id: "orca-d-001", agent: "codex" },
    });
    expect(git(f.repo, "rev-parse", "HEAD")).toBe(head);
    expect(f.run(...T, "sync").stdout).toContain("no pending worker");
  });

  it("refuses a planning dispatch without a task: there is no stdin intake", () => {
    configure();
    const r = f.run("run", "--role", "explore");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("no active task");
    expect(fs.existsSync(path.join(f.repo, ".arbor/.runtime/workers"))).toBe(
      false,
    );
    expect(f.run("canary").status).toBe(2);
    expect(f.run("bind").status).toBe(2);
    expect(f.run("collect").status).toBe(2);
  });

  it("leaves a worker alone while it runs or waits for a person, and does not guess when Orca cannot show it", () => {
    configure();
    const p = prepare();
    setOrcaState(f, p.orca_dispatch, {
      observation: { agentWait: { source: "hook", reason: "permission" } },
    });
    const waiting = f.run(...T, "sync", "--wait", "30s");
    expect(waiting.status, waiting.stdout + waiting.stderr).toBe(0);
    expect(waiting.stdout).toContain(
      "d-001 explore: waiting for a person (permission)",
    );
    fs.rmSync(orcaState(f, p.orca_dispatch));
    const unknown = f.run(...T, "sync");
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain("worker-show orca-d-001");
    expect(f.taskJson().dispatches[0].status).toBe("running");
    expect(f.taskJson().workers["d-001"]).toBe(p.request_path);
  });

  it("a worker that reports done without a reply waits for the main agent's judgment", () => {
    configure();
    const p = prepare();
    const r = settle(p, "completed", undefined, "explored the parser");
    expect(r.stdout).toContain(`d-001 explore: no reply in ${p.reply_path}`);
    expect(r.stdout).toContain("worker_done said: explored the parser");
    expect(r.stdout).toContain(
      "orca orchestration worker-read --dispatch orca-d-001",
    );
    expect(f.taskJson().dispatches[0].status).toBe("judgment");
    expect(f.taskJson().workers).toEqual({});
  });

  it("collects planning for A while B creates task files and commits on the shared main branch", () => {
    configure();
    const p = prepare();
    writeFile(
      f.repo,
      ".arbor/tasks/task-b/task.json",
      '{"status":"planning"}\n',
    );
    writeFile(f.repo, "b.txt", "B's work\n");
    git(f.repo, "add", "b.txt");
    git(
      f.repo,
      "commit",
      "-qm",
      "implement(task-b): work\n\nArbor-Dispatch: d-001",
    );
    const bHead = git(f.repo, "rev-parse", "HEAD");
    const r = settle(p, "completed", EXPLORE);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(f.taskJson().dispatches[0]).toMatchObject({
      status: "ok",
      phase: "CONTRACT",
    });
    expect(git(f.repo, "rev-parse", "HEAD")).toBe(bHead);
    expect(
      fs.existsSync(path.join(f.repo, ".arbor/tasks/task-b/task.json")),
    ).toBe(true);
  });

  it("collects A after B edits its own worktree, merges, updates remote refs and cleans up", () => {
    configure(true);
    f.brief("d-001");
    const p = JSON.parse(f.run("run").stdout);
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

    for (const file of IMPLEMENTED) {
      writeFile(f.wt, file.path, file.content);
      git(f.wt, "add", file.path);
    }
    git(
      f.wt,
      "commit",
      "-qm",
      `implement(${TASK}): work\n\nArbor-Dispatch: d-001`,
    );
    const r = settle(p, "completed", "## Implementation Complete\n", "done", []);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(f.next()).toMatchObject({ state: "GATE", needs: "run" });
    expect(git(f.repo, "rev-parse", "HEAD")).toBe(mainHead);
    expect(fs.readFileSync(path.join(f.repo, "b.txt"), "utf8")).toBe(
      "B's work\n",
    );
    expect(fs.existsSync(path.join(f.wt, "b.txt"))).toBe(false);
  });

  it("a worker that reports failed, or exits without worker_done, is a failed dispatch with its diagnostics", () => {
    configure();
    const p = prepare();
    const r = settle(p, "failed", undefined, "user canceled");
    expect(r.status).toBe(1);
    expect(f.taskJson().dispatches[0].status).toBe("fail");
    expect(
      fs.readFileSync(path.join(f.taskDir, "reports/d-001.md"), "utf-8"),
    ).toContain("user canceled");
    expect(f.taskJson().workers).toEqual({});

    f.brief("d-002", "Second angle.");
    const q = JSON.parse(
      f.run(...T, "run", "--role", "explore", "--dispatch", "d-002").stdout,
    );
    setOrcaState(f, q.orca_dispatch, {
      projection: { liveness: { verdict: "exited" } },
    });
    expect(f.run(...T, "sync").status).toBe(1);
    expect(
      fs.readFileSync(path.join(f.taskDir, "reports/d-002.md"), "utf-8"),
    ).toContain("exited without worker_done");
  });

  it("stops a worker that ran past the executor timeout and fails its dispatch", () => {
    configure(false, "");
    writeFile(
      f.repo,
      ".arbor/config.yaml",
      fs
        .readFileSync(path.join(f.repo, ".arbor/config.yaml"), "utf-8")
        .replace("timeout: 90m", "timeout: 1s"),
    );
    const p = prepare();
    spawnSync("sleep", ["1.2"]);
    const r = f.run(...T, "sync");
    expect(r.status).toBe(1);
    expect(
      orcaCalls(f).some(
        (argv) => argv[1] === "worker-stop" && argv.includes(p.orca_dispatch),
      ),
    ).toBe(true);
    expect(
      fs.readFileSync(path.join(f.taskDir, "reports/d-001.md"), "utf-8"),
    ).toContain("timeout after 1s");
  });

  it("starts each role as its configured agent, in the task worktree, and keeps commit validation in the driver", () => {
    configure(
      true,
      "    keep_open: true\n    roles:\n      implement:\n        agent: omp\n",
    );
    f.brief("d-001");
    const p = JSON.parse(f.run("run").stdout);
    expect(starts()[0]).toMatchObject({
      "--worktree": `path:${f.wt}`,
      "--agent": "omp",
      "--keep-open": "",
    });
    f.plan({ "d-001": { write: IMPLEMENTED } });
    const child = spawnSync(
      "python3",
      [
        path.join(f.tmp, "fake_exec.py"),
        "implement",
        p.prompt_path,
        f.wt,
        TASK,
        "d-001",
      ],
      { encoding: "utf-8" },
    );
    expect(child.status, child.stderr).toBe(0);
    const r = settle(p, "completed", child.stdout, "done", []);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("d-001 implement: ok");
    expect(f.next()).toMatchObject({ state: "GATE", needs: "run" });
    expect(f.taskJson().dispatches[0]).toMatchObject({
      status: "ok",
      role: "implement",
      observations: [],
    });
    expect(git(f.wt, "status", "--porcelain")).toBe("");
  });

  it("preserves a writer without a commit and records its stray files for judgment", () => {
    configure(true);
    f.brief("d-001");
    const p = JSON.parse(f.run("run").stdout);
    writeFile(f.wt, "wrong.txt", "stray");
    const r = settle(p, "completed", "## Implementation Complete\n", "done", []);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(f.taskJson().dispatches[0].status).toBe("judgment");
    expect(f.taskJson().report_pending).toHaveProperty("d-001");
    expect(f.taskJson().dispatches[0].observations.join("\n")).toContain(
      "produced no new commit",
    );
    expect(fs.readFileSync(path.join(f.wt, "wrong.txt"), "utf-8")).toBe(
      "stray",
    );
  });

  it("records a failed start as a failed dispatch and allows a new one", () => {
    configure();
    f.plan({
      "d-001": {
        start: {
          state: "failed",
          failedStage: "agent_readiness",
          lastError: "agent unavailable",
        },
      },
    });
    f.brief("d-001", "Inspect the parser.");
    const r = f.run(...T, "run", "--role", "explore");
    expect(r.status).toBe(1);
    expect(f.taskJson().workers).toEqual({});
    const report = fs.readFileSync(
      path.join(f.taskDir, "reports/d-001.md"),
      "utf-8",
    );
    expect(report).toContain(
      "worker-start failed at agent_readiness: agent unavailable",
    );
    expect(report).toContain("worker-show --dispatch orca-d-001");
    expect(JSON.parse(f.run(...T, "next", "--json").stdout)).toMatchObject({
      dispatch: "d-002",
    });
  });

  it("keeps a prepared request when the Orca CLI is missing and starts it on the next run", () => {
    configure();
    const config = path.join(f.repo, ".arbor/config.yaml");
    const good = fs.readFileSync(config, "utf-8");
    fs.writeFileSync(
      config,
      good.replace(/command: .*/, "command: no-such-orca-cli"),
    );
    f.brief("d-001", "Inspect the parser.");
    const missing = f.run(...T, "run", "--role", "explore");
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("Orca CLI not found");
    const next = JSON.parse(f.run(...T, "next", "--json").stdout);
    expect(next).toMatchObject({
      needs: "worker",
      dispatch: "d-001",
      orca_dispatch: null,
    });
    expect(next.summary).toContain("not started");
    expect(f.run(...T, "sync").stdout).toContain("d-001 explore: not started");

    fs.writeFileSync(config, good);
    const started = f.run(...T, "run", "--role", "explore");
    expect(started.status, started.stdout + started.stderr).toBe(0);
    expect(JSON.parse(started.stdout)).toMatchObject({
      dispatch: "d-001",
      orca_dispatch: "orca-d-001",
    });
    expect(starts()).toHaveLength(1);
  });

  it("blocks task start and state overrides until the worker has been collected", () => {
    configure();
    prepare();
    const start = spawnSync(
      "python3",
      [".arbor/scripts/task.py", "start", TASK],
      { cwd: f.repo, encoding: "utf-8" },
    );
    expect(start.status).toBe(1);
    expect(start.stdout).toContain("the pending workers");
    f.cleanup();
    configure(true);
    f.brief("d-001");
    expect(f.run("run").status).toBe(0);
    expect(
      f.run("override", "--to", "GATE", "--reason", "test").stderr,
    ).toContain("a worker is pending");
    expect(f.run("gate").stderr).toContain("a worker is pending");
  });

  it("runs partition workers side by side, each in its own child workspace", () => {
    const contract =
      CONTRACT +
      "\n## Partitions\n\n- a: src/**\n- b: tests/**\n\n## Waves\n\n- 1: [a, b]\n";
    configure(true, "", contract);
    expect(f.run("run").status).toBe(0);
    const wtA = path.join(f.tmp, "proj-wt", `${TASK}-a`);
    expect(
      orcaCalls(f).filter((argv) => argv.slice(0, 2).join(" ") === "worktree set"),
    ).toContainEqual([
      "worktree",
      "set",
      "--worktree",
      `path:${wtA}`,
      "--parent-worktree",
      `path:${f.wt}`,
      "--display-name",
      `${TASK}/a`,
    ]);
    f.brief("d-001");
    f.brief("d-002");
    const a = f.run("run", "--partition", "a");
    expect(a.status, a.stdout + a.stderr).toBe(0);
    expect(starts()[0]["--worktree"]).toBe(`path:${wtA}`);
    expect(
      JSON.parse(f.run("next", "--json", "--partition", "a").stdout),
    ).toMatchObject({ needs: "worker", dispatch: "d-001" });
    const b = f.run("run", "--partition", "b");
    expect(b.status, b.stdout + b.stderr).toBe(0);
    expect(f.taskJson().partitions.a.running).toMatchObject({
      dispatch: "d-001",
      external: true,
    });
    expect(Object.keys(f.taskJson().workers)).toEqual(["d-001", "d-002"]);
    expect(f.next().running).toMatchObject([
      { dispatch: "d-001", kind: "worker", orca_dispatch: "orca-d-001" },
      { dispatch: "d-002", kind: "worker", orca_dispatch: "orca-d-002" },
    ]);
  });

  it("autopilot starts the worker and stops until it is collected", () => {
    configure(true);
    f.brief("d-001");
    const r = f.run("run", "--autopilot");
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("stop, needs worker");
    expect(starts()).toHaveLength(1);
    expect(f.next()).toMatchObject({ needs: "worker", dispatch: "d-001" });
  });
});
