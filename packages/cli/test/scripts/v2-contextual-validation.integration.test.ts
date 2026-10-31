import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { TASK, RED_TEST, dispatch, git, hasPython, setupFixture, writeFile, type Fixture } from "./v2-driver-helpers";

const PASS = "PASS\n```json\n[]\n```\n";

describe.skipIf(!hasPython())("main-agent contextual judgment", { timeout: 90_000 }, () => {
  let f: Fixture;
  afterEach(() => f?.cleanup());

  it.each([false, true])("collects revised CONTRACT review without restoring hashes (edit during delegation: %s)", (during) => {
    f = setupFixture();
    writeFile(f.repo, ".arbor/config.yaml", "executors:\n  default: codeg\n  codeg:\n    type: codeg-mcp\n    assistant: arbor-review\n    assistant_ids:\n      review: 6\n");
    expect(f.run("override", "--to", "CONTRACT", "--reason", "revise plan").status).toBe(0);
    const contract = path.join(f.taskDir, "contract.md");
    const approved = f.taskJson().contract_hash;
    fs.appendFileSync(contract, "\nRevised execution plan before dispatch.\n");
    expect(f.run("override", "--role", "review", "--mode", "plan", "--reason", "review revision").status).toBe(0);
    f.brief("d-001");
    const prepared = f.run("run");
    expect(prepared.status, prepared.stdout + prepared.stderr).toBe(0);
    const request = JSON.parse(prepared.stdout);
    expect(f.run("bind", "--request", request.request_path, "--task-id", "review-plan").status).toBe(0);
    if (during) {
      fs.appendFileSync(contract, "\nMain-agent clarification during review.\n");
      writeFile(f.taskDir, "contract-revised.md", "Candidate plan, keep this evidence.\n");
    }
    const revised = fs.readFileSync(contract, "utf8");
    const result = path.join(f.tmp, "result.json");
    fs.writeFileSync(result, JSON.stringify({ task_id: "review-plan", status: "completed", text: PASS }));
    const collected = f.run("collect", "--request", request.request_path, "--result", result);
    expect(collected.status, collected.stdout + collected.stderr).toBe(0);
    expect(fs.readFileSync(contract, "utf8")).toBe(revised);
    expect(f.taskJson()).toMatchObject({ state: "CONTRACT", contract_hash: approved, mcp_pending: {} });
    expect(f.taskJson().stop).toBeUndefined();
    expect(f.taskJson().dispatches[0].observations).toContain("contract.md differs from the recorded approval");
    if (during) expect(fs.readFileSync(path.join(f.taskDir, "contract-revised.md"), "utf8")).toContain("keep this evidence");
    expect(f.run("collect", "--request", request.request_path, "--result", result).status).toBe(1);
  });

  it("main agent interprets an ambiguous review once; the original is retained and never becomes implicit PASS", () => {
    f = setupFixture();
    expect(f.run("override", "--to", "REVIEW", "--reason", "fixture").status).toBe(0);
    f.plan({ "d-001": { reply: "Looks good; no concrete findings." } });
    expect(dispatch(f, "d-001").status).toBe(0);
    const original = fs.readFileSync(path.join(f.taskDir, "reports/d-001.md"), "utf8");
    expect(f.next()).toMatchObject({ state: "REVIEW", needs: "decide", decision: { kind: "report" } });
    expect(f.next().human).toBeUndefined();
    expect(f.run("decide", "accept", "--reason", "reviewed context").status).toBe(1);
    expect(f.run("gate").status).toBe(1);
    expect(f.taskJson().state).toBe("REVIEW");
    const interpretation = path.join(f.tmp, "interpreted.md");
    fs.writeFileSync(interpretation, PASS);
    const accepted = f.run("decide", "accept", "--report", interpretation, "--reason", "Checked diff and interpreted the reviewer conclusion");
    expect(accepted.status, accepted.stdout + accepted.stderr).toBe(0);
    expect(f.taskJson()).toMatchObject({ state: "FINISH", decisions: [{ kind: "report", choice: "accept", dispatch: "d-001" }] });
    expect(f.taskJson().report_pending).toBeUndefined();
    expect(fs.readFileSync(path.join(f.taskDir, "reports/d-001.md"), "utf8")).toBe(original);
    expect(fs.readFileSync(path.join(f.taskDir, "reports/d-001-interpreted.md"), "utf8")).toContain(PASS.trim());
    expect(f.run("decide", "accept", "--report", interpretation, "--reason", "repeat").status).toBe(1);
  });

  it("a report retry preserves the review override instead of advancing the enclosing state", () => {
    f = setupFixture();
    expect(f.run("override", "--role", "review", "--mode", "plan", "--reason", "extra reader").status).toBe(0);
    f.plan({ "d-001": { reply: "unclear" }, "d-002": { reply: PASS } });
    expect(dispatch(f, "d-001").status).toBe(0);
    expect(f.run("decide", "retry", "--reason", "clarify report").status).toBe(0);
    expect(f.next()).toMatchObject({ state: "BUILD", role: "review", mode: "plan", dispatch: "d-002" });
    expect(dispatch(f, "d-002").status).toBe(0);
    expect(f.next()).toMatchObject({ state: "BUILD", role: "test" });
  });

  it("repeated executor failures preserve commits and dirty files, remain failures, and never lock the task", () => {
    f = setupFixture();
    f.plan({
      "d-001": { write: [RED_TEST], dirty: [{ path: "local.txt", content: "keep me" }], exit: 4 },
      "d-002": { write: [{ path: "tests/extra.txt", content: "second attempt" }], exit: 4 },
      "d-003": { exit: 4 },
    });
    for (const id of ["d-001", "d-002", "d-003"]) expect(dispatch(f, id).status).toBe(1);
    expect(f.taskJson()).toMatchObject({ state: "BUILD", counters: { no_progress: 3 } });
    expect(f.taskJson().stop).toBeUndefined();
    expect(f.taskJson().dispatches.map((d: { status: string }) => d.status)).toEqual(["fail", "fail", "fail"]);
    expect(fs.readFileSync(path.join(f.wt, "local.txt"), "utf8")).toBe("keep me");
    expect(fs.existsSync(path.join(f.wt, "tests/extra.txt"))).toBe(true);
    expect(git(f.wt, "log", "--format=%s")).toContain(`test(${TASK}): work`);
    expect(f.next()).toMatchObject({ needs: "brief", role: "test", dispatch: "d-004" });
  });
  it("main-agent FAIL interpretation preserves findings for fix routing and the scorecard", () => {
    f = setupFixture();
    expect(f.run("override", "--to", "REVIEW", "--reason", "fixture").status).toBe(0);
    f.plan({ "d-001": { reply: "A confirmed issue exists in src/app.txt." } });
    expect(dispatch(f, "d-001").status).toBe(0);
    const report = path.join(f.tmp, "interpreted.md");
    fs.writeFileSync(report, 'FAIL\n```json\n[{"file":"src/app.txt","line":1,"summary":"bad condition","verdict":"CONFIRMED"}]\n```\n');
    const result = f.run("decide", "accept", "--report", report, "--reason", "Preserve the confirmed finding");
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(f.next()).toMatchObject({ state: "REVIEW", role: "fix" });
    expect(f.taskJson().review_ids).toEqual(["src/app.txt:1:bad condition"]);
    expect(f.run("override", "--to", "FINISH", "--reason", "inspect scorecard fixture").status).toBe(0);
    expect(f.run("finish").status).toBe(0);
    expect(fs.readFileSync(path.join(f.taskDir, "scorecard.md"), "utf8")).toContain("| 2 review | 1 | 0 | 0 |");
  });

  it("autopilot returns ambiguous output to the main agent without repeating the role", () => {
    f = setupFixture();
    expect(f.run("override", "--to", "REVIEW", "--reason", "fixture").status).toBe(0);
    writeFile(f.taskDir, "briefs/default-review.md", "Review once.");
    f.plan({ "d-001": { reply: "unstructured result" } });
    const run = f.run("run", "--autopilot");
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(f.taskJson().dispatches).toHaveLength(1);
    expect(f.next()).toMatchObject({ needs: "decide", decision: { kind: "report" } });
    expect(f.taskJson().stop).toBeUndefined();
  });

});
