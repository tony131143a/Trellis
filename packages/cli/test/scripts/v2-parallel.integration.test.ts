/**
 * arbor.py reader batches: the REVIEW candidate readers (standard: 2) get
 * their dispatch ids up front, are all started as Orca workers before
 * any is collected, and may be collected in any order; the step completes
 * when the last reader is in.
 */

import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import {
  TASK,
  complete,
  dispatch,
  git,
  hasPython,
  orcaCalls,
  setOrcaState,
  setupFixture,
  writeFile,
  type Fixture,
} from "./v2-driver-helpers";

const finding = (
  file: string,
  line: number,
  verdict: string,
  summary = "off by one",
) => ({
  file,
  line,
  angle: "A",
  summary,
  failure_scenario: "x -> y",
  verdict,
  evidence: "two",
  fix: "z",
});
const reviewReply = (verdict: string, findings: object[]) =>
  `${verdict}\n\n\`\`\`json\n${JSON.stringify(findings)}\n\`\`\`\nMode: m; angles: A; single-context pass.\n`;
const FINDING_ID = "src/app.txt:2:off by one";

/** Commit a source change and jump to REVIEW/candidates: the candidate batch opens. */
function seedCandidates(f: Fixture): void {
  writeFile(f.wt, "src/app.txt", "one\ntwo\nthree\n");
  git(f.wt, "add", "src/app.txt");
  git(
    f.wt,
    "commit",
    "-q",
    "-m",
    `implement(${TASK}): seed\n\nArbor-Dispatch: d-000`,
  );
  expect(
    f.run("override", "--reason", "test setup", "--to", "REVIEW/candidates")
      .status,
  ).toBe(0);
  expect(f.taskJson()).toMatchObject({
    state: "REVIEW",
    step: "candidates",
    batch: { key: "REVIEW/candidates", ids: ["d-001", "d-002"] },
  });
}

