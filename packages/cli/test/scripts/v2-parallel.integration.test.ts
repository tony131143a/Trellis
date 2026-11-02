/**
 * arbor.py parallel points (v4 wave 3): reader batches (two REVIEW
 * reviewers, POLISH candidate readers) whose dispatch ids are assigned up
 * front and run concurrently, over a command executor and over codeg MCP;
 * and test || implement lanes for a standard task that pins its interfaces.
 */

import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import {
  CONTRACT, FEATURE, RED_TEST, TASK, dispatch, git, hasPython, runAsync, setupFixture, writeFile,
  type Fixture,
} from "./v2-driver-helpers";

const finding = (file: string, line: number, verdict: string, summary = "off by one") =>
  ({ file, line, angle: "A", summary, failure_scenario: "x -> y", verdict, evidence: "two", fix: "z" });
const reviewReply = (verdict: string, findings: object[]) =>
  `${verdict}\n\n\`\`\`json\n${JSON.stringify(findings)}\n\`\`\`\nMode: m; angles: A; single-context pass.\n`;
const PINNED = CONTRACT.replace("- existing interfaces", "- `src/feature.txt`: the feature file, one line");

function seedCode(f: Fixture, state: string): void {
  writeFile(f.wt, "src/app.txt", "one\ntwo\nthree\n");
  git(f.wt, "add", "src/app.txt");
  git(f.wt, "commit", "-q", "-m", `implement(${TASK}): seed\n\nArbor-Dispatch: d-000`);
  expect(f.run("override", "--reason", "test setup", "--to", state).status).toBe(0);
}

