/**
 * The Orca worker protocol: `arbor.py run` prepares a request and starts its
 * worker with `orca orchestration worker-start` (the only executor kind);
 * `arbor.py sync` reads the worker's state with `worker-show`, takes the reply
 * from the reply file, validates the writer's commit, the task boundary and
 * the reply, and advances the task. Every worker of a task starts in the
 * task's Orca Run with its own request id; a failed start stays prepared and
 * is retried on the same Orca Task. Orca also creates every worktree
 * (`worktree create --parent-worktree`).
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

  /** Settle a worker in the fake Orca (with its reply and `dispatch` fields), then sync. */
  function settle(
    p: Json,
    status: "completed" | "failed",
    reply?: string,
    args: string[] = T,
    dispatch: Json = {},
  ) {
    if (reply !== undefined) fs.writeFileSync(p.reply_path, reply);
    setOrcaState(f, p.orca_dispatch, {
      dispatch: { id: p.orca_dispatch, status, ...dispatch },
    });
    return f.run(...args, "sync");
  }

  /** The request record of an envelope. */
  function record(p: Json): Json {
    return JSON.parse(fs.readFileSync(p.request_path, "utf-8"));
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
    expect(r.stdout).not.toContain("no reply in");
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
    const r = settle(p, "completed");
    expect(r.stdout).toContain(`d-001 explore: no reply in ${p.reply_path}`);
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
    const r = settle(p, "completed", "## Implementation Complete\n", []);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(f.next()).toMatchObject({ state: "GATE", needs: "run" });
    expect(git(f.repo, "rev-parse", "HEAD")).toBe(mainHead);
    expect(fs.readFileSync(path.join(f.repo, "b.txt"), "utf8")).toBe(
      "B's work\n",
    );
    expect(fs.existsSync(path.join(f.wt, "b.txt"))).toBe(false);
  });

  it("a worker that settles failed without a report, or exits without worker_done, is a failed dispatch with Orca's reason", () => {
    configure();
    const p = prepare();
    const r = settle(p, "failed", undefined, T, {
      lastFailure: JSON.stringify({
        subject: "user canceled",
        body: "stopped from the Orca tab",
      }),
    });
    expect(r.status).toBe(1);
    expect(f.taskJson().dispatches[0].status).toBe("fail");
    expect(
      fs.readFileSync(path.join(f.taskDir, "reports/d-001.md"), "utf-8"),
    ).toContain("the worker settled as failed: user canceled");
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
    const r = settle(p, "completed", child.stdout, []);
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
    const r = settle(p, "completed", "## Implementation Complete\n", []);
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

  const FAILED_START = {
    state: "failed",
    failedStage: "agent_readiness",
    lastError: "agent unavailable",
  };
  const START_ERROR = "worker-start failed at agent_readiness: agent unavailable";

  it("a failed start stays prepared; the retry releases it and starts again on the same Orca Task", () => {
    configure();
    f.plan({ "d-001": { starts: [FAILED_START, {}] } });
    f.brief("d-001", "Inspect the parser.");
    const r = f.run(...T, "run", "--role", "explore");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`d-001 explore: ${START_ERROR}`);
    const p = JSON.parse(r.stdout);
    expect(p).toMatchObject({
      needs: "worker",
      dispatch: "d-001",
      orca_dispatch: null,
    });
    expect(p.instructions).toContain(`The last start failed (${START_ERROR})`);
    expect(p.instructions).toContain("`arbor.py run --dispatch d-001`");
    const failed = record(p);
    expect(failed).toMatchObject({
      status: "pending",
      orca: null,
      failed_starts: [
        { dispatch_id: "orca-d-001", task_id: "task-d-001", error: START_ERROR },
      ],
    });
    expect(failed.launcher).toBeUndefined();
    // the next start is a new request, not a replay of the failed answer
    expect(failed.request_id).not.toBe(starts()[0]["--retry-request"]);
    expect(f.taskJson().workers).toHaveProperty("d-001");
    expect(f.taskJson().dispatches[0].status).toBe("running");
    expect(fs.existsSync(path.join(f.taskDir, "reports/d-001.md"))).toBe(false);
    expect(f.run(...T, "sync").stdout).toContain("d-001 explore: not started");

    const again = f.run(...T, "run", "--dispatch", "d-001", "--role", "explore");
    expect(again.status, again.stdout + again.stderr).toBe(0);
    expect(JSON.parse(again.stdout)).toMatchObject({
      dispatch: "d-001",
      orca_dispatch: "orca-d-001-r1",
    });
    const names = orcaCalls(f).map((argv) => argv.slice(0, 2).join(" "));
    expect(names).toEqual([
      "orchestration run-create",
      "orchestration worker-start",
      "orchestration worker-release",
      "orchestration worker-start",
    ]);
    expect(
      orcaCalls(f).find((argv) => argv[1] === "worker-release"),
    ).toEqual(["orchestration", "worker-release", "--dispatch", "orca-d-001"]);
    const retry = starts()[1];
    expect(retry).toMatchObject({
      "--task": "task-d-001",
      "--retry-of": "orca-d-001",
      "--run": "run-1",
      "--retry-request": failed.request_id,
      "--agent": "codex",
    });
    expect(retry["--spec-file"]).toBeUndefined();
    expect(retry["--task-title"]).toBeUndefined();
    expect(record(p).orca).toMatchObject({ dispatch_id: "orca-d-001-r1" });
  });

  it("the third failed start fails the dispatch and allows a new one", () => {
    configure();
    f.plan({ "d-001": { start: FAILED_START } });
    f.brief("d-001", "Inspect the parser.");
    for (const n of [1, 2]) {
      const r = f.run(...T, "run", "--role", "explore");
      expect(r.status, `start ${n}`).toBe(1);
      expect(JSON.parse(r.stdout)).toMatchObject({ orca_dispatch: null });
      expect(f.taskJson().dispatches[0].status).toBe("running");
    }
    const third = f.run(...T, "run", "--role", "explore");
    expect(third.status).toBe(1);
    expect(starts().map((s) => s["--retry-of"])).toEqual([
      undefined,
      "orca-d-001",
      "orca-d-001-r1",
    ]);
    expect(f.taskJson().workers).toEqual({});
    expect(f.taskJson().dispatches[0].status).toBe("fail");
    expect(
      fs.readFileSync(path.join(f.taskDir, "reports/d-001.md"), "utf-8"),
    ).toContain(START_ERROR);
    expect(JSON.parse(f.run(...T, "next", "--json").stdout)).toMatchObject({
      dispatch: "d-002",
    });
  });

  it("creates one Orca Run per task and starts every worker in it with its own request id", () => {
    configure();
    const p = prepare();
    expect(f.taskJson().orca_run).toBe("run-1");
    f.brief("d-002", "Second angle.");
    const q = f.run(...T, "run", "--role", "explore", "--dispatch", "d-002");
    expect(q.status, q.stdout + q.stderr).toBe(0);
    expect(
      orcaCalls(f).filter((argv) => argv[1] === "run-create"),
    ).toEqual([["orchestration", "run-create", "--objective", `arbor ${TASK}`]]);
    const [a, b] = starts();
    expect([a["--run"], b["--run"]]).toEqual(["run-1", "run-1"]);
    expect(record(p)).toMatchObject({ run: "run-1" });
    expect(a["--retry-request"]).toBe(record(p).request_id);
    expect(b["--retry-request"]).toBe(record(JSON.parse(q.stdout)).request_id);
    expect(a["--retry-request"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(a["--retry-request"]).not.toBe(b["--retry-request"]);
  });

  it("a start fenced to another coordinator binds this one to the task's Run (run-use) and starts", () => {
    configure();
    f.plan({ "d-001": { fenced: true } });
    const p = prepare();
    expect(p.orca_dispatch).toBe("orca-d-001");
    expect(orcaCalls(f).map((argv) => argv[1])).toEqual([
      "run-create",
      "worker-start",
      "run-use",
      "worker-start",
    ]);
    expect(orcaCalls(f).find((argv) => argv[1] === "run-use")).toEqual([
      "orchestration",
      "run-use",
      "--id",
      "run-1",
    ]);
    const [fenced, started] = starts();
    expect(started["--run"]).toBe("run-1");
    expect(started["--retry-request"]).not.toBe(fenced["--retry-request"]);
    expect(record(p).failed_starts).toBeUndefined();
  });

  it("re-running a request whose launcher died mid-start replays its request id instead of starting a second worker", () => {
    configure();
    const p = prepare();
    const dead = spawnSync("true").pid;
    // as if the launcher died after Orca started the worker, before it stored the answer
    fs.writeFileSync(
      p.request_path,
      JSON.stringify({ ...record(p), orca: null, launcher: dead }),
    );
    expect(f.run(...T, "sync").stdout).toContain("d-001 explore: not started");
    const again = f.run(...T, "run", "--role", "explore");
    expect(again.status, again.stdout + again.stderr).toBe(0);
    expect(JSON.parse(again.stdout)).toMatchObject({
      dispatch: "d-001",
      orca_dispatch: "orca-d-001",
    });
    const [first, second] = starts();
    expect(second["--retry-request"]).toBe(first["--retry-request"]);
    expect(second["--spec-file"]).toBe(first["--spec-file"]);
    expect(fs.existsSync(orcaState(f, "orca-d-001-r1"))).toBe(false);
    expect(record(p)).toMatchObject({ orca: { dispatch_id: "orca-d-001" } });
  });

  it("fails at run-create, before any request exists, when the Orca CLI is missing; the next run starts normally", () => {
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
    expect(
      fs.existsSync(path.join(f.repo, ".arbor/.runtime/workers", TASK, "d-001.json")),
    ).toBe(false);
    // nothing was recorded: no Run, no worker, no dispatch; d-001 is still the next angle
    expect(f.taskJson().orca_run).toBeUndefined();
    expect(f.taskJson().workers ?? {}).toEqual({});
    expect(f.taskJson().dispatches ?? []).toEqual([]);
    expect(JSON.parse(f.run(...T, "next", "--json").stdout)).toMatchObject({
      dispatch: "d-001",
    });
    expect(f.run(...T, "sync").stdout).toContain("no pending worker");

    fs.writeFileSync(config, good);
    const started = f.run(...T, "run", "--role", "explore");
    expect(started.status, started.stdout + started.stderr).toBe(0);
    expect(JSON.parse(started.stdout)).toMatchObject({
      dispatch: "d-001",
      orca_dispatch: "orca-d-001",
    });
    expect(starts()).toHaveLength(1);
  });

  /** The worker's turn ended (Orca: `activity: done`) `ago` ms after it started, without `worker_done`. */
  function endTurn(p: Json, ago: number) {
    const r = record(p);
    r.orca.started = new Date(Date.now() - ago).toISOString();
    fs.writeFileSync(p.request_path, JSON.stringify(r));
    setOrcaState(f, p.orca_dispatch, {
      projection: {
        stage: { activity: "done" },
        liveness: { verdict: "live" },
      },
    });
  }
  const TEN_MINUTES = 10 * 60 * 1000;

  it("a worker whose turn just ended is still running (Orca's idle grace)", () => {
    configure();
    const p = prepare();
    endTurn(p, 0);
    const r = f.run(...T, "sync");
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain(
      "d-001 explore: running (orca dispatch orca-d-001)",
    );
    expect(f.taskJson().workers).toHaveProperty("d-001");
  });

  it("an idle worker without a report is not collected and is named for a nudge; sync --wait returns at once", () => {
    configure();
    const p = prepare();
    endTurn(p, TEN_MINUTES);
    const t0 = Date.now();
    const r = f.run(...T, "sync", "--wait", "60s");
    expect(Date.now() - t0).toBeLessThan(30_000);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain(
      "d-001 explore: its turn ended without a report or worker_done.",
    );
    expect(r.stdout).toContain(
      "`orca orchestration send --to dispatch:orca-d-001",
    );
    expect(r.stdout).toContain(`Write the report to ${p.reply_path}`);
    expect(f.taskJson().workers).toHaveProperty("d-001");
    expect(f.taskJson().dispatches[0].status).toBe("running");
    expect(orcaCalls(f).some((argv) => argv[1] === "worker-stop")).toBe(false);
  });

  it("an idle worker that wrote its report is stopped and collected through reply validation", () => {
    configure();
    const p = prepare();
    fs.writeFileSync(p.reply_path, EXPLORE);
    endTurn(p, TEN_MINUTES);
    const r = f.run(...T, "sync");
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain(
      "d-001 explore: its turn ended without worker_done; its report is written and is validated as the reply",
    );
    expect(r.stdout).toContain("d-001 explore: ok");
    expect(r.stdout).not.toContain("no reply in");
    expect(
      orcaCalls(f).filter((argv) => argv[1] === "worker-stop"),
    ).toEqual([
      ["orchestration", "worker-stop", "--dispatch", "orca-d-001"],
    ]);
    expect(f.taskJson().dispatches[0].status).toBe("ok");
    expect(f.taskJson().workers).toEqual({});
  });

  it("a worker past the timeout that Orca cannot prove stopped is not collected", () => {
    configure();
    writeFile(
      f.repo,
      ".arbor/config.yaml",
      fs
        .readFileSync(path.join(f.repo, ".arbor/config.yaml"), "utf-8")
        .replace("timeout: 90m", "timeout: 1s"),
    );
    f.plan({ "d-001": { stop: "unknown" } });
    const p = prepare();
    spawnSync("sleep", ["1.2"]);
    const t0 = Date.now();
    const r = f.run(...T, "sync", "--wait", "60s");
    expect(Date.now() - t0).toBeLessThan(30_000);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain(
      "d-001 explore: timeout after 1s, and Orca could not prove the worker stopped; not collected. " +
        "Inspect `orca orchestration worker-show --dispatch orca-d-001`",
    );
    expect(
      orcaCalls(f).some(
        (argv) => argv[1] === "worker-stop" && argv.includes(p.orca_dispatch),
      ),
    ).toBe(true);
    expect(f.taskJson().workers).toHaveProperty("d-001");
    expect(f.taskJson().dispatches[0].status).toBe("running");
    expect(fs.existsSync(path.join(f.taskDir, "reports/d-001.md"))).toBe(false);
  });

  it("a review that settled failed but wrote its FAIL report goes down the FAIL path with its findings", () => {
    configure(true);
    writeFile(f.wt, "src/app.txt", "one\ntwo\nthree\n");
    git(f.wt, "add", "src/app.txt");
    git(f.wt, "commit", "-qm", `implement(${TASK}): seed\n\nArbor-Dispatch: d-000`);
    expect(
      f.run("override", "--reason", "test setup", "--to", "REVIEW").status,
    ).toBe(0);
    f.brief("d-001");
    const p = JSON.parse(f.run("run").stdout);
    expect(p).toMatchObject({ role: "review", orca_dispatch: "orca-d-001" });
    const finding = {
      file: "src/app.txt",
      line: 2,
      angle: "A",
      summary: "off by one",
      failure_scenario: "x -> y",
      verdict: "CONFIRMED",
      evidence: "two",
      fix: "z",
    };
    const reply = `FAIL\n\n\`\`\`json\n${JSON.stringify([finding])}\n\`\`\`\nMode: self-check; angles: A; single-context pass.\n`;
    const r = settle(p, "failed", reply, [], {
      lastFailure: JSON.stringify({ subject: "review failed", body: "1 finding" }),
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain(
      "d-001 review: the worker settled as failed: review failed; its report is written and is validated as the reply",
    );
    expect(f.taskJson()).toMatchObject({
      state: "REVIEW",
      step: "fix",
      review_ids: ["src/app.txt:2:off by one"],
    });
    expect(f.taskJson().dispatches[0]).toMatchObject({
      id: "d-001",
      role: "review",
      status: "ok",
    });
    expect(f.next()).toMatchObject({ role: "fix" });
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
    // each partition is cut from the task branch HEAD the wave started at
    const head = f.taskJson().partitions.a.base;
    expect(head).toBe(f.taskJson().partitions.b.base);
    expect(
      orcaCalls(f).filter((argv) => argv.slice(0, 2).join(" ") === "worktree create"),
    ).toEqual([
      [
        "worktree",
        "create",
        "--repo",
        `path:${f.repo}`,
        "--name",
        TASK,
        "--branch",
        `arbor/${TASK}`,
        "--base-branch",
        git(f.repo, "rev-parse", "main"),
        "--parent-worktree",
        `path:${f.repo}`,
      ],
      ...["a", "b"].map((p) => [
        "worktree",
        "create",
        "--repo",
        `path:${f.repo}`,
        "--name",
        `${TASK}-${p}`,
        "--branch",
        `arbor/${TASK}--${p}`,
        "--base-branch",
        head,
        "--parent-worktree",
        `path:${f.wt}`,
      ]),
    ]);
    expect(f.taskJson().partitions.a.worktree).toBe(wtA);
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
