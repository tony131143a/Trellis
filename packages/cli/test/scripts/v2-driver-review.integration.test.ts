/**
 * arbor.py driver: invariant observations, fail-closed replies, the REVIEW
 * state (light self-check; standard / full self-verified candidates
 * -> fix -> candidates over the delta; the full sweep), the contract-hash
 * guard, override / abandon / status.
 */

import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import {
  IMPLEMENTED,
  TASK,
  dispatch,
  git,
  hasPython,
  setupFixture,
  writeFile,
  type Fixture,
} from "./v2-driver-helpers";

const GREEN_CHECK = { path: "tests/ac1.sh", content: "true\n" };

/** Commit a source change (plus `extra`) on the task branch and jump to `state` (STATE or STATE/step). */
function seedCode(
  f: Fixture,
  state: string,
  extra: { path: string; content: string }[] = [],
): void {
  for (const file of [
    { path: "src/app.txt", content: "one\ntwo\nthree\n" },
    ...extra,
  ]) {
    writeFile(f.wt, file.path, file.content);
    git(f.wt, "add", file.path);
  }
  git(
    f.wt,
    "commit",
    "-q",
    "-m",
    `implement(${TASK}): seed\n\nArbor-Dispatch: d-000`,
  );
  expect(
    f.run("override", "--reason", "test setup", "--to", state).status,
  ).toBe(0);
}

const finding = (
  file: string,
  line: number,
  verdict: string,
  summary = "off by one",
  repro?: object,
) => ({
  file,
  line,
  angle: "A",
  summary,
  failure_scenario: "x -> y",
  verdict,
  evidence: "two",
  fix: "z",
  ...(repro ? { repro } : {}),
});
/** A call path through files every review fixture has. */
const TRACE = { kind: "trace", path: ["src/app.txt:1", "src/app.txt:2"] };
const reviewReply = (verdict: string, findings: object[]) =>
  `${verdict}\n\n\`\`\`json\n${JSON.stringify(findings)}\n\`\`\`\nMode: m; angles: A; single-context pass.\n`;
const APP_FIX = { path: "src/app.txt", content: "one\nTWO\nthree\n" };
const FINDING_ID = "src/app.txt:2:off by one";

