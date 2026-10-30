/**
 * arbor.py driver: multi-partition waves (partition worktrees, per-partition
 * test -> implement, --no-ff merge-back, merge conflicts, two waves), parallel
 * runs under the task lock, and the full-tier POLISH sweep.
 */

import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  TASK, TEMPLATE_SCRIPTS, dispatch, git, hasPython, runAsync, setupFixture, writeFile,
  type Fixture, type Json,
} from "./v2-driver-helpers";

const contract = (partitions: string, waves: string, map: string, testPaths = "- tests/**/*.sh\n- src/**/*.test.sh") => `# Feature

## Goal

Build it in parts.

## Acceptance criteria

- AC-1: Given the repo When impl lands Then src/feature.txt exists
- AC-2: Given the repo When the fixture lands Then tests/data/fixture.txt exists

## Verification map

| id   | kind | check | file |
|------|------|-------|------|
${map}

## Interface pins

- existing interfaces

## Test paths

${testPaths}

## Partitions

${partitions}

## Waves

${waves}
`;

const SPLIT_MAP = [
  "| AC-1 | auto | `sh src/ac1.test.sh` | src/ac1.test.sh |",
  "| AC-2 | auto | `sh tests/ac2.sh` | tests/ac2.sh |",
].join("\n");
const TWO_PARTITIONS = contract("- impl: src/**\n- tests: tests/**", "- 1: [impl, tests]", SPLIT_MAP);

const IMPL_TEST = { path: "src/ac1.test.sh", content: "test -f src/feature.txt\n" };
const IMPL = { path: "src/feature.txt", content: "feature\n" };
const TESTS_TEST = { path: "tests/ac2.sh", content: "test -f tests/data/fixture.txt\n" };
const TESTS_IMPL = { path: "tests/data/fixture.txt", content: "fixture\n" };

