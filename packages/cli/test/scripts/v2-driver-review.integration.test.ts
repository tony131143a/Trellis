/**
 * arbor.py driver: invariant violations, fail-closed replies, REVIEW and
 * POLISH, the contract-hash guard, canary, override / abandon / status.
 */

import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { FEATURE, RED_TEST, TASK, dispatch, git, hasPython, setupFixture, writeFile, type Fixture } from "./v2-driver-helpers";

/** Commit a source change on the task branch and jump to `state`. */
function seedCode(f: Fixture, state: string): void {
  writeFile(f.wt, "src/app.txt", "one\ntwo\nthree\n");
  git(f.wt, "add", "src/app.txt");
  git(f.wt, "commit", "-q", "-m", `implement(${TASK}): seed\n\nArbor-Dispatch: d-000`);
  expect(f.run("override", "--reason", "test setup", "--to", state).status).toBe(0);
}

const finding = (file: string, line: number, verdict: string, summary = "off by one") =>
  ({ file, line, angle: "A", summary, failure_scenario: "x -> y", verdict, evidence: "two", fix: "z" });
const reviewReply = (verdict: string, findings: object[]) =>
  `${verdict}\n\n\`\`\`json\n${JSON.stringify(findings)}\n\`\`\`\nMode: m; angles: A; single-context pass.\n`;

