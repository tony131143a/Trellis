/**
 * Round caps as escalation gates: NO_PROGRESS (gate rounds, failed
 * dispatches) and BUDGET (review fix rounds) enter STOP; `resume` leaves it
 * and raises that cap by one.
 */

import { afterEach, describe, expect, it } from "vitest";

import {
  IMPLEMENTED,
  RED_TEST,
  TASK,
  dispatch,
  git,
  hasPython,
  setupFixture,
  writeFile,
  type Fixture,
} from "./v2-driver-helpers";

function seedCode(f: Fixture, state: string): void {
  writeFile(f.wt, "src/app.txt", "one\ntwo\nthree\n");
  writeFile(f.wt, "tests/ac1.sh", "true\n"); // AC-1 passes so GATE is green between fix rounds
  git(f.wt, "add", "src/app.txt", "tests/ac1.sh");
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

const finding = (file: string, line: number, summary: string) => ({
  file,
  line,
  angle: "A",
  summary,
  failure_scenario: "x -> y",
  verdict: "CONFIRMED",
  evidence: "two",
  fix: "z",
});
const reviewReply = (verdict: string, findings: object[]) =>
  `${verdict}\n\n\`\`\`json\n${JSON.stringify(findings)}\n\`\`\`\nMode: m; angles: A; single-context pass.\n`;

describe.skipIf(!hasPython())(
  "arbor.py round caps",
  { timeout: 90_000 },
  () => {
    let f: Fixture;
    afterEach(() => f?.cleanup());

    it("two consecutive red gates escalate a light task to standard; the green gate then enters candidates", () => {
      f = setupFixture({ gate: ["test -f a.txt", "test -f b.txt"] });
      f.plan({
        "d-001": { write: IMPLEMENTED },
        "d-002": { write: [{ path: "a.txt", content: "a\n" }] },
        "d-003": { write: [{ path: "b.txt", content: "b\n" }] },
      });
      expect(dispatch(f, "d-001").status).toBe(0);
      expect(f.run("gate").status).toBe(1);
      expect(f.taskJson().meta.tier).toBe("light");
      expect(f.run("decide", "impl", "--reason", "missing").status).toBe(0);
      expect(dispatch(f, "d-002").status).toBe(0);
      const second = f.run("gate");
      expect(second.status).toBe(1); // progress: GATE-1 now passes
      expect(second.stdout).toContain(
        "tier: light -> standard (2 consecutive red gates)",
      );
      expect(f.taskJson()).toMatchObject({
        state: "GATE",
        step: "decide",
        gate_reds: 2,
        meta: { tier: "standard" },
        tier_history: [expect.objectContaining({ signal: "gate_reds" })],
      });
      expect(f.run("decide", "impl", "--reason", "missing").status).toBe(0);
      expect(dispatch(f, "d-003").status).toBe(0);
      expect(f.run("gate").status).toBe(0);
      expect(f.taskJson()).toMatchObject({
        state: "REVIEW",
        step: "candidates",
      });
      expect(f.taskJson().tier_history).toHaveLength(1);
    });

    it("two red gates without progress still escalate; the no-progress count is kept", () => {
      f = setupFixture({ gate: ["exit 3"] });
      f.plan({
        "d-001": { write: IMPLEMENTED },
        "d-002": { write: [{ path: "src/a.txt", content: "1\n" }] },
      });
      expect(dispatch(f, "d-001").status).toBe(0);
      expect(f.run("gate").status).toBe(1);
      expect(f.run("decide", "impl", "--reason", "impl bug").status).toBe(0);
      expect(dispatch(f, "d-002").status).toBe(0);
      expect(f.run("gate").status).toBe(1);
      expect(f.taskJson()).toMatchObject({
        state: "GATE",
        meta: { tier: "standard" },
        counters: { no_progress: 1 },
      });
      expect(f.next().tier).toBe("standard");
    });

    it("two red gate rounds without progress -> STOP(NO_PROGRESS); resume continues", () => {
      f = setupFixture({ gate: ["exit 3"] });
      f.plan({
        "d-001": { write: IMPLEMENTED },
        "d-002": { write: [{ path: "src/a.txt", content: "1\n" }] },
        "d-003": { write: [{ path: "src/a.txt", content: "2\n" }] },
      });
      expect(dispatch(f, "d-001").status).toBe(0);
      expect(f.run("gate").status).toBe(1); // round 1: first red never counts as no progress
      expect(f.run("decide", "impl", "--reason", "impl bug").status).toBe(0);
      expect(dispatch(f, "d-002").status).toBe(0);
      expect(f.run("gate").status).toBe(1); // round 2: no_progress 1
      expect(f.taskJson()).toMatchObject({
        state: "GATE",
        step: "decide",
        counters: { no_progress: 1 },
      });
      expect(f.run("decide", "impl", "--reason", "try again").status).toBe(0);
      expect(dispatch(f, "d-003").status).toBe(0);
      expect(f.run("gate").status).toBe(1); // round 3: no_progress 2 -> STOP
      let data = f.taskJson();
      expect(data.state).toBe("STOP");
      expect(data.stop).toMatchObject({
        reason: "NO_PROGRESS",
        counter: "no_progress",
      });
      expect(f.next()).toMatchObject({
        state: "STOP",
        needs: "human",
        human: { kind: "stop" },
      });
      expect(f.run("run").status).toBe(1);
      expect(f.run("gate").status).toBe(1);

      expect(f.run("resume").status).toBe(0);
      data = f.taskJson();
      expect(data.state).toBe("GATE");
      expect(data.stop).toBeUndefined();
      expect(data.counters.no_progress).toBe(0);
      expect(data.caps_extra).toBeUndefined(); // NO_PROGRESS resets the counter instead
      expect(f.next()).toMatchObject({
        state: "GATE",
        needs: "decide",
        decision: { kind: "gate_red" },
      });
    });

    it("two failed dispatches -> STOP(NO_PROGRESS) with all work preserved; resume -> the step repeats", () => {
      f = setupFixture();
      f.plan({
        "d-001": {
          write: [RED_TEST],
          dirty: [{ path: "local.txt", content: "keep me" }],
          exit: 4,
        },
        "d-002": {
          write: [{ path: "tests/extra.txt", content: "second attempt" }],
          exit: 4,
        },
        "d-003": {
          write: [
            {
              path: "tests/ac1.sh",
              content: "test -f src/feature.txt # retry\n",
            },
          ],
        },
      });
      expect(dispatch(f, "d-001").status).toBe(1);
      expect(f.taskJson()).toMatchObject({
        state: "BUILD",
        counters: { no_progress: 1 },
      });
      expect(dispatch(f, "d-002").status).toBe(1);
      const data = f.taskJson();
      expect(data).toMatchObject({
        state: "STOP",
        stop: { reason: "NO_PROGRESS" },
        counters: { no_progress: 2 },
      });
      expect(data.dispatches.map((d: { status: string }) => d.status)).toEqual([
        "fail",
        "fail",
      ]);
      expect(git(f.wt, "log", "--format=%s")).toContain(
        `implement(${TASK}): work`,
      );
      expect(f.next()).toMatchObject({
        needs: "human",
        human: { kind: "stop" },
      });
      f.brief("d-003");
      expect(f.run("run", "--dispatch", "d-003").status).toBe(1);

      expect(f.run("resume").status).toBe(0);
      expect(f.next()).toMatchObject({
        state: "BUILD",
        needs: "brief",
        role: "implement",
        dispatch: "d-003",
      });
      const ok = dispatch(f, "d-003");
      expect(ok.status, ok.stdout + ok.stderr).toBe(0);
      expect(f.taskJson()).toMatchObject({ state: "GATE", step: "gate" });
    });

    it("review fix rounds past the cap -> STOP(BUDGET); resume grants one more round", () => {
      f = setupFixture(); // light: self-check review, 2 fix rounds
      seedCode(f, "REVIEW");
      f.plan({
        "d-001": {
          reply: reviewReply("FAIL", [finding("src/app.txt", 1, "first")]),
        },
        "d-002": {
          write: [{ path: "src/app.txt", content: "ONE\ntwo\nthree\n" }],
          reply: "## Fix: Done\n",
        },
        "d-003": {
          reply: reviewReply("FAIL", [finding("src/app.txt", 2, "second")]),
        },
        "d-004": {
          write: [{ path: "src/app.txt", content: "ONE\nTWO\nthree\n" }],
          reply: "## Fix: Done\n",
        },
        "d-005": {
          reply: reviewReply("FAIL", [finding("src/app.txt", 3, "third")]),
        },
        "d-006": {
          write: [{ path: "src/app.txt", content: "ONE\nTWO\nTHREE\n" }],
          reply: "## Fix: Done\n",
        },
        "d-007": { reply: reviewReply("PASS", []) },
      });
      expect(f.next()).toMatchObject({
        state: "REVIEW",
        role: "review",
        mode: "self-check",
        dispatch: "d-001",
      });
      expect(dispatch(f, "d-001").status).toBe(0);
      expect(f.taskJson()).toMatchObject({
        state: "REVIEW",
        step: "fix",
        counters: { review: 1 },
      });
      expect(dispatch(f, "d-002").status).toBe(0);
      expect(f.run("gate").status).toBe(0);
      expect(dispatch(f, "d-003").status).toBe(0);
      expect(f.taskJson()).toMatchObject({
        state: "REVIEW",
        step: "fix",
        counters: { review: 2, no_progress: 0 },
      });
      expect(dispatch(f, "d-004").status).toBe(0);
      expect(f.run("gate").status).toBe(0);
      expect(dispatch(f, "d-005").status).toBe(0);
      let data = f.taskJson();
      expect(data.state).toBe("STOP");
      expect(data.stop).toMatchObject({ reason: "BUDGET", counter: "review" });
      expect(data.stop.detail).toContain("review fix rounds (3 > 2)");
      expect(f.next()).toMatchObject({
        needs: "human",
        human: { kind: "stop" },
      });

      expect(f.run("resume").status).toBe(0);
      data = f.taskJson();
      expect(data.caps_extra).toEqual({ review: 2 }); // cap 2 -> 4: the tripping round plus one more
      expect(data.state).toBe("REVIEW");
      expect(f.next()).toMatchObject({
        state: "REVIEW",
        role: "fix",
        dispatch: "d-006",
      });
      expect(dispatch(f, "d-006").status).toBe(0);
      expect(f.run("gate").status).toBe(0);
      expect(dispatch(f, "d-007").status).toBe(0);
      expect(f.taskJson().state).toBe("FINISH");
    });
  },
);