const partitionWt = (f: Fixture, p: string) => path.join(f.tmp, "proj-wt", `${TASK}-${p}`);
const branchExists = (f: Fixture, b: string) =>
  spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${b}`], { cwd: f.repo }).status === 0;
const mergeSubjects = (f: Fixture, base: string) =>
  git(f.wt, "log", "--merges", "--format=%s", `${base}..HEAD`).split("\n").filter(Boolean).reverse();

function ok(r: { status: number | null; stdout: string; stderr: string }) {
  expect(r.status, r.stdout + r.stderr).toBe(0);
}

describe.skipIf(!hasPython())("arbor.py waves and partitions", { timeout: 90_000 }, () => {
  let f: Fixture;
  afterEach(() => f?.cleanup());

  it("a 2-partition wave: worktrees, test -> implement per partition, two --no-ff merges, then GATE", () => {
    f = setupFixture({ contract: TWO_PARTITIONS, gate: ["true"] });
    const base = f.taskJson().base;
    expect(f.next()).toMatchObject({
      state: "BUILD", wave: 1, partition: "default", partitions_pending: [], needs: "run",
      summary: expect.stringContaining("creates the partition worktrees (impl, tests)"),
    });
    ok(f.run("run"));
    let data = f.taskJson();
    expect(data.step).toBe("partitions");
    expect(data.partitions.impl).toMatchObject({
      wave: 1, branch: `arbor/${TASK}--impl`, worktree: partitionWt(f, "impl"), step: "test", next_dispatch: "d-001",
    });
    expect(data.partitions.tests).toMatchObject({ branch: `arbor/${TASK}--tests`, step: "test", next_dispatch: "d-002" });
    expect(git(partitionWt(f, "impl"), "rev-parse", "--abbrev-ref", "HEAD")).toBe(`arbor/${TASK}--impl`);

    const next = f.next();
    expect(next).toMatchObject({
      partition: "impl", role: "test", dispatch: "d-001", partitions_pending: ["tests"],
      range: `${base}..${git(partitionWt(f, "impl"), "rev-parse", "HEAD")}`,
      brief_path: path.join(f.taskDir, "briefs", "d-001.md"),
    });
    expect(next.summary).toContain("also ready: tests");
    const tests = f.run("next", "--json", "--partition", "tests");
    expect(JSON.parse(tests.stdout)).toMatchObject({ partition: "tests", role: "test", dispatch: "d-002", partitions_pending: ["impl"] });

    f.plan({
      "d-001": { write: [IMPL_TEST] }, "d-002": { write: [TESTS_TEST] },
      "d-003": { write: [IMPL] }, "d-004": { write: [TESTS_IMPL] },
    });
    f.brief("d-001");
    f.brief("d-002");
    expect(f.run("run", "--partition", "tests", "--dispatch", "d-001").stderr).toContain("is d-002, not d-001");
    ok(f.run("run", "--partition", "impl"));
    ok(f.run("run", "--partition", "tests", "--dispatch", "d-002"));
    data = f.taskJson();
    expect(data.partitions.impl).toMatchObject({ step: "implement", next_dispatch: "d-003", dispatches: ["d-001"] });
    expect(data.partitions.impl.running).toBeUndefined();
    expect(data.partitions.tests).toMatchObject({ step: "implement", next_dispatch: "d-004" });
    expect(fs.readFileSync(path.join(f.taskDir, "reports/d-001.md"), "utf-8")).toContain("- AC-1: exit 1");
    expect(fs.readFileSync(path.join(f.taskDir, "reports/d-001.md"), "utf-8")).not.toContain("AC-2");
    // the dispatch ran in the partition worktree; the task branch has only the driver's records
    expect(fs.existsSync(path.join(partitionWt(f, "impl"), IMPL_TEST.path))).toBe(true);
    expect(fs.existsSync(path.join(f.wt, IMPL_TEST.path))).toBe(false);
    const received = fs.readFileSync(path.join(f.tmp, "received/d-001.md"), "utf-8");
    expect(received.startsWith(`Active task: ${f.taskDir}\nRole: test\n`)).toBe(true);

    expect(f.next()).toMatchObject({ partition: "impl", role: "implement", dispatch: "d-003", partitions_pending: ["tests"] });
    expect(dispatch(f, "d-003").status).toBe(0); // no --partition: the first partition that needs a run
    expect(f.next()).toMatchObject({ partition: "tests", role: "implement", dispatch: "d-004" });
    f.brief("d-004");
    ok(f.run("run", "--partition", "tests"));
    expect(f.next()).toMatchObject({ needs: "run", summary: expect.stringContaining("merge wave 1") });

    ok(f.run("run"));
    expect(mergeSubjects(f, base)).toEqual([
      `arbor(${TASK}): merge wave 1 partition impl`,
      `arbor(${TASK}): merge wave 1 partition tests`,
    ]);
    for (const file of [IMPL_TEST, IMPL, TESTS_TEST, TESTS_IMPL]) {
      expect(fs.readFileSync(path.join(f.wt, file.path), "utf-8")).toBe(file.content);
    }
    expect(fs.existsSync(partitionWt(f, "impl"))).toBe(false);
    expect(fs.existsSync(partitionWt(f, "tests"))).toBe(false);
    expect(branchExists(f, `arbor/${TASK}--impl`)).toBe(false);
    data = f.taskJson();
    expect(data).toMatchObject({ state: "GATE", wave: 1, partitions: {} });
    expect(data.wave_history[0].partitions.impl.dispatches).toEqual(["d-001", "d-003"]);
    expect(data.dispatches.map((d: Json) => [d.id, d.partition, d.status])).toEqual([
      ["d-001", "impl", "ok"], ["d-002", "tests", "ok"], ["d-003", "impl", "ok"], ["d-004", "tests", "ok"],
    ]);
    expect(f.results().map((r) => [r.dispatch, r.partition, r.wave])).toEqual([
      ["d-001", "impl", 1], ["d-002", "tests", 1], ["d-003", "impl", 1], ["d-004", "tests", 1],
    ]);

    const gate = f.run("gate");
    expect(gate.status, gate.stdout).toBe(0);
    expect(f.taskJson().state).toBe("REVIEW");
    expect(git(f.wt, "status", "--porcelain", "--", "src", "tests")).toBe("");
  });

  it("a merge conflict waits for a hand merge in the task worktree; resume checks it and finishes the wave", () => {
    const map = "| AC-1 | auto | `test -f a/x.txt` | tests/ac1.sh |\n| AC-2 | manual | read b/y.txt | |";
    f = setupFixture({ contract: contract("- a: a/**\n- b: b/**", "- 1: [a, b]", map, "- tests/**") });
    ok(f.run("run"));
    // no auto check file inside a/ or b/: both skip `test`
    expect(f.taskJson().partitions.a.step).toBe("implement");
    f.plan({
      "d-001": { write: [{ path: "a/x.txt", content: "a\n" }, { path: "shared.txt", content: "A\n" }] },
      "d-002": { write: [{ path: "b/y.txt", content: "b\n" }, { path: "shared.txt", content: "B\n" }] },
    });
    f.brief("d-001");
    f.brief("d-002");
    ok(f.run("run", "--partition", "a"));
    ok(f.run("run", "--partition", "b"));
    const merge = f.run("run");
    expect(merge.status).toBe(1);
    const next = f.next();
    expect(next).toMatchObject({
      state: "BUILD", needs: "human", partition: "b",
      human: { kind: "merge_conflict", partition: "b", files: ["shared.txt"], branch: `arbor/${TASK}--b`, into: `arbor/${TASK}` },
    });
    expect(git(f.wt, "status", "--porcelain")).toBe("");
    expect(f.taskJson().partitions.a.merged).toMatch(/^[0-9a-f]{40}$/);
    expect(f.run("run").status).toBe(1);

    const early = f.run("resume");
    expect(early.status).toBe(1);
    expect(early.stderr).toContain("is not merged");
    spawnSync("git", ["merge", "--no-ff", "--no-edit", `arbor/${TASK}--b`], { cwd: f.wt });
    writeFile(f.wt, "shared.txt", "AB\n");
    git(f.wt, "add", "shared.txt");
    git(f.wt, "commit", "-q", "--no-edit");
    ok(f.run("resume"));
    const data = f.taskJson();
    expect(data).toMatchObject({ state: "GATE", partitions: {} });
    expect(data.merge_conflict).toBeUndefined();
    expect(data.wave_history[0].partitions.b.merge).toBe(git(f.wt, "rev-parse", "HEAD~1"));
    expect(fs.existsSync(partitionWt(f, "b"))).toBe(false);
    expect(fs.readFileSync(path.join(f.wt, "shared.txt"), "utf-8")).toBe("AB\n");
  });

  it("two waves in sequence; a single [default] wave keeps the task-branch flow", () => {
    const map = "| AC-1 | auto | `test -f a/x.txt` | tests/ac1.sh |\n| AC-2 | manual | read b/y.txt | |";
    f = setupFixture({ contract: contract("- a: a/**\n- b: b/**", "- 1: [a]\n- 2: [b]", map, "- tests/**") });
    const base = f.taskJson().base;
    f.plan({
      "d-001": { write: [{ path: "a/x.txt", content: "a\n" }] },
      "d-002": { write: [{ path: "b/y.txt", content: "b\n" }] },
    });
    ok(f.run("run"));
    expect(Object.keys(f.taskJson().partitions)).toEqual(["a"]);
    expect(dispatch(f, "d-001").status).toBe(0);
    ok(f.run("run"));
    let data = f.taskJson();
    expect(data).toMatchObject({ state: "BUILD", wave: 2, partitions: {} });
    expect(f.next()).toMatchObject({ wave: 2, needs: "run", summary: expect.stringContaining("(b)") });
    ok(f.run("run"));
    // wave 2 starts from the task branch with wave 1 merged
    expect(fs.existsSync(path.join(partitionWt(f, "b"), "a/x.txt"))).toBe(true);
    expect(dispatch(f, "d-002").status).toBe(0);
    ok(f.run("run"));
    data = f.taskJson();
    expect(data).toMatchObject({ state: "GATE", wave: 2 });
    expect(data.wave_history.map((w: Json) => w.wave)).toEqual([1, 2]);
    expect(mergeSubjects(f, base)).toEqual([
      `arbor(${TASK}): merge wave 1 partition a`,
      `arbor(${TASK}): merge wave 2 partition b`,
    ]);

    // the default contract: one [default] wave, no partition worktrees
    const g = setupFixture();
    try {
      const next = JSON.parse(g.run("next", "--json").stdout);
      expect(next).toMatchObject({ partition: "default", partitions_pending: [], role: "test", dispatch: "d-001" });
      expect(g.taskJson().partitions).toBeUndefined();
      expect(g.run("next", "--json", "--partition", "x").status).toBe(1);
    } finally {
      g.cleanup();
    }
  });

  it("two concurrent `run --partition` processes: distinct dispatch ids, both commits land, the lock is released", async () => {
    f = setupFixture({ contract: TWO_PARTITIONS });
    ok(f.run("run"));
    f.plan({ "d-001": { write: [IMPL_TEST], sleep: 1.5 }, "d-002": { write: [TESTS_TEST], sleep: 1.5 } });
    f.brief("d-001");
    f.brief("d-002");
    const [a, b] = await Promise.all([runAsync(f, "run", "--partition", "impl"), runAsync(f, "run", "--partition", "tests")]);
    ok(a);
    ok(b);
    const data = f.taskJson();
    expect(data.dispatches.map((d: Json) => [d.id, d.partition, d.status]).sort()).toEqual([
      ["d-001", "impl", "ok"], ["d-002", "tests", "ok"],
    ]);
    expect(data.partitions.impl.step).toBe("implement");
    expect([data.partitions.impl.next_dispatch, data.partitions.tests.next_dispatch].sort()).toEqual(["d-003", "d-004"]);
    const subjects = git(f.wt, "log", "--format=%s", "-8");
    for (const s of ["d-001 test brief", "d-002 test brief", "d-001 test ok", "d-002 test ok"]) {
      expect(subjects).toContain(`arbor(${TASK}): ${s}`);
    }
    expect(f.results().map((r) => r.dispatch).sort()).toEqual(["d-001", "d-002"]);
    expect(fs.existsSync(path.join(f.taskDir, ".lock"))).toBe(false);
    expect(git(f.wt, "status", "--porcelain")).toBe("");
  });

  it("the task lock: a dead owner is taken over; a live owner times out; a dead run's partition is reaped", () => {
    f = setupFixture({ contract: TWO_PARTITIONS });
    const dead = spawnSync("python3", ["-c", "import os; print(os.getpid())"], { encoding: "utf-8" }).stdout.trim();
    writeFile(f.taskDir, ".lock/pid", dead);
    const started = Date.now();
    ok(f.run("run"));
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(fs.existsSync(path.join(f.taskDir, ".lock"))).toBe(false);

    const code = `import sys, os
