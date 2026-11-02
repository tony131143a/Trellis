/**
 * arbor.py mandate: which human gates the main agent asks the user about.
 * `next --json` carries the gate's mandate; the driver itself skips PLAUSIBLE
 * findings, resumes a STOP once and merges a small clean branch when the
 * mandate says `auto`.
 */

import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  FEATURE, RED_TEST, TASK, dispatch, git, hasPython, setupFixture, writeFile, type Fixture,
} from "./v2-driver-helpers";

const BRANCH = `arbor/${TASK}`;
const finding = (file: string, line: number, verdict: string, summary = "off by one") =>
  ({ file, line, angle: "A", summary, failure_scenario: "x -> y", verdict, evidence: "two", fix: "z" });
const reviewReply = (verdict: string, findings: object[]) =>
  `${verdict}\n\n\`\`\`json\n${JSON.stringify(findings)}\n\`\`\`\nMode: m; angles: A; single-context pass.\n`;

function seedCode(f: Fixture, state: string): void {
  writeFile(f.wt, "src/app.txt", "one\ntwo\nthree\n");
  git(f.wt, "add", "src/app.txt");
  git(f.wt, "commit", "-q", "-m", `implement(${TASK}): seed\n\nArbor-Dispatch: d-000`);
  expect(f.run("override", "--reason", "test setup", "--to", state).status).toBe(0);
}

function appendConfig(f: Fixture, text: string): void {
  const file = path.join(f.repo, ".arbor/config.yaml");
  fs.appendFileSync(file, text);
}

/** Light task to FINISH: test -> implement -> gate green -> review PASS. */
function driveToFinish(f: Fixture): void {
  f.plan({
    "d-001": { write: [RED_TEST] },
    "d-002": { write: [FEATURE] },
    "d-003": { reply: reviewReply("PASS", []) },
  });
  expect(dispatch(f, "d-001").status).toBe(0);
  expect(dispatch(f, "d-002").status).toBe(0);
  expect(f.run("gate").status).toBe(0);
  expect(dispatch(f, "d-003").status).toBe(0);
  expect(f.taskJson().state).toBe("FINISH");
}