describe.skipIf(!hasPython())(
  "arbor.py parallel readers",
  { timeout: 120_000 },
  () => {
    let f: Fixture;
    afterEach(() => f?.cleanup());

    it("standard candidates: two readers get ids up front, both run before either is collected, findings unite", () => {
      f = setupFixture({ tier: "standard" });
      seedCandidates(f);
      const next = f.next();
      expect(next).toMatchObject({
        state: "REVIEW",
        needs: "brief",
        role: "review",
        mode: "candidates",
        dispatch: "d-001",
      });
      expect(next.batch.map((b: { dispatch: string }) => b.dispatch)).toEqual([
        "d-001",
        "d-002",
      ]);
      expect(next.batch[1].brief_path).toBe(
        path.join(f.taskDir, "briefs/d-002.md"),
      );
      expect(next.summary).toContain("may run concurrently");
      // The ready set lists every reader of the batch as its own item.
      expect(
        next.items.map(
          (i: { role: string; dispatch: string; brief_path: string }) => [
            i.role,
            i.dispatch,
            i.brief_path,
          ],
        ),
      ).toEqual([
        ["review", "d-001", path.join(f.taskDir, "briefs/d-001.md")],
        ["review", "d-002", path.join(f.taskDir, "briefs/d-002.md")],
      ]);

      f.plan({
        "d-001": { reply: reviewReply("PASS", []) },
        "d-002": {
          reply: reviewReply("FAIL", [finding("src/app.txt", 2, "PLAUSIBLE")]),
        },
      });
      f.brief("d-001", "Angles: A, Acceptance");
      f.brief("d-002", "Angles: B, Conventions");
      // The printed prompt of the second reader is available before it runs.
      expect(
        f.run("prompt", "--dispatch", "d-002", "--print").stdout,
      ).toContain("Angles: B, Conventions");
      const second = f.run("run", "--dispatch", "d-002");
      const first = f.run("run", "--dispatch", "d-001");
      expect(f.taskJson().batch).toMatchObject({
        ids: [],
        running: { "d-001": { external: true }, "d-002": { external: true } },
      });
      const a = complete(f, second);
      expect(a.status, a.stdout + a.stderr).toBe(0);
      expect(
        fs.readFileSync(path.join(f.tmp, "received/d-002.md"), "utf-8"),
      ).toContain("Mode: candidates");
      expect(f.taskJson()).toMatchObject({
        state: "REVIEW",
        step: "candidates",
        cycle: { candidates_done: 1, candidate_dispatches: ["d-002"] },
      });
      const b = complete(f, first);
      expect(b.status, b.stdout + b.stderr).toBe(0);

      const data = f.taskJson();
      expect(data).toMatchObject({
        state: "REVIEW",
        step: "plausible",
        counters: { review: 1 },
        cycle_ids: [FINDING_ID],
      });
      expect(data.cycle.candidate_dispatches).toEqual(["d-002", "d-001"]);
      expect(data.workers).toEqual({});
      expect(
        data.dispatches.map((d: { id: string; status: string }) => [
          d.id,
          d.status,
        ]),
      ).toEqual([
        ["d-002", "ok"],
        ["d-001", "ok"],
      ]);
      // The reader that completed the batch carries the prefilter note.
      expect(
        fs.readFileSync(path.join(f.taskDir, "reports/d-001.md"), "utf-8"),
      ).toContain("### Prefilter");
      expect(
        fs.readFileSync(path.join(f.taskDir, "reports/d-002.md"), "utf-8"),
      ).not.toContain("### Prefilter");
      const gate = f.next();
      expect(gate).toMatchObject({
        needs: "human",
        human: { kind: "plausible" },
      });
      expect(gate.readers_running).toBeUndefined();
      expect(gate.batch).toBeUndefined();
    });

    it("standard candidates: run one reader at a time without --dispatch; nothing kept -> FINISH", () => {
      f = setupFixture({ tier: "standard" });
      seedCandidates(f);
      f.plan({
        "d-001": { reply: reviewReply("PASS", []) },
        "d-002": { reply: reviewReply("PASS", []) },
      });
      expect(dispatch(f, "d-001").status).toBe(0);
      expect(f.taskJson()).toMatchObject({
        state: "REVIEW",
        step: "candidates",
        cycle: { candidates_done: 1 },
      });
      expect(f.next()).toMatchObject({
        role: "review",
        mode: "candidates",
        dispatch: "d-002",
      });
      expect(f.next().batch).toBeUndefined(); // one reader left
      f.brief("d-002");
      const r = complete(f, f.run("run"));
      expect(r.status, r.stdout + r.stderr).toBe(0);
      const data = f.taskJson();
      expect(data).toMatchObject({
        state: "FINISH",
        counters: { review: 0 },
        cycle_ids: [],
      });
      expect(data.cycle).toBeUndefined();
      expect(
        JSON.parse(
          fs.readFileSync(
            path.join(f.taskDir, "reports/candidates-r1.json"),
            "utf-8",
          ),
        ).kept,
      ).toEqual([]);
    });

    it("a reader id outside the batch is refused; a finished reader is not started twice", () => {
      f = setupFixture({ tier: "standard" });
      seedCandidates(f);
      f.brief("d-005");
      const r = f.run("run", "--dispatch", "d-005");
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("d-001 (or one of d-001, d-002), not d-005");
      f.plan({ "d-001": { reply: reviewReply("PASS", []) } });
      expect(dispatch(f, "d-001").status).toBe(0);
      const again = f.run("run", "--dispatch", "d-001");
      expect(again.status).toBe(1);
      expect(again.stderr).toContain("the next dispatch is d-002, not d-001");
      expect(f.taskJson().cycle.candidates_done).toBe(1);
    });

    it("next lists the running reader beside the other's brief; collected out of order", () => {
      f = setupFixture({ tier: "standard" });
      const config = path.join(f.repo, ".arbor/config.yaml");
      fs.writeFileSync(
        config,
        fs
          .readFileSync(config, "utf8")
          .replace("    timeout: 30s\n", "    timeout: 30s\n    max_parallel: 3\n"),
      );
      seedCandidates(f);
      f.brief("d-001");
      f.brief("d-002");
      const first = JSON.parse(f.run("run", "--dispatch", "d-001").stdout);
      expect(first).toMatchObject({
        needs: "worker",
        dispatch: "d-001",
        orca_dispatch: "orca-d-001",
      });
      const between = f.next();
      expect(between).toMatchObject({
        needs: "brief",
        dispatch: "d-002",
        readers_running: ["d-001"],
      });
      expect(
        between.pending_workers.map((d: { dispatch: string }) => d.dispatch),
      ).toEqual(["d-001"]);
      // Ready set: d-002's brief is actionable while d-001's worker runs.
      expect(
        between.items.map((i: { needs: string; dispatch: string }) => [
          i.needs,
          i.dispatch,
        ]),
      ).toEqual([["brief", "d-002"]]);
      const running = (payload: {
        running: { dispatch: string; orca_dispatch: string }[];
      }) => payload.running.map((r) => [r.dispatch, r.orca_dispatch]);
      expect(running(between)).toEqual([["d-001", "orca-d-001"]]);
      // `run` without --dispatch starts the next reader instead of repeating d-001's envelope.
      const second = JSON.parse(f.run("run").stdout);
      expect(second).toMatchObject({ needs: "worker", dispatch: "d-002" });
      const both = f.next();
      expect(both).toMatchObject({ needs: "worker" });
      expect(both.items).toEqual([]);
      expect(running(both)).toEqual([
        ["d-001", "orca-d-001"],
        ["d-002", "orca-d-002"],
      ]);
      // Asking for d-001 again returns its own envelope, not a new worker.
      expect(
        JSON.parse(f.run("run", "--dispatch", "d-001").stdout),
      ).toMatchObject({ dispatch: "d-001", request_path: first.request_path });
      expect(
        orcaCalls(f).filter((argv) => argv[1] === "worker-start"),
      ).toHaveLength(2);
      // A third reader does not exist: the gate and decisions wait for the batch.
      expect(f.run("gate").stderr).toContain("a worker is pending");

      const collect = (
        p: { dispatch: string; reply_path: string; orca_dispatch: string },
        text: string,
      ) => {
        fs.writeFileSync(p.reply_path, text);
        setOrcaState(f, p.orca_dispatch, {
          dispatch: { id: p.orca_dispatch, status: "completed" },
        });
        const r = f.run("sync", "--dispatch", p.dispatch);
        expect(r.status, r.stdout + r.stderr).toBe(0);
        expect(r.stdout).toContain(`${p.dispatch} review: ok; report:`);
      };
      collect(
        second,
        reviewReply("FAIL", [finding("src/app.txt", 2, "PLAUSIBLE")]),
      );
      expect(f.taskJson()).toMatchObject({
        state: "REVIEW",
        step: "candidates",
        cycle: { candidates_done: 1 },
      });
      collect(first, reviewReply("PASS", []));
      expect(f.taskJson()).toMatchObject({
        state: "REVIEW",
        step: "plausible",
        workers: {},
        cycle_ids: [FINDING_ID],
      });
      expect(
        f.results().map((r) => [r.dispatch, r.executor, r.status]),
      ).toEqual([
        ["d-002", "fake", "ok"],
        ["d-001", "fake", "ok"],
      ]);
    });
  },
);