sys.path.insert(0, ${JSON.stringify(TEMPLATE_SCRIPTS)})
from pathlib import Path
from common.driver.lock import acquire, release, LockTimeout, LOCK_DIR
d = Path(sys.argv[1])
(d / LOCK_DIR).mkdir()
(d / LOCK_DIR / "pid").write_text(str(os.getppid()))
try:
    acquire(d, timeout=0.3); raise SystemExit("live lock taken")
except LockTimeout as e:
    assert "held by pid" in str(e)
(d / LOCK_DIR / "pid").unlink(); (d / LOCK_DIR).rmdir()
acquire(d); acquire(d); release(d)
assert (d / LOCK_DIR / ".gitignore").read_text() == "*\\n"
release(d)
assert not (d / LOCK_DIR).exists()
print("ok")
`;
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "arbor-lock-")));
    try {
      const r = spawnSync("python3", ["-B", "-c", code, tmp], { encoding: "utf-8" });
      expect(r.stdout.trim(), r.stderr).toBe("ok");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }

    // a run marked running by a process that is gone: next offers the partition again
    const data = f.taskJson();
    data.partitions.impl.running = { dispatch: "d-001", pid: Number(dead) };
    data.partitions.impl.next_dispatch = null;
    data.dispatches.push({ id: "d-001", role: "test", partition: "impl", status: "running" });
    fs.writeFileSync(path.join(f.taskDir, "task.json"), JSON.stringify(data));
    expect(f.next()).toMatchObject({ partition: "impl", role: "test", dispatch: "d-003" });
    ok(f.run("status"));
    f.brief("d-003");
    f.plan({ "d-003": { write: [IMPL_TEST] } });
    ok(f.run("run", "--partition", "impl"));
    const after = f.taskJson();
    expect(after.dispatches.map((d: Json) => [d.id, d.status])).toEqual([["d-001", "aborted"], ["d-003", "ok"]]);
  });

  it("state: partition decide / no-progress, polish cap and plausible skip lead to the sweep only in full", () => {
    const code = `import sys