describe.skipIf(!hasPython())(
  "arbor.py validators and REVIEW",
  { timeout: 120_000 },
  () => {
    let f: Fixture;
    afterEach(() => f?.cleanup());

    it("records boundary observations without resetting commits, deleting files or stopping", () => {
      f = setupFixture();
      f.plan({
        "d-001": {
          write: IMPLEMENTED,
          dirty: [{ path: "stray.txt", content: "x" }],
        },
      });
      const before = git(f.wt, "rev-parse", "HEAD");
      const r = dispatch(f, "d-001");
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(git(f.wt, "log", "--format=%s", `${before}..HEAD`)).toContain(
        `implement(${TASK})`,
      );
      expect(fs.existsSync(path.join(f.wt, "src/feature.txt"))).toBe(true);
      expect(fs.readFileSync(path.join(f.wt, "stray.txt"), "utf-8")).toBe("x");
      const data = f.taskJson();
      expect(data.dispatches[0]).toMatchObject({ id: "d-001", status: "ok" });
      expect(data.state).toBe("GATE");
      expect(data.stop).toBeUndefined();
      expect(data.dispatches[0].observations.join("\n")).toContain(
        "implement left uncommitted changes: stray.txt",
      );
      expect(
        fs.readFileSync(path.join(f.taskDir, "reports/d-001.md"), "utf-8"),
      ).toContain("their author is not determined");
    });

    it("ambiguous reports require agent judgment without deleting work or entering STOP", () => {
      f = setupFixture();
      // (an empty reply is refused at collect time; a reply without the status line is kept for judgment)
      f.plan({ "d-001": { write: IMPLEMENTED, reply: "done, I think\n" } });
      expect(dispatch(f, "d-001").status).toBe(0);
      expect(f.next()).toMatchObject({
        needs: "decide",
        decision: { kind: "report" },
      });
      expect(fs.existsSync(path.join(f.wt, "tests/ac1.sh"))).toBe(true);
      expect(f.taskJson().dispatches[0]).toMatchObject({
        role: "implement",
        status: "judgment",
      });
      expect(
        f.run("decide", "retry", "--reason", "need actual report").status,
      ).toBe(0);
      expect(f.next()).toMatchObject({
        state: "BUILD",
        role: "implement",
        dispatch: "d-002",
      });
      seedCode(f, "REVIEW");
      f.plan({
        "d-002": { reply: `Looks fine to me.\n\n${reviewReply("PASS", [])}` },
      });
      expect(dispatch(f, "d-002").status).toBe(0);
      expect(f.taskJson().dispatches[1]).toMatchObject({
        role: "review",
        status: "judgment",
        confidence: "low",
      });
      expect(f.taskJson().state).toBe("REVIEW");
      expect(f.taskJson().stop).toBeUndefined();
      expect(f.taskJson().counters.no_progress).toBe(0);
    });

    it("REVIEW (light): FAIL -> fix -> gate -> re-review of last_reviewed..HEAD -> PASS -> FINISH", () => {
      f = setupFixture();
      seedCode(f, "REVIEW");
      f.plan({
        "d-001": {
          reply: reviewReply("FAIL", [finding("src/app.txt", 2, "CONFIRMED")]),
        },
        "d-002": { write: [APP_FIX], reply: "## Fix: Done\n" },
        "d-003": { reply: reviewReply("PASS", []) },
      });
      expect(f.next()).toMatchObject({
        state: "REVIEW",
        role: "review",
        mode: "self-check",
        dispatch: "d-001",
      });
      expect(f.next().batch).toBeUndefined(); // light: one reviewer
      expect(dispatch(f, "d-001").status).toBe(0);
      let data = f.taskJson();
      expect(data).toMatchObject({
        state: "REVIEW",
        step: "fix",
        counters: { review: 1 },
      });
      const reviewedTo = data.last_reviewed;
      expect(data.review_ids).toEqual([FINDING_ID]);
      expect(f.next()).toMatchObject({
        role: "fix",
        range: expect.stringMatching(new RegExp(`^${data.base}\\.\\.`)),
      });

      expect(dispatch(f, "d-002").status).toBe(0);
      expect(f.taskJson()).toMatchObject({
        state: "GATE",
        after_gate: { state: "REVIEW", step: "recheck" },
      });
      expect(f.next()).toMatchObject({ state: "GATE", needs: "run" });
      expect(f.run("gate").status).toBe(1); // AC-1's tests/ac1.sh does not exist on this branch
      f.run(
        "override",
        "--reason",
        "AC-1 is covered elsewhere in this test",
        "--to",
        "REVIEW",
      );
      const next = f.next();
      expect(next).toMatchObject({
        role: "review",
        mode: "self-check",
        range: expect.stringMatching(new RegExp(`^${reviewedTo}\\.\\.`)),
      });

      expect(dispatch(f, "d-003").status).toBe(0);
      data = f.taskJson();
      expect(data.state).toBe("FINISH");
      expect(f.next()).toMatchObject({ state: "FINISH", needs: "run" }); // `arbor finish` writes the scorecard
    });

    it("REVIEW (light): the third fix round passes the round cap -> STOP(BUDGET); resume grants one more", () => {
      f = setupFixture();
      seedCode(f, "REVIEW");
      const fail = (line: number) => ({
        reply: reviewReply("FAIL", [finding("src/app.txt", line, "CONFIRMED")]),
      });
      const fix = (content: string) => ({
        write: [{ path: "src/app.txt", content }],
      });
      f.plan({
        "d-001": fail(1),
        "d-002": fix("ONE\ntwo\nthree\n"),
        "d-003": fail(2),
        "d-004": fix("ONE\nTWO\nthree\n"),
        "d-005": fail(3),
      });
      for (const [review, fixId] of [
        ["d-001", "d-002"],
        ["d-003", "d-004"],
      ]) {
        expect(dispatch(f, review).status).toBe(0);
        expect(f.taskJson()).toMatchObject({ state: "REVIEW", step: "fix" });
        expect(dispatch(f, fixId).status).toBe(0);
        f.run("override", "--reason", "skip the gate", "--to", "REVIEW");
      }
      expect(f.taskJson().counters).toMatchObject({
        review: 2,
        no_progress: 0,
      }); // new findings each round: progress
      expect(dispatch(f, "d-005").status).toBe(0);
      let data = f.taskJson();
      expect(data.state).toBe("STOP");
      expect(data.stop).toMatchObject({
        reason: "BUDGET",
        counter: "review",
        value: 3,
        cap: 2,
        prev: { state: "REVIEW", step: "fix" },
      });
      expect(f.next()).toMatchObject({
        needs: "human",
        human: { kind: "stop", mandate: "ask" },
      });
      expect(f.run("resume").status).toBe(0);
      data = f.taskJson();
      // The cap moves past the value that tripped it (3) plus one more round: 2 + 2 = 4.
      expect(data).toMatchObject({
        state: "REVIEW",
        step: "fix",
        caps_extra: { review: 2 },
      });
      expect(f.next()).toMatchObject({ role: "fix", dispatch: "d-006" });
    });

    it("REVIEW (standard): 2 candidate readers verify their own findings -> dedup + prefilter -> PLAUSIBLE -> decide skip -> FINISH", () => {
      f = setupFixture({ tier: "standard" });
      seedCode(f, "REVIEW/candidates");
      f.plan({
        "d-001": {
          reply: reviewReply("FAIL", [
            finding("src/app.txt", 2, "PLAUSIBLE"),
            finding("src/gone.txt", 1, "PLAUSIBLE"),
          ]),
        },
        "d-002": {
          reply: reviewReply("FAIL", [
            finding("src/app.txt", 2, "PLAUSIBLE"),
            finding("README.md", 1, "PLAUSIBLE", "old"),
            finding("src/app.txt", 3, "REFUTED", "guarded"),
          ]),
        },
      });
      expect(f.taskJson()).toMatchObject({
        state: "REVIEW",
        step: "candidates",
        cycle: { candidates_done: 0 },
      });
      const next = f.next();
      expect(next).toMatchObject({
        state: "REVIEW",
        role: "review",
        mode: "candidates",
        dispatch: "d-001",
      });
      expect(next.batch.map((b: { dispatch: string }) => b.dispatch)).toEqual([
        "d-001",
        "d-002",
      ]);
      expect(dispatch(f, "d-001").status).toBe(0);
      expect(f.taskJson().cycle.candidates_done).toBe(1);
      expect(dispatch(f, "d-002").status).toBe(0);

      const data = f.taskJson();
      expect(data).toMatchObject({
        state: "REVIEW",
        step: "plausible",
        counters: { review: 1 },
        cycle_ids: [FINDING_ID],
        decision: { kind: "plausible", failing: [FINDING_ID] },
      });
      expect(data.cycle).toMatchObject({
        confirmed: [],
        plausible: [FINDING_ID],
        candidates_file: `.arbor/tasks/${TASK}/reports/candidates-r1.json`,
      });
      const filtered = JSON.parse(
        fs.readFileSync(
          path.join(f.taskDir, "reports/candidates-r1.json"),
          "utf-8",
        ),
      );
      expect(filtered.kept.map((k: { id: string }) => k.id)).toEqual([
        FINDING_ID,
      ]);
      expect(
        filtered.dropped.map((d: { reason: string }) => d.reason).sort(),
      ).toEqual([
        expect.stringContaining("README.md:1 is not within 5 lines"),
        "file src/gone.txt does not exist",
      ]);
      expect(
        fs.readFileSync(path.join(f.taskDir, "reports/d-002.md"), "utf-8"),
      ).toContain("- kept 1, dropped 2 -> reports/candidates-r1.json");
      expect(f.next()).toMatchObject({
        needs: "human",
        human: { kind: "plausible", mandate: "ask" },
      });
      expect(f.run("decide", "impl", "--reason", "x").status).toBe(1);
      expect(
        f.run("decide", "skip", "--reason", "trigger is unrealistic").status,
      ).toBe(0);
      const done = f.taskJson();
      expect(done.state).toBe("FINISH");
      expect(done.cycle).toBeUndefined();
      expect(done.decisions.at(-1)).toMatchObject({
        kind: "plausible",
        choice: "skip",
      });
    });

    it("REVIEW (standard): readers that disagree on a finding keep its CONFIRMED copy", () => {
      f = setupFixture({ tier: "standard" });
      seedCode(f, "REVIEW/candidates", [GREEN_CHECK]);
      f.plan({
        "d-001": {
          reply: reviewReply("FAIL", [finding("src/app.txt", 2, "PLAUSIBLE")]),
        },
        "d-002": {
          reply: reviewReply("FAIL", [
            finding("src/app.txt", 2, "CONFIRMED", undefined, TRACE),
          ]),
        },
      });
      expect(dispatch(f, "d-001").status).toBe(0);
      expect(dispatch(f, "d-002").status).toBe(0);
      expect(f.taskJson()).toMatchObject({
        state: "REVIEW",
        step: "fix",
        cycle: { confirmed: [FINDING_ID], plausible: [], fix: [FINDING_ID] },
      });
    });

    /** Two candidate readers on a standard task (`d-001` = ``reader``, `d-002` PASS); returns once both are collected. */
    function toReviewed(reader: object): void {
      f = setupFixture({ tier: "standard" });
      seedCode(f, "REVIEW/candidates", [GREEN_CHECK]);
      f.plan({
        "d-001": reader,
        "d-002": { reply: reviewReply("PASS", []) },
        "d-003": { write: [APP_FIX] },
        "d-004": { reply: reviewReply("PASS", []) },
      });
      expect(dispatch(f, "d-001").status).toBe(0);
      expect(dispatch(f, "d-002").status).toBe(0);
    }
    const REPRO_REL = `.arbor/tasks/${TASK}/research/repro/d-001-1.sh`;
    const EXEC = {
      kind: "exec",
      path: "research/repro/d-001-1.sh",
      command: `sh ${REPRO_REL}`,
      exit: 1,
      output_tail: "",
    };
    const execReader = () => ({
      dirty: [{ path: REPRO_REL, content: "grep -q TWO src/app.txt\n" }],
      reply: reviewReply("FAIL", [
        finding("src/app.txt", 2, "CONFIRMED", undefined, EXEC),
      ]),
    });

    it("REVIEW (standard): a CONFIRMED verdict with an exec repro stays CONFIRMED; the repro is committed with the reader's report", () => {
      toReviewed(execReader());
      const data = f.taskJson();
      expect(data).toMatchObject({
        state: "REVIEW",
        step: "fix",
        cycle: {
          fix: [FINDING_ID],
          repros: {
            [FINDING_ID]: {
              kind: "exec",
              path: REPRO_REL,
              command: `sh ${REPRO_REL}`,
            },
          },
        },
      });
      expect(data.dispatches[0].downgraded).toBeUndefined();
      expect(data.dispatches[0].observations).toEqual([]);
      const reproCommit = git(
        f.wt,
        "log",
        "-1",
        "--format=%H",
        "--",
        REPRO_REL,
      );
      const committed = git(
        f.wt,
        "show",
        "--name-only",
        "--format=",
        reproCommit,
      );
      expect(committed).toContain(`.arbor/tasks/${TASK}/reports/d-001.md`);
      expect(committed).toContain(REPRO_REL);
      expect(f.next()).toMatchObject({
        role: "fix",
        repros: { [FINDING_ID]: { kind: "exec" } },
      });
    });

    it("REVIEW (standard): a CONFIRMED verdict without a valid repro is read as PLAUSIBLE, with an observation", () => {
      toReviewed({
        reply: reviewReply("FAIL", [
          finding("src/app.txt", 2, "CONFIRMED"),
          finding("src/app.txt", 3, "CONFIRMED", "one step", {
            kind: "trace",
            path: ["src/app.txt:3"],
          }),
        ]),
      });
      const shallow = "src/app.txt:3:one step";
      const data = f.taskJson();
      expect(data).toMatchObject({
        state: "REVIEW",
        step: "plausible",
        decision: { kind: "plausible", failing: [FINDING_ID, shallow] },
      });
      expect(data.dispatches[0]).toMatchObject({
        status: "ok",
        downgraded: [FINDING_ID, shallow],
      });
      expect(
        fs.readFileSync(path.join(f.taskDir, "reports/d-001.md"), "utf-8"),
      ).toContain(
        `CONFIRMED without repro downgraded to PLAUSIBLE: ${FINDING_ID}, ${shallow}`,
      );
    });

    it("REVIEW (standard): the recheck gate runs every exec repro as REPRO-n; a repro that still fails is a red gate", () => {
      toReviewed(execReader());
      f.plan({
        "d-003": {
          write: [{ path: "src/app.txt", content: "one\ntwo\nthree\nfour\n" }],
        },
      });
      expect(dispatch(f, "d-003").status).toBe(0);
      expect(f.run("gate").status).toBe(1);
      expect(f.taskJson()).toMatchObject({
        state: "GATE",
        step: "decide",
        gate_failing: ["REPRO-1"],
      });
      const report = fs.readFileSync(
        path.join(f.taskDir, "reports/gate-1.md"),
        "utf-8",
      );
      expect(report).toContain(`repros: REPRO-1 = ${FINDING_ID}`);
      expect(report).toContain("- REPRO-1: exit 1");
    });

    it("REVIEW (standard): when the passing repros cover every fixed finding, the small fix skips the self-check -> FINISH", () => {
      toReviewed(execReader());
      expect(dispatch(f, "d-003").status).toBe(0);
      const fixed = git(f.wt, "rev-parse", "HEAD");
      expect(f.run("gate").status).toBe(0);
      const data = f.taskJson();
      expect(data).toMatchObject({
        state: "FINISH",
        last_reviewed: fixed,
        recheck_skips: [{ reason: "repros", findings: [FINDING_ID], gate: 1 }],
      });
      expect(data.dispatches.map((d: { id: string }) => d.id)).not.toContain(
        "d-004",
      );
      expect(
        fs.readFileSync(path.join(f.taskDir, "reports/gate-1.md"), "utf-8"),
      ).toContain("- REPRO-1: pass");
    });

    it("REVIEW (standard): a trace repro is not executable, so the fix still gets its self-check", () => {
      toReviewed({
        reply: reviewReply("FAIL", [
          finding("src/app.txt", 2, "CONFIRMED", undefined, TRACE),
        ]),
      });
      expect(f.taskJson().cycle.repros[FINDING_ID]).toEqual(TRACE);
      expect(dispatch(f, "d-003").status).toBe(0);
      expect(f.run("gate").status).toBe(0);
      expect(f.taskJson()).toMatchObject({ state: "REVIEW", step: "review" });
      expect(f.next()).toMatchObject({ mode: "self-check", dispatch: "d-004" });
    });

    it("REVIEW (standard): candidates CONFIRMED -> fix -> GATE -> one self-check over the delta -> FINISH", () => {
      f = setupFixture({ tier: "standard" });
      seedCode(f, "REVIEW/candidates", [GREEN_CHECK]);
      const base = f.taskJson().base;
      f.plan({
        "d-001": {
          reply: reviewReply("FAIL", [
            finding("src/app.txt", 2, "CONFIRMED", undefined, TRACE),
          ]),
        },
        "d-002": { reply: reviewReply("PASS", []) },
        "d-003": { write: [APP_FIX] },
        "d-004": { reply: reviewReply("PASS", []) },
      });
      expect(f.taskJson()).toMatchObject({
        state: "REVIEW",
        step: "candidates",
        cycle: { range_from: base },
      });
      expect(f.next()).toMatchObject({
        role: "review",
        mode: "candidates",
        dispatch: "d-001",
        range: expect.stringMatching(new RegExp(`^${base}\\.\\.`)),
      });
      expect(dispatch(f, "d-001").status).toBe(0);
      expect(dispatch(f, "d-002").status).toBe(0);
      let data = f.taskJson();
      expect(data).toMatchObject({
        state: "REVIEW",
        step: "fix",
        counters: { review: 1 },
        cycle_ids: [FINDING_ID],
        cycle: { confirmed: [FINDING_ID], fix: [FINDING_ID] },
      });
      const reviewedTo = data.last_reviewed;
      expect(f.next()).toMatchObject({
        role: "fix",
        dispatch: "d-003",
        range: expect.stringMatching(new RegExp(`^${base}\\.\\.`)),
      });
      expect(dispatch(f, "d-003").status).toBe(0);
      expect(f.taskJson()).toMatchObject({
        state: "GATE",
        after_gate: { state: "REVIEW", step: "recheck" },
      });
      expect(f.run("gate").status).toBe(0);

      // A small fix delta: one self-check reader over last_reviewed..HEAD instead of a new candidate cycle.
      data = f.taskJson();
      expect(data).toMatchObject({ state: "REVIEW", step: "review" });
      const next = f.next();
      expect(next).toMatchObject({
        role: "review",
        mode: "self-check",
        dispatch: "d-004",
        range: expect.stringMatching(new RegExp(`^${reviewedTo}\\.\\.`)),
      });
      expect(next.batch).toBeUndefined();
      expect(dispatch(f, "d-004").status).toBe(0);
      data = f.taskJson();
      expect(data).toMatchObject({
        state: "FINISH",
        counters: { gate: 1, review: 1, no_progress: 0 },
        review_ids: [],
      });
      expect(data.cycle).toBeUndefined();
      expect(
        fs.existsSync(path.join(f.taskDir, "reports/candidates-r2.json")),
      ).toBe(false);
      expect(
        data.dispatches.map(
          (d: { id: string; role: string; mode: string | null }) => [
            d.id,
            d.role,
            d.mode,
          ],
        ),
      ).toEqual([
        ["d-001", "review", "candidates"],
        ["d-002", "review", "candidates"],
        ["d-003", "fix", null],
        ["d-004", "review", "self-check"],
      ]);
    });

    it("REVIEW (standard): a fix delta above auto_merge_max_lines reopens the candidate cycle over the delta", () => {
      f = setupFixture({ tier: "standard" });
      fs.appendFileSync(
        path.join(f.repo, ".arbor/config.yaml"),
        "\nmandate:\n  auto_merge_max_lines: 1\n",
      );
      seedCode(f, "REVIEW/candidates", [GREEN_CHECK]);
      f.plan({
        "d-001": {
          reply: reviewReply("FAIL", [
            finding("src/app.txt", 2, "CONFIRMED", undefined, TRACE),
          ]),
        },
        "d-002": { reply: reviewReply("PASS", []) },
        "d-003": { write: [APP_FIX] },
        "d-004": { reply: reviewReply("PASS", []) },
        "d-005": { reply: reviewReply("PASS", []) },
      });
      for (const id of ["d-001", "d-002", "d-003"])
        expect(dispatch(f, id).status).toBe(0);
      const reviewedTo = f.taskJson().last_reviewed;
      expect(f.run("gate").status).toBe(0);
      const data = f.taskJson();
      expect(data).toMatchObject({
        state: "REVIEW",
        step: "candidates",
        cycle: { range_from: reviewedTo, candidates_done: 0 },
      });
      const next = f.next();
      expect(next).toMatchObject({
        role: "review",
        mode: "candidates",
        dispatch: "d-004",
        range: expect.stringMatching(new RegExp(`^${reviewedTo}\\.\\.`)),
      });
      expect(next.batch.map((b: { dispatch: string }) => b.dispatch)).toEqual([
        "d-004",
        "d-005",
      ]);
      expect(dispatch(f, "d-004").status).toBe(0);
      expect(dispatch(f, "d-005").status).toBe(0);
      expect(f.taskJson()).toMatchObject({ state: "FINISH", cycle_ids: [] });
      expect(
        fs.existsSync(path.join(f.taskDir, "reports/candidates-r2.json")),
      ).toBe(true);
    });

    it("REVIEW (standard): candidate readers in a delta cycle are told the task base", () => {
      f = setupFixture({ tier: "standard" });
      fs.appendFileSync(
        path.join(f.repo, ".arbor/config.yaml"),
        "\nmandate:\n  auto_merge_max_lines: 1\n",
      );
      seedCode(f, "REVIEW/candidates", [GREEN_CHECK]);
      const base = f.taskJson().base;
      const confirmed = reviewReply("FAIL", [
        finding("src/app.txt", 2, "CONFIRMED", undefined, TRACE),
      ]);
      f.plan({
        "d-001": { reply: confirmed },
        "d-002": { reply: reviewReply("PASS", []) },
        "d-003": { write: [APP_FIX] },
        "d-004": { reply: confirmed },
        "d-005": { reply: reviewReply("PASS", []) },
      });
      for (const id of ["d-001", "d-002", "d-003"])
        expect(dispatch(f, id).status).toBe(0);
      expect(f.run("gate").status).toBe(0);
      for (const id of ["d-004", "d-005"])
        expect(dispatch(f, id).status).toBe(0);
      const prompt = (id: string) =>
        fs.readFileSync(path.join(f.tmp, "received", `${id}.md`), "utf-8");
      expect(prompt("d-001")).not.toContain("Task base:");
      expect(prompt("d-004")).toContain(`Task base: ${base}.`);
    });

    it("REVIEW (full): 3 candidate readers, a clean cycle -> one self-verified sweep over base..HEAD -> fix -> GATE -> self-check -> FINISH", () => {
      f = setupFixture({ tier: "full" });
      seedCode(f, "REVIEW/candidates", [GREEN_CHECK]);
      const base = f.taskJson().base;
      f.plan({
        "d-001": { reply: reviewReply("PASS", []) },
        "d-002": { reply: reviewReply("PASS", []) },
        "d-003": { reply: reviewReply("PASS", []) },
        "d-004": {
          reply: reviewReply("FAIL", [
            finding("src/app.txt", 2, "CONFIRMED", undefined, TRACE),
          ]),
        },
        "d-005": { write: [APP_FIX] },
        "d-006": { reply: reviewReply("PASS", []) },
      });
      const next = f.next();
      expect(next).toMatchObject({
        role: "review",
        mode: "candidates",
        dispatch: "d-001",
      });
      expect(next.batch.map((b: { dispatch: string }) => b.dispatch)).toEqual([
        "d-001",
        "d-002",
        "d-003",
      ]);
      for (const id of ["d-001", "d-002", "d-003"])
        expect(dispatch(f, id).status).toBe(0);

      let data = f.taskJson();
      expect(data).toMatchObject({
        state: "REVIEW",
        step: "sweep",
        cycle: { sweep: true, range_from: base },
        counters: { review: 0 },
      });
      expect(data.sweep_done).toBeUndefined();
      expect(f.next()).toMatchObject({
        role: "review",
        mode: "sweep",
        dispatch: "d-004",
        range: expect.stringMatching(new RegExp(`^${base}\\.\\.`)),
      });
      expect(f.next().batch).toBeUndefined();
      expect(dispatch(f, "d-004").status).toBe(0);
      data = f.taskJson();
      expect(data).toMatchObject({
        state: "REVIEW",
        step: "fix",
        sweep_done: true,
        sweep_ids: [FINDING_ID],
        cycle: { sweep: true, fix: [FINDING_ID] },
      });
      expect(
        JSON.parse(
          fs.readFileSync(path.join(f.taskDir, "reports/sweep.json"), "utf-8"),
        ).kept.map((k: { id: string }) => k.id),
      ).toEqual([FINDING_ID]);
      expect(f.next()).toMatchObject({
        role: "fix",
        dispatch: "d-005",
        range: expect.stringMatching(new RegExp(`^${base}\\.\\.`)),
      });
      expect(dispatch(f, "d-005").status).toBe(0);
      expect(f.taskJson()).toMatchObject({
        state: "GATE",
        after_gate: { state: "REVIEW", step: "recheck" },
      });
      expect(f.run("gate").status).toBe(0);
      const reviewedTo = f.taskJson().last_reviewed;
      expect(f.next()).toMatchObject({
        role: "review",
        mode: "self-check",
        dispatch: "d-006",
        range: expect.stringMatching(new RegExp(`^${reviewedTo}\\.\\.`)),
      });
      expect(dispatch(f, "d-006").status).toBe(0);
      data = f.taskJson();
      expect(data.state).toBe("FINISH"); // the sweep never repeats
      expect(data.sweep_done).toBe(true);
      expect(data.cycle).toBeUndefined();
      expect(f.taskJson().counters.gate).toBe(1);
    });

    it("role instructions come from the driver's install, not the task worktree's copy", () => {
      f = setupFixture();
      seedCode(f, "REVIEW");
      writeFile(f.repo, ".arbor/agents/review.md", "# MAIN-ROLE review\n");
      writeFile(f.wt, ".arbor/agents/review.md", "# STALE-WORKTREE review\n");
      f.plan({ "d-001": { reply: reviewReply("PASS", []) } });
      expect(dispatch(f, "d-001").status).toBe(0);
      const received = fs.readFileSync(
        path.join(f.tmp, "received/d-001.md"),
        "utf-8",
      );
      expect(received).toContain("# MAIN-ROLE review");
      expect(received).not.toContain("STALE-WORKTREE");
      expect(received).toContain(
        path.join(f.repo, ".arbor/scripts/check_report.py"),
      );
    });

    it("contract edits are observations, not a frozen-hash execution gate", () => {
      f = setupFixture();
      const frozen = f.taskJson().contract_hash;
      fs.appendFileSync(
        path.join(f.taskDir, "contract.md"),
        "\nUpdated planning explanation.\n",
      );
      expect(f.next()).toMatchObject({
        state: "BUILD",
        needs: "brief",
        observations: expect.any(Array),
      });
      f.plan({ "d-001": { write: IMPLEMENTED } });
      const r = dispatch(f, "d-001");
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.stderr).toContain("contract.md differs");
      expect(f.taskJson().stop).toBeUndefined();
      expect(f.taskJson().contract_hash).toBe(frozen);
      expect(f.taskJson().dispatches[0].observations).toContain(
        "contract.md differs from the recorded approval",
      );
      expect(f.next()).toMatchObject({
        state: "GATE",
        needs: "run",
        observations: expect.any(Array),
      });
    });

    it("override --role dispatches once without advancing; abandon stops; status prints", () => {
      f = setupFixture();
      expect(
        f.run(
          "override",
          "--reason",
          "need a second opinion",
          "--role",
          "explore",
        ).status,
      ).toBe(0);
      expect(f.next()).toMatchObject({
        state: "BUILD",
        role: "explore",
        dispatch: "d-001",
      });
      expect(dispatch(f, "d-001").status).toBe(0);
      let data = f.taskJson();
      expect(data).toMatchObject({ state: "BUILD" });
      expect(data.dispatches[0]).toMatchObject({
        role: "explore",
        override: true,
      });
      expect(data.overrides[0]).toMatchObject({
        role: "explore",
        reason: "need a second opinion",
      });
      expect(f.next()).toMatchObject({ role: "implement", dispatch: "d-002" });

      expect(f.run("abandon", "--reason", "scope moved").status).toBe(0);
      data = f.taskJson();
      expect(data.stop).toMatchObject({
        reason: "HUMAN",
        detail: "abandoned: scope moved",
      });
      const status = f.run("status");
      expect(status.status).toBe(0);
      expect(status.stdout).toContain("STOP/stop");
      expect(status.stdout).toContain("d-001 explore");
      expect(status.stdout).toContain(
        "mandate: contract=ask, plausible=ask, merge=ask",
      );
    });
  },
);
