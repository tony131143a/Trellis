/**
 * arbor.py driver: multi-partition waves (partition worktrees, one implement
 * dispatch per partition, --no-ff merge-back, scope escapes and merge
 * conflicts, two waves), parallel `run --partition` under the task lock, and
 * the full-tier REVIEW sweep after a clean candidates cycle.
 */

import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  TASK,
  TEMPLATE_SCRIPTS,
  complete,
  dispatch,
  git,
  hasPython,
  runAsync,
  setupFixture,
  writeFile,
  type Fixture,
  type Json,
} from "./v2-driver-helpers";

const contract = (partitions: string, waves: string, map: string) => `# Feature

## Goal

Build it in parts.

## Acceptance criteria

- AC-1: Given the repo When impl lands Then src/feature.txt exists
- AC-2: Given the repo When the fixture lands Then tests/data/fixture.txt exists

## Verification map

| id   | kind | check | file |
|------|------|-------|------|
${map}

## Partitions

${partitions}

## Waves

${waves}
`;

const SPLIT_MAP = [
  "| AC-1 | auto | `sh src/ac1.test.sh` | src/ac1.test.sh |",
  "| AC-2 | auto | `sh tests/ac2.sh` | tests/ac2.sh |",
].join("\n");
const TWO_PARTITIONS = contract(
  "- impl: src/**\n- tests: tests/**",
  "- 1: [impl, tests]",
  SPLIT_MAP,
);

const IMPL_TEST = {
  path: "src/ac1.test.sh",
  content: "test -f src/feature.txt\n",
};
const IMPL = { path: "src/feature.txt", content: "feature\n" };
const TESTS_TEST = {
  path: "tests/ac2.sh",
  content: "test -f tests/data/fixture.txt\n",
};
const TESTS_IMPL = { path: "tests/data/fixture.txt", content: "fixture\n" };

const partitionWt = (f: Fixture, p: string) =>
  path.join(f.tmp, "proj-wt", `${TASK}-${p}`);
