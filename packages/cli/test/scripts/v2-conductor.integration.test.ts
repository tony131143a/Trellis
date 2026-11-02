/**
 * arbor.py conduct: launching a conductor through a fake `codeg-cli`,
 * the Planner/conductor identity split (`--as-conductor`), `--collect`
 * (still running / DONE / ESCALATE / garbage), `--cancel`, relaunch.
 */

import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { TASK, git, hasPython, setupFixture, writeFile, type Fixture } from "./v2-driver-helpers";

const FAKE_CODEG = String.raw`import json, os, pathlib, sys
here = pathlib.Path(__file__).resolve().parent
cmd = sys.argv[1]
if cmd == "run":
    (here / "conductor-prompt.md").write_bytes(sys.stdin.buffer.read())
    (here / "conductor-env.json").write_text(json.dumps(dict(os.environ)))
    (here / "conductor-argv.json").write_text(json.dumps(sys.argv[1:]))
    print("run-123")
elif cmd == "result":
    spec = json.loads((here / "conductor-result.json").read_text())
    sys.stdout.write(spec.get("stdout", ""))
    sys.exit(spec.get("exit", 0))
elif cmd == "cancel":
    (here / "canceled").write_text(sys.argv[2])
sys.exit(0)
`;

function withConductor(f: Fixture): void {
  writeFile(f.tmp, "fake_codeg.py", FAKE_CODEG);
  const shim = `python3 ${path.join(f.tmp, "fake_codeg.py")}`;
  const cfg = fs.readFileSync(path.join(f.repo, ".arbor/config.yaml"), "utf-8");
  fs.writeFileSync(
    path.join(f.repo, ".arbor/config.yaml"),
    cfg +
      `conductor:\n` +
      `  command: "${shim} run -A arbor-conductor -w {worktree} --detach --title arbor-conductor-{task}-{run} -q -p - < {prompt}"\n` +
      `  result_command: "${shim} result {run_id} -q"\n` +
      `  cancel_command: "${shim} cancel {run_id} -q"\n` +
      `  executor: fake\n`,
  );
}

function result(f: Fixture, spec: { exit?: number; stdout?: string }): void {
  fs.writeFileSync(path.join(f.tmp, "conductor-result.json"), JSON.stringify(spec));
}

const DONE = `Work finished.

## Conductor DONE
Reason: done
State: FINISH/merge
Dispatches: d-001..d-003 (3)
Summary: tests red then green, gate green, review PASS.
Needs from planner: none
`;

const ESCALATE = `## Conductor ESCALATE
Reason: plausible
State: POLISH/plausible
Dispatches: d-001..d-006 (6)
Summary: two PLAUSIBLE findings survived verify.
Needs from planner: decide fix|skip for P1 (src/a.py:3 unchecked None) and P2 (src/b.py:9 off-by-one); recommend fix P1, skip P2
`;