sys.path.insert(0, ${JSON.stringify(TEMPLATE_SCRIPTS)})
from common.driver import state as sm
W = (("impl", "tests"),)
def wave():
    d = sm.ensure_fields({"state": "BUILD", "base": "b"})
    assert sm.plan(d, "full", W).action == "start_wave"
    sm.on_wave_started(d, {"impl": {"branch": "x--impl", "worktree": "/i", "base": "b", "step": "test"},
                           "tests": {"branch": "x--tests", "worktree": "/t", "base": "b", "step": "implement"}})
    d["partitions"]["impl"]["next_dispatch"] = "d-001"; d["partitions"]["tests"]["next_dispatch"] = "d-002"
    return d
d = wave()
s = sm.plan(d, "full", W)
assert (s.partition, s.role, s.dispatch, s.pending) == ("impl", "test", "d-001", ["tests"]), s
sm.on_partition_dispatch(d, "impl", "d-001", 1)
assert sm.plan(d, "full", W).partition == "tests" and sm.plan(d, "full", W, "impl").needs == "wait"
sm.on_partition_finished(d, "impl"); sm.on_partition_red_check(d, "impl", ["AC-1"], [])
s = sm.plan(d, "full", W)
assert s.needs == "decide" and s.decision["partition"] == "impl" and s.pending == ["tests"], s
sm.decide(d, "contract", "full")
assert d["state"] == "CONTRACT" and d["partitions"]["impl"]["step"] == "test"
sm.resume(d)
assert (d["state"], d["step"]) == ("BUILD", "partitions")
sm.on_partition_failed(d, "tests", "implement")
assert d["state"] == "BUILD"
sm.on_partition_failed(d, "tests", "implement")
assert d["state"] == "STOP" and d["stop"]["reason"] == "NO_PROGRESS" and "tests" in d["stop"]["detail"]
sm.resume(d)
assert (d["state"], d["step"]) == ("BUILD", "partitions")
for p in ("impl", "tests"): sm.on_partition_implemented(d, p)
assert sm.plan(d, "full", W).action == "merge"
sm.on_merge_conflict(d, {"partition": "tests", "files": ["a"], "branch": "x--tests", "into": "x"})
assert sm.plan(d, "full", W).human["kind"] == "merge_conflict"
assert sm.on_conflict_resolved(d, "s") == "tests" and "merge_conflict" not in d
sm.on_wave_merged(d, 1)
assert (d["state"], d["after_gate"]["state"]) == ("GATE", "REVIEW")