const branchExists = (f: Fixture, b: string) =>
  spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${b}`], {
    cwd: f.repo,
  }).status === 0;
const mergeSubjects = (f: Fixture, base: string) =>
  git(f.wt, "log", "--merges", "--format=%s", `${base}..HEAD`)
    .split("\n")
    .filter(Boolean)
    .reverse();

function ok(r: { status: number | null; stdout: string; stderr: string }) {
  expect(r.status, r.stdout + r.stderr).toBe(0);
}

describe.skipIf(!hasPython())(
  "arbor.py waves and partitions",
  { timeout: 90_000 },
  () => {
    let f: Fixture;
    afterEach(() => f?.cleanup());

    it("a 2-partition wave: worktrees, implement per partition, two --no-ff merges, then GATE", () => {
      f = setupFixture({ contract: TWO_PARTITIONS, gate: ["true"] });
      const base = f.taskJson().base;
      expect(f.next()).toMatchObject({
        state: "BUILD",
        wave: 1,
        partition: "default",
        partitions_pending: [],
        needs: "run",
        summary: expect.stringContaining(
          "creates the partition worktrees (impl, tests)",
        ),
      });
      ok(f.run("run"));
      let data = f.taskJson();
      expect(data.step).toBe("partitions");
      expect(data.partitions.impl).toMatchObject({
        wave: 1,
        branch: `arbor/${TASK}--impl`,
        worktree: partitionWt(f, "impl"),
        step: "implement",
        next_dispatch: "d-001",
      });
      expect(data.partitions.tests).toMatchObject({
        branch: `arbor/${TASK}--tests`,
        step: "implement",
        next_dispatch: "d-002",
      });
      expect(
        git(partitionWt(f, "impl"), "rev-parse", "--abbrev-ref", "HEAD"),
      ).toBe(`arbor/${TASK}--impl`);

      const next = f.next();
      expect(next).toMatchObject({
        partition: "impl",
        role: "implement",
        dispatch: "d-001",
        partitions_pending: ["tests"],
        range: `${base}..${git(partitionWt(f, "impl"), "rev-parse", "HEAD")}`,
        brief_path: path.join(f.taskDir, "briefs", "d-001.md"),
      });
      expect(next.summary).toContain("also ready: tests");
      expect(next.items.map((i: Json) => [i.dispatch, i.partition])).toEqual([
        ["d-001", "impl"],
        ["d-002", "tests"],
      ]);
      const tests = f.run("next", "--json", "--partition", "tests");
      expect(JSON.parse(tests.stdout)).toMatchObject({
        partition: "tests",
        role: "implement",
        dispatch: "d-002",
        partitions_pending: ["impl"],
      });

      f.plan({
        "d-001": { write: [IMPL_TEST, IMPL] },
        "d-002": { write: [TESTS_TEST, TESTS_IMPL] },
      });
      f.brief("d-001");
      f.brief("d-002");
      expect(
        f.run("run", "--partition", "tests", "--dispatch", "d-001").stderr,
      ).toContain("is d-002, not d-001");
      // both partitions are delegated before either is collected
      const implRun = f.run("run", "--partition", "impl");
      ok(implRun);
      const testsRun = f.run(
        "run",
        "--partition",
        "tests",
        "--dispatch",
        "d-002",
      );
      ok(testsRun);
      data = f.taskJson();
      expect(data.partitions.impl.running).toMatchObject({
        dispatch: "d-001",
        external: true,
      });
      expect(data.partitions.tests.running).toMatchObject({
        dispatch: "d-002",
        external: true,
      });
      expect(f.next()).toMatchObject({
        needs: "delegation",
        dispatch: "d-001",
      });
      ok(complete(f, implRun));
      data = f.taskJson();
      expect(data.partitions.impl).toMatchObject({
        step: "done",
        next_dispatch: null,
        dispatches: ["d-001"],
      });
      expect(data.partitions.impl.running).toBeUndefined();
      expect(data.partitions.tests.step).toBe("implement");
      // the dispatch ran in the partition worktree; the task branch has only the driver's records
      expect(
        fs.existsSync(path.join(partitionWt(f, "impl"), IMPL_TEST.path)),
      ).toBe(true);
      expect(fs.existsSync(path.join(f.wt, IMPL_TEST.path))).toBe(false);
      const received = fs.readFileSync(
        path.join(f.tmp, "received/d-001.md"),
        "utf-8",
      );
      expect(
        received.startsWith(`Active task: ${f.taskDir}\nRole: implement\n`),
      ).toBe(true);
      expect(received).toContain(
        `Work only in ${partitionWt(f, "impl")} (branch arbor/${TASK}--impl, paths: src/**); commit there and nowhere else.\n\nBrief for d-001.`,
      );
      expect(
        fs.readFileSync(path.join(f.taskDir, "reports/d-001.md"), "utf-8"),
      ).toContain("- partition: impl");

      ok(complete(f, testsRun));
      expect(f.next()).toMatchObject({
        needs: "run",
        summary: expect.stringContaining("merge wave 1"),
      });

      ok(f.run("run"));
      expect(mergeSubjects(f, base)).toEqual([
        `arbor(${TASK}): merge wave 1 partition impl`,
        `arbor(${TASK}): merge wave 1 partition tests`,
      ]);
      for (const file of [IMPL_TEST, IMPL, TESTS_TEST, TESTS_IMPL]) {
        expect(fs.readFileSync(path.join(f.wt, file.path), "utf-8")).toBe(
          file.content,
        );
      }
      expect(fs.existsSync(partitionWt(f, "impl"))).toBe(false);
      expect(fs.existsSync(partitionWt(f, "tests"))).toBe(false);
      expect(branchExists(f, `arbor/${TASK}--impl`)).toBe(false);
      data = f.taskJson();
      expect(data).toMatchObject({ state: "GATE", wave: 1, partitions: {} });
      expect(data.wave_history[0].partitions.impl.dispatches).toEqual([
        "d-001",
      ]);
      expect(
        data.dispatches.map((d: Json) => [d.id, d.partition, d.status]),
      ).toEqual([
        ["d-001", "impl", "ok"],
        ["d-002", "tests", "ok"],
      ]);
      expect(f.results().map((r) => [r.dispatch, r.partition, r.wave])).toEqual(
        [
          ["d-001", "impl", 1],
          ["d-002", "tests", 1],
        ],
      );

      // the prompt still rebuilds byte for byte after the partition worktree is gone
      expect(f.run("prompt", "--dispatch", "d-001", "--print").stdout).toBe(
        received,
      );

      const gate = f.run("gate");
      expect(gate.status, gate.stdout).toBe(0);
      expect(f.taskJson().state).toBe("REVIEW");
      expect(git(f.wt, "status", "--porcelain", "--", "src", "tests")).toBe("");
    });

    it("a partition writer outside its paths is reported, then stops the merge until reverted; a merge conflict waits for a hand merge and resume", () => {
      const map =
        "| AC-1 | auto | `test -f a/x.txt` | tests/ac1.sh |\n| AC-2 | manual | read b/y.txt | |";
      f = setupFixture({
        contract: contract("- a: a/**\n- b: b/**", "- 1: [a, b]", map),
      });
      ok(f.run("run"));
      expect(f.taskJson().partitions.a.step).toBe("implement");
      f.plan({
        "d-001": {
          write: [
            { path: "a/x.txt", content: "a\n" },
            { path: "b/stray.txt", content: "s\n" },
          ],
        },
        "d-002": { write: [{ path: "b/y.txt", content: "b\n" }] },
      });
      const aHead = git(partitionWt(f, "a"), "rev-parse", "HEAD");
      const stray = dispatch(f, "d-001", "--partition", "a");
      expect(stray.status, stray.stdout + stray.stderr).toBe(0);
      expect(
        fs.readFileSync(path.join(f.taskDir, "reports/d-001.md"), "utf-8"),
      ).toContain("implement touched files outside partition a: b/stray.txt");
      expect(git(partitionWt(f, "a"), "rev-parse", "HEAD")).not.toBe(aHead);
      expect(f.taskJson()).toMatchObject({ state: "BUILD" });
      expect(f.taskJson().stop).toBeUndefined();
      expect(f.next()).toMatchObject({
        partition: "b",
        role: "implement",
        dispatch: "d-002",
      });
      ok(dispatch(f, "d-002", "--partition", "b"));
      // a conflict no partition writer may cause: the task branch itself changed b/y.txt by hand
      writeFile(f.wt, "b/y.txt", "B0\n");
      git(f.wt, "add", "b/y.txt");
      git(f.wt, "commit", "-q", "-m", "hand edit on the task branch");
      // the merge-time scope check stops partition a on its stray file, nothing merged
      const scoped = f.run("run");
      expect(scoped.status).toBe(1);
      expect(f.next()).toMatchObject({
        needs: "human",
        human: { kind: "merge_conflict" },
      });
      expect(f.taskJson().merge_conflict).toMatchObject({
        partition: "a",
        reason: "scope",
        files: ["b/stray.txt"],
      });
      expect(f.taskJson().partitions.a.merged).toBeUndefined();
      git(partitionWt(f, "a"), "rm", "-q", "b/stray.txt");
      git(partitionWt(f, "a"), "commit", "-q", "-m", "revert stray");
      const merge = f.run("resume");
      expect(merge.status).toBe(1);
      const next = f.next();
      expect(next).toMatchObject({
        state: "BUILD",
        needs: "human",
        partition: "b",
        human: {
          kind: "merge_conflict",
          partition: "b",
          files: ["b/y.txt"],
          branch: `arbor/${TASK}--b`,
          into: `arbor/${TASK}`,
        },
      });
      expect(git(f.wt, "status", "--porcelain")).toBe("");
      expect(f.taskJson().partitions.a.merged).toMatch(/^[0-9a-f]{40}$/);
      expect(f.run("run").status).toBe(1);

      const early = f.run("resume");
      expect(early.status).toBe(1);
      expect(early.stderr).toContain("is not merged");
      spawnSync("git", ["merge", "--no-ff", "--no-edit", `arbor/${TASK}--b`], {
        cwd: f.wt,
      });
      writeFile(f.wt, "b/y.txt", "AB\n");
      git(f.wt, "add", "b/y.txt");
      git(f.wt, "commit", "-q", "--no-edit");
      ok(f.run("resume"));
      const data = f.taskJson();
      expect(data).toMatchObject({ state: "GATE", partitions: {} });
      expect(data.merge_conflict).toBeUndefined();
      expect(data.wave_history[0].partitions.b.merge).toBe(
        git(f.wt, "rev-parse", "HEAD~1"),
      );
      expect(fs.existsSync(partitionWt(f, "b"))).toBe(false);
      expect(fs.readFileSync(path.join(f.wt, "b/y.txt"), "utf-8")).toBe("AB\n");
    });

    it("two waves in sequence; a single [default] wave keeps the task-branch flow", () => {
      const map =
        "| AC-1 | auto | `test -f a/x.txt` | tests/ac1.sh |\n| AC-2 | manual | read b/y.txt | |";
      f = setupFixture({
        contract: contract("- a: a/**\n- b: b/**", "- 1: [a]\n- 2: [b]", map),
      });
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
      expect(f.next()).toMatchObject({
        wave: 2,
        needs: "run",
        summary: expect.stringContaining("(b)"),
      });
      ok(f.run("run"));
      // wave 2 starts from the task branch with wave 1 merged
      expect(fs.existsSync(path.join(partitionWt(f, "b"), "a/x.txt"))).toBe(
        true,
      );
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
        expect(next).toMatchObject({
          partition: "default",
          partitions_pending: [],
          role: "implement",
          dispatch: "d-001",
        });
        expect(g.taskJson().partitions).toBeUndefined();
        expect(g.run("next", "--json", "--partition", "x").status).toBe(1);
      } finally {
        g.cleanup();
      }
    });

    it("two concurrent `run --partition` processes: distinct dispatch ids, both commits land, the lock is released", async () => {
      f = setupFixture({ contract: TWO_PARTITIONS });
      ok(f.run("run"));
      f.plan({
        "d-001": { write: [IMPL_TEST, IMPL] },
        "d-002": { write: [TESTS_TEST, TESTS_IMPL] },
      });
      f.brief("d-001");
      f.brief("d-002");
      const [a, b] = await Promise.all([
        runAsync(f, "run", "--partition", "impl"),
        runAsync(f, "run", "--partition", "tests"),
      ]);
      ok(a);
      ok(b);
      expect(
        f
          .taskJson()
          .dispatches.map((d: Json) => [d.id, d.partition, d.status])
          .sort(),
      ).toEqual([
        ["d-001", "impl", "running"],
        ["d-002", "tests", "running"],
      ]);
      const pending = f.next();
      expect(pending.needs).toBe("delegation");
      expect(pending.blocked_on).toBeUndefined();
      expect(
        pending.items
          .map((i: Json) => [i.dispatch, i.needs, i.partition])
          .sort(),
      ).toEqual([
        ["d-001", "delegation", "impl"],
        ["d-002", "delegation", "tests"],
      ]);
      ok(complete(f, a));
      ok(complete(f, b));
      const data = f.taskJson();
      expect(
        data.dispatches.map((d: Json) => [d.id, d.partition, d.status]).sort(),
      ).toEqual([
        ["d-001", "impl", "ok"],
        ["d-002", "tests", "ok"],
      ]);
      expect([data.partitions.impl.step, data.partitions.tests.step]).toEqual([
        "done",
        "done",
      ]);
      expect(data.mcp_pending).toEqual({});
      expect(fs.existsSync(path.join(partitionWt(f, "impl"), IMPL.path))).toBe(
        true,
      );
      expect(
        fs.existsSync(path.join(partitionWt(f, "tests"), TESTS_IMPL.path)),
      ).toBe(true);
      const subjects = git(f.wt, "log", "--format=%s", "-8");
      for (const s of [
        "d-001 implement brief",
        "d-002 implement brief",
        "d-001 implement ok",
        "d-002 implement ok",
      ]) {
        expect(subjects).toContain(`arbor(${TASK}): ${s}`);
      }
      expect(
        f
          .results()
          .map((r) => r.dispatch)
          .sort(),
      ).toEqual(["d-001", "d-002"]);
      expect(fs.existsSync(path.join(f.taskDir, ".lock"))).toBe(false);
      expect(git(f.wt, "status", "--porcelain")).toBe("");
    });

    it("the task lock: a dead owner is taken over; a live owner times out; a dead run's partition is reaped", () => {
      f = setupFixture({ contract: TWO_PARTITIONS });
      const dead = spawnSync(
        "python3",
        ["-c", "import os; print(os.getpid())"],
        { encoding: "utf-8" },
      ).stdout.trim();
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
      const tmp = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), "arbor-lock-")),
      );
      try {
        const r = spawnSync("python3", ["-B", "-c", code, tmp], {
          encoding: "utf-8",
        });
        expect(r.stdout.trim(), r.stderr).toBe("ok");
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }

      // a run marked running by a process that is gone: next offers the partition again
      const data = f.taskJson();
      data.partitions.impl.running = { dispatch: "d-001", pid: Number(dead) };
      data.partitions.impl.next_dispatch = null;
      data.dispatches.push({
        id: "d-001",
        role: "implement",
        partition: "impl",
        status: "running",
      });
      fs.writeFileSync(path.join(f.taskDir, "task.json"), JSON.stringify(data));
      expect(f.next()).toMatchObject({
        partition: "impl",
        role: "implement",
        dispatch: "d-003",
      });
      ok(f.run("status"));
      f.plan({ "d-003": { write: [IMPL_TEST, IMPL] } });
      ok(dispatch(f, "d-003", "--partition", "impl"));
      const after = f.taskJson();
      expect(after.dispatches.map((d: Json) => [d.id, d.status])).toEqual([
        ["d-001", "aborted"],
        ["d-003", "ok"],
      ]);
    });

    it("state: partition no-progress, the review cap at the gate and a plausible skip lead to the sweep only in full", () => {
      const code = `import sys
sys.path.insert(0, ${JSON.stringify(TEMPLATE_SCRIPTS)})
from common.driver import state as sm
W = (("impl", "tests"),)
def wave():
    d = sm.ensure_fields({"state": "BUILD", "base": "b"})
    assert sm.plan(d, "full", W).action == "start_wave"
    sm.on_wave_started(d, {"impl": {"branch": "x--impl", "worktree": "/i", "base": "b", "step": "implement"},
                           "tests": {"branch": "x--tests", "worktree": "/t", "base": "b", "step": "implement"}})
    d["partitions"]["impl"]["next_dispatch"] = "d-001"; d["partitions"]["tests"]["next_dispatch"] = "d-002"
    return d
d = wave()
s = sm.plan(d, "full", W)
assert (s.partition, s.role, s.dispatch, s.pending) == ("impl", "implement", "d-001", ["tests"]), s
sm.on_partition_dispatch(d, "impl", "d-001", 1)
assert sm.plan(d, "full", W).partition == "tests" and sm.plan(d, "full", W, "impl").needs == "wait"
sm.on_partition_finished(d, "impl")
assert sm.plan(d, "full", W).partition == "impl" and sm.plan(d, "full", W).pending == ["tests"]
sm.on_partition_failed(d, "tests", "implement")
assert d["state"] == "BUILD" and d["partitions"]["tests"]["counters"]["no_progress"] == 1
sm.on_partition_failed(d, "tests", "implement")
assert d["state"] == "STOP" and d["stop"]["reason"] == "NO_PROGRESS" and d["partitions"]["tests"]["counters"]["no_progress"] == 2
assert d["stop"]["prev"] == {"state": "BUILD", "step": "partitions"}
sm.resume(d)
assert (d["state"], d["step"]) == ("BUILD", "partitions") and d["partitions"]["tests"]["counters"]["no_progress"] == 0
for p in ("impl", "tests"): sm.on_partition_implemented(d, p)
assert sm.plan(d, "full", W).action == "merge"
sm.on_merge_conflict(d, {"partition": "tests", "files": ["a"], "branch": "x--tests", "into": "x"})
assert sm.plan(d, "full", W).human["kind"] == "merge_conflict"
assert sm.on_conflict_resolved(d, "s") == "tests" and "merge_conflict" not in d
sm.on_wave_merged(d, 1, "full")
assert (d["state"], d["after_gate"]) == ("GATE", {"state": "REVIEW", "step": "candidates"})
assert d["wave_history"][0]["partitions"]["tests"]["merge"] == "s"

# the review cap never stops a green gate: the next candidates cycle opens
for tier in ("full", "standard"):
    d = sm.ensure_fields({"state": "GATE", "base": "b", "last_reviewed": "h",
                          "after_gate": {"state": "REVIEW", "step": "candidates"}})
    d["counters"]["review"] = sm.REVIEW_ROUND_CAP
    sm.on_gate(d, [], tier)
    assert (d["state"], d["step"]) == ("REVIEW", "candidates") and "stop" not in d, (tier, d)
    assert d["cycle"]["range_from"] == "h"
# a plausible skip with nothing confirmed ends the cycle: full sweeps once, standard finishes
for tier, want in (("full", ("REVIEW", "sweep")), ("standard", ("FINISH", "finish"))):
    d = sm.ensure_fields({"state": "REVIEW", "step": "plausible", "base": "b",
                          "decision": {"kind": "plausible"}, "cycle": {"confirmed": [], "plausible": ["x"]}})
    sm.decide(d, "skip", tier)
    assert (d["state"], d["step"]) == want, (tier, d)
assert d.get("cycle") is None
d["state"], d["step"] = "REVIEW", "plausible"
d["decision"], d["cycle"], d["sweep_done"] = {"kind": "plausible"}, {"confirmed": [], "plausible": ["x"]}, True
sm.decide(d, "skip", "full")
assert d["state"] == "FINISH"
print("ok")
`;
      const r = spawnSync("python3", ["-B", "-c", code], { encoding: "utf-8" });
      expect(r.stdout.trim(), r.stderr).toBe("ok");
    });

    it("full tier: REVIEW runs one sweep after a clean candidates cycle; CONFIRMED -> fix -> GATE -> FINISH", () => {
      f = setupFixture({ tier: "full", gate: ["true"] });
      writeFile(f.wt, "src/app.txt", "one\ntwo\nthree\n");
      writeFile(f.wt, "src/feature.txt", "feature\n");
      writeFile(f.wt, "tests/ac1.sh", "test -f src/feature.txt\n");
      git(f.wt, "add", "src", "tests");
      git(
        f.wt,
        "commit",
        "-q",
        "-m",
        `implement(${TASK}): seed\n\nArbor-Dispatch: d-000`,
      );
      ok(f.run("override", "--reason", "test setup", "--to", "GATE"));
      // the gate resolves the REVIEW entry: the candidate readers
      ok(f.run("gate"));

      const finding = {
        file: "src/app.txt",
        line: 2,
        angle: "B",
        summary: "wrong word",
        failure_scenario: "x",
        evidence: "two",
        fix: "TWO",
      };
      const review = (v: string, fs_: object[]) =>
        `${v}\n\n\`\`\`json\n${JSON.stringify(fs_)}\n\`\`\`\nMode: m; angles: A; single-context pass.\n`;
      f.plan({
        "d-001": { reply: review("PASS", []) },
        "d-002": { reply: review("PASS", []) },
        "d-003": { reply: review("PASS", []) },
        "d-004": {
          reply: review("FAIL", [{ ...finding, verdict: "CANDIDATE" }]),
        },
        "d-005": {
          reply: `\`\`\`json\n${JSON.stringify([{ ...finding, verdict: "CONFIRMED" }])}\n\`\`\`\nCONFIRMED 1, PLAUSIBLE 0, REFUTED 0.\n`,
        },
        "d-006": {
          write: [{ path: "src/app.txt", content: "one\nTWO\nthree\n" }],
          reply: "## Fix: Done\n",
        },
        "d-007": { reply: review("PASS", []) },
      });
      // three candidate readers, all delegated before any is collected
      const candidates = f.next();
      expect(candidates).toMatchObject({
        state: "REVIEW",
        role: "review",
        mode: "candidates",
        dispatch: "d-001",
      });
      expect(candidates.batch.map((b: Json) => b.dispatch)).toEqual([
        "d-001",
        "d-002",
        "d-003",
      ]);
      const runs = candidates.batch.map((b: Json) => {
        f.brief(b.dispatch);
        const res = f.run("run", "--dispatch", b.dispatch);
        ok(res);
        return res;
      });
      const delegated = f.next();
      expect(delegated.needs).toBe("delegation");
      expect(delegated.items.map((i: Json) => [i.dispatch, i.needs])).toEqual([
        ["d-001", "delegation"],
        ["d-002", "delegation"],
        ["d-003", "delegation"],
      ]);
      expect(Object.keys(f.taskJson().batch.running)).toEqual([
        "d-001",
        "d-002",
        "d-003",
      ]);
      for (const res of runs) ok(complete(f, res));
      expect(
        fs.readFileSync(path.join(f.taskDir, "reports/d-003.md"), "utf-8"),
      ).toContain("kept 0, dropped 0");
      // nothing kept: full sweeps once instead of finishing
      const base = f.taskJson().base;
      expect(f.next()).toMatchObject({
        state: "REVIEW",
        role: "review",
        mode: "sweep",
        dispatch: "d-004",
        range: expect.stringMatching(new RegExp(`^${base}\\.\\.`)),
      });
      expect(dispatch(f, "d-004").status).toBe(0);
      expect(
        fs.readFileSync(path.join(f.tmp, "received/d-004.md"), "utf-8"),
      ).toContain("Mode: sweep");
      expect(f.taskJson()).toMatchObject({
        step: "verify",
        sweep_done: true,
        sweep_ids: ["src/app.txt:2:wrong word"],
      });
      expect(dispatch(f, "d-005").status).toBe(0);
      expect(f.next()).toMatchObject({ role: "fix", dispatch: "d-006" });
      expect(dispatch(f, "d-006").status).toBe(0);
      expect(f.taskJson()).toMatchObject({
        state: "GATE",
        after_gate: { state: "REVIEW", step: "recheck" },
      });
      // a small fix delta: one self-check reader over last_reviewed..HEAD, then FINISH (the sweep never repeats)
      ok(f.run("gate"));
      const reviewedTo = f.taskJson().last_reviewed;
      expect(f.next()).toMatchObject({
        role: "review",
        mode: "self-check",
        dispatch: "d-007",
        range: expect.stringMatching(new RegExp(`^${reviewedTo}\\.\\.`)),
      });
      expect(dispatch(f, "d-007").status).toBe(0);
      const data = f.taskJson();
      expect(data.state).toBe("FINISH");
      expect(
        data.dispatches.filter((d: Json) => d.mode === "sweep"),
      ).toHaveLength(1);
      expect(
        data.dispatches.filter((d: Json) => d.mode === "candidates"),
      ).toHaveLength(3);
    });
  },
);