describe.skipIf(!hasPython())("arbor.py validators, REVIEW, POLISH", { timeout: 90_000 }, () => {
  let f: Fixture;
  afterEach(() => f?.cleanup());

  it("records boundary observations without resetting commits, deleting files or stopping", () => {
    f = setupFixture();
    f.plan({
      "d-001": { write: [RED_TEST] },
      "d-002": { write: [FEATURE, { path: "tests/ac1.sh", content: "true\n" }], dirty: [{ path: "stray.txt", content: "x" }] },
    });
    expect(dispatch(f, "d-001").status).toBe(0);
    const before = git(f.wt, "rev-parse", "HEAD");
    const r = dispatch(f, "d-002");
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(git(f.wt, "log", "--format=%s", `${before}..HEAD`)).toContain(`implement(${TASK})`);
    expect(fs.existsSync(path.join(f.wt, "src/feature.txt"))).toBe(true);
    expect(fs.readFileSync(path.join(f.wt, "stray.txt"), "utf-8")).toBe("x");
    expect(fs.readFileSync(path.join(f.wt, "tests/ac1.sh"), "utf-8")).toBe("true\n");
    const data = f.taskJson();
    expect(data.dispatches[1]).toMatchObject({ id: "d-002", status: "ok" });
    expect(data.state).toBe("GATE");
    expect(data.stop).toBeUndefined();
    expect(data.dispatches[1].observations.join("\n")).toContain("implement touched test paths");
    expect(fs.readFileSync(path.join(f.taskDir, "reports/d-002.md"), "utf-8"))
      .toContain("their author is not determined");
  });

  it("ambiguous reports require agent judgment without deleting work or entering STOP", () => {
    f = setupFixture();
    f.plan({ "d-001": { write: [RED_TEST], reply: "" } });
    expect(dispatch(f, "d-001").status).toBe(0);
    expect(f.next()).toMatchObject({ needs: "decide", decision: { kind: "report" } });
    expect(fs.existsSync(path.join(f.wt, "tests/ac1.sh"))).toBe(true);
    expect(f.run("decide", "retry", "--reason", "need actual report").status).toBe(0);
    seedCode(f, "REVIEW");
    f.plan({ "d-002": { reply: `Looks fine to me.\n\n${reviewReply("PASS", [])}` } });
    expect(dispatch(f, "d-002").status).toBe(0);
    expect(f.taskJson().dispatches[1]).toMatchObject({ role: "review", status: "judgment", confidence: "low" });
    expect(f.taskJson().state).toBe("REVIEW");
    expect(f.taskJson().stop).toBeUndefined();
    expect(f.taskJson().counters.no_progress).toBe(0);
  });

  it("REVIEW: FAIL -> fix -> gate -> re-review of last_reviewed..HEAD -> PASS -> FINISH (light)", () => {
    f = setupFixture();
    seedCode(f, "REVIEW");
    f.plan({
      "d-001": { reply: reviewReply("FAIL", [finding("src/app.txt", 2, "CONFIRMED")]) },
      "d-002": { write: [{ path: "src/app.txt", content: "one\nTWO\nthree\n" }], reply: "## Fix: Done\n" },
      "d-003": { reply: reviewReply("PASS", []) },
    });
    expect(dispatch(f, "d-001").status).toBe(0);
    let data = f.taskJson();
    expect(data).toMatchObject({ state: "REVIEW", step: "fix", counters: { review: 1 } });
    const reviewedTo = data.last_reviewed;
    expect(data.review_ids).toEqual(["src/app.txt:2:off by one"]);
    expect(f.next()).toMatchObject({ role: "fix", range: expect.stringMatching(new RegExp(`^${data.base}\\.\\.`)) });

    expect(dispatch(f, "d-002").status).toBe(0);
    expect(f.next()).toMatchObject({ state: "GATE", needs: "run" });
    expect(f.run("gate").status).toBe(1); // AC-1's tests/ac1.sh does not exist on this branch
    f.run("override", "--reason", "AC-1 is covered elsewhere in this test", "--to", "REVIEW");
    const next = f.next();
    expect(next).toMatchObject({ role: "review", mode: "self-check", range: expect.stringMatching(new RegExp(`^${reviewedTo}\\.\\.`)) });

    expect(dispatch(f, "d-003").status).toBe(0);
    data = f.taskJson();
    expect(data.state).toBe("FINISH");
    expect(f.next()).toMatchObject({ state: "FINISH", needs: "run" }); // `arbor finish` writes the scorecard
  });

  it("POLISH (standard): simplify No Change -> 2 candidate reviews -> prefilter -> verify PLAUSIBLE -> decide skip -> FINISH", () => {
    f = setupFixture({ tier: "standard" });
    seedCode(f, "REVIEW");
    f.plan({
      "d-001": { reply: reviewReply("PASS", []) },
      "d-002": { reply: "## Simplify: No Change\n" },
      "d-003": { reply: reviewReply("FAIL", [finding("src/app.txt", 2, "CANDIDATE"), finding("src/gone.txt", 1, "CANDIDATE")]) },
      "d-004": { reply: reviewReply("FAIL", [finding("src/app.txt", 2, "CANDIDATE"), finding("README.md", 1, "CANDIDATE", "old")]) },
      "d-005": { reply: `\`\`\`json\n${JSON.stringify([finding("src/app.txt", 2, "PLAUSIBLE")])}\n\`\`\`\nCONFIRMED 0, PLAUSIBLE 1, REFUTED 0.\n` },
    });
    expect(dispatch(f, "d-001").status).toBe(0);
    expect(f.taskJson()).toMatchObject({ state: "POLISH", step: "simplify" });
    expect(dispatch(f, "d-002").status).toBe(0);
    expect(f.next()).toMatchObject({ state: "POLISH", role: "review", mode: "candidates" });
    expect(dispatch(f, "d-003").status).toBe(0);
    expect(f.taskJson().polish.candidates_done).toBe(1);
    expect(dispatch(f, "d-004").status).toBe(0);

    const data = f.taskJson();
    expect(data).toMatchObject({ step: "verify", counters: { polish: 1 }, polish_ids: ["src/app.txt:2:off by one"] });
    const filtered = JSON.parse(fs.readFileSync(path.join(f.taskDir, "reports/candidates-r1.json"), "utf-8"));
    expect(filtered.kept.map((k: { id: string }) => k.id)).toEqual(["src/app.txt:2:off by one"]);
    expect(filtered.dropped.map((d: { reason: string }) => d.reason).sort()).toEqual([
      expect.stringContaining("README.md:1 is not within 5 lines"),
      "file src/gone.txt does not exist",
    ]);
    expect(f.next()).toMatchObject({ role: "verify", summary: expect.stringContaining("candidates-r1.json") });

    expect(dispatch(f, "d-005").status).toBe(0);
    expect(f.next()).toMatchObject({ needs: "human", human: { kind: "plausible" } });
    expect(f.run("decide", "impl", "--reason", "x").status).toBe(1);
    expect(f.run("decide", "skip", "--reason", "trigger is unrealistic").status).toBe(0);
    expect(f.taskJson().state).toBe("FINISH");
  });

  it("contract edits are observations, not a frozen-hash execution gate", () => {
    f = setupFixture();
    const frozen = f.taskJson().contract_hash;
    fs.appendFileSync(path.join(f.taskDir, "contract.md"), "\nUpdated planning explanation.\n");
    expect(f.next()).toMatchObject({ state: "BUILD", needs: "brief", observations: expect.any(Array) });
    f.plan({ "d-001": { write: [RED_TEST] } });
    const r = dispatch(f, "d-001");
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stderr).toContain("contract.md differs");
    expect(f.taskJson().stop).toBeUndefined();
    expect(f.taskJson().contract_hash).toBe(frozen);
    expect(f.next()).toMatchObject({ state: "BUILD", role: "implement" });
  });

  it("canary checks the executor and the reply's first line without touching state", () => {
    f = setupFixture();
    const before = fs.readFileSync(path.join(f.taskDir, "task.json"), "utf-8");
    const ok = f.run("canary");
    expect(ok.status, ok.stdout + ok.stderr).toBe(0);
    expect(ok.stdout).toContain("canary explore via fake: ok");
    expect(fs.readFileSync(path.join(f.tmp, "received/canary.md"), "utf-8")).toContain("Role: explore");
    const review = f.run("canary", "--role", "review");
    expect(review.status, review.stdout).toBe(0);
    f.plan({ canary: { reply: "sure, done\n" } });
    const bad = f.run("canary", "--role", "review");
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain("does not start with PASS or FAIL");
    f.plan({ canary: { exit: 4, stderr: "boom\n" } });
    const crashed = f.run("canary");
    expect(crashed.status).toBe(1);
    expect(crashed.stdout).toContain("executor exited 4");
    expect(fs.readFileSync(path.join(f.taskDir, "task.json"), "utf-8")).toBe(before);
    expect(f.results().map((r) => [r.dispatch, r.status])).toEqual([
      ["canary", "ok"], ["canary", "ok"], ["canary", "fail"], ["canary", "fail"],
    ]);
  });

  it("override --role dispatches once without advancing; abandon stops; status prints", () => {
    f = setupFixture();
    expect(f.run("override", "--reason", "need a second opinion", "--role", "explore").status).toBe(0);
    expect(f.next()).toMatchObject({ state: "BUILD", role: "explore", dispatch: "d-001" });
    expect(dispatch(f, "d-001").status).toBe(0);
    let data = f.taskJson();
    expect(data).toMatchObject({ state: "BUILD" });
    expect(data.dispatches[0]).toMatchObject({ role: "explore", override: true });
    expect(data.overrides[0]).toMatchObject({ role: "explore", reason: "need a second opinion" });
    expect(f.next()).toMatchObject({ role: "test", dispatch: "d-002" });

    expect(f.run("abandon", "--reason", "scope moved").status).toBe(0);
    data = f.taskJson();
    expect(data.stop).toMatchObject({ reason: "HUMAN", detail: "abandoned: scope moved" });
    const status = f.run("status");
    expect(status.status).toBe(0);
    expect(status.stdout).toContain("STOP/stop");
    expect(status.stdout).toContain("d-001 explore");
  });
});