for tier, want in (("full", ("POLISH", "sweep")), ("standard", ("STOP", "stop"))):
    d = sm.ensure_fields({"state": "GATE", "base": "b", "after_gate": {"state": "POLISH", "step": "candidates"}})
    d["counters"]["polish"] = 2
    sm.on_gate(d, [], tier)
    assert (d["state"], d["step"]) == want, (tier, d)
for tier, want in (("full", "POLISH"), ("standard", "FINISH")):
    d = sm.ensure_fields({"state": "POLISH", "step": "plausible", "base": "b",
                          "decision": {"kind": "plausible"}, "polish": {"confirmed": [], "plausible": ["x"]}})
    sm.decide(d, "skip", tier)
    assert d["state"] == want, (tier, d)
d["sweep_done"] = True
sm._polish_done(d, "full")
assert d["state"] == "FINISH"
print("ok")
`;
    const r = spawnSync("python3", ["-B", "-c", code], { encoding: "utf-8" });
    expect(r.stdout.trim(), r.stderr).toBe("ok");
  });

  it("full tier: POLISH runs one sweep after the candidates cycle; CONFIRMED -> fix -> GATE -> FINISH", () => {
    f = setupFixture({ tier: "full", gate: ["true"] });
    writeFile(f.wt, "src/app.txt", "one\ntwo\nthree\n");
    writeFile(f.wt, "src/feature.txt", "feature\n");
    writeFile(f.wt, "tests/ac1.sh", "test -f src/feature.txt\n");
    git(f.wt, "add", "src", "tests");
    git(f.wt, "commit", "-q", "-m", `implement(${TASK}): seed\n\nArbor-Dispatch: d-000`);
    ok(f.run("override", "--reason", "test setup", "--to", "REVIEW"));

    const finding = { file: "src/app.txt", line: 2, angle: "B", summary: "wrong word", failure_scenario: "x", evidence: "two", fix: "TWO" };
    const review = (v: string, fs_: object[]) => `${v}\n\n\`\`\`json\n${JSON.stringify(fs_)}\n\`\`\`\nMode: m; angles: A; single-context pass.\n`;
    f.plan({
      "d-001": { reply: review("PASS", []) },
      "d-002": { reply: "## Simplify: No Change\n" },
      "d-003": { reply: review("PASS", []) },
      "d-004": { reply: review("PASS", []) },
      "d-005": { reply: review("PASS", []) },
      "d-006": { reply: review("FAIL", [{ ...finding, verdict: "CANDIDATE" }]) },
      "d-007": { reply: `\`\`\`json\n${JSON.stringify([{ ...finding, verdict: "CONFIRMED" }])}\n\`\`\`\nCONFIRMED 1, PLAUSIBLE 0, REFUTED 0.\n` },
      "d-008": { write: [{ path: "src/app.txt", content: "one\nTWO\nthree\n" }], reply: "## Fix: Done\n" },
    });
    for (const id of ["d-001", "d-002", "d-003", "d-004"]) expect(dispatch(f, id).status).toBe(0);
    expect(f.next()).toMatchObject({ state: "POLISH", role: "review", mode: "candidates", dispatch: "d-005" });
    expect(dispatch(f, "d-005").status).toBe(0);
    // three readers, nothing kept: full sweeps once instead of finishing
    const base = f.taskJson().base;
    expect(f.next()).toMatchObject({
      state: "POLISH", role: "review", mode: "sweep", dispatch: "d-006", range: expect.stringMatching(new RegExp(`^${base}\\.\\.`)),
    });
    expect(dispatch(f, "d-006").status).toBe(0);
    expect(fs.readFileSync(path.join(f.tmp, "received/d-006.md"), "utf-8")).toContain("Mode: sweep");
    expect(f.taskJson()).toMatchObject({ step: "verify", sweep_done: true, sweep_ids: ["src/app.txt:2:wrong word"] });
    expect(dispatch(f, "d-007").status).toBe(0);
    expect(f.next()).toMatchObject({ role: "fix", dispatch: "d-008" });
    expect(dispatch(f, "d-008").status).toBe(0);
    ok(f.run("gate"));
    const data = f.taskJson();
    expect(data.state).toBe("FINISH");
    expect(data.dispatches.filter((d: Json) => d.mode === "sweep")).toHaveLength(1);
  });
});
