/**
 * arbor.py driver: `next --json`, the BUILD test -> implement cycle with the
 * red check, GATE, `prompt --print`, results.jsonl and the task-branch commits.
 */

import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  FEATURE, RED_TEST, SESSION, TASK, dispatch, git, hasPython, setupFixture, writeFile,
  type Fixture,
} from "./v2-driver-helpers";

describe.skipIf(!hasPython())("arbor.py next / BUILD / GATE", { timeout: 90_000 }, () => {
  let f: Fixture;
  afterEach(() => f?.cleanup());

  it("next --json: BUILD asks for a test brief with a concrete range; no brief -> run refuses", () => {
    f = setupFixture();
    const data = f.taskJson();
    const head = git(f.wt, "rev-parse", "HEAD");
    const next = f.next();
    expect(next).toMatchObject({
      task: TASK, state: "BUILD", tier: "light", wave: 1, partition: "default", needs: "brief",
      role: "test", mode: null, range: `${data.base}..${head}`, dispatch: "d-001",
      brief_path: path.join(f.taskDir, "briefs", "d-001.md"), touched_files: [],
    });
    expect(next.summary).toContain("test");

    const refused = f.run("run");
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("write the brief first");
    expect(git(f.wt, "rev-parse", "HEAD")).toBe(head);
  });

  it("next --json without an active task, and for a task still in planning", () => {
    f = setupFixture();
    const none = spawnSync("python3", [path.join(f.repo, ".arbor/scripts/arbor.py"), "next", "--json"], {
      cwd: f.repo, encoding: "utf-8", env: { ...process.env, ARBOR_CONTEXT_ID: "other-session" },
    });
    // the single-session fallback still finds the one session file
    expect(JSON.parse(none.stdout).task).toBe(TASK);

    writeFile(f.repo, ".arbor/tasks/10-30-plan/task.json", JSON.stringify({ id: "plan", status: "planning" }));
    const planning = f.run("--task", ".arbor/tasks/10-30-plan", "next", "--json");
    expect(JSON.parse(planning.stdout)).toEqual({
      task: "10-30-plan", state: "CONTRACT", needs: "human", human: { kind: "approve_contract" },
      summary: expect.stringContaining("task.py start"),
    });
  });

  it("test (valid red) -> implement -> gate green -> REVIEW; prompts, reports, commits, results", () => {
    f = setupFixture({ gate: ["true"] });
    const base = f.taskJson().base;
    f.plan({ "d-001": { write: [RED_TEST] }, "d-002": { write: [FEATURE] } });

    const t = dispatch(f, "d-001");
    expect(t.status, t.stdout + t.stderr).toBe(0);
    let data = f.taskJson();
    expect(data.dispatches[0]).toMatchObject({ id: "d-001", role: "test", status: "ok", confidence: "high" });
    expect(data.state).toBe("BUILD");
    expect(data.step).toBe("implement");
    const report = fs.readFileSync(path.join(f.taskDir, "reports/d-001.md"), "utf-8");
    expect(report).toContain("## Tests Written");
    expect(report).toContain("### Red check");
    expect(report).toContain("- AC-1: exit 1");

    // the prompt sent is reproducible byte for byte
    const printed = f.run("prompt", "--dispatch", "d-001", "--print");
    expect(printed.status).toBe(0);
    const received = fs.readFileSync(path.join(f.tmp, "received/d-001.md"), "utf-8");
    expect(printed.stdout).toBe(received);
    expect(received).toMatch(new RegExp(`^Active task: ${f.taskDir}\nRole: test\nRange: ${base}\\.\\.[0-9a-f]{40}\nDispatch: d-001\n`));
    expect(received).toContain("Brief for d-001.");

    const next = f.next();
    expect(next).toMatchObject({ role: "implement", dispatch: "d-002" });
    expect(next.touched_files).toEqual(["tests/ac1.sh"]);
    expect(dispatch(f, "d-002").status).toBe(0);
    expect(f.next()).toMatchObject({ state: "GATE", needs: "run" });

    const gate = f.run("gate");
    expect(gate.status, gate.stdout).toBe(0);
    expect(gate.stdout).toContain("gate green");
    data = f.taskJson();
    expect(data.state).toBe("REVIEW");
    expect(data.counters.gate).toBe(1);
    expect(f.next()).toMatchObject({ role: "review", mode: "self-check", dispatch: "d-003" });

    // task branch: brief / role / result commits, nothing left dirty
    const subjects = git(f.wt, "log", "--format=%s", `${base}..HEAD`).split("\n").reverse();
    expect(subjects).toEqual([
      `contract(${TASK}): approve contract`,
      `arbor(${TASK}): d-001 test brief`,
      `test(${TASK}): work`,
      `arbor(${TASK}): d-001 test ok`,
      `arbor(${TASK}): d-002 implement brief`,
      `implement(${TASK}): work`,
      `arbor(${TASK}): d-002 implement ok`,
    ]);
    expect(git(f.wt, "status", "--porcelain", "--", "src", "tests")).toBe("");

    const rows = f.results();
    expect(rows.map((r) => [r.dispatch, r.role, r.status])).toEqual([["d-001", "test", "ok"], ["d-002", "implement", "ok"]]);
    expect(Object.keys(rows[0]).sort()).toEqual([
      "commit", "dispatch", "duration_s", "ended", "executor", "exit_code", "mode", "partition", "role",
      "started", "state", "status", "task", "ts", "violations", "wave",
    ]);
    expect(rows[1]).toMatchObject({ executor: "fake", exit_code: 0, state: "BUILD", wave: 1, violations: [] });
    expect(rows[1].commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("red check: a check that already passes -> decide; decide tests re-dispatches test", () => {
    f = setupFixture();
    f.plan({ "d-001": { write: [{ path: "tests/ac1.sh", content: "true\n" }] }, "d-002": { write: [RED_TEST] } });
    expect(dispatch(f, "d-001").status).toBe(0);
    const next = f.next();
    expect(next).toMatchObject({
      state: "BUILD", needs: "decide", decision: { kind: "red_check", options: ["impl", "tests", "contract"], failing: ["AC-1"] },
    });
    expect(f.run("run").status).toBe(1);
    expect(f.run("decide", "tests", "--reason", "test passes vacuously").status).toBe(0);
    expect(f.next()).toMatchObject({ role: "test", dispatch: "d-002" });
    expect(dispatch(f, "d-002").status).toBe(0);
    expect(f.taskJson().step).toBe("implement");
    expect(f.taskJson().decisions[0]).toMatchObject({ kind: "red_check", choice: "tests" });
  });

  it("red check: a collection/import error is not a valid red; decide contract -> CONTRACT -> resume", () => {
    f = setupFixture();
    f.plan({ "d-001": { write: [{ path: "tests/ac1.sh", content: "echo 'ModuleNotFoundError: feature'; exit 1\n" }] } });
    expect(dispatch(f, "d-001").status).toBe(0);
    expect(f.next().decision).toMatchObject({ kind: "red_check", failing: ["AC-1"], errored: ["AC-1"] });

    expect(f.run("decide", "contract", "--reason", "pins are wrong").status).toBe(0);
    expect(f.next()).toMatchObject({ state: "CONTRACT", needs: "human", human: { kind: "approve_contract" } });
    const contract = path.join(f.taskDir, "contract.md");
    fs.appendFileSync(contract, "\n<!-- revised -->\n");
    const resumed = f.run("resume");
    expect(resumed.status, resumed.stdout + resumed.stderr).toBe(0);
    const data = f.taskJson();
    expect(data.state).toBe("BUILD");
    expect(data.step).toBe("test");
    expect(git(f.wt, "log", "-1", "--format=%s")).toBe(`contract(${TASK}): re-approve contract`);
  });

  it("GATE red -> decide impl -> fix; the same failing set twice -> STOP(NO_PROGRESS)", () => {
    f = setupFixture({ gate: ["exit 3"] });
    f.plan({
      "d-001": { write: [RED_TEST] },
      "d-002": { write: [FEATURE] },
      "d-003": { write: [{ path: "src/a.txt", content: "1\n" }] },
    });
    expect(dispatch(f, "d-001").status).toBe(0);
    expect(dispatch(f, "d-002").status).toBe(0);
    const red = f.run("gate");
    expect(red.status).toBe(1);
    expect(red.stdout).toContain("failing: GATE-1");
    expect(f.next()).toMatchObject({
      state: "GATE", needs: "decide", decision: { kind: "gate_red", failing: ["GATE-1"] },
    });
    expect(fs.readFileSync(path.join(f.taskDir, "reports/gate-1.md"), "utf-8")).toContain("failing: GATE-1");
    expect(f.run("decide", "impl", "--reason", "lint is an impl bug").status).toBe(0);
    expect(f.next()).toMatchObject({ state: "GATE", role: "fix", dispatch: "d-003" });
    expect(dispatch(f, "d-003").status).toBe(0);
    expect(f.next()).toMatchObject({ state: "GATE", needs: "run" });
    // `run` in GATE runs the gate
    expect(f.run("run").status).toBe(1);
    let data = f.taskJson();
    expect(data.counters).toMatchObject({ gate: 2, no_progress: 1 });
    expect(data.step).toBe("decide");
    expect(f.run("decide", "tests", "--reason", "retry").status).toBe(0);
    expect(f.next()).toMatchObject({ role: "test" });
    f.run("override", "--reason", "skip the retest", "--to", "GATE/gate");
    expect(f.run("gate").status).toBe(1);
    data = f.taskJson();
    expect(data.state).toBe("STOP");
    expect(data.stop).toMatchObject({ reason: "NO_PROGRESS", prev: { state: "GATE", step: "gate" } });
    expect(f.next()).toMatchObject({ needs: "human", human: { kind: "stop", reason: "NO_PROGRESS" } });
    expect(f.run("run").status).toBe(1);
    expect(f.run("resume").status).toBe(0);
    expect(f.taskJson()).toMatchObject({ state: "GATE", step: "gate", counters: { no_progress: 0 } });
    expect(f.taskJson().overrides).toHaveLength(1);
  });
});