describe.skipIf(!hasPython())("arbor.py parallel readers and lanes", { timeout: 120_000 }, () => {
  let f: Fixture;
  afterEach(() => f?.cleanup());

  it("standard REVIEW: two reviewers get ids up front, run concurrently, FAIL wins and findings unite", async () => {
    f = setupFixture({ tier: "standard" });
    seedCode(f, "REVIEW");
    const next = f.next();
    expect(next).toMatchObject({ state: "REVIEW", needs: "brief", role: "review", mode: "self-check", dispatch: "d-001" });
    expect(next.batch.map((b: { dispatch: string }) => b.dispatch)).toEqual(["d-001", "d-002"]);
    expect(next.batch[1].brief_path).toBe(path.join(f.taskDir, "briefs/d-002.md"));
    expect(next.summary).toContain("may run concurrently");

    f.plan({
      "d-001": { sleep: 2, reply: reviewReply("PASS", []) },
      "d-002": { sleep: 2, reply: reviewReply("FAIL", [finding("src/app.txt", 2, "CONFIRMED")]) },
    });
    f.brief("d-001", "Angles: A, Acceptance");
    f.brief("d-002", "Angles: B, Conventions");
    // The printed prompt of the second reader is available before it runs.
    expect(f.run("prompt", "--dispatch", "d-002", "--print").stdout).toContain("Angles: B, Conventions");
    const [a, b] = await Promise.all([runAsync(f, "run", "--dispatch", "d-002"), runAsync(f, "run", "--dispatch", "d-001")]);
    expect(a.status, a.stdout + a.stderr).toBe(0);
    expect(b.status, b.stdout + b.stderr).toBe(0);
    // Both executors were running at the same time.
    const rows = Object.fromEntries(f.results().map((r) => [r.dispatch, r]));
    expect(rows["d-001"].started < rows["d-002"].ended && rows["d-002"].started < rows["d-001"].ended).toBe(true);

    const data = f.taskJson();
    expect(data).toMatchObject({ state: "REVIEW", step: "fix", counters: { review: 1 }, review_ids: ["src/app.txt:2:off by one"] });
    expect(data.batch).toBeUndefined();
    expect(data.review_round).toBeUndefined();
    expect(data.dispatches.map((d: { id: string; status: string }) => [d.id, d.status]).sort()).toEqual([["d-001", "ok"], ["d-002", "ok"]]);
    expect(fs.readFileSync(path.join(f.taskDir, "reports/d-002.md"), "utf-8")).toContain("### Review round");
    expect(f.next()).toMatchObject({ role: "fix", dispatch: "d-003" });
  });

  it("standard REVIEW: run one reader at a time without --dispatch; both PASS -> POLISH, candidates batch next", () => {
    f = setupFixture({ tier: "standard" });
    seedCode(f, "REVIEW");
    f.plan({ "d-001": { reply: reviewReply("PASS", []) }, "d-002": { reply: reviewReply("PASS", []) } });
    expect(dispatch(f, "d-001").status).toBe(0);
    expect(f.taskJson()).toMatchObject({ state: "REVIEW", step: "review", review_round: { done: 1 } });
    expect(f.next()).toMatchObject({ role: "review", dispatch: "d-002" });
    expect(f.next().batch).toBeUndefined(); // one reader left
    f.brief("d-002");
    expect(f.run("run").status).toBe(0);
    expect(f.taskJson()).toMatchObject({ state: "POLISH", step: "simplify" });
  });

  it("a reader id outside the batch is refused; a finished reader is not counted twice", () => {
    f = setupFixture({ tier: "standard" });
    seedCode(f, "REVIEW");
    f.brief("d-005");
    const r = f.run("run", "--dispatch", "d-005");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("d-001 (or one of d-001, d-002), not d-005");
  });

  it("POLISH candidates: the readers of a round run concurrently, then verify", async () => {
    f = setupFixture({ tier: "standard" });
    seedCode(f, "REVIEW");
    f.plan({
      "d-001": { reply: reviewReply("PASS", []) },
      "d-002": { reply: reviewReply("PASS", []) },
      "d-003": { reply: "## Simplify: No Change\n" },
      "d-004": { sleep: 1, reply: reviewReply("FAIL", [finding("src/app.txt", 2, "CANDIDATE")]) },
      "d-005": { sleep: 1, reply: reviewReply("FAIL", [finding("src/app.txt", 2, "CANDIDATE")]) },
    });
    for (const id of ["d-001", "d-002", "d-003"]) expect(dispatch(f, id).status).toBe(0);
    const next = f.next();
    expect(next).toMatchObject({ state: "POLISH", role: "review", mode: "candidates", dispatch: "d-004" });
    expect(next.batch.map((b: { dispatch: string }) => b.dispatch)).toEqual(["d-004", "d-005"]);
    f.brief("d-004", "Angles: A, D");
    f.brief("d-005", "Angles: B, Conventions");
    const results = await Promise.all([runAsync(f, "run", "--dispatch", "d-004"), runAsync(f, "run", "--dispatch", "d-005")]);
    for (const r of results) expect(r.status, r.stdout + r.stderr).toBe(0);
    const data = f.taskJson();
    expect(data).toMatchObject({ state: "POLISH", step: "verify", counters: { polish: 1 }, polish_ids: ["src/app.txt:2:off by one"] });
    expect(data.polish.candidate_dispatches.sort()).toEqual(["d-004", "d-005"]);
    expect(f.next()).toMatchObject({ role: "verify", dispatch: "d-006" });
  });

  it("codeg MCP: both reviewers are delegated before either is collected, and collected out of order", () => {
    f = setupFixture({ tier: "standard" });
    writeFile(f.repo, ".arbor/config.yaml",
      "executors:\n  default: codeg\n  codeg:\n    type: codeg-mcp\n    assistant: arbor-{role}\n    max_parallel: 3\n"
      + "mandate:\n  standard:\n    contract: ask\n    plausible: ask\n    stop: ask\n    merge: ask\n");
    seedCode(f, "REVIEW");
    f.brief("d-001");
    f.brief("d-002");
    const first = JSON.parse(f.run("run", "--dispatch", "d-001").stdout);
    expect(first).toMatchObject({ needs: "delegation", dispatch: "d-001" });
    const between = f.next();
    expect(between).toMatchObject({ needs: "brief", dispatch: "d-002", readers_running: ["d-001"] });
    expect(between.pending_delegations.map((d: { dispatch: string }) => d.dispatch)).toEqual(["d-001"]);
    // `run` without --dispatch starts the next reader instead of repeating d-001's envelope.
    const second = JSON.parse(f.run("run").stdout);
    expect(second).toMatchObject({ needs: "delegation", dispatch: "d-002" });
    expect(f.next()).toMatchObject({ needs: "delegation" });
    // Asking for d-001 again returns its own envelope, not a new delegation.
    expect(JSON.parse(f.run("run", "--dispatch", "d-001").stdout)).toMatchObject({ dispatch: "d-001", request_path: first.request_path });

    const collect = (p: { request_path: string }, id: string, text: string) => {
      expect(f.run("bind", "--request", p.request_path, "--task-id", id).status).toBe(0);
      const file = path.join(f.tmp, `${id}.json`);
      fs.writeFileSync(file, JSON.stringify({ tasks: [{ task_id: id, status: "completed", text }] }));
      const r = f.run("collect", "--request", p.request_path, "--result", file);
      expect(r.status, r.stdout + r.stderr).toBe(0);
    };
    collect(second, "codeg-2", reviewReply("FAIL", [finding("src/app.txt", 2, "CONFIRMED")]));
    expect(f.taskJson()).toMatchObject({ state: "REVIEW", step: "review", review_round: { done: 1 } });
    collect(first, "codeg-1", reviewReply("PASS", []));
    expect(f.taskJson()).toMatchObject({ state: "REVIEW", step: "fix", mcp_pending: {} });
  });

  it("test || implement: a standard task that pins its interfaces runs BUILD as two lanes, then merges into GATE", async () => {
    f = setupFixture({ tier: "standard", contract: PINNED, gate: [] });
    expect(f.next()).toMatchObject({ state: "BUILD", needs: "run" });
    const started = f.run("run");
    expect(started.status, started.stdout + started.stderr).toBe(0);
    expect(f.taskJson()).toMatchObject({ lanes: true, step: "partitions", partitions: { tests: { step: "test" }, impl: { step: "implement" } } });
    const next = f.next();
    expect(next).toMatchObject({ needs: "brief", partition: "tests", role: "test" });
    expect(next.partitions_pending).toEqual(["impl"]);
    const { tests, impl } = f.taskJson().partitions;

    f.plan({ [tests.next_dispatch]: { sleep: 1, write: [RED_TEST] }, [impl.next_dispatch]: { sleep: 1, write: [FEATURE] } });
    f.brief(tests.next_dispatch, "Write the AC-1 test.");
    f.brief(impl.next_dispatch, "Write the feature file.");
    const [rt, ri] = await Promise.all([
      runAsync(f, "run", "--partition", "tests"),
      runAsync(f, "run", "--partition", "impl"),
    ]);
    expect(rt.status, rt.stdout + rt.stderr).toBe(0);
    expect(ri.status, ri.stdout + ri.stderr).toBe(0);
    const received = (id: string) => fs.readFileSync(path.join(f.tmp, "received", `${id}.md`), "utf-8");
    expect(received(tests.next_dispatch)).toContain("The implementation is written at the same time on another branch");
    expect(received(impl.next_dispatch)).toContain("The tests are written at the same time on another branch");
    const report = fs.readFileSync(path.join(f.taskDir, "reports", `${tests.next_dispatch}.md`), "utf-8");
    expect(report).toContain("### Red check");
    expect(report).toContain("AC-1: exit 1");
    expect(f.taskJson().partitions).toMatchObject({ tests: { step: "done" }, impl: { step: "done" } });

    expect(f.next()).toMatchObject({ needs: "run" });
    const merged = f.run("run");
    expect(merged.status, merged.stdout + merged.stderr).toBe(0);
    expect(f.taskJson()).toMatchObject({ state: "GATE", wave: 1, lanes: true, partitions: {} });
    expect(fs.existsSync(path.join(f.wt, "tests/ac1.sh"))).toBe(true);
    expect(fs.existsSync(path.join(f.wt, "src/feature.txt"))).toBe(true);
    expect(f.run("gate").status).toBe(0);
    expect(f.next()).toMatchObject({ state: "REVIEW", role: "review" });
  });

  it("no lanes for light tasks or for 'existing interfaces' pins", () => {
    f = setupFixture({ tier: "light", contract: PINNED });
    expect(f.next()).toMatchObject({ state: "BUILD", needs: "brief", role: "test" });
    f.cleanup();
    f = setupFixture({ tier: "standard" });
    expect(f.next()).toMatchObject({ state: "BUILD", needs: "brief", role: "test" });
    expect(f.taskJson().lanes).toBeUndefined();
  });
});