describe.skipIf(!hasPython())("arbor.py mandate", { timeout: 120_000 }, () => {
  let f: Fixture;
  afterEach(() => f?.cleanup());

  it("next --json names the gate's mandate: tier default, config per tier, task.json meta override", () => {
    f = setupFixture({ start: false, mandate: "default" });
    expect(f.run("--task", f.taskDir, "next", "--json").stdout).toContain('"mandate": "auto"');
    appendConfig(f, "mandate:\n  light:\n    contract: ask\n");
    let next = JSON.parse(f.run("--task", f.taskDir, "next", "--json").stdout);
    expect(next.human).toEqual({ kind: "approve_contract", mandate: "ask" });

    const taskJson = path.join(f.taskDir, "task.json");
    const data = JSON.parse(fs.readFileSync(taskJson, "utf-8"));
    data.meta.mandate = "contract=auto, merge=ask";
    fs.writeFileSync(taskJson, JSON.stringify(data) + "\n");
    next = JSON.parse(f.run("--task", f.taskDir, "next", "--json").stdout);
    expect(next.human).toEqual({ kind: "approve_contract", mandate: "auto" });

    data.meta.mandate = "contract=maybe";
    fs.writeFileSync(taskJson, JSON.stringify(data) + "\n");
    const bad = f.run("--task", f.taskDir, "next", "--json");
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("meta.mandate");
  });

  it("task.py create --mandate validates and records meta.mandate", () => {
    f = setupFixture({ start: false, mandate: "default" });
    const env = { ...process.env, ARBOR_CONTEXT_ID: "v2-driver-session" };
    const bad = spawnSync("python3", [".arbor/scripts/task.py", "create", "Other", "--slug", "other", "--description", "d",
      "--mandate", "stop=later", "--no-start"],
      { cwd: f.repo, encoding: "utf-8", env });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("invalid mandate");
    const ok = spawnSync("python3", [".arbor/scripts/task.py", "create", "Other", "--slug", "other", "--description", "d",
      "--tier", "light", "--mandate", "merge=ask", "--no-start"], { cwd: f.repo, encoding: "utf-8", env });
    expect(ok.status, ok.stdout + ok.stderr).toBe(0);
    const dir = fs.readdirSync(path.join(f.repo, ".arbor/tasks")).find((n: string) => n.endsWith("-other")) ?? "";
    expect(dir).not.toBe("");
    const created = JSON.parse(fs.readFileSync(path.join(f.repo, ".arbor/tasks", dir, "task.json"), "utf-8"));
    expect(created.meta).toMatchObject({ tier: "light", mandate: "merge=ask" });
  });

  it("plausible=auto (standard default): PLAUSIBLE findings are skipped by the driver, not asked", () => {
    f = setupFixture({ tier: "standard", mandate: "default" });
    seedCode(f, "REVIEW");
    f.plan({
      "d-001": { reply: reviewReply("PASS", []) },
      "d-002": { reply: reviewReply("PASS", []) },
      "d-003": { reply: "## Simplify: No Change\n" },
      "d-004": { reply: reviewReply("FAIL", [finding("src/app.txt", 2, "CANDIDATE")]) },
      "d-005": { reply: reviewReply("FAIL", [finding("src/app.txt", 2, "CANDIDATE")]) },
      "d-006": { reply: `\`\`\`json\n${JSON.stringify([finding("src/app.txt", 2, "PLAUSIBLE")])}\n\`\`\`\nCONFIRMED 0, PLAUSIBLE 1, REFUTED 0.\n` },
    });
    for (const id of ["d-001", "d-002", "d-003", "d-004", "d-005"]) expect(dispatch(f, id).status).toBe(0);
    expect(f.taskJson()).toMatchObject({ state: "POLISH", step: "verify" });
    const r = dispatch(f, "d-006");
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("mandate: skip");
    const data = f.taskJson();
    expect(data.state).toBe("FINISH");
    expect(data.decisions).toMatchObject([{ kind: "plausible", choice: "skip", mandate: true, failing: ["src/app.txt:2:off by one"] }]);
    expect(f.next()).toMatchObject({ state: "FINISH", needs: "run" });
  });

  it("plausible=ask (config override) keeps the human gate", () => {
    f = setupFixture({ tier: "standard", mandate: "default" });
    appendConfig(f, "mandate:\n  standard:\n    plausible: ask\n");
    seedCode(f, "REVIEW");
    f.plan({
      "d-001": { reply: reviewReply("PASS", []) },
      "d-002": { reply: reviewReply("PASS", []) },
      "d-003": { reply: "## Simplify: No Change\n" },
      "d-004": { reply: reviewReply("FAIL", [finding("src/app.txt", 2, "CANDIDATE")]) },
      "d-005": { reply: reviewReply("FAIL", [finding("src/app.txt", 2, "CANDIDATE")]) },
      "d-006": { reply: `\`\`\`json\n${JSON.stringify([finding("src/app.txt", 2, "PLAUSIBLE")])}\n\`\`\`\nCONFIRMED 0, PLAUSIBLE 1, REFUTED 0.\n` },
    });
    for (const id of ["d-001", "d-002", "d-003", "d-004", "d-005", "d-006"]) expect(dispatch(f, id).status).toBe(0);
    expect(f.next()).toMatchObject({ needs: "human", human: { kind: "plausible", mandate: "ask" } });
    expect(f.taskJson().decisions ?? []).toEqual([]);
  });

  it("stop=auto (light default): the first STOP resumes itself, every later STOP asks", () => {
    f = setupFixture({ mandate: "default" });
    seedCode(f, "REVIEW");
    const same = reviewReply("FAIL", [finding("src/app.txt", 2, "CONFIRMED")]);
    const fix = { write: [{ path: "src/app.txt", content: "one\nTWO\nthree\n" }], reply: "## Fix: Done\n" };
    const fix2 = { write: [{ path: "src/app.txt", content: "one\ntwo\nTHREE\n" }], reply: "## Fix: Done\n" };
    f.plan({ "d-001": { reply: same }, "d-002": fix, "d-003": { reply: same }, "d-004": fix2, "d-005": { reply: same },
             "d-006": { reply: same } });
    expect(dispatch(f, "d-001").status).toBe(0);
    expect(dispatch(f, "d-002").status).toBe(0);
    expect(f.run("override", "--reason", "skip the gate in this test", "--to", "REVIEW").status).toBe(0);
    expect(dispatch(f, "d-003").status).toBe(0);
    expect(f.taskJson()).toMatchObject({ state: "REVIEW", counters: { no_progress: 1 } });
    expect(dispatch(f, "d-004").status).toBe(0);
    expect(f.run("override", "--reason", "skip the gate in this test", "--to", "REVIEW").status).toBe(0);
    const r = dispatch(f, "d-005");
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("mandate: resume");
    let data = f.taskJson();
    expect(data.state).toBe("REVIEW");
    expect(data.stop).toBeUndefined();
    expect(data.mandate_resumed).toMatchObject({ reason: "NO_PROGRESS", counter: "no_progress" });
    expect(data.decisions).toMatchObject([{ kind: "stop", choice: "resume", mandate: true }]);
    expect(f.next().needs).toBe("brief");

    // The next STOP (here the light review budget) is a human gate again.
    expect(dispatch(f, "d-006").status).toBe(0);
    data = f.taskJson();
    expect(data.state).toBe("STOP");
    expect(data.stop).toMatchObject({ reason: "BUDGET", counter: "review" });
    expect(data.decisions).toHaveLength(1);
    expect(f.next()).toMatchObject({ needs: "human", human: { kind: "stop", mandate: "auto" } });
  });

  it("merge=ask is the light default: finish prints the human merge command", () => {
    f = setupFixture({ mandate: "default" });
    driveToFinish(f);
    expect(f.run("finish").status).toBe(0);
    const r = f.run("finish");
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).not.toContain("auto-merge");
    expect(r.stdout).toContain(`merge (human): git -C ${f.repo} merge --no-ff ${BRANCH}`);
    expect(f.next()).toMatchObject({ needs: "human", human: { kind: "merge", mandate: "ask" } });
  });

  it("merge=auto (opted in): finish writes the scorecard first, then merges --no-ff itself and cleans up", () => {
    f = setupFixture({ mandate: "default" });
    appendConfig(f, "mandate:\n  light:\n    merge: auto\n");
    driveToFinish(f);
    const first = f.run("finish");
    expect(first.status, first.stdout + first.stderr).toBe(0);
    expect(first.stdout).toContain("auto-merge deferred");
    expect(first.stdout).not.toContain("merge (human)");
    expect(git(f.repo, "branch", "--show-current")).toBe("main");

    const second = f.run("finish");
    expect(second.status, second.stdout + second.stderr).toBe(0);
    expect(second.stdout).toContain(`merged ${BRANCH} into main with --no-ff (mandate merge=auto`);
    expect(second.stdout).toContain("cleaning up");
    expect(git(f.repo, "log", "--merges", "-1", "--format=%s", "main")).toBe(`merge ${BRANCH}`);
    expect(git(f.repo, "log", "--merges", "-1", "--format=%P", "main").split(" ")).toHaveLength(2);
    // The record of the auto-merge was committed on the task branch before the merge.
    const mergeCommit = git(f.repo, "log", "--merges", "-1", "--format=%H", "main");
    expect(git(f.repo, "log", "-1", "--format=%s", `${mergeCommit}^2`)).toBe(`arbor(${TASK}): auto-merge into main (mandate merge=auto, 2 lines)`);
    expect(fs.existsSync(f.wt)).toBe(false);
    const month = new Date().toISOString().slice(0, 7);
    expect(fs.existsSync(path.join(f.repo, ".arbor/tasks/archive", month, TASK))).toBe(true);
  });

  it("merge=auto falls back to the merge command when the diff is too large or the mandate says ask", () => {
    f = setupFixture({ mandate: "default" });
    appendConfig(f, "mandate:\n  auto_merge_max_lines: 1\n  light:\n    merge: auto\n");
    driveToFinish(f);
    expect(f.run("finish").status).toBe(0);
    const r = f.run("finish");
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("auto-merge skipped: 2 changed lines, auto-merge allows fewer than 1");
    expect(r.stdout).toContain(`merge (human): git -C ${f.repo} merge --no-ff ${BRANCH}`);
    expect(f.taskJson().state).toBe("FINISH");
    expect(f.next()).toMatchObject({ needs: "human", human: { kind: "merge", mandate: "auto" } });

    const data = JSON.parse(fs.readFileSync(path.join(f.taskDir, "task.json"), "utf-8"));
    data.meta.mandate = "merge=ask";
    fs.writeFileSync(path.join(f.taskDir, "task.json"), JSON.stringify(data) + "\n");
    const asked = f.run("finish");
    expect(asked.stdout).not.toContain("auto-merge");
    expect(asked.stdout).toContain("merge (human)");
    expect(f.next()).toMatchObject({ needs: "human", human: { kind: "merge", mandate: "ask" } });
  });
});
