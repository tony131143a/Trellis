/**
 * arbor.py `run --role`: CONTRACT-phase dispatches (explore / architect /
 * review plan) before `task.py start`, run in the main checkout, recorded but
 * never committed, outside the state table.
 */

import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { SESSION, TASK, git, hasPython, setupFixture, type Fixture } from "./v2-driver-helpers";

const T = ["--task", `.arbor/tasks/${TASK}`];
const research = (file: string) => ({ path: `.arbor/tasks/${TASK}/research/${file}`, content: "# notes\n" });
const reviewReply = (verdict: string, findings: object[]) =>
  `${verdict}\n\n\`\`\`json\n${JSON.stringify(findings)}\n\`\`\`\nMode: plan; angles: Plan; single-context pass.\n`;

describe.skipIf(!hasPython())("arbor.py run --role (CONTRACT phase)", { timeout: 90_000 }, () => {
  let f: Fixture;
  afterEach(() => f?.cleanup());

  it("explore with no task reads the brief from stdin and prints the reply; other roles need a task", () => {
    f = setupFixture({ start: false });
    const head = git(f.repo, "rev-parse", "HEAD");
    const r = spawnSync("python3", [path.join(f.repo, ".arbor/scripts/arbor.py"), "run", "--role", "explore"], {
      cwd: f.repo, encoding: "utf-8", input: "Where is the config parser?\n", env: { ...process.env, ...SESSION },
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("## Explore Results");
    const prompt = fs.readFileSync(path.join(f.tmp, "received/intake.md"), "utf-8");
    expect(prompt).toMatch(/^Role: explore\n/);
    expect(prompt).toContain("Where is the config parser?");
    expect(f.results()[0]).toMatchObject({ task: null, dispatch: "intake", state: "INTAKE", status: "ok" });
    expect(git(f.repo, "rev-parse", "HEAD")).toBe(head);
    expect(fs.existsSync(path.join(f.taskDir, "reports"))).toBe(false);

    const review = f.run("run", "--role", "review");
    expect(review.status).toBe(1);
    expect(review.stderr).toContain("needs a task");
  });

  it("explore + architect before start write research, are recorded, commit nothing; ids continue after start", () => {
    f = setupFixture({ start: false });
    const head = git(f.repo, "rev-parse", "HEAD");
    const next = JSON.parse(f.run(...T, "next", "--json").stdout);
    expect(next).toMatchObject({
      state: "CONTRACT", needs: "human", human: { kind: "approve_contract" }, dispatch: "d-001",
      brief_path: path.join(f.taskDir, "briefs/d-001.md"), contract_roles: ["explore", "architect", "review"],
    });
    expect(next.summary).toContain("run --role");

    f.plan({ "d-001": { dirty: [research("explore-a.md")] }, "d-002": { dirty: [research("design-x.md")] } });
    f.brief("d-001");
    expect(f.run(...T, "run", "--role", "explore", "--dispatch", "d-001").status).toBe(0);
    f.brief("d-002");
    const arch = f.run(...T, "run", "--role", "architect");
    expect(arch.status, arch.stdout + arch.stderr).toBe(0);

    const data = f.taskJson();
    expect(data.dispatches).toMatchObject([
      { id: "d-001", role: "explore", status: "ok", phase: "CONTRACT", commit: null },
      { id: "d-002", role: "architect", status: "ok", phase: "CONTRACT" },
    ]);
    expect(fs.existsSync(path.join(f.taskDir, "research/explore-a.md"))).toBe(true);
    expect(fs.readFileSync(path.join(f.taskDir, "reports/d-002.md"), "utf-8")).toContain("## Driver: d-002 architect ok");
    expect(fs.readFileSync(path.join(f.tmp, "received/d-002.md"), "utf-8")).toMatch(
      new RegExp(`^Active task: ${f.taskDir}\nRole: architect\nDispatch: d-002\n`),
    );
    expect(git(f.repo, "rev-parse", "HEAD")).toBe(head);
    expect(f.results().map((r) => [r.dispatch, r.state, r.status])).toEqual([
      ["d-001", "CONTRACT", "ok"], ["d-002", "CONTRACT", "ok"],
    ]);

    const start = spawnSync("python3", [".arbor/scripts/task.py", "start", TASK], {
      cwd: f.repo, encoding: "utf-8", env: { ...process.env, ...SESSION },
    });
    expect(start.status, start.stdout + start.stderr).toBe(0);
    // start resets task.json `dispatches`; the CONTRACT-phase reports keep the ids unique
    expect(f.next()).toMatchObject({ state: "BUILD", role: "test", dispatch: "d-003" });
    expect(fs.existsSync(path.join(f.wt, `.arbor/tasks/${TASK}/reports/d-002.md`))).toBe(true);
    const refused = f.run("run", "--role", "explore");
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("use `arbor override --role explore`");
  });

  it("an explore that commits and strays: violation, stray paths restored, HEAD left alone", () => {
    f = setupFixture({ start: false });
    const head = git(f.repo, "rev-parse", "HEAD");
    f.plan({ "d-001": { write: [{ path: "notes.txt", content: "x\n" }], dirty: [{ path: "README.md", content: "changed\n" }, { path: "stray.txt", content: "y" }] } });
    f.brief("d-001");
    const r = f.run(...T, "run", "--role", "explore");
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("violation");
    expect(fs.readFileSync(path.join(f.repo, "README.md"), "utf-8")).toBe("hi\n");
    expect(fs.existsSync(path.join(f.repo, "stray.txt"))).toBe(false);
    expect(git(f.repo, "rev-parse", "HEAD~1")).toBe(head); // the commit is reported, not reset
    expect(f.taskJson().dispatches[0]).toMatchObject({ status: "violation" });
    expect(f.taskJson().state).toBeUndefined();
    const row = f.results()[0];
    expect(row.status).toBe("violation");
    expect(row.violations.join("\n")).toContain("explore must not commit");
    expect(row.violations.join("\n")).toContain("undo it by hand");
  });

  it("review Mode: plan: verdict rule applies, findings recorded; prompt --print rebuilds a pre-start dispatch", () => {
    f = setupFixture({ start: false });
    const finding = { file: "contract.md", line: 7, angle: "Plan", summary: "AC-1 lacks an edge case", verdict: "CONFIRMED" };
    f.plan({
      "d-001": { reply: reviewReply("FAIL", [finding]) },
      "d-002": { reply: "Mostly fine.\n" },
      "d-003": { reply: reviewReply("PASS", []) },
    });
    f.brief("d-001");
    expect(f.run(...T, "run", "--role", "review", "--mode", "plan").status).toBe(0);
    f.brief("d-002");
    expect(f.run(...T, "run", "--role", "review").status).toBe(1);
    f.brief("d-003");
    expect(f.run(...T, "run", "--role", "review").status).toBe(0);
    expect(f.taskJson().dispatches).toMatchObject([
      { id: "d-001", mode: "plan", status: "ok", verdict: "FAIL", findings: 1 },
      { id: "d-002", status: "fail", confidence: "low" },
      { id: "d-003", status: "ok", verdict: "PASS", findings: 0 },
    ]);
    const received = fs.readFileSync(path.join(f.tmp, "received/d-001.md"), "utf-8");
    expect(received).toMatch(new RegExp(`^Active task: ${f.taskDir}\nRole: review\nMode: plan\nDispatch: d-001\n`));
    const printed = f.run(...T, "prompt", "--dispatch", "d-001", "--print");
    expect(printed.status).toBe(0);
    expect(printed.stdout).toBe(received);

    expect(f.run(...T, "run", "--role", "explore", "--mode", "plan").status).toBe(1);
  });
});
