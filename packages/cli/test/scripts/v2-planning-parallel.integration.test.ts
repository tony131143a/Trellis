/**
 * CONTRACT planning through Orca workers: independent explore / architect
 * angles fan out without a count limit, each a worker `sync` collects in any
 * order; a plan review waits for all of them.
 */

import { afterEach, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  SESSION,
  TASK,
  git,
  hasPython,
  orcaCalls,
  setOrcaState,
  setupFixture,
  writeFile,
  type Fixture,
} from "./v2-driver-helpers";

const T = ["--task", `.arbor/tasks/${TASK}`];
const EXPLORE = "## Explore Results\nIndependent evidence.\n";
const ARCHITECT = "## Architect: latency\nIndependent design.\n";

interface Worker {
  request_path: string;
  dispatch: string;
  prompt_path: string;
  reply_path: string;
  orca_dispatch: string;
}

describe.skipIf(!hasPython())(
  "parallel planning angles",
  { timeout: 90_000 },
  () => {
    let f: Fixture;
    afterEach(() => f?.cleanup());

    function setup(limit = 3, start = false) {
      f = setupFixture({ start });
      const config = path.join(f.repo, ".arbor/config.yaml");
      fs.writeFileSync(
        config,
        fs
          .readFileSync(config, "utf8")
          .replace("    timeout: 30s\n", `    timeout: 30s\n    max_parallel: ${limit}\n`),
      );
    }
    function prepare(id: string, role = "explore") {
      f.brief(id, `Independent ${role} angle ${id}`);
      const result = f.run(
        "--task",
        f.taskDir,
        "run",
        "--role",
        role,
        "--dispatch",
        id,
      );
      expect(result.status, result.stdout + result.stderr).toBe(0);
      return JSON.parse(result.stdout) as Worker;
    }
    // The worker's spec is only the header plus pointers; the injected context lives in the prompt file.
    const promptOf = (p: { prompt_path: string }) =>
      fs.readFileSync(p.prompt_path, "utf8");
    const specOf = (p: { request_path: string }) =>
      fs.readFileSync(
        JSON.parse(fs.readFileSync(p.request_path, "utf8")).spec_path,
        "utf8",
      );
    /** The worker writes its reply and reports done in Orca. */
    function settle(p: Worker, role = "explore") {
      fs.writeFileSync(p.reply_path, role === "architect" ? ARCHITECT : EXPLORE);
      setOrcaState(f, p.orca_dispatch, {
        dispatch: { id: p.orca_dispatch, status: "completed" },
      });
    }
    const syncArgs = (p: Worker) => [
      "--task",
      f.taskDir,
      "sync",
      "--dispatch",
      p.dispatch,
    ];
    function collect(p: Worker, role = "explore") {
      settle(p, role);
      const result = f.run(...syncArgs(p));
      expect(result.status, result.stdout + result.stderr).toBe(0);
    }
    function asyncRun(id: string, role = "explore") {
      return asyncDriver([...T, "run", "--role", role, "--dispatch", id]);
    }
    function asyncDriver(args: string[]) {
      const child = spawn(
        "python3",
        [path.join(f.repo, ".arbor/scripts/arbor.py"), ...args],
        {
          cwd: f.repo,
          env: { ...process.env, ...SESSION },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      return new Promise<{ code: number | null; out: string; err: string }>(
        (resolve, reject) => {
          let out = "",
            err = "";
          child.stdout.on("data", (data: Buffer) => {
            out += data.toString();
          });
          child.stderr.on("data", (data: Buffer) => {
            err += data.toString();
          });
          child.on("error", reject);
          child.on("close", (code) => resolve({ code, out, err }));
        },
      );
    }

    it("fans out mixed explore/architect angles and collects out of order without count limits", () => {
      setup(3);
      const before = git(f.repo, "rev-parse", "HEAD");
      const a = prepare("d-001"),
        b = prepare("d-002", "architect"),
        c = prepare("d-003");
      for (const p of [a, b, c]) {
        expect(specOf(p)).toContain(`Prompt: ${p.prompt_path}`);
        expect(promptOf(p)).toContain(`/research/${p.dispatch}-`);
      }
      const pending = JSON.parse(f.run(...T, "next", "--json").stdout);
      expect(
        pending.pending_workers.map(
          (d: { dispatch: string }) => d.dispatch,
        ),
      ).toEqual(["d-001", "d-002", "d-003"]);
      const more = JSON.parse(
        f.run(...T, "next", "--role", "architect", "--json").stdout,
      );
      expect(more).toMatchObject({ needs: "brief", dispatch: "d-004" });
      expect(more.max_parallel).toBeUndefined();
      f.brief("d-004");
      expect(
        f.run(...T, "run", "--role", "review", "--dispatch", "d-004").status,
      ).toBe(1);
      const start = spawnSync(
        "python3",
        [".arbor/scripts/task.py", "start", TASK],
        { cwd: f.repo, env: { ...process.env, ...SESSION }, encoding: "utf8" },
      );
      expect(start.status).toBe(1);
      expect(start.stdout).toContain("the pending workers");
      collect(c);
      expect(
        JSON.parse(f.run(...T, "next", "--role", "architect", "--json").stdout),
      ).toMatchObject({ needs: "brief", dispatch: "d-004" });
      // More than the former full-tier five-research budget, with two older readers still pending.
      for (let n = 4; n <= 8; n++) {
        const p = prepare(
          `d-${String(n).padStart(3, "0")}`,
          n % 2 ? "explore" : "architect",
        );
        collect(p, n % 2 ? "explore" : "architect");
      }
      collect(b, "architect");
      collect(a);
      expect(f.taskJson().dispatches).toHaveLength(8);
      expect(
        f.taskJson().dispatches.map((d: { status: string }) => d.status),
      ).toEqual(Array(8).fill("ok"));
      expect(f.taskJson().workers).toEqual({});
      expect(git(f.repo, "rev-parse", "HEAD")).toBe(before);
      expect(f.run(...syncArgs(a)).stdout).toContain("no pending worker");
    });

    it("ignores max_parallel for research while keeping dispatch replay idempotent", () => {
      setup(1);
      const a = prepare("d-001");
      const replay = f.run(
        ...T,
        "run",
        "--role",
        "explore",
        "--dispatch",
        "d-001",
      );
      expect(JSON.parse(replay.stdout)).toMatchObject({
        orca_dispatch: "orca-d-001",
        request_path: a.request_path,
      });
      expect(
        f.run(...T, "run", "--role", "architect", "--dispatch", "d-001").status,
      ).toBe(1);
      for (let n = 2; n <= 6; n++) prepare(`d-00${n}`, "architect");
      expect(Object.keys(f.taskJson().workers)).toHaveLength(6);
      expect(
        f.run(...T, "run", "--role", "explore", "--dispatch", "../escape")
          .status,
      ).toBe(1);
      expect(
        JSON.parse(f.run(...T, "next", "--role", "explore", "--json").stdout),
      ).toMatchObject({ needs: "brief", dispatch: "d-007" });
    });

    it("allocates simultaneous explicit ids under the task lock without overwriting requests or metadata", async () => {
      setup(1);
      for (const id of ["d-001", "d-002", "d-003"]) f.brief(id);
      const results = await Promise.all([
        asyncRun("d-003", "architect"),
        asyncRun("d-001"),
        asyncRun("d-002"),
      ]);
      for (const r of results) expect(r.code, r.out + r.err).toBe(0);
      const requests = results.map(
        (r) => JSON.parse(r.out) as { request_path: string; dispatch: string },
      );
      expect(new Set(requests.map((r) => r.request_path)).size).toBe(3);
      expect(Object.keys(f.taskJson().workers).sort()).toEqual([
        "d-001",
        "d-002",
        "d-003",
      ]);
      for (const r of requests)
        expect(specOf(r)).toContain(`Dispatch: ${r.dispatch}`);
      expect(
        JSON.parse(f.run(...T, "next", "--role", "explore", "--json").stdout)
          .dispatch,
      ).toBe("d-004");
    });

    it("two retries of the same id prepare one request and start one worker", async () => {
      setup(3);
      f.brief("d-001");
      const results = await Promise.all([asyncRun("d-001"), asyncRun("d-001")]);
      for (const r of results) expect(r.code, r.out + r.err).toBe(0);
      expect(JSON.parse(results[0].out).request_path).toBe(
        JSON.parse(results[1].out).request_path,
      );
      expect(f.taskJson().dispatches).toHaveLength(1);
      expect(
        orcaCalls(f).filter((argv) => argv[1] === "worker-start"),
      ).toHaveLength(1);
    });

    it("does not inject an unfinished sibling's output into another architecture perspective", () => {
      setup(3);
      const a = prepare("d-001");
      writeFile(
        f.taskDir,
        "research/d-001-partial.md",
        "UNFINISHED_SIBLING_EVIDENCE",
      );
      writeFile(
        f.taskDir,
        "research/previous.md",
        "COMPLETED_PREVIOUS_EVIDENCE",
      );
      const b = prepare("d-002", "architect");
      expect(promptOf(b)).not.toContain("UNFINISHED_SIBLING_EVIDENCE");
      expect(promptOf(b)).toContain("COMPLETED_PREVIOUS_EVIDENCE");
      collect(a);
      const c = prepare("d-003", "architect");
      expect(promptOf(c)).toContain("UNFINISHED_SIBLING_EVIDENCE");
      expect(
        fs.readFileSync(
          path.join(f.taskDir, "research/d-001-partial.md"),
          "utf8",
        ),
      ).toBe("UNFINISHED_SIBLING_EVIDENCE");
    });

    it("also supports parallel replanning in a started task's CONTRACT state", () => {
      setup(3, true);
      expect(
        f.run("override", "--to", "CONTRACT", "--reason", "replan").status,
      ).toBe(0);
      const a = prepare("d-001"),
        b = prepare("d-002", "architect");
      expect(f.run("resume").status).toBe(1);
      collect(b, "architect");
      collect(a);
      expect(f.taskJson()).toMatchObject({
        state: "CONTRACT",
        workers: {},
      });
      expect(f.run("resume").status).toBe(0);
      expect(f.taskJson().state).toBe("BUILD");
    });

    it("collects several settled workers concurrently without dropping a sibling result", async () => {
      setup(3);
      const requests = [
        prepare("d-001"),
        prepare("d-002", "architect"),
        prepare("d-003"),
      ];
      const commands = requests.map((p, i) => {
        settle(p, i === 1 ? "architect" : "explore");
        writeFile(
          f.taskDir,
          `research/${p.dispatch}-findings.md`,
          `Independent output ${i}`,
        );
        return syncArgs(p);
      });
      const results = await Promise.all(commands.reverse().map(asyncDriver));
      for (const r of results) expect(r.code, r.out + r.err).toBe(0);
      expect(f.taskJson().workers).toEqual({});
      expect(
        f.taskJson().dispatches.map((d: { status: string }) => d.status),
      ).toEqual(["ok", "ok", "ok"]);
      expect(
        new Set(f.results().map((r) => r.dispatch)).size,
      ).toBe(3);
      for (const [i, p] of requests.entries()) {
        expect(
          fs.readFileSync(
            path.join(f.taskDir, `research/${p.dispatch}-findings.md`),
            "utf8",
          ),
        ).toBe(`Independent output ${i}`);
        expect(
          fs.existsSync(path.join(f.taskDir, `reports/${p.dispatch}.md`)),
        ).toBe(true);
      }
    });

    it("canceling one reader does not cancel siblings or import partial output", () => {
      setup(2);
      const a = prepare("d-001");
      prepare("d-002", "architect");
      writeFile(f.taskDir, "research/d-001-aborted.md", "ABORTED_DRAFT");
      setOrcaState(f, a.orca_dispatch, {
        dispatch: {
          id: a.orca_dispatch,
          status: "failed",
          lastFailure: JSON.stringify({ subject: "cancel only this angle" }),
        },
      });
      expect(f.run(...syncArgs(a)).status).toBe(1);
      expect(Object.keys(f.taskJson().workers)).toEqual(["d-002"]);
      expect(f.taskJson().dispatches[0].status).toBe("fail");
      expect(
        fs.readFileSync(path.join(f.taskDir, "reports/d-001.md"), "utf8"),
      ).toContain("cancel only this angle");
      const c = prepare("d-003", "architect");
      expect(promptOf(c)).not.toContain("ABORTED_DRAFT");
      expect(f.taskJson().stop).toBeUndefined();
    });
  },
);