describe.skipIf(!hasPython())("arbor.py conduct", { timeout: 90_000 }, () => {
  let f: Fixture;
  afterEach(() => f?.cleanup());

  it("--dry-run prints the command and the prompt without recording anything", () => {
    f = setupFixture();
    withConductor(f);
    const dry = f.run("conduct", "--dry-run");
    expect(dry.status, dry.stderr).toBe(0);
    expect(dry.stdout).toContain("c-001: would run in");
    expect(dry.stdout).toContain("arbor-conductor-10-30-feat-c-001");
    const promptPath = /prompt: (\S+)/.exec(dry.stdout)?.[1] ?? "";
    expect(promptPath).toBeTruthy();
    const prompt = fs.readFileSync(promptPath, "utf-8");
    expect(prompt.startsWith(`Active task: ${f.taskDir}\nConductor: ${TASK}\nExecutor: fake\nRun: c-001\n`)).toBe(true);
    expect(prompt).toContain("<!-- arbor-hook-injected -->");
    expect(prompt).toContain("--as-conductor c-001");
    expect(prompt).toContain("## Contract");
    expect(f.taskJson().conductor).toBeUndefined();
    expect(fs.existsSync(path.join(f.tmp, "conductor-prompt.md"))).toBe(false);
  });

  it("conduct launches the run, blocks the Planner, lets the conductor drive, --collect records DONE", () => {
    f = setupFixture();
    withConductor(f);
    writeFile(f.tmp, "brief.md", "Decision: keep the CLI flag names.\n");
    const head = git(f.wt, "rev-parse", "HEAD");

    const launched = f.run("conduct", "--brief", path.join(f.tmp, "brief.md"));
    expect(launched.status, launched.stderr).toBe(0);
    expect(launched.stdout).toContain("c-001: conductor started");
    const record = f.taskJson().conductor;
    expect(record).toMatchObject({ run: "c-001", run_id: "run-123", status: "running", executor: "fake" });
    expect(fs.readFileSync(path.join(f.taskDir, "briefs", "c-001.md"), "utf-8")).toContain("keep the CLI flag names");
    expect(fs.readFileSync(path.join(f.tmp, "conductor-prompt.md"), "utf-8")).toContain("## Planner brief\n\nDecision: keep the CLI flag names.");
    const env = JSON.parse(fs.readFileSync(path.join(f.tmp, "conductor-env.json"), "utf-8"));
    expect(env.ARBOR_CONTEXT_ID).toBeUndefined();
    expect(git(f.wt, "log", "-1", "--format=%s")).toBe(`arbor(${TASK}): c-001 conductor start`);
    expect(git(f.wt, "rev-parse", "HEAD")).not.toBe(head);

    // Planner view and refusal.
    expect(f.next()).toMatchObject({ needs: "conductor", conductor: { run: "c-001", status: "running" } });
    f.brief("d-001");
    const refused = f.run("run");
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("conductor c-001 is driving");
    const wrong = f.run("--as-conductor", "c-009", "next", "--json");
    expect(wrong.status).toBe(0); // next never refuses; it just does not show the conductor view
    const refusedWrong = f.run("--as-conductor", "c-009", "run");
    expect(refusedWrong.status).toBe(1);
    expect(refusedWrong.stderr).toContain("is not the running conductor");

    // The conductor drives from the worktree with --task and --as-conductor.
    const asConductor = (...args: string[]) =>
      f.run("--task", f.taskDir, "--executor", "fake", "--as-conductor", "c-001", ...args);
    const n = asConductor("next", "--json");
    expect(JSON.parse(n.stdout)).toMatchObject({ needs: "brief", role: "test", dispatch: "d-001" });
    f.plan({ "d-001": { write: [{ path: "tests/ac1.sh", content: "test -f src/feature.txt\n" }] } });
    const ran = asConductor("run", "--dispatch", "d-001");
    expect(ran.status, ran.stdout + ran.stderr).toBe(0);
    expect(f.taskJson().state).toBe("BUILD");
    expect(f.taskJson().step).toBe("implement");

    // Still running, then DONE.
    result(f, { exit: 6 });
    const running = f.run("conduct", "--collect");
    expect(running.status).toBe(0);
    expect(running.stdout).toContain("still running");
    expect(f.taskJson().conductor.status).toBe("running");

    result(f, { exit: 0, stdout: DONE });
    const done = f.run("conduct", "--collect");
    expect(done.status, done.stderr).toBe(0);
    expect(done.stdout).toContain("c-001 conductor: done (done)");
    expect(f.taskJson().conductor).toMatchObject({ run: "c-001", status: "done", outcome: "DONE", reason: "done" });
    const report = fs.readFileSync(path.join(f.taskDir, "reports", "c-001.md"), "utf-8");
    expect(report).toContain("## Conductor DONE");
    expect(report).toContain("## Driver: c-001 conductor done");
    expect(git(f.wt, "log", "-1", "--format=%s")).toBe(`arbor(${TASK}): c-001 conductor done`);
    // After DONE the Planner sees the driver step again and may drive.
    expect(f.next()).toMatchObject({ needs: "brief", role: "implement", dispatch: "d-002" });
    const rows = f.results();
    expect(rows[rows.length - 1]).toMatchObject({ dispatch: "c-001", role: "conductor", status: "done" });
  });

  it("ESCALATE surfaces as human.kind=conductor; conduct again starts c-002 and archives c-001", () => {
    f = setupFixture();
    withConductor(f);
    expect(f.run("conduct").status).toBe(0);
    result(f, { exit: 0, stdout: ESCALATE });
    const collected = f.run("conduct", "--collect");
    expect(collected.status, collected.stderr).toBe(0);
    expect(collected.stdout).toContain("c-001 conductor: escalated (plausible)");
    const next = f.next();
    expect(next).toMatchObject({
      needs: "human",
      human: { kind: "conductor", run: "c-001", outcome: "ESCALATE", reason: "plausible" },
    });
    expect(next.human.needs_from_planner).toContain("decide fix|skip for P1");
    expect(next.summary).toContain("`arbor conduct` again");

    const again = f.run("conduct");
    expect(again.status, again.stderr).toBe(0);
    const data = f.taskJson();
    expect(data.conductor).toMatchObject({ run: "c-002", status: "running" });
    expect(data.conductor_runs.map((r: { run: string }) => r.run)).toEqual(["c-001"]);
    expect(fs.readFileSync(path.join(f.tmp, "conductor-prompt.md"), "utf-8")).toContain("Run: c-002");
    expect(f.run("conduct").stderr).toContain("conductor c-002 is driving");
  });

  it("an unparseable reply is failed; --cancel records failed/canceled and unblocks the Planner", () => {
    f = setupFixture();
    withConductor(f);
    expect(f.run("conduct").status).toBe(0);
    result(f, { exit: 0, stdout: "I got confused and stopped.\n" });
    const garbage = f.run("conduct", "--collect");
    expect(garbage.status).toBe(1);
    expect(garbage.stdout).toContain("c-001 conductor: failed");
    expect(f.taskJson().conductor).toMatchObject({ status: "failed", outcome: null });
    expect(f.taskJson().conductor.problem).toContain("no `## Conductor DONE|ESCALATE|FAILED` header");
    expect(f.next()).toMatchObject({ needs: "human", human: { kind: "conductor", run: "c-001" } });

    expect(f.run("conduct").status).toBe(0);
    const canceled = f.run("conduct", "--cancel");
    expect(canceled.status).toBe(1);
    expect(fs.readFileSync(path.join(f.tmp, "canceled"), "utf-8")).toBe("run-123");
    expect(f.taskJson().conductor).toMatchObject({ run: "c-002", status: "failed", reason: "canceled" });
    expect(f.run("conduct", "--collect").stderr).toContain("has no running conductor");
    f.brief("d-001");
    f.plan({ "d-001": { write: [{ path: "tests/ac1.sh", content: "test -f src/feature.txt\n" }] } });
    const ran = f.run("run");
    expect(ran.status, ran.stdout + ran.stderr).toBe(0);
  });

  it("refuses with an empty conductor.command and on an unstarted task", () => {
    f = setupFixture();
    fs.appendFileSync(path.join(f.repo, ".arbor/config.yaml"), `conductor:\n  command: ""\n`);
    const noCfg = f.run("conduct", "--dry-run");
    expect(noCfg.status).toBe(1);
    expect(noCfg.stderr).toContain("conductor.command is empty");
    f.cleanup();

    f = setupFixture({ start: false });
    withConductor(f);
    const unstarted = f.run("--task", f.taskDir, "conduct", "--dry-run");
    expect(unstarted.status).toBe(1);
  });
});
